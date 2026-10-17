"""KEEP_ALIVE patch for the gemini-webapi library (applied at build time by patch_webai.py).

Root cause of "cookies work 2-3 h, then the account is GUEST / logged out":
  gemini-webapi flips `account_status` to UNAUTHENTICATED when ANY rpc answers with code 7 (not only the real
  account-status check; the 60-120 s heartbeat, quota calls ... can do it on a one-off Google hiccup).  After that
  both background tasks stop for good:  `start_auto_refresh` (the __Secure-1PSIDTS rotation) and the heartbeat.
  Nothing rotates the cookie any more, it ages out a couple of hours later and the account is dead.

What this patch changes (library behaviour only, nothing else):
  1. only the account-status rpc (GET_USER_STATUS) may mark the session UNAUTHENTICATED
  2. the refresh loop keeps rotating even when the status is not AVAILABLE (rotation is what saves the cookie)
     and re-checks the status after each rotation, so a false alarm heals itself in one interval
  3. the heartbeat waits instead of exiting when the status is not AVAILABLE
  4. the gap between two rotations is a NEW random value every time, uniform between WEBAI_REFRESH_MIN_SECONDS (180)
     and WEBAI_REFRESH_MAX_SECONDS (480), e.g. 4.5 min, 3.7 min, 7.2 min (not a fixed 5 min with a few seconds of jitter)
"""
import sys

MARK = "KEEP_ALIVE_PATCH"


def _sub(s, old, new, what):
    assert s.count(old) == 1, f"gemini-webapi anchor missing/ambiguous: {what}"
    return s.replace(old, new, 1)


def patch_source(s):
    if MARK in s:
        return s
    # 1) a code-7 answer to some OTHER rpc must not kill the session state
    s = _sub(s,
"""                if reject_code == 7:
                    self.account_status = AccountStatus.UNAUTHENTICATED
""",
"""                if reject_code == 7:
                    if target_id == GRPC.GET_USER_STATUS:   # KEEP_ALIVE_PATCH: only the real auth check decides
                        self.account_status = AccountStatus.UNAUTHENTICATED
""", "reject_code 7")

    # 2) refresh loop: keep rotating, re-check status afterwards
    s = _sub(s,
"""            if not self._check_account_status():
                logger.warning(
                    f"Stopping the auto-refresh cookies. Account status: {self.account_status.name} - {self.account_status.description}"
                )
                self.refresh_task = None
                break

            try:
                async with self._lock:""",
"""            # KEEP_ALIVE_PATCH: never stop rotating (rotation is what keeps the cookie alive) and ALWAYS re-check the
            # real account status afterwards: a one-off glitch heals itself, a real logout is still detected.
            _recheck = True
            if not self._check_account_status():
                logger.warning(
                    f"Auto-refresh: account status is {self.account_status.name}; still rotating cookies and re-checking status."
                )

            try:
                async with self._lock:""", "refresh loop head")
    s = _sub(s,
"""            except Exception as e:
                logger.warning(
                    f"Unexpected error while refreshing cookies: {e}. Retrying in next interval."
                )
""",
"""            except Exception as e:
                logger.warning(
                    f"Unexpected error while refreshing cookies: {e}. Retrying in next interval."
                )

            if _recheck and self._running:                     # KEEP_ALIVE_PATCH
                try:
                    _was_ok = self._check_account_status()
                    await self._fetch_user_status()
                    if self._check_account_status() and not _was_ok:
                        logger.info("Auto-refresh: account is AVAILABLE again.")
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.warning(f"Auto-refresh: status re-check failed: {e}")
""", "refresh loop tail")

    # 2b) random gap between rotations (3-8 min by default), a different value every cycle
    s = _sub(s,
"""            jitter = random.uniform(-15, 15)
            await asyncio.sleep(max(60, self.refresh_interval + jitter))
""",
"""            # KEEP_ALIVE_PATCH: new random gap every time (default 3-8 min, fractional seconds)
            import os as _os
            try:
                _lo = float(_os.environ.get("WEBAI_REFRESH_MIN_SECONDS", "180"))
                _hi = float(_os.environ.get("WEBAI_REFRESH_MAX_SECONDS", "480"))
            except ValueError:
                _lo, _hi = 180.0, 480.0
            if _hi < _lo:
                _lo, _hi = _hi, _lo
            await asyncio.sleep(max(60.0, random.uniform(_lo, _hi)))
""", "refresh gap")

    # 3) heartbeat: wait, do not exit
    s = _sub(s,
"""            if not self._check_account_status():
                logger.warning(
                    f"Stopping the activity watchdog. Account status: {self.account_status.name} - {self.account_status.description}"
                )
                self.activity_task = None
                break
""",
"""            if not self._check_account_status():
                # KEEP_ALIVE_PATCH: wait for the refresh loop to re-check the status instead of exiting for good
                await asyncio.sleep(60)
                continue
""", "watchdog")
    return s


def patch_file(path):
    with open(path, encoding="utf-8") as f:
        s = f.read()
    new = patch_source(s)
    if new != s:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new)
        return True
    return False


if __name__ == "__main__":
    print("patched" if patch_file(sys.argv[1]) else "already patched")

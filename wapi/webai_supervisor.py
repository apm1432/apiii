#!/usr/bin/env python3
"""
WebAI pool supervisor: one WebAI-to-API process per Gemini account.

Source of truth is MongoDB (collection `webai_cookies`, managed on /api/web/v1/ui/auth).  Every few seconds:

  * enabled account without a process        -> write its own config.conf, start WebAI on a free port
  * account removed / disabled               -> stop its process, delete its temp files
  * cookies pasted again                     -> restart that account only
  * process crashed                          -> restart with back-off (5s, 10s ... 60s)
  * every WEBAI_COOKIE_SYNC_SECONDS          -> save rotated cookies to the DB + health check / self-heal
  * no account saved at all                  -> one anonymous "guest" instance (same as the old single-WebAI setup)

Each instance is isolated: own port, own cwd (config.conf), own TMPDIR (rotated-cookie cache) and RUNTIME_DIR.
State for the router is published atomically to POOL_DIR/pool.json (read by wapi/webai_pool.py).

Run:  python3 webai_supervisor.py        (started by start.sh in a restart loop)
SIGTERM: saves the newest rotated cookies of every account, stops all instances, exits.
"""
import os, sys, json, time, shutil, signal, socket, threading, subprocess, datetime

import webai_cookies as wc

PY = os.environ.get("WEBAI_PY", "/opt/webai-venv/bin/python")
WEBAI_ROOT = os.environ.get("WEBAI_ROOT", "/opt/webai")
BASE_PORT = int(os.environ.get("WEBAI_POOL_BASE_PORT", "6969"))
POLL_SECONDS = max(1.0, float(os.environ.get("WEBAI_POOL_POLL_SECONDS", "3")))
STATUS_SECONDS = 10.0
POOL_FILE = os.path.join(wc.POOL_DIR, "pool.json")
PID_FILE = os.path.join(wc.POOL_DIR, "supervisor.pid")
GUEST_ID = "guest"
STALL_MAX_RESTARTS = int(os.environ.get("WEBAI_STALL_MAX_RESTARTS", "6"))

_stop = threading.Event()


def log(msg):
    print(f"[webai-pool] {msg}", flush=True)


def tg_alert(text):
    """Telegram message to the admin (same TELEGRAM_BOT_TOKENS / ADMIN_TG_ID the admin bot uses). Never raises."""
    try:
        import requests
        clean = lambda v: (v or "").replace('"', "").replace("'", "").strip()
        token = clean((os.environ.get("TELEGRAM_BOT_TOKENS") or "").split(",")[0])
        chat = clean(os.environ.get("ADMIN_TG_ID"))
        if not token or not chat:
            return False
        r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                          json={"chat_id": chat, "text": text}, timeout=10)
        return r.ok
    except Exception as e:
        log(f"telegram alert failed: {e}")
        return False


def _pdeathsig():
    """Child dies with the supervisor (Linux), so a crash never leaves orphan WebAI processes."""
    try:
        import ctypes
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)   # PR_SET_PDEATHSIG
    except Exception:
        pass


def _port_free(port):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


# ── last WebAI log lines -> file, so they can be read at /api/web/v1/webai-log without the host's log console ──
import collections as _collections
_RING = _collections.deque(maxlen=600)
_RING_LOCK = threading.Lock()
_RING_FILE = os.path.join(os.environ.get("WEBAI_POOL_DIR", "/tmp/webai-pool"), "webai.log")


def _ring_add(line):
    try:
        with _RING_LOCK:
            _RING.append(line[:600])
            os.makedirs(os.path.dirname(_RING_FILE), exist_ok=True)
            with open(_RING_FILE + ".tmp", "w", encoding="utf-8") as f:
                f.write("\n".join(_RING))
            os.replace(_RING_FILE + ".tmp", _RING_FILE)
    except Exception:
        pass



class Inst:
    def __init__(self, iid, port, label, guest=False):
        self.id, self.port, self.label, self.guest = iid, port, label, guest
        self.dir = wc.instance_dir(iid)
        self.tmp = wc.instance_tmp(iid)
        self.proc = None
        self.started = 0.0
        self.fp = None                 # fingerprint of the cookies it was started with
        self.crashes = 0
        self.next_start = 0.0
        self.authenticated = None
        self.status = None
        self.state = "stopped"         # stopped | starting | running | backoff
        # health bookkeeping (accounts only)
        self.bad = 0
        self.ok_since = None
        self.stall_restarts = 0

    # ── process control ──────────────────────────────────────────────────────
    def start(self, doc, seed_mode="auto"):
        os.makedirs(self.tmp, exist_ok=True)
        os.makedirs(os.path.join(self.dir, "runtime"), exist_ok=True)
        psid = doc.get("psid") if doc else ""
        psidts = doc.get("psidts") if doc else ""
        wc.write_config(psid or "", psidts or "", os.path.join(self.dir, "config.conf"))
        seed = os.path.join(self.dir, "seed")
        shutil.rmtree(seed, ignore_errors=True)
        try:
            how = wc.write_seed(doc, seed, seed_mode) if doc else None
            if how:
                n = len((doc.get("jar") if how == "rotated" else doc.get("pastedJar")) or [])
                log(f"'{self.label}': starting with the {how} cookie jar ({n} cookies)")
        except Exception as e:
            log(f"'{self.label}': could not restore cookie jar ({e}) - starting from the pasted cookies")
        env = dict(os.environ, TMPDIR=self.tmp, RUNTIME_DIR=os.path.join(self.dir, "runtime"),
                   WEBAI_COOKIE_SEED_DIR=seed,
                   PYTHONPATH=os.path.join(WEBAI_ROOT, "src"), PYTHONUNBUFFERED="1")
        cmd = [PY, os.path.join(WEBAI_ROOT, "src", "run.py"), "--host", "127.0.0.1", "--port", str(self.port)]
        self.proc = subprocess.Popen(cmd, cwd=self.dir, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1, errors="replace", preexec_fn=_pdeathsig)
        threading.Thread(target=self._pump, args=(self.proc,), daemon=True).start()
        self.started = time.time()
        self.fp = doc.get("pastedAtEpoch") if doc else None
        self.state = "starting"
        self.authenticated = None
        self.bad = 0
        self.ok_since = None
        log(f"started '{self.label}' ({self.id}) on 127.0.0.1:{self.port} pid={self.proc.pid}")

    def _pump(self, proc):
        tag = f"[webai:{self.label}] "
        try:
            for line in proc.stdout:
                print(tag + line.rstrip("\n"), flush=True)
                _ring_add(time.strftime("%H:%M:%S ") + tag + line.rstrip("\n"))
        except Exception:
            pass

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def stop(self, wipe=False):
        p = self.proc
        if p is not None and p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=15)
            except Exception:
                try:
                    p.kill()
                    p.wait(timeout=5)
                except Exception:
                    pass
        self.proc = None
        self.state = "stopped"
        self.authenticated = None
        shutil.rmtree(self.tmp, ignore_errors=True)            # stale rotated caches
        if wipe:
            shutil.rmtree(self.dir, ignore_errors=True)

    def restart(self, doc, sync_first=False, drop_jar=False, seed_mode="auto"):
        """drop_jar: self-heal restart. The saved rotated jar is what produced the unauthenticated session, so do NOT
        seed it again: forget it and start from the newest auth cookies (__Secure-1PSID / __Secure-1PSIDTS) only."""
        if sync_first and not self.guest:
            try:
                wc.sync_from_cache(self.id, self.tmp)           # keep the newest rotated cookies before caches are wiped
            except Exception as e:
                log(f"pre-restart sync failed for {self.id}: {e}")
        if drop_jar and not self.guest:
            try:
                wc._coll().update_one({"_id": self.id}, {"$unset": {"jar": "", "jarPsid": ""}})
                fresh = wc.get_doc(self.id)
                doc = fresh if fresh else doc
                doc.pop("jar", None)
            except Exception as e:
                log(f"could not drop saved cookie jar of {self.id}: {e}")
        self.stop()
        self.start(doc, seed_mode)


class Supervisor:
    def __init__(self):
        self.insts = {}
        self.last_status = 0.0
        self.last_sync = 0.0
        self.last_ids = None

    def alloc_port(self):
        used = {i.port for i in self.insts.values()}
        for p in range(BASE_PORT, BASE_PORT + 60):
            if p not in used and _port_free(p):
                return p
        raise RuntimeError("no free port for a new WebAI instance")

    # ── desired state from the DB ────────────────────────────────────────────
    def desired(self):
        docs = [d for d in wc.list_docs() if d.get("enabled", True)][:wc.MAX_ACCOUNTS]
        if docs:
            return {d["_id"]: d for d in docs}
        if wc.list_docs():                  # accounts exist but all disabled -> nothing runs (disabled means disabled)
            return {}
        return {GUEST_ID: None}             # no account at all -> anonymous guest like the old single-WebAI setup

    def reconcile(self):
        try:
            want = self.desired()
        except Exception as e:
            log(f"DB not reachable ({e}) - keeping current instances")
            return
        now = time.time()
        for iid in [i for i in self.insts if i not in want]:
            log(f"removing instance '{self.insts[iid].label}' ({iid})")
            self.insts.pop(iid).stop(wipe=True)
        for iid, doc in want.items():
            label = (doc.get("label") if doc else None) or ("guest (no cookies)" if doc is None else iid)
            inst = self.insts.get(iid)
            if inst is None:
                try:
                    inst = Inst(iid, self.alloc_port(), label, guest=doc is None)
                except RuntimeError as e:
                    log(str(e))
                    continue
                self.insts[iid] = inst
            inst.label = label
            fp = doc.get("pastedAtEpoch") if doc else None
            if inst.alive():
                if inst.fp != fp:                                  # cookies pasted again -> restart this account only
                    log(f"cookies changed for '{inst.label}' -> restart")
                    inst.restart(doc)
                elif inst.crashes and now - inst.started > 60:
                    inst.crashes = 0
                continue
            if inst.proc is not None:                              # it exited by itself
                code = inst.proc.poll()
                inst.proc = None
                inst.crashes += 1
                inst.next_start = now + min(60, 5 * inst.crashes)
                inst.state = "backoff"
                inst.authenticated = None
                log(f"'{inst.label}' exited (code {code}) -> restart in {min(60, 5 * inst.crashes)}s")
            if now >= inst.next_start:
                try:
                    inst.start(doc)
                except Exception as e:
                    inst.crashes += 1
                    inst.next_start = now + min(60, 5 * inst.crashes)
                    inst.state = "backoff"
                    log(f"could not start '{inst.label}': {e}")

    # ── live status (every ~10 s) ────────────────────────────────────────────
    def refresh_status(self):
        for inst in self.insts.values():
            if not inst.alive():
                continue
            st = wc.webai_status(inst.port)
            if st is None:
                inst.authenticated = None
                inst.state = "starting" if time.time() - inst.started < 90 else "backoff"
                continue
            inst.status = st[0]
            inst.authenticated = (st[0] == "AUTHENTICATED")
            inst.state = "running"

    # ── DB sync + health (every WEBAI_COOKIE_SYNC_SECONDS) ───────────────────
    def sync_and_health(self):
        for inst in list(self.insts.values()):
            if inst.guest or not inst.alive():
                continue
            try:
                wc.sync_from_cache(inst.id, inst.tmp)
            except Exception as e:
                log(f"sync_from_cache({inst.id}) failed: {e}")
            try:
                self.check_health(inst)
            except Exception as e:                                 # DB hiccup must never kill the loop
                log(f"check_health({inst.id}) failed: {e}")

    def check_health(self, inst):
        """gemini-webapi flips to UNAUTHENTICATED on ANY single rejected RPC and then stops its auto-refresh loop for
        good (and the guest-mode patch keeps answering anonymously, so nobody notices).  Restarting that one instance
        re-initialises it from the newest cookies in the DB.  Still not authenticated after a few tries -> the cookies
        are really dead -> needsRepaste (shown on the page)."""
        doc = wc.get_doc(inst.id)
        if not doc or not doc.get("psid"):
            return
        st = wc.webai_status(inst.port)
        if st is None:                                             # restarting / down: nothing to judge
            inst.ok_since = None
            return
        status = st[0]
        now = wc._now()
        flt = {"_id": inst.id, "pastedAtEpoch": doc.get("pastedAtEpoch")}
        sets = {"lastStatus": status, "lastStatusAt": now}

        def save():
            wc._coll().update_one(flt, {"$set": sets})

        if status == "AUTHENTICATED":
            inst.bad = 0
            if inst.ok_since is None:
                inst.ok_since = time.time()
            sets.update(healAttempts=0, needsRepaste=False, okSinceEpoch=inst.ok_since, alerted=False)
            # STALL_RESTART: gemini-webapi cancels its auto-refresh loop for good when Google rejects one rotation
            # (AuthError) but keeps reporting AUTHENTICATED, so the cookie quietly ages out. Restarting the instance
            # starts the refresh loop again. 1st try keeps the saved jar, later tries drop it. Max STALL_MAX_RESTARTS.
            lr = wc._aware(doc.get("lastRotationAt"))
            last_rot = lr.timestamp() if lr else 0.0
            if last_rot > inst.ok_since:
                inst.stall_restarts = 0                              # rotation works again
            idle = time.time() - max(inst.ok_since, last_rot)
            if idle > wc.STALL_SECONDS and inst.stall_restarts < STALL_MAX_RESTARTS:
                inst.stall_restarts += 1
                log(f"'{inst.label}' authenticated but no cookie rotation for {int(idle // 60)} min -> "
                    f"restart #{inst.stall_restarts} (refresh loop is dead)")
                save()
                return inst.restart(doc, sync_first=True, drop_jar=inst.stall_restarts > 1,
                                    seed_mode="auto" if inst.stall_restarts == 1 else "none")
            return save()

        inst.ok_since = None
        sets["okSinceEpoch"] = None
        inst.bad += 1
        if inst.bad < 2 or doc.get("needsRepaste"):                # need 2 bad checks in a row (startup blips)
            return save()
        attempts = int(doc.get("healAttempts") or 0)
        if attempts >= 1 and not doc.get("alerted"):               # 1st restart did not recover it -> tell the admin now
            if tg_alert(f"⚠️ Gemini web account '{inst.label}' is logged out (status={status}). "
                        f"Cookies were rejected by Google - paste fresh ones at /api/web/v1/ui/auth"):
                sets["alerted"] = True
        if attempts >= wc.HEAL_MAX_ATTEMPTS:
            sets["needsRepaste"] = True
            log(f"cookies of '{inst.label}' look dead - paste fresh ones at /api/web/v1/ui/auth")
            return save()
        last = wc._aware(doc.get("lastHealAt"))
        wait = min(wc.HEAL_MIN_SECONDS * (2 ** attempts), 1800)
        if last and (now - last).total_seconds() < wait:
            return save()
        log(f"'{inst.label}' status={status} -> self-heal restart #{attempts + 1}")
        sets.update(lastHealAt=now, healAttempts=attempts + 1)
        save()
        # ladder: heal #1 = full pasted jar with the newest 1PSIDTS, heal #2+ = only the two auth cookies
        inst.restart(doc, sync_first=True, drop_jar=True, seed_mode="pasted" if attempts == 0 else "none")

    # ── publish for the router ───────────────────────────────────────────────
    def publish(self):
        items = []
        for inst in sorted(self.insts.values(), key=lambda i: i.port):
            items.append({"id": inst.id, "label": inst.label, "port": inst.port, "guest": inst.guest,
                          "state": inst.state, "authenticated": inst.authenticated,
                          "status": inst.status, "pid": inst.proc.pid if inst.alive() else None})
        data = {"updated": datetime.datetime.now(datetime.timezone.utc).isoformat(), "instances": items}
        ids = json.dumps(items, sort_keys=True)
        os.makedirs(wc.POOL_DIR, exist_ok=True)
        tmp = POOL_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, POOL_FILE)
        if ids != self.last_ids:
            self.last_ids = ids
            log("pool: " + (", ".join(f"{i['label']}={i['state']}"
                                      f"{'/auth' if i['authenticated'] else ''}@{i['port']}" for i in items) or "empty"))

    def run(self):
        os.makedirs(wc.POOL_DIR, exist_ok=True)
        with open(PID_FILE, "w") as f:
            f.write(str(os.getpid()))
        log(f"supervisor started (max {wc.MAX_ACCOUNTS} accounts, base port {BASE_PORT})")
        while not _stop.is_set():
            self.reconcile()
            now = time.time()
            if now - self.last_status >= STATUS_SECONDS:
                self.last_status = now
                self.refresh_status()
            if now - self.last_sync >= wc.SYNC_SECONDS:
                self.last_sync = now
                self.sync_and_health()
            try:
                self.publish()
            except OSError as e:
                log(f"could not write pool.json: {e}")
            _stop.wait(POLL_SECONDS)
        self.shutdown()

    def shutdown(self):
        log("stopping: saving rotated cookies and stopping all instances")
        for inst in self.insts.values():
            if not inst.guest:
                try:
                    wc.sync_from_cache(inst.id, inst.tmp)
                except Exception as e:
                    log(f"final sync failed for {inst.id}: {e}")
        threads = [threading.Thread(target=i.stop) for i in self.insts.values()]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=25)
        try:
            os.remove(PID_FILE)
        except OSError:
            pass


def main():
    if not os.path.exists(PY) or not os.path.isdir(os.path.join(WEBAI_ROOT, "src")):
        log("WebAI-to-API is not installed - nothing to supervise")
        return 0
    def _on_term(*_):
        try:                                      # tells start.sh's restart loop this exit is intentional
            os.makedirs(wc.POOL_DIR, exist_ok=True)
            open(os.path.join(wc.POOL_DIR, "stopping"), "w").close()
        except OSError:
            pass
        _stop.set()
    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)
    Supervisor().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())

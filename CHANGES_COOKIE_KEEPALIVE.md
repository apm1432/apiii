# Cookie keep-alive fix (accounts dying after 2-3 h)

Cause (in gemini-webapi 2.1.1): ONE rpc answered with code 7 (also the 60-120 s heartbeat or a quota call) set the
session to UNAUTHENTICATED; after that the library stopped BOTH the __Secure-1PSIDTS rotation and the heartbeat for good.
Nothing renewed the cookie, so it expired 2-3 h later, even though Google had not rejected the login.

Fix: `wapi/patch_gemini_lib.py` (applied at build by `patch_webai.py` step 2g)
- only the real account-status rpc can mark the session UNAUTHENTICATED
- the rotation loop never stops; it re-checks the status after each rotation, so a false alarm heals itself
- the heartbeat waits instead of exiting
Also: rotation interval 300 s -> 540 s (fewer requests from the server IP); optional env `WEBAI_PROXY`
(http://user:pass@host:port) so Google sees one stable IP for the account.

Needs a Docker REBUILD, then re-paste the cookies once (use incognito, close it WITHOUT signing out).
If it still dies, look in the logs for "Auto-refresh:" and "Rotation" lines; they now show why.

# Cookie keep-alive fix (accounts dying after 2-3 h)

Cause (in gemini-webapi 2.1.1): ONE rpc answered with code 7 (also the 60-120 s heartbeat or a quota call) set the
session to UNAUTHENTICATED; after that the library stopped BOTH the __Secure-1PSIDTS rotation and the heartbeat for good.
Nothing renewed the cookie, so it expired 2-3 h later, even though Google had not rejected the login.

Fix: `wapi/patch_gemini_lib.py` (applied at build by `patch_webai.py` step 2g)
- only the real account-status rpc can mark the session UNAUTHENTICATED
- the rotation loop never stops; it re-checks the status after each rotation, so a false alarm heals itself
- the heartbeat waits instead of exiting
Also: rotation + status check at a NEW random gap every time, uniform 3-8 min with fractional seconds (e.g. 4.5, 3.7, 7.2 min); env `WEBAI_REFRESH_MIN_SECONDS` (180) / `WEBAI_REFRESH_MAX_SECONDS` (480), library minimum 60 s. Keep MAX below 800 s (the stall watchdog warns after 900 s without a rotation). If the patch cannot be applied the stock fixed gap `WEBAI_REFRESH_SECONDS` (300) is used; optional env `WEBAI_PROXY`
(http://user:pass@host:port) so Google sees one stable IP for the account.

Needs a Docker REBUILD, then re-paste the cookies once (use incognito, close it WITHOUT signing out).
If it still dies, look in the logs for "Auto-refresh:" and "Rotation" lines; they now show why.

# Logs page (/logs) smooth under heavy parallel / image traffic
- Cause: each request's `message` was `str(<list with base64 images>)` (MBs) and `/dashboard_data` sent all 50 full entries every 5 s.
- Now: `/dashboard_data?slim=1` returns small fixed-size rows (~12 KB); request body / attempts / full error load only when you click **Details** (`?detail=<id>`).
- Failed requests are also kept in a separate buffer (last 100) so successes can never push an error off the page. Filter chips: All / Errors / Fallback / Pending / OK. Errors: red row, error text visible inline.
- Buttons: **Skip this load** (aborts a slow refresh), **Pause logs**; refresh never overlaps, backs off when the server is slow, and does nothing while the tab is hidden.

# Finished requests are deleted from server memory
- Success (200, no problem): request summary, attempts, error and message text are deleted right after the response; only a one-line summary (time, status, model, route, ms) stays. Env `LOG_KEEP_SUCCESS_DETAIL=1` turns this off.
- Failed requests and "200 but fallback" keep error + attempts (bounded: 50 recent + 100 failed) because you debug with them.
- After uploads > 1 MB (images) the freed memory is handed back to the OS (`gc` + `malloc_trim`, debounced); gunicorn runs with `MALLOC_MMAP_THRESHOLD_`/`MALLOC_TRIM_THRESHOLD_` = 256 KB so big bodies are not kept by glibc.
- WebAI raw-reply capture (/tmp/webai-capture, wrote up to 3 MB per reply) is OFF by default; `WEBAI_CAPTURE=1` turns it on for diagnostics.

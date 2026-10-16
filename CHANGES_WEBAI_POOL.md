# Multi-account WebAI pool (/api/web/v1)

Add 2-3+ Gemini web accounts at `/api/web/v1/ui/auth`. Each account runs in its OWN WebAI-to-API process and requests are
spread over all of them in parallel, so no single account takes all the load or gets blocked.

- `wapi/webai_supervisor.py` (new): one WebAI process per account (ports 6969, 6970, ...), own config.conf / TMPDIR / RUNTIME_DIR.
  Starts/stops/restarts on DB changes, restarts crashed ones, saves auto-rotated cookies back to MongoDB, per-account self-heal.
  No account saved -> one anonymous guest instance (same as before).
- `wapi/webai_pool.py` (new): picks the account: logged-in first, least requests in flight, then least recently used;
  per-account concurrency cap; failing account (401/403/429/5xx/network) gets a cooldown and the request is retried on
  another account; `conversation_id` sticks to its account; artifact links carry `a=<account>` so files are downloaded
  with the account that generated them.
- `wapi/webai_cookies.py`: multi-account store (collection `webai_cookies`, one doc per account; the old single doc `gemini`
  becomes "Account 1" automatically) + new page. Paste the same account again -> updates it (no duplicate).
- `wapi/smart_router.py`: `/api/web/v1/*` proxy and the Gemini-key -> WebAI fallback both use the pool.
- `start.sh`: starts the supervisor instead of the single WebAI loop; graceful shutdown saves cookies of all accounts.

Env (all optional): `WEBAI_MAX_ACCOUNTS` (4), `WEBAI_PER_ACCOUNT_CONCURRENCY` (4), `WEBAI_POOL_WAIT` (30 s),
`WEBAI_COOLDOWN_AUTH/RATE/SOFT` (120/60/30 s), `WEBAI_POOL_BASE_PORT` (6969).
Memory: every account = one extra Python process (~100-200 MB) - check the container RAM before adding many.

## Cookie jar survives restarts
gemini-webapi keeps the rotated cookies (new `__Secure-1PSIDTS`, `__Secure-1PSIDCC`, ...) in a cache dir that WebAI creates
fresh on every start, so a restart used to fall back to the two pasted cookies. Now `webai_cookies.sync_from_cache` saves the
whole jar in MongoDB (`jar`), the supervisor writes it to `<instance>/seed/` at start (`WEBAI_COOKIE_SEED_DIR`), and a new build
patch (`patch_webai.py` 2f) copies it into WebAI's new cache dir, where the library tries cached cookies first.
A re-paste drops the old jar. Needs a Docker rebuild (the patch is applied at build time).
Self-heal: when an account shows UNAUTHENTICATED, its restart does NOT re-seed the saved jar (that jar is what produced the bad
session): the jar is dropped from the DB and the instance starts from the newest `__Secure-1PSID/1PSIDTS`. Still failing after
`WEBAI_HEAL_MAX_ATTEMPTS` tries -> "cookies expired, replace" on the page.

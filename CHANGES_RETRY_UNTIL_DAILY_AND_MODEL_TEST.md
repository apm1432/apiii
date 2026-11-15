# Retry until all keys are daily-penalized + RPM safety + model test

## Root causes found (from the dashboard logs)
1. `proxy_chat` added every (key, model) to `tried` the moment it was SENT. So after one pass over the pool
   (~23-25 attempts) nothing was left and the request failed with 429, even though most slots were only RPM-cooling.
2. `_escalate_or_stay_rpm` turned 5 ambiguous 429s ("resource has been exhausted") into a MIDNIGHT daily lock ->
   healthy keys were locked for a whole day (that is why "gemini-3.6-flash" was locked on 14 keys with only 22 requests).
3. The wait calculation used a stale RPM window while a cooldown was active -> 0.2 s busy-loop
   ("all slots busy -> waiting 0.2s" x 60) and it added cooldown and window waits separately instead of taking the later.
4. Wait > FALLBACK_MAX_WAIT (3 s) / POOL_MAX_WAIT (5 s) -> request gave up although keys were only cooling down.

## Behaviour now (smart_router.py)
- A request keeps trying until a slot answers 200, or EVERY key x model is daily-penalized / RPD-exhausted / blocked / broken
  (then: 429 `all_keys_daily_exhausted`, Retry-After 600), or `REQUEST_MAX_SECS` (default 900, 0 = never) passed
  (429 `keys_busy_timeout`).
- RPM 429 = cooldown only (until its RPM window is over). Nothing is sent to that key+model meanwhile; the request
  moves to other slots or sleeps until the soonest one is free (re-checks every <=5 s, one trail line per 10 s).
- Only REAL daily-quota errors create a daily penalty (one day, until midnight IST). Ambiguous 429s never do
  (`AMBIGUOUS_429_STRIKES=<n>` brings the old strike behaviour back, default 0 = off).
- 500/503/network errors: growing cooldown (20/40/60.. max 120 s) instead of permanent exclusion for the request.
- A real 403 (invalid / leaked key) is not retried on the same combo in that request.
- Specific-model requests only wait for that model (before, they waited on slots of unrelated models).
- WebAI fallback (if enabled) is only tried at the very end, when the keys cannot serve the request.

## Model test (dashboard)
- New endpoint `POST|GET /model_test` (`/router/model_test`): `{"models":[..]}` or `{"all":true}`.
  One real call per model on ONE free key, next free key on 429/5xx. Reports: works?, type
  (text out / image out / audio out (TTS) / embedding / live / Imagen-Veo), output kinds, ms, key, answer or error.
- Dashboard: checkbox on every model, `Test selected (n)`, `Test all models`, All/None, and `Test this model`
  inside the Add-model form (before saving).
- nginx: `location /router/model_test` (300 s).

## Ops
- gunicorn threads now `${WAPI_THREADS:-96}` (waiting requests hold a thread; 32 was too few for a 50-request burst).

## New env vars
`REQUEST_MAX_SECS` (900) · `AMBIGUOUS_429_STRIKES` (0) · `PROBE_TIMEOUT` (60) · `PROBE_MAX_KEYS` (3) · `WAPI_THREADS` (96)

## Specific model requests (follow-up)
- When the client asks for ONE specific model (not `auto`), every key is tried at most ONCE per request. If all keys
  fail, the last real Google error is returned as it is (status + body). No second attempt, so Google never sees a
  hammered model (e.g. `deep-research-pro-preview-12-2025`, which answers 429 on every key).
- Keys that are still cooling down are waited for at most `SPECIFIC_MAX_WAIT` seconds (default 20), then the error is returned.
- `auto` / pool requests keep the "retry until all keys are daily-penalized" behaviour.

# No-wait routing + browser-side live logs

## No waiting (wapi `/v1/chat/completions`, `/v1/responses`)
- `STICKY_MAX_WAIT` default 15 -> 0: a tool-call continuation uses its pinned (key, model) only if it is free RIGHT NOW,
  otherwise it goes to any free slot (signatures are re-injected). No more sitting on one model's cooldown.
- `POOL_MAX_WAIT` (new, default 5 s): replaces the old 65 s sleep when the WebAI fallback is not allowed (tools).
- gunicorn `--threads 32` -> `128` (start.sh, Start.sh) so parallel requests are never queued behind sleeping ones.
- Keys from DIFFERENT Google projects have independent quota, so many keys = real parallelism.

## Live logs kept in the BROWSER (nothing saved on the server / DB)
- Server keeps, in RAM only, the full request (all messages incl. assistant tool_calls + tool results, tools offered, params),
  the full response (text, tool calls, finish_reason, usage) and a route trail (which key/model got it, 429s, waits) for
  `LIVE_TTL` s (default 300) after the request ends, max `LIVE_MAX` (300) records. Pending requests are visible while running.
- `/logs` page pulls new records (`/router/dashboard_data?live_since=..`) and stores them in the browser's IndexedDB
  (newest 300). Details button shows trail / request / tool calls / response. New chip "Saved in browser" + "Clear browser logs".
- Close the tab before the TTL and a record is lost (by design: the server holds no history).

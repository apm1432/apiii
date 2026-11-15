# Block = auto only · "Last" models in your own order (saved) · Stop a pending request

## 1. Model block now applies only to auto / round-robin
* ⛔ Block still removes a model from **auto / round-robin** routing (all keys, for the time you chose, survives restarts).
* A client that asks for the model **by name** (e.g. `"model": "gemini-3.5-flash"`) is now always served by exactly that
  model, even while it is blocked. Before, such a request was silently answered by other models (or got 429).
* Also applies to tool-call continuations (sticky pin) and the transcription model.
* Old behaviour: `BLOCK_NAMED_TOO=1` (then `BLOCKED_MODEL_FALLBACK_AUTO` works as before).

## 2. "Last" models: pick several, in order, saved
* Before: only models with `lite` in the name were last (`LITE_LAST`).
* Now: **/logs -> Models -> ⬇ Last order**: add any models from the list, order them with ▲ ▼, 💾 Save.
  They are used only when no other model has a free key; #1 before #2 before #3 ...
  Every model row also has a one-click **⬇ Last / ⬆ Normal** button and shows `⬇ last #n`.
* Saved in MongoDB (collection `wapi_last_models`, doc `order`) + JSON file `wapi/last_models.json` -> survives restarts
  (redeploys need `MONGO_URI`, the file lives inside the container).
* Nothing saved = old default (every lite model last). **↩ Default (lite last)** goes back to it.
  An empty saved list = no model is last.
* API (Bearer PASSWORD; nginx `/router/model_last`):
```
GET    /model_last
POST   /model_last {"models":["gemini-3.5-flash","gemini-3.1-flash-lite"]}   # these are last, in this order
POST   /model_last {"action":"add"|"remove","model":"..."}
POST   /model_last {"action":"reset"}   (or DELETE)
```

## 3. Stop a pending request
* Pending rows on /logs have **⏹ Stop**, plus **⏹ Stop all pending (n)** next to the chips.
* A request waiting for a free key stops at once; a request waiting for Google is abandoned within ~0.4 s
  (a call Google already received still counts there). The client gets **499 `request_cancelled`**
  (SDKs do not auto-retry a 499). The row shows `499 Stopped by admin`.
* API: `POST /request_cancel {"id": <log id>}` | `{"ids":[..]}` | `{"all":true}` (nginx `/router/request_cancel`).
* Only `/v1/chat/completions` and `/v1/responses` requests can be stopped (not `/api/web/v1`, not a stream that already started).
* With the anti-504 heartbeat (start.sh) a request pending >10 s already sent `200`, so the stop answer arrives as a
  200 whose body is the `request_cancelled` error JSON (same as every other error in that case).

## Fixed on the way
* `/logs` JS had `renderLogs` defined twice (the first copy was dead code) - removed.

## Files
`wapi/smart_router.py`, `nginx.conf` (2 new locations). New env: `BLOCK_NAMED_TOO` (0), `LAST_MODELS_COLLECTION`, `LAST_MODELS_FILE`.

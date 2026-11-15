# Memory-leak fixes + model block + model/key tests

## Memory leaks fixed (wapi/smart_router.py)
| Where | Problem | Fix |
|---|---|---|
| `proxy_chat` (Gemini `stream=True`) | 429/5xx/400 answers were only `continue`d past: socket + buffer stayed open until GC | `_drain_close()` reads the small error body and closes it; `_heal_signature` closes the superseded answer |
| streamed responses (`_stream_gemini_sse`, live capture, `/api/web/v1` SSE + downloads) | a generator that never started is closed WITHOUT running its `finally` -> upstream socket and the WebAI account's "in flight" slot leaked when a client disconnected early | `_GuardedIter` runs the cleanup on `.close()` in every case |
| anti-504 heartbeat middleware | after the client disconnected, the worker thread kept reading the upstream and filling an unbounded queue | `stop` event: worker stops, queue is drained |
| `conversation_sticky` | pruned only on tool-continuations -> one entry per chat forever | pruned + capped (`CONV_STICKY_MAX`, default 2000) on every write and by the janitor |
| `sig_cache` | cleaned only above 5000 entries (each is several KB) | cap `SIG_CACHE_MAX` (1500) + TTL sweep |
| live capture | `LIVE_MAX` 300 full request/response records, `_LiveAcc.buf` unbounded for a body without newlines | default 120, buffer capped at 256 KB |
| rpm/rpd/cooldown/strike tables | empty deques and expired entries kept; random client model names added pairs forever | new janitor thread (`JANITOR_SECS`, 60 s): prunes everything, `gc.collect()` + `malloc_trim` every 5 min |
| `webai_pool` | state of deleted accounts kept | `trim()` from the janitor |

## Memory leaks fixed (Node)
`utils/jobManager.js` (finished fixer jobs were never deleted; now after `JOB_KEEP_MIN`=30 min without viewers),
`routes/insights.js backfillTried`, `routes/auth.js recentRecoverMail`, `routes/examimport.js rescans` (timed sweeps),
`middleware/auth.js sessionCache` (LRU cap 20000; falls back to the DB).

## Model block (any time: 1h, 1d, 43d, 2h30m, 3mo, forever)
Dashboard (`/logs`): every model has **⛔ Block** (pick 1h/1d/43d... or type your own) / **✅ Unblock**; blocked models are listed with time left.
API (password as `Authorization: Bearer <PASSWORD>` or browser login), nginx path `/router/model_block` (also `/wapi/model_block`):
```
GET    /model_block
POST   /model_block {"model":"gemini-3.5-flash","duration":"43d","reason":"bad answers"}
POST   /model_block {"model":"...","hours":6}          # seconds | minutes | hours | days
POST   /model_block {"model":"...","until":"2026-12-31T23:59"}   # IST if no zone
POST   /model_block {"action":"unblock","model":"..."}   (or DELETE /model_block?model=...)
POST   /model_block {"action":"unblock_all"}              (or DELETE /model_block)
```
* The block is for ALL keys, is skipped by auto routing, sticky pins and web search, and survives restarts
  (MongoDB collection `wapi_model_blocks` with a TTL index, JSON file as fallback `MODEL_BLOCKS_FILE`).
* A client that asks for the blocked model by name is answered by the other models (auto). `BLOCKED_MODEL_FALLBACK_AUTO=0`
  returns `429 model_blocked` + `Retry-After` instead.
* "Release daily locks" does not lift manual blocks.

## Tests
`GET /test_keys?key=<last chars>` (one key, all models) - existed.
NEW `GET /test_keys?model=<name>` (one model, all keys) and `?key=..&model=..` (one pair). Dashboard: **🧪 Test** next to every model.

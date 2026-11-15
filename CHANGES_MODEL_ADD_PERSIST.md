# Add models from /logs (saved: survive restarts) with RPM + RPD

## Dashboard (/logs -> Models card)
* **➕ Add model**: name + RPM + RPD -> routed immediately, saved in MongoDB (collection `wapi_custom_models`,
  JSON file `wapi/custom_models.json` as fallback) and re-applied on every start / redeploy.
* Every model row shows `RPM x · RPD y` and has **✏️ Limits** (change RPM/RPD). Saved models show `💾 saved`.
  In the edit window: **🗑 Delete model** (saved-only model) or **↩ Reset to env limits** (a GEMINI_MODELS model).

## API (password as `Authorization: Bearer <PASSWORD>`; nginx path `/router/model_config`, also `/wapi/model_config`)
```
GET    /model_config
POST   /model_config {"model":"gemini-3.9-flash","rpm":10,"rpd":250}      add or update limits
POST   /model_config {"action":"delete","model":"gemini-3.9-flash"}       (or DELETE ?model=...)
```
The old `POST /add {"model","rpm","rpd"}` now saves too (it used to be memory only).

## Notes
* A saved entry overrides the limits from the `GEMINI_MODELS` env for the same model name. Delete it to go back to env.
* RPD counters are per key + model and reset at midnight IST (unchanged); changing a limit takes effect at once.
* Model name: letters, digits, `. _ - /` only (a leading `models/` is removed).

---
# Pick models from Google + requests per day per key

## ➕ Add model: drop-down from Google
* Opening **➕ Add model** fetches the live model list of your account (`models.list`, all pages, key sent in a header, cached 5 min,
  🔄 re-fetches). Models not added yet are listed first (newest version names on top), already added ones are greyed out.
  Embedding / image / audio / tts models are hidden. Choosing one fills the name, RPM and RPD.
* Google's API does **not** publish RPM / RPD. They are suggested by copying the newest model of the same family you already have
  (flash-lite / flash / pro), otherwise 5 / 20. Check your quota (ai.google.dev/gemini-api/docs/rate-limits) and edit before Save.
* API: `GET /model_available[?refresh=1][&all=1]` (nginx `/router/model_available`).

## 📊 Requests per day (per key) - new card on /logs
* For every model: today / yesterday total, and per key a bar `today / RPD limit` (green < 70 %, amber, red at the limit) + yesterday.
  Each model row also shows `today N`.
* Only **today and yesterday** are kept. The day changes at midnight IST; older days are deleted from memory and MongoDB.
* Counted where RPD is counted (confirmed 200 from Google). Saved in MongoDB (`wapi_usage_daily`, one document per day, keys stored
  only as a 12-char hash, flushed every 15 s and at exit), so a restart does not lose today's count.
  After a restart today's saved count is also put back into the RPD counter (before, RPD started again from 0 on every restart).
* `USAGE_FLUSH_SECS` (default 15) and `USAGE_COLLECTION` env vars.

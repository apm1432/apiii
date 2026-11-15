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

# Dashboard (/logs): test models on all / selected keys, collapsible cards, clean numbered Models table

Only `wapi/smart_router.py` changed.

## 1. Model test window: choose the keys
Every model's **🧪 Test** (and **🧪 Test selected**, **🧪 Test all models**) opens the model-test window. At the top of it:
* **⚡ One free key** - the old quick test (one real call per model on one free key).
* **🔑 Test with all keys** - every chosen model on EVERY key (one real call per model x key).
* **🎯 Select keys to test** - tick the keys you want (☑ All / ☐ None) and press **▶ Test on selected keys (n)**.
The result table has one row per (model, key); above it a line `Per model: gemini-x 12/14 keys` shows on how many keys each model works.
More than 40 calls at once asks for a confirmation. Models of a type that cannot be tested here (Imagen/Veo/live) give ONE "not tested" row.

API: `POST /model_test` (`/router/model_test`) now also accepts
`{"models":[..], "all_keys": true}` or `{"models":[..], "keys": ["...ab12","cd34"]}` (keys are matched by their last characters);
GET: `?all_keys=1` / `?keys=ab12,cd34`. Response gets `multi` and `keys_tested`. Without these fields nothing changes.
New env `PROBE_MAX_COMBOS` (default 400) = max model x key calls of one request (nginx allows 300 s for this path).
A per-key test counts like a normal call (RPM slot; on 200 one RPD; a real 429/403 is handled like in the router).

## 2. Cards you can hide / show
**Active Keys**, **Models** and **📊 Requests per day (per key)** are now collapsible cards (click the header).
Active Keys and Requests per day start collapsed, Models starts open. The header still shows a short summary
(key count + locks/cooldowns, model count + blocked/last, requests today/yesterday). The open/closed state is kept while the
page refreshes itself, and starts from the default again after a reload.

## 3. Models card: numbered, aligned table
Columns: `# | tick | Model | Keys ok | RPM | RPD | Today | Actions`. Actions are always in the same order
(✏️ Limits, 🧪 Test, ⬇ Last / ⬆ Normal, ⛔ Block / ✅ Unblock, 🔓 Release when keys are locked).
Order: normal models in the configured order, then the ⬇ last models in their "last order". Numbers follow that order.

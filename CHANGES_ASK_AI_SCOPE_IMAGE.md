# Ask AI: image toggle + MPSC-only scope, and WebAI fallback fix for image requests

## 1. Bug: image requests failed with 429 when all Gemini keys were cooling down
Log: `web fallback failed: WebAI 'patilakshay2u' HTTP 400 (model=playwright/gemini/gemini-3.1-flash-lite):
File content parts are only supported on the Gemini WebAPI backend.`

Cause: `_webai_pick_model()` picked the first "lite" model of WebAI, which is a `playwright/*` model; that
backend cannot take image/file parts. Also image requests gave up on the keys after only 3 s (FALLBACK_MAX_WAIT).

Fix (wapi/smart_router.py):
- `_has_file_parts(data)` detects image/file/audio parts.
- `_webai_pick_model(need_files=True)` never returns a `playwright/*` model. If WebAI has no WebAPI-backend model,
  the fallback is skipped with a clear reason instead of sending a doomed request.
- Requests with images/files wait for the keys up to `FILE_MAX_WAIT` seconds (env, default 45) before the fallback.

## 2. Ask AI (student chat)
- New switch "📷 प्रश्नाची image सोबत पाठवा" - shown only for questions that have an image, **default OFF**.
  The server fetches / sends the question image only when `withImage === true` (saves quota, fewer file requests).
- Scope widened: any MPSC / competitive-exam study doubt (history, geography, polity, economy, science, current
  affairs, Maharashtra GK, grammar, maths/reasoning, exam strategy) - not only the opened question.
- Technical-knowledge requests (coding, software, engineering how-to, ...) are refused: by the prompt, and by a cheap
  pre-filter `looksTechnicalRequest()` in routes/api.js that answers without spending AI quota.

Files: wapi/smart_router.py, routes/api.js, utils/aiService.js, public/qchat.js, public/script.js, public/style.css

## 3. Notes + Ask AI panels: movable, resizable, auto-close switch (public/panelkit.js)
- Drag the panel by its header (mouse or finger).
- Resize: drag the bottom-left / bottom-right corner, or tap the **S / M / L** button (small / medium / large).
- **Auto-close: ON / OFF** button in the panel header. OFF (default) = the panel stays open until ✕ is pressed;
  ON = touching anywhere outside closes it. Notes used to always close on an outside touch.
- Position, size and the switch are remembered per panel in this browser (localStorage `panelkit:notes`, `panelkit:askai`).
- index.html: panelkit.js added; cache-bust versions bumped (style.css v24, notes.js v6, qchat.js v3).

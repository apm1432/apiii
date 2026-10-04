# AI Fix: option order, format and re-verification

Changed files: utils/aiService.js, routes/api.js

1. Prompt: options must stay in paper order; AI first copies options from the image
   (image_options_in_paper_order) and fixed_options[i] must be the repaired version of it.
   Match-the-following (Group A / Group B) and statements keep their layout and line breaks.
2. Code guards (before save): reject shuffled options (vs image reading, vs old Marathi/English
   options) and reject lost layout (lines / list items missing).
3. Second AI pass (independent verifier): re-reads options from the image, checks order + format,
   re-solves the question without seeing the first answer. If the answers differ -> retry
   (3 rounds). If still not verified -> NOTHING is saved and the admin sees the reason.
4. /admin/fix-question now also updates text_eng / options_eng and is_ai_fixed (same as the job).

## Update 2: already-shuffled old data
- With an image, the old DB options are NOT sent to the AI (it used to copy them). It reads the options only from the image.
- With an image, the paper is the authority: restoring the paper order is allowed even if old DB options were shuffled
  (checked against the image reading + the verifier). The old-order guard is used only when no image exists.
- The admin log shows a note when the old option order differed and was corrected.

## Update 3: "Ask AI" chat on every question (all users)
- public/qchat.js (new), script.js (button in quiz + full paper view), style.css, index.html (script/css version bump)
- routes/api.js: POST /api/question-chat  (login + same subscription / free-trial rule as /api/questions)
- utils/aiService.js: chatAboutQuestion()
- Strictly scoped: the server loads the question from the DB by id; the system prompt allows only that question and its directly related facts, refuses everything else.
- Nothing is saved: no DB, no localStorage; history stays in browser memory and is cleared on close / other question / reload.
- Limits: 15 messages / 10 min and 80 / day per user, message max 1000 chars, last 8 turns sent.
- Optional env CHAT_USE_SEARCH=1 turns on Gemini Google Search so current-affairs answers can be live (default off).

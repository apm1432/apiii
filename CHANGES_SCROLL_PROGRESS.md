# Fix: AI Fix scroll jump + lost user progress

## 1. AI Fix no longer moves the page / Paper Mode
- public/script.js `renderFullPaper`: if the question list is the same, only the questions that really changed
  (text / AI fix / answer) are redrawn. A different list (subject / topic filter) rebuilds, but the page is kept at the same question.
- `refreshFullQuestion`: replaces only the one question; if it is above the screen the scroll is corrected.
- `question_done` (AI Fix finished): the fixed question is MERGED into the object already on screen (keeps qnum / subject / topic),
  it is not replaced by the raw server document any more.
- public/paper.js: after an AI Fix / progress sync the current page is found again by its question ids (not by page number) and the
  sub-image page is kept. Closing Paper Mode no longer rebuilds the whole Full Paper.
- index.html: script.js?v=31, paper.js?v=12 (browsers load the new files).

## 2. Progress is saved reliably
- routes/api.js `/progress/save`: ONE atomic MongoDB update ($set + $inc, first answer wins). Before it was load whole document ->
  change -> save(), so two answers at the same moment overwrote each other (answer or counter lost).
  A missing `section` no longer causes a 500.
- Rate limit of answers is now per USER (120/min) not per IP (60/min). Students on the same Wi-Fi shared one limit and got 429.
- utils/progressSync.js: AI-fix re-evaluation and the dashboard self-heal are atomic too (no stale save() overwriting new answers).
- public/script.js: answer OUTBOX. Every answer is stored in localStorage and removed only after the server confirmed it; it is retried
  (network error, 401/429/5xx, internet back, tab visible, every 15 s). Pending answers stay on screen when data is loaded from the server.

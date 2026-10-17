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

## 3. Question Palette goes to the question on the first tap
- script.js `jumpToFullQuestion(idx)` replaces `scrollIntoView({behavior:'smooth'})`: instant jump, top of the question kept below the
  sticky mobile palette, re-corrected for a few frames while content-visibility questions get their real height.
- index.html: script.js?v=32

## 4. Negative marking (-0.25) + Timer, both switchable by the student
- NEW public/examsettings.js: bar under the paper header with "Negative marking" and "Timer" switches (saved in the browser),
  timer minutes (default 1.2 min per question, editable), start/pause, restart, live score and a "Result" button.
- Score = correct x 1 - wrong x 0.25 (cancelled / unattempted = 0). Shown in the bar, Quiz score bar, floating stats and Paper Mode.
- Timer: remaining time is kept per paper (reload safe), pauses when the paper is left, "Time up" opens the result window. Answers are not locked.
- Only calculation: answers / progress saved in the database are unchanged.
- index.html: script.js?v=33, paper.js?v=13, examsettings.js?v=1

## 5. Palette click did nothing (fix)
- The app scrolls inside `.view-section` / `.questions-list` (body is overflow:hidden), NOT in the window, so `window.scrollTo` did nothing.
  `jumpToFullQuestion`, the "stay at the same question" anchor in `renderFullPaper` and `refreshFullQuestion` now scroll the nearest
  scrollable parent of the question (`getScroller`). index.html: script.js?v=34

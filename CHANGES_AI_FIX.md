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

## Update 4: instant subscription/admin updates + login fix
- Instant account sync (no logout/login): utils/userEvents.js (new), GET /api/auth/events (SSE push), GET /api/auth/me (fresh DB data),
  admin_bot.js notifies the user after give premium / revoke / make admin / remove admin, public/accountsync.js (new) shows the
  welcome / revoked / admin message, updates the profile and refreshes the screen. Fallback: polls /me every 15 s + on tab focus.
  Revoke while a paid paper is open -> user is moved back to the dashboard immediately.
- Login (routes/auth.js): no longer takes "the first matching user". All candidate accounts are collected and ranked (exact email
  first, gmail-alias second); the first whose password matches signs in. So two users with the SAME password, or an old account +
  a gmail-alias account, no longer clash. Also tries password with/without trailing space + unicode NFC, case-insensitive email
  fallback for old accounts, and accepts + upgrades very old plain-text passwords. Failure reason is written to the server log only.
- index.html: autocapitalize/autocorrect off on email + password fields (mobile keyboards were changing what users typed).

## Update 5: payments (website purchase -> instant access, and safer)
- NEW utils/payments.js + models/Payment.js: one function applyPayment() used by BOTH the browser verify and the Razorpay webhook.
  Each paymentId applies exactly once (unique index + atomic claim), so replays / retries / verify+webhook race can't extend or reset access.
- verify-payment: plan and owner are read from the Razorpay ORDER (server side), not from the browser (before: a Rs.50 order could be
  verified as the 2-year plan). Paid amount must equal the plan price. Signature compared in constant time.
- webhook: fixed - it handled '1_day' (no such plan) so a '1_month' payment set expiry = NOW and could cancel the access right after
  it was given. It also read userId/planId from the payment (empty for order payments); now it reads them from the order.
  It no longer has a default secret: without RAZORPAY_WEBHOOK_SECRET it rejects every call (503).
- Renewal keeps the days still left. Verify response now includes isAdmin / hasUsedFreeTrial.
- After payment the user is also notified through the live channel (Welcome message without reload on other tabs/devices).

## Update 6: AI fix retries + webhook optional
- aiService.js: the layout guard no longer counts the answer-option lines that old DB texts contain ("(1) ...", "(2) ...").
  This was the cause of "layout lost (old text had 10 lines, new has 6)" and the endless retries.
- Rejected answers now tell the AI the exact reason on the next attempt (blind retries repeated the same mistake).
- Option text that drifted from the paper reading (e.g. English text in the Marathi list) is repaired from the paper reading instead of rejected.
- Attempts per pass 10 -> 6, verification rounds 3 -> 2 (fewer wasted API calls).
- jobManager.js: atomic updateOne instead of question.save() (fixes "No matching document found ... version" VersionError).
- Payment webhook is optional: without RAZORPAY_WEBHOOK_SECRET it just answers 200 and does nothing. Browser verification still activates the plan.

## Update 7: deeper explanations
- Prompt: new DEPTH TARGET rule (background, chronology, facts behind every statement and option, parent topic, confusion points; 8-15 pointers for rich topics).
- New deepening pass (after answer/order/format are verified): if the explanation has fewer than 12 pointers or is short, the AI extends it with
  more certain facts. The old points are kept; accepted only if clearly deeper (+2 pointers, +20% length), no year/number dropped, answer unchanged.
  If the AI finds a mistake in the old explanation it is only reported in the log. On any failure the verified explanation is kept (never fails the fix).

## Update 8: exam groups (dashboard tabs) + hide exams
- NEW models/ExamGroup.js, models/ExamHidden.js, utils/examCatalog.js (+ broadcast() in utils/userEvents.js)
- routes/api.js: /exams/hierarchy returns {data, groups}; hidden papers removed for students (admins get them flagged `hidden`),
  passage count ignores hidden papers. /questions: hidden paper -> EXAM_HIDDEN for students, subject-wise never includes hidden papers,
  new optional body.year_exams = only the papers of the selected tab/group. Free-trial papers = 2 newest VISIBLE papers (server + dashboard).
  /question-chat and /questions/siblings also respect hidden papers.
  Admin: POST /admin/exams/visibility, POST/PUT/DELETE /admin/exam-groups. Every change is pushed live to online students ("catalog" event).
- Frontend: dashboard tabs = All / Prelims / Mains + one tab per group, in BOTH Exam-Wise and Subject-Wise. Subject-Wise inside a group shows
  only that group's subjects and opens only that group's questions; "All Exams" = every visible paper.
  Admin: "Manage Exams" button (public/examadmin.js): create / rename / delete groups, tick papers -> add/remove to group, hide/show.
  Hidden papers show dimmed with a Show/Hide button for admins. Students inside a paper that gets hidden are moved back to the dashboard.

## Update 9: "Fix Complete Paper" range
- public/script.js: the Fix button opens a dialog: "From the start" (everything shown) or "Choose range" = from question no. A to B
  (both included, empty "To" = up to the end), with a live count. In a subject-wise list that mixes several papers the numbers are positions in the list.

## Update 10: why one question took 20+ AI calls (verification redesign)
Cause (seen in the Q2 seating-puzzle log):
1. A verifier disagreement was thrown INSIDE the verifier call, so the same verifier prompt was repeated 4 times (same opinion each time), then the whole solve+verify round was repeated.
2. The verifier JSON had "answer" BEFORE "reason": the model committed to an answer first (its own working ended with E = option 1, but it still wrote answer 2).
3. Logic puzzles were solved by the small "lite" model, and the first pass sometimes answered without solving (earlier hint also limited thought_process to 600 characters).
Fix (utils/aiService.js):
- The verifier is asked ONCE per round. If it disagrees, a tie-breaker (strongest model) is asked; 2 of 3 agreeing = accepted. If all differ, the next round re-solves with the verifiers' reasoning as a hint.
- Verifier JSON now has "working" BEFORE "answer".
- Reasoning / maths / seating questions (needsStrongModel) use non-"lite" models for solve, verify and deepen, and must show step-by-step working in thought_process.
- Typical cost: 2-3 calls (+1 deepen) instead of 20+. Worst case (permanent disagreement): 6 calls, then "Not updated" - nothing is saved.

## Update 11: blind verification (stop the AI copy-pasting what it is shown)
Problem: Gemini copies whatever data it is handed (right or wrong).
- Pass 1 (when the paper image exists): the old question text and old options are NOT sent any more, only the question number and the first ~70 characters
  (just to find the question in the image). The AI must read question + options from the image itself.
- Verifier (when the image exists) is BLIND: it gets no question text, no options and no answer from pass 1. It reads the printed options from the image
  and solves the question itself. The CODE then compares: (1) its options vs the fixed options, same order, same count; (2) its answer vs the first answer.
  Disagreement -> tie-breaker (2 of 3), otherwise a re-solve.
- Without an image there is nothing to read from, so the old options/text are used as before.
- A different explanation never fails a fix: only options (order + content) and the answer are verified. The explanation deepening step stays optional.

## Update 12: option comparison ignores cosmetic differences
Option comparison between the first pass and the blind verifier (utils/aiService.js: matchScore + optionsProblem) now accepts:
extra spaces, capital letters, punctuation / symbols, option labels ("2.", "(2)", "B)") and one or a few extra words
("president" = "president is" = "the president of India" = "2. president."), also for short options ("E" = "E is", "5" = "5 years").
Still rejected: a different option, a wrong option count, two options swapped, and numbers that differ ("20" vs "2019").
So a cosmetic difference never causes a retry.

## Update 13: server disk cache (less DB / Telegram / bandwidth, faster pages)
NEW utils/dataCache.js, utils/imageStore.js, models/AppSetting.js, public/cacheadmin.js
- Question data: one gzip file per exam in os.tmpdir()/mpscpyq_data + small RAM layer. /api/questions is answered from it with a PRE-GZIPPED response
  (little CPU, little bandwidth). 10 students opening the same exam = 1 database read (even after a restart: read from disk, zero DB reads).
  Loaded in the background at startup (WARM_DATA_ON_START=0 turns that off) so the first student is fast too.
  Freshness: max 1 cheap DB probe per minute (document count). Exams whose count changed (new exam / questions added by add_exam.py) are dropped
  and the exam list refreshes automatically. AI fixes, /admin/clear-cache and the admin buttons invalidate at once. Safety TTL: DATA_CACHE_TTL_HOURS (default 6)
  for edits that do not change the count.
- Images: downloaded from Telegram ONCE, then served from disk (browser keeps them 30 days). Simultaneous requests for a new image = 1 Telegram download.
  Atomic writes (no half-downloaded file can be served). 429 from Telegram is waited out and retried. Size limit (IMAGE_CACHE_MAX_MB, default 900; changeable
  in the admin screen, saved in the database); least-recently-used images are deleted when full.
- Admin "💾 Server Cache" button (dashboard header): images cached / total / remaining, disk used vs limit, server free space, data cached per exam,
  requests saved, per-exam table; actions: cache images of ONE exam or ALL exams (background job with progress + Stop), clear one exam / all images,
  reduce to N MB, set size limit, load ALL exams' data to disk, re-read from database, clear data cache.
- Endpoints (admin only): GET /admin/cache/status, GET /admin/cache/job, POST /admin/cache/images/{precache,stop,clear,trim}, /admin/cache/settings,
  /admin/cache/data/{warm,clear}
- NOTE: os.tmpdir() is wiped when the container is redeployed; the cache is simply rebuilt (data) / re-downloaded (images) on demand.

## Update 14: set / add page images per question + wider AI chat
Images (admin, "🖼 Set Image" button on every question; students see the result at once):
- Use as MAIN image: e.g. Q1 is printed on page 2 but its image is the blank page 1 -> give Q1 the image of Q2 (page 2). Paper mode then shows Q1 together with Q2
  on that page. The first original image is remembered (original_image_backup) so "Reset" restores it.
- + Extra image: a question that continues on another page gets more page images (extra_images, max 5). View Original Image shows all pages with ◀ ▶;
  Paper mode gets a "🖼 1/2" switch.
- Source: tap a page of the same paper (thumbnails grouped by image, with the question numbers on it) or type exam + question number (ANY question, also from another exam).
- AI Fix and Ask AI now read ALL page images of the question (solver, blind verifier, chat).
- Server: POST /api/admin/question-image {questionId, action: use|add|removeExtra|reset, sourceQuestionId | sourceExam+sourceQnum, index}; the exam's disk data cache
  is invalidated; admin cache numbers count extra images too.
Ask AI (utils/aiService.js buildChatSystemPrompt): the question is only the STARTING POINT. It now answers other items of the same category
(other minerals / organizations / rivers / schemes ...), their latest position for current affairs, comparisons and extra exam-relevant facts. It refuses only
clearly unrelated requests (chit-chat, coding, personal advice, other subjects, attempts to change its rules). Reply limit raised to 2500 tokens.
- (Update 14b) "✕ Remove" on the MAIN image too: the first extra page (if any) becomes the main image, otherwise the question has no image. "Reset" brings the original back.

## Update 15: fix failed after an image change (log analysis)
Cause: after the image change the page image shows SEVERAL questions. The blind verifier answered with a JSON ARRAY (one object per question) and the code only
accepted a single object -> "Verifier did not return the printed options" 3x -> round lost. In round 1 the verifier hit truncated output + 503s and also lost the round.
Fix (utils/aiService.js):
- An array answer is accepted: the object whose printed options match OUR question is used (the prompt also asks for ONE object, working < 1500 characters).
- 503 / 429 no longer use up the attempts (up to 12 "busy" waits with a short pause), they only mean the service is busy.
- If only the VERIFIER cannot run (busy / unusable output), the good solver result is kept and only the verification is repeated in the next round
  (the solver is not run again).

## Update 16: no blank page after Back, smooth + light on slow internet
Blank after "Back": the app had no browser-history entries for its screens, so the phone's Back button left the page / showed an empty shell and only a refresh helped.
Fix (public/script.js):
- History: an entry is pushed when an exam opens, Back (button or phone gesture) returns to the dashboard INSIDE the app. pageshow / visibilitychange / popstate
  run a self-repair: if no screen is visible, or the dashboard grid is empty, it is restored and reloaded by itself (no refresh needed).
- Exam screen opens at once with a light skeleton; the full-screen "Loading Exam Paper" overlay is gone (the small loader is now a tiny non-blocking pill).
  Back works while loading (the request is cancelled, a late answer is ignored).
- Questions of an exam are saved on the phone (IndexedDB, per user, 24 exams). Re-opening shows them instantly; the server copy is fetched in the background and
  only replaces them if something changed (e.g. an AI fix). Saved copies are used only for paid users / admins and are wiped on logout; the server still checks access.
- Finger-down (or mouse-over) on an exam / subject card already starts downloading its questions; opening then reuses it.
- Dashboard: shows the saved list from the last visit instantly, never empties the grid while loading (skeleton cards only on the very first visit), loads the exam list
  and the progress numbers in parallel (list is painted first). Several callers share one request.
- Nothing of an exam is loaded until the student opens it (only the exam list is loaded at start).
- Static files: scripts/styles versioned with ?v= are cached by the phone for 30 days (server.js); nginx gzips text files (nginx.conf).

## Update 8: SHORT, exam-focused explanations (replaces "deeper explanations" of Update 7)
- Prompt (`utils/aiService.js`): the long "cover everything / 8-15 pointers / no limit" rules are replaced by the new short-explanation rules:
  - Length: max 3-4 short lines to read (30-45 seconds) + ONE last line `वहीत नोंद:` with keywords only (notebook).
  - Structure (4 pillars, each on its own line): `कारण:` / `पर्याय:` / `जोडीदार फॅक्ट:` / `सापळा:`.
  - Only facts and figures (names, articles, dates, numbers, formulas); no stories or long history; maths/reasoning = short trick/formula only.
  - `fixed_options_explanation`: one short line (~20 words) per option.
- The deepening pass (Update 7) is switched OFF. Set env `AI_DEEPEN_EXPLANATION=1` to bring it back (not recommended).
- `normalizeExplanation()` also puts the labels पर्याय / जोडीदार फॅक्ट / सापळा / वहीत नोंद on their own line if the AI returns everything in one line.
- `add_exam.py` (new exam import) uses the same short format instead of "at least 300 words".
- Existing questions in the database keep their old long explanations until they are fixed again with the AI.

## Update 9: smart key/model cooldown (no more repeated 429 / 502 requests)
Problem: after an error the same key+model was tried again after only a few seconds (502 had no pause at all), so almost every question wasted requests.
- `utils/aiService.js`: a failed key/model now RESTS (the unused `cooldownUntil` field is used) and the selector skips it until it is ready; work flows through the other keys/models meanwhile.
  - 429: only that key+model rests. Wait = Google's own "retry in Ns" hint; if the body says "PerDay" it rests until the daily reset (Pacific midnight); otherwise 65s, doubling on repeated 429 (max 15 min).
  - 500 / 502 / 503 / 504: the MODEL rests for all keys, 6-8s doubling up to 2 min.
  - Network errors (reset / timeout / DNS): that key+model rests 5s doubling up to 60s (they no longer count as a "wrong answer").
  - 401 / 403: key+model rests 30 min. "API key not valid": the key is disabled until restart.
  - The error body is now read fully (4000 chars) so the retry hint is found. A success clears the back-off.
  - If every key/model is resting longer than `AI_MAX_COOLDOWN_WAIT_MS` (default 180000 = 3 min) NO request is sent; an error with `aiResting = true` is thrown instead.
  - The strong-model preference falls back to the other models when all strong ones rest > 60s. The question chat uses the same logic.
- `utils/jobManager.js`: on that error, a rest <= 10 min -> the job waits and retries the SAME question automatically; a longer rest (daily quota finished) -> the job stops, the current question is marked failed (retry button), the others stay pending.
- Limits you set (`GEMINI_MODELS` rpm, `rpmDelayMs`) are unchanged and still respected.

## Update 10: copy allowed ONLY inside explanations
- Before: the whole site blocked selecting, right-click and Ctrl+C, so even explanations could not be copied.
- `public/script.js`: select / right-click / copy now work ONLY inside an opened explanation (`.explanation` in quiz + full view, `.pm-expl` in paper mode).
  A copy is cancelled (clipboard stays empty) if the selection touches anything outside one explanation (question, options, answers, other page parts, Ctrl+A).
  Still blocked: F12, Ctrl+Shift+I/J/C, Ctrl+U and the DevTools detector.
- A "📋 Copy" button is added inside every explanation (also after it is re-rendered): it copies the COMPLETE explanation + option-wise breakdown as plain text.
- `public/style.css`: `user-select: text` only for `.explanation` / `.pm-expl`, plus the button style. `public/index.html`: cache version bumped (script.js?v=22, style.css?v=12).
- Explanations are visible only after the student answers (or the admin opens them), so unanswered questions stay protected.

## Update 11: Notes
- New `public/notes.js` (+ styles in `style.css`, script tag in `index.html`).
- Dashboard header: new **📝 Notes** button (with a small counter) opens the Notes panel (right side drawer, full width on phones).
- Under every explanation (quiz, full paper, paper mode) the buttons are now: **📋 Copy**, **📝 Add to Notes**, **📂 Notes**.
  "Add to Notes" adds the part you selected inside that explanation, or the whole explanation when nothing is selected; the question number is saved as a small tag.
- Panel: small paste box - every paste is added at once as a new note at the END, so notes stay in the order you added them (typing + Add / Enter also works).
  Compact list (small font) with move up / down and delete per note, plus Copy all, download .txt and Clear.
- Notes are shown with textContent only (no HTML injection). (Storage: see Update 12 - they are now saved on the server.)
- Selecting/copying is also allowed inside the Notes panel (it only holds the student's own notes); questions/options/answers stay protected.
- `public/paper.js`: keyboard shortcuts (A-F answers, arrows, +/-, Esc) are ignored while typing in the Notes panel or any text box.

## Update 12: Notes are saved on the SERVER
- New `models/UserNotes.js` (one document per user, notes in the order added), `utils/notesService.js` (validation: id, max 4000 chars, max 500 notes) and routes in `routes/api.js`
  (all need login, rate limited 120/min, a user can only touch his own notes):
  `GET /api/notes`, `POST /api/notes/add` (idempotent - the same id is never stored twice, so retries are safe), `DELETE /api/notes/:id`, `POST /api/notes/reorder`, `POST /api/notes/clear`.
- `public/notes.js`: every change is shown at once, saved in the browser and sent to the server. If the internet/server is down the change waits in a small queue and is sent automatically later
  (panel shows "☁ saved" / "⏳ saving" / "⚠ offline - will sync"). The server copy is loaded on page open, on opening Notes, when the tab is used again and when the internet returns,
  so the notes appear after every login on any device. Notes that an older version saved only in the browser are uploaded once.
- Logout removes the local copy of the notes (kept on the server; changes still waiting to be sent are kept).
- Cache versions: script.js?v=24, notes.js?v=2.

## Update 13: option explanations = useful facts, not "wrong / not related"
- `fixed_options_explanation` (and `options_explanation` in `add_exam.py`): each option now gets ONE short line (15-25 words) saying what the option IS and its key exam fact
  (full form, year, founder, headquarters, purpose; for statement combinations the real fact of each statement).
- Forbidden wording: "not the correct answer", "incorrect", "not related to this question/scheme". The "पर्याय:" pillar of the main explanation follows the same rule.
- Applies to questions fixed / imported from now on; old saved option explanations stay until fixed again.

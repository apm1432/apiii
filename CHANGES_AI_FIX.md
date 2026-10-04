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

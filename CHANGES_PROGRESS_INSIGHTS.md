# Progress / Insights (📊 Progress button on the dashboard)

NEW files: models/AttemptLog.js, models/RevisionState.js, models/InsightReport.js, utils/examMeta.js, utils/insights.js,
utils/coachAI.js, routes/insights.js, public/insights.js, tests/*.test.js
CHANGED: routes/api.js (answers now carry `at` + one AttemptLog row per answer; exports freeExamIds), server.js (mount /api/insights),
public/index.html (Progress button + script tag).  Nothing else in the exam / progress flow is changed.

Without AI (exact, instant): Overall, Exam-wise, Wrong Qs, Revision (Leitner 1/3/7/16/35 days), PYQ Trend (group / stage filter)
With AI: AI Coach report (cached, max 4 / day) + chat. The AI only reads numbers computed by the server; it uses the providers
configured in "AI Settings" (chat scope). No new env variables.

Tests (no database needed):  node tests/insights.test.js && node tests/insights.routes.test.js
UI test (needs `npm i --no-save jsdom`):  node tests/insights.ui.test.js

Limits: answers given BEFORE this update have no date (they count in all totals, but not in the daily graph / streak).
Topic numbers are only as good as the subject/topic tags on the questions (the Progress screen shows the % of untagged questions).

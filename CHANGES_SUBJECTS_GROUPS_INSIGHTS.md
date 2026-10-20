# Subjects normalised + exam-group scope + full study tracking for AI

## 1. One name for one subject (no more "Economics" / "Economics (अर्थशास्त्र)" / "अर्थशास्त्र")
NEW: utils/subjects.js, models/SubjectAlias.js, public/subjectadmin.js (admin button "🔗 Subjects"), tests/subjects*.test.js
Names are mapped while READING - questions in the database are never rewritten, so every merge can be undone.
1. Same name: case, spaces, punctuation do not matter.
2. Learned from the data: "Economics (अर्थशास्त्र)" says Economics = अर्थशास्त्र, so plain "Economics" and plain "अर्थशास्त्र" join it (only an English + Marathi bracket pair counts; "History (Ancient)" is NOT merged).
3. Admin merge for the rest (e.g. "Indian Polity" = "Polity"), with "💡 Maybe the same" hints, rename, and split.
The shown name = admin's name, else the spelling with most questions. Applied in: Progress (all tabs + AI), dashboard Subject-Wise cards, opening a subject / in-test subject chips, admin download, new imports.
A new spelling that appears later is joined automatically if it matches rule 1/2.

## 2. Groups = YOUR exam groups (nothing hard-coded)
Removed: Pre / Mains / Group A-B-C guessing from paper names (only the YEAR is still read from the name).
Progress has a scope bar: सर्व + every group you made in Manage Exams. It starts on the dashboard tab you are on (group tab -> that group, All Exams -> all) and limits every tab, the PYQ trend, revision and the AI. A report is saved per group.

## 3. Study tracking + AI gets everything
- Study history from the AttemptLog: estimated study time (gap between answers, labelled as estimate), sittings, active days, streak, best hours, first-try accuracy, mistakes fixed / still wrong / repeated, revision accuracy.
- Old dated answers missing from the log are copied into it once (history complete). Answers that never had a date are counted in totals and listed as "without date".
- New tab 🧩 Topic-wise: every subject -> every topic -> sub-topics, search / sort / level filter. Group-wise summary in Overall.
- AI digest now contains: totals, lifetime, study time, 60-day daily log, weekday/hours, learning, revision, ALL subjects, ALL attempted topics (compact table with time + starred), weak sub-topics, not-started topics, per-group summary, all attempted papers, PYQ trend, 60 wrong-question samples, starred, notes, data-quality. If a student is so active that it exceeds ~60k characters the least urgent topic rows are dropped AND the AI is told how many.
- AI tab: "👁 AI ला गेलेला data" shows / downloads exactly what the AI received.
- AI report has a new "study habits" section.

Tests: node tests/subjects.test.js && node tests/insights.test.js && node tests/insights.routes.test.js && node tests/subjects.routes.test.js
UI test: npm i --no-save jsdom && node tests/insights.ui.test.js
Notes: topic names are still matched by exact text (case-insensitive); the same merge idea can be added for topics later. Hidden papers / free-trial rules are unchanged.

## 4. Last attempted test
Overall shows "🕘 शेवटचे attempt केलेले tests" (latest first, date + how many days ago, answers, accuracy, last subject/topic, Open button). Exam-wise tab shows the last-attempt date on every paper and can sort "शेवटचा attempt आधी". The AI digest has `lastAttemptedTest` and `recentTests`. All follow the selected group.

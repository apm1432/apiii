# Answer key: "🔁 Re-scan by AI" button

Where: Official Answer Key → step 2 (Verification result) and next to the "⚠ N answer(s) were not confirmed by both readings" warning.

What it does
- Downloads the SAVED key page images from Telegram, reads them again with the AI (the second, different prompt - not the one used
  the first time) and merges the new reading into the result by voting.
- An unverified answer becomes **verified** as soon as two readings agree (pass 1 / pass 2 / AI re-scan). Example: only pass 2 (AI) read
  "Q84 = 3", the re-scan also reads 3 -> verified, the set count goes up and the compare % is calculated.
- A conflict (pass 1 != pass 2) is resolved when the re-scan sides with one of them. Disagreement stays in the list with an extra
  "AI re-scan" column so you can see all readings next to the page link.
- Already verified answers are NEVER changed (a different re-scan value is only counted: "N differ from verified (kept)").
- Questions that no earlier pass read are added as single-source (accept them with the checkbox, or choose them yourself).
- Can be pressed again; every press adds one more AI reading to the vote.
- Progress is shown live; your selected set / exam / manual choices are kept after the re-scan.

Files: `utils/answerKeyService.js` (downloadRef, mergeRescan, recomputePerSet, rescanByAi), `routes/answerkey.js`
(`POST /api/admin/answer-key/:id/rescan`, status in `GET /:id` -> `key.rescan`), `models/AnswerKey.js` (`rescan`),
`public/answerkeyadmin.js` (button + column), `public/index.html` (script ?v=4).
Needs an AI provider (AI Settings → Fix list or GEMINI_API_KEYS) and the Telegram bot env that the upload already uses.

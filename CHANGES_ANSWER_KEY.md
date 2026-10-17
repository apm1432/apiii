# Official Answer Key (admin) — PDF → verified answers → questions

Admin ला official answer key चा PDF upload करता येतो. Server तो PDF **दोनदा independently वाचतो**, सर्व sets चे answers
काढतो, PDF चे pages Telegram var upload करतो (message id सकट save), आणि admin ने exam + set निवडल्यावर
**final answers vs official key चा match %** दाखवतो. **Save** दाबल्यावर त्या exam च्या सर्व questions मध्ये official answer आणि
key page चा image update होतो.

## Flow
1. Dashboard (admin) → **📋 Official Answer Key** → exam निवडा → PDF निवडा → **Upload & verify**.
2. Server (background job, UI progress दाखवतो):
   - pages → JPEG (130 dpi), `pdftoppm`
   - **Pass 1:** `pdftotext -layout` + parser (table `Set A | Set B…` आणि `Set A: 1-B 2-C…` दोन्ही formats)
   - **Pass 2:** Gemini vision (page images) — Gemini key नसेल तर `pdftotext -raw` वेगळ्या reading order ने
   - answer **verified** तेव्हाच जेव्हा दोन्ही passes ने same value वाचली. वेगळी value = *conflict*, एकाच pass ने सापडली = *single-source*.
   - सर्व page images (आणि original PDF) Telegram channel वर upload → `{botIdx: fileId}` + `message_id` DB (`AnswerKey`) मध्ये save.
3. Admin: **Set** (A/B/C/D) आणि exam निवडतो → **match %**, किती same/different, आणि वेगळे questions ची list.
   Unverified answers असतील तर page बघून admin ते निवडतो (conflict निवडल्याशिवाय Save होत नाही).
4. **💾 Save to all questions** → प्रत्येक question मध्ये:
   `official_answer_key_answers`, `official_answer_key`, `answer_key_image_url`, `answer_key_images` (त्या answer चे page चा image),
   `official_answer_key_msg_id`, `official_answer_key_set`. `correct_answer_option` (final answer) **बदलत नाही**.
   Exam cache invalidate होतो, म्हणजे students ला लगेच दिसतं (existing "📋 View Official Answer Key" button).

## Supported key formats
- **Header नसलेला table** (खरी MPSC key, उदा. "Final key … Paper No. 01"): `1 3 4 3 1   26 4 1 1 2` = प्रश्न क्र. + 4 answers (दोन blocks एका line वर).
  Set letters छापलेली नसतात, म्हणून 4 columns = **Set A, B, C, D** (छापलेल्या क्रमाने) — UI मध्ये तसा इशारा दाखवतो. `#` = प्रश्न रद्द.
- `Set A | Set B | Set C | Set D` header असलेला table.
- `Set A:` section मध्ये `1-B 2-C …` pairs.

## Files
| File | |
|---|---|
| `models/AnswerKey.js` | नवीन — upload record (sets, pages, verification, Telegram refs + message ids) |
| `utils/answerKeyService.js` | नवीन — parser, 2-pass verify, page render, Telegram upload, % compare |
| `routes/answerkey.js` | नवीन — `/api/admin/answer-key/*` (admin only) |
| `public/answerkeyadmin.js` | नवीन — admin modal |
| `server.js` | route mount |
| `models/Question.js` | `official_answer_key_msg_id`, `official_answer_key_set` fields |
| `utils/aiService.js` | `chatViaGemini` export (vision pass साठी) |
| `Dockerfile` | `poppler-utils` (pdftotext / pdftoppm / pdfinfo) — **image rebuild लागेल** |
| `nginx.conf` | `/api/admin/answer-key/upload` ला 30 MB body limit (नाहीतर HTTP 413) |
| `public/index.html`, `public/examadmin.js` | admin button + script |

## Env
`TELEGRAM_BOT_TOKENS`, `TELEGRAM_CHANNEL_ID` (आधीच आहेत). `GEMINI_API_KEYS` optional (pass 2 AI vision / scanned PDF).

## Limits
PDF ≤ 25 MB, ≤ 40 pages. Scanned PDF (text layer नाही) → Gemini key आवश्यक (दोन AI reads).
Question जुळवणी `qnum` ने होते.

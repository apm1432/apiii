# Official Answer Key → FINAL answer (replace + per-question change)

## काय नवीन आहे
1. **Save करताना option**: Official Answer Key → step 3 मध्ये नवीन checkbox
   **"Also replace the site's FINAL answers with the official key"**. टिक केल्यास *Save to all questions* दाबल्यावर ज्या questions ला
   official answer आहे त्यांचं `correct_answer_option` (final answer) official key नुसार बदलतं. ज्यांना official answer नाही त्यांना काहीच होत नाही.
2. **नवीन route** `POST /api/admin/answer-key/apply-final`
   - `{ examId, mode: 'official-all' }` → exam मध्ये आधीच save झालेल्या official answers नुसार सर्व final answers replace
     (UI button: **🔁 Replace final answers with the saved official key**).
   - `{ examId, mode: 'choices', choices: { questionId: '1'|'2'|'3'|'4'|'#' } }` → admin ने निवडलेले final answers.
3. **Compare list (चुकीचे questions)**: official key आणि site final वेगळे असलेल्या प्रत्येक question साठी card:
   question चा image (क्लिक = मोठा), Site final / Official key / AI answer, आणि **"Final answer to store"** dropdown
   (Keep site's final / 1 / 2 / 3 / 4 / #; default = official key). Buttons: *Set all below to official key*, *Keep all site finals*,
   **✅ Apply final answers below (N)**.
4. **↩ Undo final answer changes** → या tool ने बदललेले final answers पहिल्या बदलाआधीच्या value ला परत जातात.

## नियम / काळजी
- `1/3` सारखं (एकापेक्षा जास्त accepted) official answer आपोआप replace होत नाही (site एकच option मानते) — list मध्ये तुम्ही एक निवडा.
  `#` (रद्द) final म्हणून set होऊ शकतं.
- बदललेल्या question ला जुना final `ai_answer_option` मध्ये (रिकामं असल्यास) ठेवला जातो, त्यामुळे explanation "Option X साठी लिहिलेली असू शकते"
  ही ओळ students ना दिसते. Explanation आपोआप पुन्हा लिहिली जात नाही.
- **Students चे scores आपोआप नवीन final answer नुसार होतात**: final answer बदलताच (Save+replace, Apply, Replace all, Undo) ज्या students नी ते question सोडवलं होतं त्यांचं correct/wrong, totalCorrect आणि section-wise count पुन्हा ठरवलं जातं (`utils/progressSync.js`, atomic). 20 सेकंदात न संपल्यास background मध्ये चालू राहतं. जुन्या बदलांसाठी बटण: **🔄 Recalculate student scores** (`POST /recalc-students`). Starred attempt चे निकाल आधीपासून current key नुसारच दाखवले जातात.
- Exam cache invalidate होतो, म्हणजे students ना नवीन final answer लगेच दिसतं.

## Changed files
`models/Question.js` (final_answer_prev, final_answer_prev_source, final_answer_changed_at), `routes/answerkey.js`, `public/answerkeyadmin.js`, `public/index.html` (script ?v=5)

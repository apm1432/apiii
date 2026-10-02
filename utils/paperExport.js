// Builds a plain-text (.txt) copy of an exam paper: Marathi + English question and options,
// optionally with the correct answer and the explanations.

const LINE = '='.repeat(70);
const THIN = '-'.repeat(70);

const MODES = ['questions', 'answers', 'full'];

function clean(v) {
    if (v === undefined || v === null) return '';
    const s = String(v).replace(/\r\n/g, '\n').trim();
    return (s === 'null' || s === 'undefined') ? '' : s;
}

// Remove a leading "(1)" / "1." / "१)" that some stored options already have
function stripOptionPrefix(s) {
    return clean(s).replace(/^\s*(\(\s*[0-9०-९]\s*\)|[0-9०-९]\s*[.)])\s*/, '');
}

function indent(text, pad) {
    return clean(text).split('\n').map(l => pad + l).join('\n');
}

function answerIndex(q) {
    const raw = clean(q.correct_answer_option || q.final_answer_key);
    const m = raw.match(/[1-4]/);
    return m ? parseInt(m[0], 10) - 1 : -1;
}

const MODE_LABEL = {
    questions: 'Questions only',
    answers: 'Questions + Answers',
    full: 'Questions + Answers + Explanations'
};

// Appends every question of ONE paper to `out`
function renderQuestions(out, questions, mode) {
    const withAnswers = mode === 'answers' || mode === 'full';
    const withExplanations = mode === 'full';

    let lastPassage = '';
    questions.forEach((q, i) => {
        const num = q.qnum || (i + 1);

        // Passage (print once for consecutive questions sharing it)
        const pMr = clean(q.passage_marathi) || clean(q.passage_text);
        const pEn = clean(q.passage_english);
        const passageKey = pMr + '||' + pEn;
        if ((pMr || pEn) && passageKey !== lastPassage) {
            out.push('[PASSAGE]');
            if (pMr) out.push(pMr);
            if (pEn) { if (pMr) out.push(''); out.push(pEn); }
            out.push('');
            lastPassage = passageKey;
        }

        out.push(THIN);
        out.push(`Q${num}.`);
        const tMr = clean(q.text), tEn = clean(q.text_eng);
        if (tMr) out.push(tMr);
        if (tEn) { if (tMr) out.push(''); out.push(tEn); }
        if (clean(q.diagram_description) && q.has_diagram_or_passage) {
            out.push('');
            out.push(`[Diagram: ${clean(q.diagram_description)}]`);
        }
        out.push('');

        const mr = (q.options || []).map(stripOptionPrefix);
        const en = (q.options_eng || []).map(stripOptionPrefix);
        const n = Math.max(mr.length, en.length);
        if (n) out.push('Options:');
        for (let k = 0; k < n; k++) {
            const a = mr[k] || '', b = en[k] || '';
            let line = `  (${k + 1}) ${a}`;
            if (a && b && a !== b) line += `  /  ${b}`;
            else if (!a) line = `  (${k + 1}) ${b}`;
            out.push(line);
        }

        if (withAnswers) {
            out.push('');
            const idx = answerIndex(q);
            if (idx >= 0) {
                const a = mr[idx] || '', b = en[idx] || '';
                let txt = `(${idx + 1})`;
                const body = (a && b && a !== b) ? `${a}  /  ${b}` : (a || b);
                if (body) txt += ` ${body}`;
                out.push(`Answer: ${txt}`);
            } else {
                out.push('Answer: Not available');
            }
        }

        if (withExplanations) {
            const exp = clean(q.toppers_explanation_marathi);
            const optExp = (q.options_explanation || []).map(clean).filter(Boolean);
            if (exp) {
                out.push('');
                out.push('Explanation:');
                out.push(indent(exp, '  '));
            }
            if (optExp.length) {
                out.push('');
                out.push('Option-wise explanation:');
                optExp.forEach(e => out.push(indent(e, '  ')));
            }
            if (!exp && !optExp.length) {
                out.push('');
                out.push('Explanation: Not available');
            }
        }
        out.push('');
    });
}

// BOM so Windows Notepad shows Marathi correctly
function finish(out) {
    out.push(LINE);
    out.push('End of paper');
    return '\uFEFF' + out.join('\n') + '\n';
}

// ONE complete paper (questions already sorted by qnum)
function buildPaperText(questions, { title, mode }) {
    if (!MODES.includes(mode)) mode = 'questions';
    const out = [];
    out.push(LINE);
    out.push(clean(title) || 'Question Paper');
    out.push(`Total Questions : ${questions.length}`);
    out.push(`Content         : ${MODE_LABEL[mode]}`);
    out.push(LINE);
    out.push('');
    renderQuestions(out, questions, mode);
    return finish(out);
}

// Year found inside an exam name, e.g. "2018 group b pre" or Marathi digits "२०१८ ..."
function extractYear(str) {
    const map = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };
    const eng = String(str || '').replace(/[०-९]/g, m => map[m]);
    const m = eng.match(/\b(19\d{2}|20\d{2})\b/);
    return m ? parseInt(m[1], 10) : 0;
}

// Groups questions by exam and orders the exams NEWEST -> OLDEST (year in the exam name),
// questions inside each exam by question number.
function groupByExamNewestFirst(questions) {
    const map = new Map();
    for (const q of questions) {
        const key = clean(q.year_exam) || 'Unknown exam';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(q);
    }
    const groups = [...map.entries()].map(([exam, qs]) => ({
        exam,
        year: extractYear(exam),
        questions: qs.sort((a, b) => (a.qnum || 0) - (b.qnum || 0))
    }));
    groups.sort((a, b) => (b.year - a.year) || a.exam.localeCompare(b.exam));
    return groups;
}

// One SUBJECT across ALL exams, year-wise newest -> oldest
function buildSubjectText(questions, { subject, mode }) {
    if (!MODES.includes(mode)) mode = 'questions';
    const groups = groupByExamNewestFirst(questions);

    const out = [];
    out.push(LINE);
    out.push(`Subject : ${clean(subject)}`);
    out.push(`Exams           : ${groups.length}`);
    out.push(`Total Questions : ${questions.length}`);
    out.push('Order           : Year-wise, newest to oldest');
    out.push(`Content         : ${MODE_LABEL[mode]}`);
    out.push(LINE);
    out.push('');
    out.push('INDEX');
    groups.forEach((g, i) => out.push(`  ${i + 1}. ${g.exam}  (${g.questions.length} questions)`));
    out.push('');

    groups.forEach((g, i) => {
        out.push('');
        out.push(LINE);
        out.push(`EXAM ${i + 1}/${groups.length}: ${g.exam}  -  ${clean(subject)}  (${g.questions.length} questions)`);
        out.push(LINE);
        out.push('');
        renderQuestions(out, g.questions, mode);
    });
    return finish(out);
}

module.exports = { buildPaperText, buildSubjectText, groupByExamNewestFirst, extractYear, MODES };

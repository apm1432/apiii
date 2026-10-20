// run: node tests/insights.ui.test.js (needs: npm i --no-save jsdom)   (models are replaced by in-memory fakes, no MongoDB needed)
const assert = require('assert');
const path = require('path');
const R = (p) => require.resolve(path.join('..', p));
const stub = (p, exp) => { require.cache[R(p)] = { id: R(p), filename: R(p), loaded: true, exports: exp }; };
const chain = (v) => { const o = { select: () => o, lean: async () => v, then: (a, b) => Promise.resolve(v).then(a, b) }; return o; };

// ---- fake data: 2 papers, 6 questions
const Q = [];
const mkq = (i, exam, subject, topic, ans) => Q.push({ _id: String(i).padStart(24, '0'), year_exam: exam, subject, topic, text: 'Q' + i, text_eng: 'Question ' + i, options: ['a', 'b', 'c', 'd'], correct_answer_option: String(ans), toppers_explanation_marathi: 'expl' + i });
for (let i = 1; i <= 8; i++) mkq(i, '2018 group b pre', i >= 7 ? 'Polity (राज्यशास्त्र)' : 'Polity', 'Rights', 1);   // two spellings of ONE subject
for (let i = 9; i <= 14; i++) mkq(i, '2023 group c mains', 'History', 'Revolt', 2);
const id = (i) => String(i).padStart(24, '0');
const answers = {};
for (let i = 1; i <= 6; i++) answers[id(i)] = { selected: 3, isCorrect: false, isCancelled: false, section: '2018 group b pre' };   // 6 wrong in Rights
answers[id(7)] = { selected: 0, isCorrect: true, isCancelled: false }; answers[id(9)] = { selected: 1, isCorrect: true, isCancelled: false, at: new Date(Date.now() - 3600000) };   // q9: dated answer that is missing from the log -> backfilled
const states = {}, logs = [];
const GB = 'aaaaaaaaaaaaaaaaaaaaaaaa', GC = 'bbbbbbbbbbbbbbbbbbbbbbbb', GALL = 'cccccccccccccccccccccccc';
for (let i = 1; i <= 7; i++) logs.push({ userId: '507f1f77bcf86cd799439011', qid: id(i), exam: '2018 group b pre', subject: i === 7 ? 'Polity (राज्यशास्त्र)' : 'Polity', topic: 'Rights', isCorrect: i === 7, src: 'exam', at: new Date(Date.now() - 600000 + i * 20000) });

stub('models/User.js', { findById: () => chain({ isAdmin: false, isSubscribed: true, subscriptionExpiry: new Date(Date.now() + 1e9) }) });
stub('models/Progress.js', { findOne: (f) => chain(f[`answers.${id(1)}`] === undefined && Object.keys(f).some(k => k.startsWith('answers.')) ? (answers[Object.keys(f).find(k => k.startsWith('answers.')).slice(8)] ? { answers } : null) : { answers }) });
stub('models/Question.js', {
  find: (f, fields) => chain(Q.filter(q => !f._id || f._id.$in.includes(q._id))),
  findById: (i) => chain(Q.find(q => q._id === i) || null),
  aggregate: async () => { const m = {}; Q.forEach(q => { const k = [q.year_exam, q.subject, q.topic].join('|'); m[k] = m[k] || { _id: { e: q.year_exam, s: q.subject, t: q.topic }, n: 0 }; m[k].n++; }); return Object.values(m); }
});
stub('models/AttemptLog.js', { find: () => { const o = { select: () => o, sort: () => o, limit: () => o, lean: async () => logs.slice().sort((a, b) => +a.at - +b.at), then: (a, b) => o.lean().then(a, b) }; return o; },
  insertMany: async (rows) => { rows.forEach(r => logs.push(r)); return rows; }, create: async (d) => { logs.push(Object.assign({ at: new Date() }, d)); return d; } });
stub('models/SubjectAlias.js', { find: () => chain([]) });
stub('models/UserStars.js', { findOne: () => chain({ ids: [id(1), id(2)], answers: {} }) });
stub('models/UserNotes.js', { findOne: () => chain({ notes: [{ id: 'n1', text: 'Article 21 पुन्हा वाचायचा', src: 'Q1', ts: 1 }] }) });
stub('models/RevisionState.js', {
  find: () => chain(Object.values(states)),
  findOne: (f) => chain(states[f.qid] || null),
  updateOne: async (f, u) => { const s = states[f.qid] || { qid: f.qid, seen: 0 }; Object.assign(s, u.$set); s.seen += (u.$inc || {}).seen || 0; states[f.qid] = s; }
});
let report = null;
stub('models/InsightReport.js', { findOne: () => chain(report), updateOne: async (f, u) => { report = Object.assign({}, report, u.$set); } });
stub('utils/examCatalog.js', { getCatalog: async () => ({ hidden: new Set(), groups: [
  { _id: GB, name: 'MPSC Group B', exams: ['2018 group b pre'] }, { _id: GC, name: 'My Mains Set', exams: ['2023 group c mains'] },
  { _id: GALL, name: 'Everything', exams: ['2018 group b pre', '2023 group c mains', 'deleted paper'] }] }) });
let aiCalls = 0;
stub('utils/coachAI.js', {
  askCoach: async ({ system, message }) => { aiCalls++; assert(system.includes('ONLY the numbers')); assert(message.includes('Polity > Rights') || system.includes('Polity > Rights') || system.includes('"name":"My Mains Set"')); assert(!/Group B|Group C|prelims \+ mains/i.test(system.split('STUDENT RECORD')[0]), 'no hard-coded group names in the coach rules'); return { text: '```json\n{"headline":"ok","summary":"s","strengths":[],"weaknesses":[{"topic":"Polity > Rights","why":"6 wrong","fix":"redo"}],"coverNext":[],"revisionPlan":[],"trendComment":"t","warning":""}\n```', provider: 'fake' }; },
  parseJsonLoose: require('../utils/coachAI').parseJsonLoose
});
stub('middleware/auth.js', { authMiddleware: (req, res, next) => { req.user = { id: '507f1f77bcf86cd799439011' }; next(); } });

const express = require('express');
const app = express(); app.use(express.json()); app.use('/api/insights', require('../routes/insights'));

const { JSDOM } = require('jsdom');
const fs = require('fs');
const srv = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  // make the AI report answerable
  for (let i = 10; i <= 13; i++) answers[id(i)] = { selected: 1, isCorrect: true, isCancelled: false };
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.localStorage.setItem('jwtToken', 't');
  w.fetch = (u, o) => fetch(base + u, o);
  const errors = []; w.addEventListener('error', e => errors.push(e.message));
  w.eval(fs.readFileSync('public/insights.js', 'utf8'));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const text = () => w.document.getElementById('ins-body').textContent;
  try {
    w.currentExamFilter = 'g:' + GB;                          // the student is on the "MPSC Group B" tab of the dashboard
    w.MpscInsights.open(); await sleep(400);
    assert(/MPSC Group B \(1\)/.test(w.document.getElementById('ins-scope').textContent), 'scope bar shows the admin groups');
    assert(w.document.querySelector('#ins-scope .ins-chip.on').textContent.startsWith('MPSC Group B'), 'starts on the dashboard tab');
    assert(/सोडवलेले \/ 8/.test(text()), 'numbers are limited to the group: ' + text().slice(0, 160));
    w.document.querySelector('#ins-scope [data-sc="all"]').click(); await sleep(400);
    assert(/शेवटचे attempt केलेले tests/.test(text()) && /शेवटचा/.test(text()), 'last attempted test is shown');
    assert(/सोडवलेले \/ 14/.test(text()), 'switching to all');
    assert(/Accuracy/.test(text()) && /Rights/.test(text()), 'overall: ' + text().slice(0, 200));
    w.MpscInsights.go('topics'); await sleep(300);
    assert(/Polity/.test(text()) && /Rights/.test(text()) && /Revolt/.test(text()), 'topic-wise lists every subject / topic: ' + text().slice(0, 200));
    assert(!/Group B prelims|Prelims \+ Mains/.test(w.document.body.textContent), 'no hard-coded Pre/Mains buttons');
    for (const t of ['exams', 'wrong', 'trend']) { w.MpscInsights.go(t); await sleep(300); assert(text().length > 50, t + ' empty'); console.log(t, 'ok:', text().replace(/\s+/g, ' ').slice(0, 90)); if (t === 'wrong') assert(/Question \d/.test(text()) && /तुमचं उत्तर/.test(text()), 'wrong list shows questions + my answer'); }
    w.MpscInsights.go('revise'); await sleep(300);
    const opt = w.document.querySelector('#rev-box .ins-opt.pick'); assert(opt, 'revision question shown');
    opt.click(); await sleep(300); assert(w.document.querySelector('#rev-box .ins-opt.right'), 'revision answer marks correct option');
    w.document.querySelector('.ins-mode[data-m="ai"]').click(); await sleep(500);
    assert(/Polity > Rights/.test(text()), 'AI report shown: ' + text().slice(0, 200));
    w.document.getElementById('ai-dg').click(); await sleep(400);
    assert(/studyTime/.test(w.document.querySelector('.ins-pre').textContent), 'the data the AI received can be read');
    assert.deepStrictEqual(errors, []);
    console.log('UI TEST PASSED');
  } catch (e) { console.error('UI FAILED', e); process.exitCode = 1; }
  srv.close();
});

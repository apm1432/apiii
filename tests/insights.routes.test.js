// run: node tests/insights.routes.test.js   (models are replaced by in-memory fakes, no MongoDB needed)
const assert = require('assert');
const path = require('path');
const R = (p) => require.resolve(path.join('..', p));
const stub = (p, exp) => { require.cache[R(p)] = { id: R(p), filename: R(p), loaded: true, exports: exp }; };
const chain = (v) => { const o = { select: () => o, lean: async () => v, then: (a, b) => Promise.resolve(v).then(a, b) }; return o; };

// ---- fake data: 2 papers, 6 questions
const Q = [];
const mkq = (i, exam, subject, topic, ans) => Q.push({ _id: String(i).padStart(24, '0'), year_exam: exam, subject, topic, text: 'Q' + i, text_eng: 'Question ' + i, options: ['a', 'b', 'c', 'd'], correct_answer_option: String(ans), toppers_explanation_marathi: 'expl' + i });
for (let i = 1; i <= 8; i++) mkq(i, '2018 group b pre', 'Polity', 'Rights', 1);
for (let i = 9; i <= 14; i++) mkq(i, '2023 group c mains', 'History', 'Revolt', 2);
const id = (i) => String(i).padStart(24, '0');
const answers = {};
for (let i = 1; i <= 6; i++) answers[id(i)] = { selected: 3, isCorrect: false, isCancelled: false, section: '2018 group b pre' };   // 6 wrong in Rights
answers[id(7)] = { selected: 0, isCorrect: true, isCancelled: false }; answers[id(9)] = { selected: 1, isCorrect: true, isCancelled: false };
const states = {}, logs = [];

stub('models/User.js', { findById: () => chain({ isAdmin: false, isSubscribed: true, subscriptionExpiry: new Date(Date.now() + 1e9) }) });
stub('models/Progress.js', { findOne: (f) => chain(f[`answers.${id(1)}`] === undefined && Object.keys(f).some(k => k.startsWith('answers.')) ? (answers[Object.keys(f).find(k => k.startsWith('answers.')).slice(8)] ? { answers } : null) : { answers }) });
stub('models/Question.js', {
  find: (f, fields) => chain(Q.filter(q => !f._id || f._id.$in.includes(q._id))),
  findById: (i) => chain(Q.find(q => q._id === i) || null),
  aggregate: async () => { const m = {}; Q.forEach(q => { const k = [q.year_exam, q.subject, q.topic].join('|'); m[k] = m[k] || { _id: { e: q.year_exam, s: q.subject, t: q.topic }, n: 0 }; m[k].n++; }); return Object.values(m); }
});
stub('models/AttemptLog.js', { aggregate: async () => [{ _id: new Date().toISOString().slice(0, 10), n: 8, c: 2 }], countDocuments: async () => 8, create: async (d) => { logs.push(d); return d; } });
stub('models/RevisionState.js', {
  find: () => chain(Object.values(states)),
  findOne: (f) => chain(states[f.qid] || null),
  updateOne: async (f, u) => { const s = states[f.qid] || { qid: f.qid, seen: 0 }; Object.assign(s, u.$set); s.seen += (u.$inc || {}).seen || 0; states[f.qid] = s; }
});
let report = null;
stub('models/InsightReport.js', { findOne: () => chain(report), updateOne: async (f, u) => { report = Object.assign({}, report, u.$set); } });
stub('utils/examCatalog.js', { getCatalog: async () => ({ hidden: new Set(), groups: [] }) });
let aiCalls = 0;
stub('utils/coachAI.js', {
  askCoach: async ({ system, message }) => { aiCalls++; assert(system.includes('ONLY the numbers')); assert(message.includes('Polity > Rights') || system.includes('Polity > Rights')); return { text: '```json\n{"headline":"ok","summary":"s","strengths":[],"weaknesses":[{"topic":"Polity > Rights","why":"6 wrong","fix":"redo"}],"coverNext":[],"revisionPlan":[],"trendComment":"t","warning":""}\n```', provider: 'fake' }; },
  parseJsonLoose: require('../utils/coachAI').parseJsonLoose
});
stub('middleware/auth.js', { authMiddleware: (req, res, next) => { req.user = { id: '507f1f77bcf86cd799439011' }; next(); } });

const express = require('express');
const app = express(); app.use(express.json()); app.use('/api/insights', require('../routes/insights'));
const srv = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port + '/api/insights';
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
  try {
    let r = await get('/overview'); assert(r.success, JSON.stringify(r));
    assert.strictEqual(r.data.totals.solved, 8); assert.strictEqual(r.data.totals.wrong, 6); assert.strictEqual(r.data.totals.bank, 14);
    assert.strictEqual(r.data.plan.fix[0].topic, 'Rights'); assert.strictEqual(r.data.exams.length, 2);
    assert.strictEqual(r.data.daily.last7.solved, 8); assert(r.data.hasHistory);

    r = await get('/trend?group=B&stage=prelims'); assert(r.success); assert.strictEqual(r.data.papers, 1); assert.strictEqual(r.data.totalQuestions, 8);
    r = await get('/trend'); assert.strictEqual(r.data.papers, 2); assert.deepStrictEqual(r.data.years, [2018, 2023]);

    r = await get('/wrong?subject=Polity&page=0'); assert.strictEqual(r.data.total, 6); assert.strictEqual(r.data.items[0].correct, 0); assert.strictEqual(r.data.items[0].selected, 3);
    r = await get('/wrong?topic=Nope'); assert.strictEqual(r.data.total, 0);

    // revision: legacy wrong answers (no date) are due now
    r = await get('/revision/queue?limit=3'); assert.strictEqual(r.data.dueNow, 6); assert.strictEqual(r.data.items.length, 3);
    assert(!('correct' in r.data.items[0]) && !('correct_answer_option' in r.data.items[0]), 'queue must not reveal the answer');
    let a = await post('/revision/answer', { questionId: id(1), selectedOption: 0 }); assert(a.success && a.isCorrect && a.state.box === 1 && !a.state.mastered);
    a = await post('/revision/answer', { questionId: id(2), selectedOption: 2 }); assert(a.success && !a.isCorrect && a.state.box === 0);
    r = await get('/revision/queue'); assert.strictEqual(r.data.dueNow, 4, 'q1 (+1 day) and q2 (+6 h) are scheduled for later'); assert.strictEqual(r.data.later, 2);
    a = await post('/revision/answer', { questionId: id(12), selectedOption: 0 }); assert.strictEqual(a.success, false, 'unanswered question must be refused (no answer probing)');
    assert.strictEqual((await post('/revision/answer', { questionId: 'bad', selectedOption: 0 })).success, false);
    for (let k = 0; k < 5; k++) a = await post('/revision/answer', { questionId: id(1), selectedOption: 0 });
    assert(a.state.mastered, 'five right answers in a row = mastered'); r = await get('/revision/queue'); assert.strictEqual(r.data.mastered, 1);
    assert(logs.some(l => l.src === 'revise'));

    // AI report: < 10 answers -> refused WITHOUT calling the AI
    r = await post('/ai/report', {}); assert(r.data.tooFew && aiCalls === 0, JSON.stringify(r));
    for (let i = 10; i <= 13; i++) answers[id(i)] = { selected: 1, isCorrect: true, isCancelled: false };
    r = await post('/ai/report', {}); assert(r.success && r.data.report && r.data.report.weaknesses[0].topic === 'Polity > Rights', JSON.stringify(r)); assert.strictEqual(aiCalls, 1);
    r = await post('/ai/report', {}); assert(r.data.cached && aiCalls === 1, 'same statistics -> saved report, no new AI call');
    r = await post('/ai/report', { refresh: true }); assert(!r.data.cached && aiCalls === 2);
    r = await post('/ai/chat', { message: 'माझा सर्वात कमकुवत भाग?' }); assert(r.success && r.reply.includes('headline')); assert.strictEqual(aiCalls, 3);
    assert.strictEqual((await post('/ai/chat', { message: '   ' })).success, false);
    console.log('ALL ROUTE TESTS PASSED');
  } catch (e) { console.error('FAILED', e); process.exitCode = 1; }
  srv.close();
});

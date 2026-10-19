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
    w.MpscInsights.open(); await sleep(300);
    assert(/Accuracy/.test(text()) && /Rights/.test(text()), 'overall: ' + text().slice(0, 200));
    for (const t of ['exams', 'wrong', 'trend']) { w.MpscInsights.go(t); await sleep(300); assert(text().length > 50, t + ' empty'); console.log(t, 'ok:', text().replace(/\s+/g, ' ').slice(0, 90)); if (t === 'wrong') assert(/Question \d/.test(text()) && /तुमचं उत्तर/.test(text()), 'wrong list shows questions + my answer'); }
    w.MpscInsights.go('revise'); await sleep(300);
    const opt = w.document.querySelector('#rev-box .ins-opt.pick'); assert(opt, 'revision question shown');
    opt.click(); await sleep(300); assert(w.document.querySelector('#rev-box .ins-opt.right'), 'revision answer marks correct option');
    w.document.querySelector('.ins-mode[data-m="ai"]').click(); await sleep(500);
    assert(/Polity > Rights/.test(text()), 'AI report shown: ' + text().slice(0, 200));
    assert.deepStrictEqual(errors, []);
    console.log('UI TEST PASSED');
  } catch (e) { console.error('UI FAILED', e); process.exitCode = 1; }
  srv.close();
});

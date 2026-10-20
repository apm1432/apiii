// run: node tests/subjects.routes.test.js   (fake database, no MongoDB needed)
process.env.RAZORPAY_KEY_ID = 'x'; process.env.RAZORPAY_KEY_SECRET = 'y'; process.env.JWT_SECRET = 'z'.repeat(40);
const assert = require('assert'); const path = require('path');
const R = (p) => require.resolve(path.join('..', p));
const stub = (p, exp) => { require.cache[R(p)] = { id: R(p), filename: R(p), loaded: true, exports: exp }; };
const chain = (v) => { const o = { select: () => o, lean: async () => v, then: (a, b) => Promise.resolve(v).then(a, b) }; return o; };
const aliases = [];
stub('models/SubjectAlias.js', {
  find: () => chain(aliases.slice()),
  bulkWrite: async (ops) => ops.forEach(o => { const f = o.updateOne; const i = aliases.findIndex(a => a.key === f.filter.key); const d = Object.assign({}, f.update.$set); if (i >= 0) aliases[i] = d; else aliases.push(d); }),
  deleteOne: async (f) => { const i = aliases.findIndex(a => a.key === f.key); if (i >= 0) aliases.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; }
});
const subjects = { 'Polity': 3, 'Polity (राज्यशास्त्र)': 17, 'Indian Polity': 7, 'Geography': 5 };
stub('models/Question.js', { aggregate: async () => Object.keys(subjects).map(k => ({ _id: k, n: subjects[k] })), distinct: async () => Object.keys(subjects) });
stub('models/User.js', { findById: () => chain({ isAdmin: true }) });
stub('middleware/auth.js', { authMiddleware: (req, res, next) => { req.user = { id: '507f1f77bcf86cd799439011' }; next(); }, requireSubscription: (q, s, n) => n(), isSessionActive: () => true });
const express = require('express');
const app = express(); app.use(express.json()); app.use('/api', require('../routes/api').router);
const srv = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port + '/api';
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
  try {
    let r = await get('/admin/subject-groups'); assert(r.success);
    assert.strictEqual(r.subjects.length, 3, 'Polity + Polity (राज्यशास्त्र) are already one: ' + r.subjects.map(s => s.name));
    assert(r.suggestions.some(x => [x.a, x.b].includes('Indian Polity')), 'merge hint');
    r = await post('/admin/subject-groups/merge', { names: ['Indian Polity', 'Polity (राज्यशास्त्र)'], into: 'Indian Polity' }); assert(r.success, JSON.stringify(r));
    r = await get('/admin/subject-groups'); assert.strictEqual(r.subjects.length, 2); assert.strictEqual(r.subjects[0].name, 'Indian Polity'); assert.strictEqual(r.subjects[0].total, 27);
    r = await post('/admin/subject-groups/split', { stored: 'Indian Polity' }); assert(r.success);
    r = await post('/admin/subject-groups/split', { stored: 'Geography' }); assert.strictEqual(r.success, false, 'auto / unmerged spellings can not be split');
    r = await post('/admin/subject-groups/merge', { names: ['Unclassified'], into: 'X' }); assert.strictEqual(r.success, false);
    console.log('SUBJECT ROUTE TESTS PASSED');
  } catch (e) { console.error('FAILED', e); process.exitCode = 1; }
  srv.close(); setTimeout(() => process.exit(process.exitCode || 0), 200);
});

// run: node tests/insights.test.js   (no database needed)
const assert = require('assert');
const { computeUserStats, computeTrend, summarizeDaily, levelOf } = require('../utils/insights');
const { topicKey } = require('../utils/examMeta');

// tiny bank: 3 papers (2 old, 1 recent), 3 topics
const mk = (subject, topic, byExam) => ({ subject, topic, total: Object.values(byExam).reduce((a, b) => a + b, 0), byExam, byYear: {} });
const exams = {
  '2018 group b pre': { total: 20, year: 2018, group: 'B', stage: 'prelims', subjects: { Polity: 10, History: 10 } },
  '2019 group b pre': { total: 20, year: 2019, group: 'B', stage: 'prelims', subjects: { Polity: 10, History: 10 } },
  '2023 group c mains': { total: 10, year: 2023, group: 'C', stage: 'mains', subjects: { Polity: 8, Economy: 2 } }
};
const topics = {};
[mk('Polity', 'Fundamental Rights', { '2018 group b pre': 2, '2019 group b pre': 2, '2023 group c mains': 6 }),
 mk('Polity', 'Parliament', { '2018 group b pre': 8, '2019 group b pre': 8, '2023 group c mains': 2 }),
 mk('History', 'Revolt of 1857', { '2018 group b pre': 10, '2019 group b pre': 10 }),
 mk('Economy', 'Inflation', { '2023 group c mains': 2 })].forEach(t => { topics[topicKey(t.subject, t.topic)] = t; });
const catalog = { exams, topics, total: 50, untagged: 0 };

// student: Fundamental Rights 6 answered / 1 right (weak), Parliament 8 / 7 right (strong), 1 cancelled
const answers = {}, qmeta = {};
let n = 0;
const add = (subject, topic, exam, ok, extra = {}) => { const id = ('a'.repeat(23) + (n++ % 10)) + String(n).padStart(0, ''); const qid = String(n).padStart(24, '0'); answers[qid] = Object.assign({ selected: 1, isCorrect: ok, isCancelled: false }, extra); qmeta[qid] = { subject, topic, exam }; };
for (let i = 0; i < 6; i++) add('Polity', 'Fundamental Rights', '2018 group b pre', i === 0);
for (let i = 0; i < 8; i++) add('Polity', 'Parliament', '2019 group b pre', i !== 0);
add('Polity', 'Parliament', '2019 group b pre', false, { isCancelled: true });

const s = computeUserStats({ answers, qmeta, catalog, allowed: null });
assert.strictEqual(s.totals.solved, 15);
assert.strictEqual(s.totals.correct, 8);
assert.strictEqual(s.totals.wrong, 6);                // cancelled is neither right nor wrong
assert.strictEqual(s.totals.cancelled, 1);
assert.strictEqual(s.totals.accuracy, 57.1);
const fr = s.topics.find(t => t.topic === 'Fundamental Rights'), pa = s.topics.find(t => t.topic === 'Parliament');
assert.strictEqual(fr.level, 'weak'); assert.strictEqual(pa.level, 'strong');
assert.strictEqual(fr.accuracy, 16.7); assert.strictEqual(pa.attempted, 8);
assert.strictEqual(fr.bank, 10); assert.strictEqual(fr.weightPct, 20);
assert.strictEqual(s.plan.fix[0].topic, 'Fundamental Rights');
assert(s.plan.start.some(t => t.topic === 'Revolt of 1857'), 'untouched big topic must be in "start"');
assert.strictEqual(s.plan.wrongTotal, 6);   // 5 wrong in Fundamental Rights + 1 in Parliament
const e18 = s.exams.find(e => e.exam === '2018 group b pre');
assert.strictEqual(e18.solved, 6); assert.strictEqual(e18.unattempted, 14);
// the free-trial scope hides other papers completely
const only = computeUserStats({ answers, qmeta, catalog, allowed: new Set(['2018 group b pre']) });
assert.strictEqual(only.totals.solved, 6); assert.strictEqual(only.exams.length, 1);

// trend: Fundamental Rights share: 2018 10 %, 2019 10 %, 2023 60 %  -> rising ; Parliament falling
const tr = computeTrend({ catalog, scope: null });
assert.deepStrictEqual(tr.years, [2018, 2019, 2023]);
assert.strictEqual(tr.topics.find(t => t.topic === 'Fundamental Rights').trend, 'rising');
assert.strictEqual(tr.topics.find(t => t.topic === 'Parliament').trend, 'falling');
assert.strictEqual(tr.topics.find(t => t.topic === 'Parliament').askedInYears, 3);
const trB = computeTrend({ catalog, scope: new Set(['2018 group b pre', '2019 group b pre']) });
assert.strictEqual(trB.totalQuestions, 40);

// levels + daily
assert.strictEqual(levelOf(2, 0), 'new'); assert.strictEqual(levelOf(10, 9), 'strong'); assert.strictEqual(levelOf(10, 6), 'average'); assert.strictEqual(levelOf(10, 3), 'weak');
const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10), yest = new Date(Date.now() + 5.5 * 3600000 - 86400000).toISOString().slice(0, 10);
const d = summarizeDaily([{ _id: today, n: 10, c: 7 }, { _id: yest, n: 5, c: 5 }]);
assert.strictEqual(d.streak, 2); assert.strictEqual(d.last7.solved, 15); assert.strictEqual(d.last7.accuracy, 80);
console.log('all insights tests passed');

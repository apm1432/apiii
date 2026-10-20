/**
 * routes/insights.js  -  "Progress" for students.
 *
 *  EVERY route takes  scope = "all" | "g:<ExamGroup id>"  (query for GET, body for POST). A group is what the ADMIN made in
 *  "Manage Exams" - nothing is guessed from paper names any more. The selected group limits every number on every tab and the AI.
 *
 *  WITHOUT AI (exact numbers, free, instant):
 *    GET  /scopes            the groups the student can choose from
 *    GET  /overview          totals, subject / topic / sub-topic strength, exam-wise table, study time + habits, rule-based "what to study next"
 *    GET  /trend             real PYQ topic trend of the question bank (inside the selected group)
 *    GET  /wrong             every wrong question with the student's answer + the right answer
 *    GET  /revision/queue    wrong questions that are DUE today (spaced repetition)
 *    POST /revision/answer   answer one of them -> Leitner box + next due date
 *  WITH AI (uses the AI the admin set up for Ask-AI):
 *    GET  /digest            EXACTLY the data the AI receives (so the student can check that nothing is missing)
 *    POST /ai/report         written coach report (strong / weak / cover next / revision plan / habits / trend)  - cached per scope
 *    POST /ai/chat           ask the coach anything about your own progress
 *
 *  The AI never calculates: every number is computed in utils/insights.js and only handed to the AI as text.
 */
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Question = require('../models/Question');
const Progress = require('../models/Progress');
const AttemptLog = require('../models/AttemptLog');
const RevisionState = require('../models/RevisionState');
const InsightReport = require('../models/InsightReport');
const UserStars = require('../models/UserStars');
const UserNotes = require('../models/UserNotes');
const examCatalog = require('../utils/examCatalog');
const examMeta = require('../utils/examMeta');
const { computeUserStats, computeTrend, summarizeDaily, computeActivity, pct } = require('../utils/insights');
const { askCoach, parseJsonLoose } = require('../utils/coachAI');

const OID_RE = /^[a-f0-9]{24}$/i;
const perUser = (limit, windowMs, message) => rateLimit({
    windowMs, limit, message: { success: false, message },
    keyGenerator: (req) => 'u:' + String((req.user && req.user.id) || 'anon'),
    validate: { keyGeneratorIpFallback: false, ip: false }
});
const readLimiter = perUser(60, 60 * 1000, 'Too many requests. Please slow down.');
const aiLimiter = perUser(12, 10 * 60 * 1000, 'Too many AI requests. Please wait a few minutes.');
const answerLimiter = perUser(120, 60 * 1000, 'Too many answers. Please slow down.');

// ---------------------------------------------------------------- access (same rule as /questions) + the selected group
async function getScope(userId, scopeParam) {
    const user = await User.findById(userId).select('isAdmin isSubscribed subscriptionExpiry hasUsedFreeTrial').lean();
    if (!user) return null;
    const { hidden, groups } = await examCatalog.getCatalog();
    const catalog = await examMeta.getCatalog();
    const all = Object.keys(catalog.exams).filter(ex => user.isAdmin || !hidden.has(ex));
    const subscribed = !!(user.isSubscribed && user.subscriptionExpiry && new Date() <= new Date(user.subscriptionExpiry));
    let base;
    if (user.isAdmin || subscribed) base = new Set(all);
    else {
        let free = [];
        try { free = user.hasUsedFreeTrial ? require('./api').freeExamIds(hidden) : []; } catch (e) { free = []; }
        base = new Set(all.filter(ex => free.includes(ex)));
        if (!base.size) return { denied: true };
    }
    // the admin's groups, limited to the papers this student may open (a group with none of them is not offered)
    const mine = (groups || []).map(g => ({ _id: g._id, id: 'g:' + g._id, name: g.name, exams: (g.exams || []).filter(e => base.has(e)) })).filter(g => g.exams.length);
    const want = String(scopeParam || 'all');
    const grp = want.startsWith('g:') ? mine.find(g => g.id === want) : null;
    const allowed = grp ? new Set(grp.exams) : base;
    return {
        user, catalog, allowed, base,
        key: grp ? grp.id : 'all', label: grp ? grp.name : 'सर्व papers',
        scopes: [{ id: 'all', name: 'सर्व', papers: base.size }].concat(mine.map(g => ({ id: g.id, name: g.name, papers: g.exams.length }))),
        groupDefs: mine.map(g => ({ _id: g._id, name: g.name, exams: g.exams }))
    };
}
const deny = (res) => res.status(403).json({ success: false, message: 'Subscription required or expired' });
const scopeInfo = (scope) => ({ scope: scope.key, scopeLabel: scope.label, scopes: scope.scopes });

// answers + question meta -> stats (shared by overview / wrong / revision / AI)
async function loadStats(userId, scope) {
    const prog = await Progress.findOne({ userId }).select('answers').lean();
    const answers = (prog && prog.answers) || {};
    const ids = Object.keys(answers).filter(k => OID_RE.test(k));
    const qmeta = {};
    for (let i = 0; i < ids.length; i += 1500) {
        const rows = await Question.find({ _id: { $in: ids.slice(i, i + 1500) } }, 'subject topic sub_topic year_exam').lean();
        // ONE name per subject: every spelling of "Economics" is counted together (utils/subjects.js)
        rows.forEach(r => { qmeta[String(r._id)] = { subject: scope.catalog.canon(r.subject), rawSubject: r.subject, topic: r.topic, sub_topic: r.sub_topic, exam: r.year_exam }; });
    }
    const stats = computeUserStats({ answers, qmeta, catalog: scope.catalog, allowed: scope.allowed, groups: scope.groupDefs });
    return { stats, answers, qmeta };
}

// Every answer the student ever gave (AttemptLog). Answers saved BEFORE the log existed (they carry a date inside Progress)
// are copied into it once, so the history is complete; answers that never had a date cannot be placed on a day.
const backfillTried = new Map();
async function loadActivity(userId, scope, answers, qmeta) {
    let rows = [];
    try { rows = await AttemptLog.find({ userId }).select('qid exam subject topic isCorrect src at').sort({ at: 1 }).limit(150000).lean(); } catch (e) { console.error('attempt log read:', e.message); }
    const haveExam = new Set(rows.filter(r => (r.src || 'exam') === 'exam').map(r => String(r.qid)));
    const missing = [];
    Object.keys(answers || {}).forEach(qid => {
        const a = answers[qid], m = qmeta[qid];
        if (!a || !m || typeof a.selected !== 'number' || a.isCancelled || haveExam.has(qid) || !a.at) return;
        const at = new Date(a.at);
        if (isNaN(+at) || Date.now() - +at < 120000) return;                      // a very fresh answer is logged by the save route itself
        missing.push({ userId, qid, exam: m.exam, subject: m.rawSubject, topic: m.topic, selected: a.selected, isCorrect: !!a.isCorrect, src: 'exam', at });
    });
    if (missing.length) {
        const k = String(userId);
        if (!backfillTried.has(k) || Date.now() - backfillTried.get(k) > 10 * 60000) {
            backfillTried.set(k, Date.now());
            try { if (typeof AttemptLog.insertMany === 'function') await AttemptLog.insertMany(missing, { ordered: false }); } catch (e) { console.error('attempt log backfill:', e.message); }
        }
        rows = rows.concat(missing);                                              // this response is complete even if the copy failed
    }
    return computeActivity({ rows, allowed: scope.allowed, canon: scope.catalog.canon });
}

// ---------------------------------------------------------------- 0. which groups can the student choose
router.get('/scopes', authMiddleware, readLimiter, async (req, res) => {
    try {
        const scope = await getScope(req.user.id, req.query.scope);
        if (!scope) return res.status(401).json({ success: false, message: 'User not found' });
        if (scope.denied) return deny(res);
        res.set('Cache-Control', 'no-store');
        res.json(Object.assign({ success: true }, scopeInfo(scope)));
    } catch (e) { console.error('insights scopes:', e); res.status(500).json({ success: false, message: 'Could not load groups' }); }
});

// ---------------------------------------------------------------- 1. overview (no AI)
const undatedCount = (answers, qmeta, allowed) => Object.keys(answers).filter(q => { const a = answers[q], m = qmeta[q]; return a && m && typeof a.selected === 'number' && !a.at && (!allowed || allowed.has(m.exam)); }).length;

router.get('/overview', authMiddleware, readLimiter, async (req, res) => {
    try {
        const scope = await getScope(req.user.id, req.query.scope);
        if (!scope) return res.status(401).json({ success: false, message: 'User not found' });
        if (scope.denied) return deny(res);
        const { stats, answers, qmeta } = await loadStats(req.user.id, scope);
        const act = await loadActivity(req.user.id, scope, answers, qmeta);
        const daily = summarizeDaily(act.days.map(d => ({ _id: d.day, n: d.n, c: d.c })));
        daily.streak = act.streakAll;                                  // "did you study today" counts every paper
        daily.days = act.days;                                         // [{ day, n, c, min }]
        daily.last7.min = act.study.last7Min; daily.prev7.min = act.study.prev7Min;
        const { wrongList, ...out } = stats;
        out.topics = out.topics.map(t => { const x = act.topicTime[examMeta.topicKey(t.subject, t.topic)]; return Object.assign({}, t, { avgSec: x ? Math.round(x.sec / x.n) : null }); });
        out.subjects = out.subjects.map(s => { const x = act.subjTime[s.subject]; return Object.assign({}, s, { avgSec: x ? Math.round(x.sec / x.n) : null }); });
        out.subtopics = out.subtopics.slice(0, 400);
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: Object.assign(out, scopeInfo(scope), {
            daily, hasHistory: act.lifetime.attempts > 0, quality: qualityOf(scope.catalog),
            activity: { lifetime: act.lifetime, study: act.study, learning: act.learning, weekday: act.weekday, hour: act.hour, recentExams: act.recentExams.slice(0, 40) },
            undated: undatedCount(answers, qmeta, scope.allowed)
        }) });
    } catch (e) { console.error('insights overview:', e); res.status(500).json({ success: false, message: 'Could not load progress' }); }
});

function qualityOf(catalog) {
    return { totalQuestions: catalog.total, untaggedPct: catalog.total ? Math.round(catalog.untagged / catalog.total * 1000) / 10 : 0, topicCount: Object.keys(catalog.topics).length };
}

// ---------------------------------------------------------------- 2. PYQ trend (no AI)
router.get('/trend', authMiddleware, readLimiter, async (req, res) => {
    try {
        const scope = await getScope(req.user.id, req.query.scope);
        if (!scope) return res.status(401).json({ success: false, message: 'User not found' });
        if (scope.denied) return deny(res);
        const trend = computeTrend({ catalog: scope.catalog, scope: scope.allowed });
        trend.topics = trend.topics.slice(0, 150);
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: Object.assign(trend, scopeInfo(scope), { quality: qualityOf(scope.catalog) }) });
    } catch (e) { console.error('insights trend:', e); res.status(500).json({ success: false, message: 'Could not load trend' }); }
});

// ---------------------------------------------------------------- 3. wrong questions (no AI)
const imagesOf = (q) => {
    const o = q.original_image_url;
    if (o && typeof o === 'object') return Object.values(o).filter(v => typeof v === 'string' && v).slice(0, 3);
    return (typeof o === 'string' && o) ? [o] : [];
};
const qView = (q, canon) => ({
    id: String(q._id), qnum: q.qnum, exam: q.year_exam, subject: canon ? canon(q.subject) : (q.subject || ''), topic: q.topic || '', sub_topic: q.sub_topic || '',
    text: q.text || '', text_eng: q.text_eng || '', options: q.options || [], options_eng: q.options_eng || [],
    passage: [q.passage_marathi, q.passage_text, q.passage_english].find(x => x && x !== 'null') || '', images: imagesOf(q)
});
const FIELDS = 'qnum text text_eng options options_eng subject topic sub_topic year_exam original_image_url passage_marathi passage_english passage_text correct_answer_option final_answer_key toppers_explanation_marathi';

router.get('/wrong', authMiddleware, readLimiter, async (req, res) => {
    try {
        const scope = await getScope(req.user.id, req.query.scope);
        if (!scope) return res.status(401).json({ success: false, message: 'User not found' });
        if (scope.denied) return deny(res);
        const { stats, answers } = await loadStats(req.user.id, scope);
        const f = { subject: String(req.query.subject || ''), topic: String(req.query.topic || ''), exam: String(req.query.exam || '') };
        let list = stats.wrongList.filter(w => (!f.subject || w.subject === f.subject) && (!f.topic || w.topic === f.topic) && (!f.exam || w.exam === f.exam));
        list.sort((a, b) => (b.at || 0) - (a.at || 0));
        const total = list.length;
        const page = Math.max(0, parseInt(req.query.page, 10) || 0), size = 15;
        const slice = list.slice(page * size, page * size + size);
        const qs = await Question.find({ _id: { $in: slice.map(w => w.qid) } }, FIELDS).lean();
        const byId = {}; qs.forEach(q => { byId[String(q._id)] = q; });
        const items = slice.map(w => {
            const q = byId[w.qid]; if (!q) return null;
            const ans = String(q.correct_answer_option || q.final_answer_key || '').trim();
            return Object.assign(qView(q, scope.catalog.canon), { selected: answers[w.qid].selected, correct: parseInt(ans, 10) - 1, explanation: q.toppers_explanation_marathi || '', at: w.at });
        }).filter(Boolean);
        // filters for the dropdowns = what the student actually got wrong (one name per subject)
        const subjects = {}; const topics = {}; const exams = {};
        stats.wrongList.forEach(w => { subjects[w.subject] = (subjects[w.subject] || 0) + 1; topics[w.subject + '||' + w.topic] = (topics[w.subject + '||' + w.topic] || 0) + 1; exams[w.exam] = (exams[w.exam] || 0) + 1; });
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: Object.assign({ total, page, pageSize: size, items, facets: { subjects, topics, exams } }, scopeInfo(scope)) });
    } catch (e) { console.error('insights wrong:', e); res.status(500).json({ success: false, message: 'Could not load wrong questions' }); }
});

// ---------------------------------------------------------------- 4. revision (spaced repetition, no AI)
const INTERVAL_DAYS = [1, 3, 7, 16, 35];                  // box 1..5
const DAY = 86400000;

// wrong questions -> due now / later / mastered (shared by the queue and the AI digest)
function bucketRevision(wrongList, states, now) {
    const st = {}; (states || []).forEach(s => { st[s.qid] = s; });
    const due = [], perTopic = {}, boxes = {}; let later = 0, mastered = 0;
    wrongList.forEach(w => {
        const s = st[w.qid];
        if (s && s.mastered) { mastered++; return; }
        const when = s ? new Date(s.nextDue).getTime() : (w.at ? w.at + DAY : 0);      // first revision = 1 day after the mistake (old answers without a date: now)
        const box = s ? s.box : 0;
        boxes[box] = (boxes[box] || 0) + 1;
        if (when <= now) { due.push(Object.assign({ when, box }, w)); const k = w.subject + '||' + w.topic; perTopic[k] = (perTopic[k] || 0) + 1; } else later++;
    });
    return { due, later, mastered, perTopic, boxes };
}

router.get('/revision/queue', authMiddleware, readLimiter, async (req, res) => {
    try {
        const scope = await getScope(req.user.id, req.query.scope);
        if (!scope) return res.status(401).json({ success: false, message: 'User not found' });
        if (scope.denied) return deny(res);
        const { stats } = await loadStats(req.user.id, scope);
        const f = { subject: String(req.query.subject || ''), topic: String(req.query.topic || '') };
        const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const states = await RevisionState.find({ userId: req.user.id }).lean();
        const b = bucketRevision(stats.wrongList, states, Date.now());
        const dueAll = b.due.length;
        const due = b.due.filter(w => (!f.subject || w.subject === f.subject) && (!f.topic || w.topic === f.topic));
        due.sort((x, y) => x.when - y.when);
        const pick = due.slice(0, limit);
        const qs = await Question.find({ _id: { $in: pick.map(w => w.qid) } }, FIELDS).lean();
        const byId = {}; qs.forEach(q => { byId[String(q._id)] = q; });
        const items = pick.map(w => byId[w.qid] ? Object.assign(qView(byId[w.qid], scope.catalog.canon), { box: w.box }) : null).filter(Boolean);
        res.set('Cache-Control', 'no-store');
        // perTopic = how many are due per topic -> the student can choose "revise Polity > Fundamental Rights only"
        res.json({ success: true, data: Object.assign({ items, dueNow: dueAll, later: b.later, mastered: b.mastered, perTopic: b.perTopic }, scopeInfo(scope)) });
    } catch (e) { console.error('revision queue:', e); res.status(500).json({ success: false, message: 'Could not load revision' }); }
});

router.post('/revision/answer', authMiddleware, answerLimiter, async (req, res) => {
    try {
        const qid = String((req.body && req.body.questionId) || '');
        const selected = req.body && req.body.selectedOption;
        if (!OID_RE.test(qid) || !Number.isInteger(selected) || selected < 0 || selected > 20) return res.status(400).json({ success: false, message: 'Invalid answer' });
        const scope = await getScope(req.user.id, 'all');
        if (!scope) return res.status(401).json({ success: false, message: 'User not found' });
        if (scope.denied) return deny(res);
        // only a question the student ALREADY answered in the exam can be revised (this route never reveals answers of unseen questions)
        const prog = await Progress.findOne({ userId: req.user.id, [`answers.${qid}`]: { $exists: true } }).select({ [`answers.${qid}`]: 1 }).lean();
        if (!prog) return res.status(404).json({ success: false, message: 'Question not found in your progress' });
        const q = await Question.findById(qid).lean();
        if (!q || !scope.allowed.has(q.year_exam)) return res.status(404).json({ success: false, message: 'Question not found' });

        const ans = String(q.correct_answer_option || q.final_answer_key || '').trim();
        const cancelled = ans === '#';
        const correctIdx = parseInt(ans, 10) - 1;
        const isCorrect = !cancelled && selected === correctIdx;

        const cur = await RevisionState.findOne({ userId: req.user.id, qid }).lean();
        let box = cur ? cur.box : 0, mastered = false, nextDue;
        if (cancelled) { mastered = true; nextDue = new Date(Date.now() + 3650 * DAY); }
        else if (isCorrect) {
            box = Math.min(box + 1, INTERVAL_DAYS.length + 1);
            if (box > INTERVAL_DAYS.length) { mastered = true; nextDue = new Date(Date.now() + 3650 * DAY); }
            else nextDue = new Date(Date.now() + INTERVAL_DAYS[box - 1] * DAY);
        } else { box = 0; nextDue = new Date(Date.now() + 6 * 3600000); }

        await RevisionState.updateOne({ userId: req.user.id, qid },
            { $set: { box, nextDue, mastered, lastResult: isCorrect, updatedAt: new Date() }, $inc: { seen: 1 } }, { upsert: true });
        if (!cancelled) AttemptLog.create({ userId: req.user.id, qid, exam: q.year_exam, subject: q.subject, topic: q.topic, selected, isCorrect, src: 'revise' }).catch(() => {});

        res.json({ success: true, isCorrect, isCancelled: cancelled, correctOptionIndex: correctIdx, explanation: q.toppers_explanation_marathi || '',
                   optionsExplanation: q.options_explanation || [], state: { box, mastered, nextDue } });
    } catch (e) { console.error('revision answer:', e); res.status(500).json({ success: false, message: 'Could not save' }); }
});

// ---------------------------------------------------------------- 5. AI coach
const clip = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
const iso = (t) => (t ? new Date(t).toISOString() : null);
const DIGEST_MAX_CHARS = 60000;           // ~20k tokens: the whole record of a very active student still fits every AI provider

async function starsSummary(userId, scope) {
    let doc = null; try { doc = await UserStars.findOne({ userId }).lean(); } catch (e) { doc = null; }
    const ids = ((doc && doc.ids) || []).filter(k => OID_RE.test(k));
    const ans = Object.values((doc && doc.answers) || {}).filter(a => a && typeof a.selected === 'number' && !a.isCancelled);
    if (!ids.length) return { count: 0, perTopic: {} };
    const perTopic = {}; let inScope = 0;
    for (let i = 0; i < ids.length; i += 1500) {
        const rows = await Question.find({ _id: { $in: ids.slice(i, i + 1500) } }, 'subject topic year_exam').lean();
        rows.forEach(r => { if (!scope.allowed.has(r.year_exam)) return; inScope++; const k = examMeta.topicKey(scope.catalog.canon(r.subject), r.topic); perTopic[k] = (perTopic[k] || 0) + 1; });
    }
    const named = {};
    Object.keys(perTopic).forEach(k => { named[k] = perTopic[k]; });
    return { count: ids.length, inThisScope: inScope, attemptedInStarredSession: ans.length, correctInStarredSession: ans.filter(a => a.isCorrect).length, perTopic: named };
}
async function notesSummary(userId) {
    let doc = null; try { doc = await UserNotes.findOne({ userId }).lean(); } catch (e) { doc = null; }
    const notes = (doc && doc.notes) || [];
    return { count: notes.length, latest: notes.slice(-15).map(n => ({ about: n.src || '', text: clip(n.text, 140) })) };
}

// the COMPLETE, numeric description of the student for the selected scope (this is ALL the AI sees about them)
async function buildDigest(userId, scope) {
    const { stats, answers, qmeta } = await loadStats(userId, scope);
    const act = await loadActivity(userId, scope, answers, qmeta);
    const daily = summarizeDaily(act.days.map(d => ({ _id: d.day, n: d.n, c: d.c })));
    const trend = computeTrend({ catalog: scope.catalog, scope: scope.allowed });
    const [states, stars, notes] = await Promise.all([RevisionState.find({ userId }).lean().catch(() => []), starsSummary(userId, scope), notesSummary(userId)]);
    const rev = bucketRevision(stats.wrongList, states, Date.now());
    const tk = (t) => t.subject + ' > ' + t.topic;
    const key = (t) => examMeta.topicKey(t.subject, t.topic);
    const trendOf = {}; trend.topics.forEach(t => { trendOf[key(t)] = t; });

    // every topic the student has touched, one compact row each (columns are listed once)
    const attempted = stats.topics.filter(t => t.attempted > 0).sort((a, b) => b.priority - a.priority);
    const topicRows = attempted.map(t => {
        const x = trendOf[key(t)], tt = act.topicTime[key(t)];
        return [tk(t), t.attempted, t.correct, t.accuracy, t.bank, t.coverage, t.weightPct, t.level, x ? x.trend : null, x ? `${x.askedInYears}/${x.ofYears}` : null, tt ? Math.round(tt.sec / tt.n) : null, stars.perTopic[key(t)] || 0];
    });
    const untouched = stats.topics.filter(t => t.attempted === 0 && t.bank > 0);
    const untouchedBySubject = {}; untouched.forEach(t => { untouchedBySubject[t.subject] = (untouchedBySubject[t.subject] || 0) + 1; });

    // wrong questions: all counted below; a spread of recent ones with their question text
    const per = {}; const sample = [];
    stats.wrongList.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).forEach(w => { const k = w.subject + '||' + w.topic; if ((per[k] = (per[k] || 0) + 1) <= 3 && sample.length < 60) sample.push(w); });
    const qs = await Question.find({ _id: { $in: sample.map(w => w.qid) } }, 'text text_eng').lean();
    const qm = {}; qs.forEach(q => { qm[String(q._id)] = q; });

    const hours = act.hour.map((n, h) => ({ h, n })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3).map(x => `${x.h}:00-${x.h + 1}:00`);
    const exams = stats.exams.filter(e => e.solved > 0);
    const names = Object.keys(scope.catalog.exams).filter(e => scope.allowed.has(e));

    const digest = {
        today: new Date().toISOString().slice(0, 10),
        scope: { name: scope.label, papers: names.length, paperNames: names.slice(0, 40), groupsTheStudentCanChoose: scope.scopes.map(s => s.name) },
        totals: stats.totals,
        lifetime: { attempts: act.lifetime.attempts, correct: act.lifetime.correct, accuracyPct: act.lifetime.accuracy, bySource: act.lifetime.bySource, firstTrackedAt: iso(act.lifetime.firstAt), lastAnsweredAt: iso(act.lifetime.lastAt), activeDays: act.lifetime.activeDays },
        studyTime: act.study,
        activity: {
            streakDays: act.streakAll, last7Days: daily.last7, previous7Days: daily.prev7,
            dailyLast60: act.days.slice(-60).map(d => [d.day, d.n, d.c, d.min]), dailyColumns: ['day', 'answered', 'correct', 'estimatedMinutes'],
            weekdayIST: act.weekday.map(w => ({ day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][w.dow], answered: w.n, accuracyPct: w.accuracy })), busiestHoursIST: hours
        },
        learning: act.learning,
        lastAttemptedTest: act.recentExams[0] ? { exam: act.recentExams[0].exam, at: iso(act.recentExams[0].lastAt), lastSubject: act.recentExams[0].lastSubject, lastTopic: act.recentExams[0].lastTopic } : null,
        recentTests: act.recentExams.slice(0, 15).map(e => ({ exam: e.exam, lastAttemptedAt: iso(e.lastAt), firstAttemptedAt: iso(e.firstAt), answers: e.attempts, correct: e.correct, accuracyPct: e.accuracy })),
        revision: { dueNow: rev.due.length, later: rev.later, mastered: rev.mastered, wrongByBox: rev.boxes,
                    dueByTopic: Object.keys(rev.perTopic).sort((a, b) => rev.perTopic[b] - rev.perTopic[a]).slice(0, 10).map(k => ({ topic: k.replace('||', ' > '), due: rev.perTopic[k] })) },
        subjects: stats.subjects.map(s => ({ subject: s.subject, attempted: s.attempted, correct: s.correct, accuracyPct: s.accuracy, bankQuestions: s.bank, coveragePct: s.coverage, level: s.level, avgSecPerQuestion: act.subjTime[s.subject] ? Math.round(act.subjTime[s.subject].sec / act.subjTime[s.subject].n) : null })),
        topics: { columns: ['subject > topic', 'attempted', 'correct', 'accuracyPct', 'bankQuestions', 'coveragePct', 'pyqSharePct', 'level', 'pyqTrend', 'askedInYears', 'avgSecPerQuestion', 'starred'], rows: topicRows, note: 'every topic with at least one answer, most urgent first' },
        weakSubTopics: stats.subtopics.filter(x => x.wrong > 0).slice(0, 25).map(x => ({ subTopic: `${x.subject} > ${x.topic} > ${x.sub}`, attempted: x.attempted, wrong: x.wrong })),
        notStartedTopics: { count: untouched.length, perSubject: untouchedBySubject, biggestByPyqShare: untouched.slice().sort((a, b) => b.weightPct - a.weightPct).slice(0, 25).map(t => ({ topic: tk(t), bankQuestions: t.bank, sharePct: t.weightPct })) },
        groups: stats.groups,
        exams: { attempted: exams.slice(0, 60).map(e => ({ exam: e.exam, solved: e.solved, of: e.total, accuracyPct: e.accuracy, completionPct: e.completion })), attemptedCount: exams.length, notStartedCount: stats.exams.length - exams.length },
        pyq: {
            papers: trend.papers, years: trend.years, recentYears: trend.recentYears,
            subjectShare: trend.subjects.slice(0, 14).map(s => ({ subject: s.subject, questions: s.total, sharePct: s.sharePct })),
            rising: trend.topics.filter(t => t.trend === 'rising').slice(0, 10).map(t => ({ topic: tk(t), recentSharePct: t.recentPct, earlierSharePct: t.olderPct })),
            falling: trend.topics.filter(t => t.trend === 'falling').slice(0, 6).map(t => ({ topic: tk(t), recentSharePct: t.recentPct, earlierSharePct: t.olderPct })),
            mostAsked: trend.topics.slice(0, 12).map(t => ({ topic: tk(t), questions: t.total, askedIn: `${t.askedInYears}/${t.ofYears} years` }))
        },
        wrongTotal: stats.wrongList.length,
        wrongQuestionSamples: sample.map(w => ({ topic: tk(w), subTopic: w.sub || undefined, exam: w.exam, question: clip((qm[w.qid] || {}).text_eng || (qm[w.qid] || {}).text, 110) })),
        starredQuestions: { count: stars.count, inThisScope: stars.inThisScope, attemptedInStarredSession: stars.attemptedInStarredSession, correctInStarredSession: stars.correctInStarredSession },
        notes,
        dataQuality: {
            untaggedQuestionsPct: qualityOf(scope.catalog).untaggedPct,
            answersWithoutDate: undatedCount(answers, qmeta, scope.allowed),
            studyTimeIsEstimated: 'gap between consecutive answers (a gap over 5 minutes starts a new sitting = 40 s); not a stopwatch',
            historyBeforeTrackingHasNoDate: true
        }
    };
    // never silently cut data: if the record is very large the least urgent topic rows are dropped AND the AI is told how many
    let omitted = 0;
    while (JSON.stringify(digest).length > DIGEST_MAX_CHARS && digest.topics.rows.length > 30) {
        const keep = Math.max(30, Math.floor(digest.topics.rows.length * 0.85));
        omitted += digest.topics.rows.length - keep; digest.topics.rows.length = keep;
    }
    if (omitted) digest.topics.omittedLeastUrgentTopics = omitted;
    const sig = crypto.createHash('sha1').update(JSON.stringify([scope.key, stats.totals, Object.keys(answers).length, act.lifetime.attempts, rev.mastered, digest.topics.rows.slice(0, 20).map(r => r[0] + r[1] + r[2])])).digest('hex');
    return { digest, sig, solved: stats.totals.solved };
}

const COACH_RULES = `You are a strict but friendly MPSC exam coach inside a practice website. You are given the student's COMPLETE record (JSON) for the scope they selected (digest.scope: all papers, or one exam group made by the admin). Every number was computed by the website from the official previous-year papers - you never calculate anything.
RULES:
- Use ONLY the numbers in the JSON. Never invent a score, percentage, rank, date or trend. If something is missing or the data is thin (few answers), say so plainly. Everything in the JSON is the full record unless a field says "omitted".
- "sharePct" / "pyqSharePct" = how much of ALL previous-year questions of this scope come from that topic; "askedInYears" and pyqTrend (rising / steady / falling) are exact facts from the papers. Use them to decide what is worth the student's time.
- studyTime is an ESTIMATE (gap between answers). "learning" tells how the student reacts to mistakes: fixed = was wrong, now right; stillWrong; repeatWrong = wrong two or more times; firstTryAccuracyPct = accuracy on the first attempt of each question.
- topics.rows are arrays in the order of topics.columns. A topic with few attempted questions is not proven weak or strong - say "not enough data yet".
- Be specific: name the exact subject > topic (and subTopic when given), give concrete actions (how many questions to redo, what to read, in which order). No generic motivation.
- Language: Marathi sentences in Devanagari with key terms in English. Short, clear sentences. No markdown symbols such as ** or #.
- Only talk about the student's exam preparation. Refuse anything else in one short line.`;

const REPORT_FORMAT = `Reply with ONE JSON object only (no text outside it) in exactly this shape:
{"headline":"one line verdict",
 "summary":"4-6 sentences: overall position in this scope, accuracy, coverage, honest assessment",
 "strengths":[{"topic":"Subject > Topic","why":"numbers"}],
 "weaknesses":[{"topic":"Subject > Topic","why":"numbers + the kind of mistakes seen in wrongQuestionSamples if any","fix":"concrete action"}],
 "coverNext":[{"topic":"Subject > Topic","reason":"why now (share of PYQ, rising trend, not started)"}],
 "revisionPlan":[{"when":"Day 1 / Day 2-3 / Week 1 ...","task":"specific task"}],
 "studyHabits":"3-4 sentences on study time, consistency (streak, active days), best hours, how the student handles mistakes (learning) - numbers only",
 "trendComment":"what the PYQ trend and the student's last-7-day activity say; what to prioritise or skip",
 "warning":"data limitation or risk, or empty string"}
Give at most 5 items in each list.`;

const dayKey = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

// exactly what the AI receives - the student can read / download it ("is everything there?")
router.get('/digest', authMiddleware, readLimiter, async (req, res) => {
    try {
        const scope = await getScope(req.user.id, req.query.scope);
        if (!scope) return res.status(401).json({ success: false, message: 'User not found' });
        if (scope.denied) return deny(res);
        const { digest } = await buildDigest(req.user.id, scope);
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: Object.assign({ digest, chars: JSON.stringify(digest).length }, scopeInfo(scope)) });
    } catch (e) { console.error('insights digest:', e); res.status(500).json({ success: false, message: 'Could not build the data' }); }
});

// one saved report per student PER SCOPE (legacy single report = scope "all")
const savedFor = (doc, key) => {
    if (!doc) return null;
    if (key === 'all') return doc.report ? { sig: doc.sig, report: doc.report, provider: doc.provider, createdAt: doc.createdAt } : null;
    return (doc.byScope && doc.byScope[key]) || null;
};

router.post('/ai/report', authMiddleware, aiLimiter, async (req, res) => {
    try {
        const scope = await getScope(req.user.id, req.body && req.body.scope);
        if (!scope) return res.status(401).json({ success: false, message: 'User not found' });
        if (scope.denied) return deny(res);
        const force = !!(req.body && req.body.refresh);
        const { digest, sig, solved } = await buildDigest(req.user.id, scope);
        const info = scopeInfo(scope);
        if (solved < 10) return res.json({ success: true, data: Object.assign({ tooFew: true, solved, message: 'AI report साठी या निवडीत किमान 10 प्रश्न सोडवा.' }, info) });

        const doc = await InsightReport.findOne({ userId: req.user.id }).lean();
        const saved = savedFor(doc, scope.key);
        const fresh = saved && saved.report && (Date.now() - new Date(saved.createdAt).getTime() < 24 * 3600000);
        const out0 = (extra) => ({ success: true, data: Object.assign({ report: saved.report, provider: scope.user.isAdmin ? saved.provider : undefined, at: saved.createdAt, cached: true }, extra, info) });
        if (saved && saved.report && saved.sig === sig && !force) return res.json(out0({}));
        if (saved && fresh && !force && saved.sig !== sig) return res.json(out0({ outdated: true }));     // stats changed, but a report younger than 24 h exists: the student decides to refresh
        const day = dayKey();
        const used = doc && doc.makeDay === day ? doc.makeCount : 0;
        if (used >= 4) return res.status(429).json({ success: false, message: 'आजचे AI reports संपले (दिवसाला 4). उद्या पुन्हा try करा.' });

        const out = await askCoach({ system: COACH_RULES + '\n\n' + REPORT_FORMAT, message: 'STUDENT RECORD (JSON):\n' + JSON.stringify(digest), maxTokens: 3800 });
        const report = parseJsonLoose(out.text);
        if (!report || !report.summary) return res.status(502).json({ success: false, message: 'AI चे उत्तर नीट वाचता आले नाही. पुन्हा प्रयत्न करा.' });
        const entry = { sig, report, provider: out.provider, createdAt: new Date() };
        const $set = { makeDay: day, makeCount: used + 1 };
        if (scope.key === 'all') Object.assign($set, entry); else $set.byScope = Object.assign({}, (doc && doc.byScope) || {}, { [scope.key]: entry });
        await InsightReport.updateOne({ userId: req.user.id }, { $set }, { upsert: true });
        res.json({ success: true, data: Object.assign({ report, provider: scope.user.isAdmin ? out.provider : undefined, at: entry.createdAt, cached: false }, info) });
    } catch (e) { console.error('ai report:', e.message); res.status(500).json({ success: false, message: e.message || 'AI error' }); }
});

// short-lived digest cache so a chat of 10 messages builds the statistics once (per student AND scope)
const digestCache = new Map();
router.post('/ai/chat', authMiddleware, aiLimiter, async (req, res) => {
    try {
        const message = String((req.body && req.body.message) || '').trim().slice(0, 800);
        if (!message) return res.status(400).json({ success: false, message: 'Please type a question.' });
        const scope = await getScope(req.user.id, req.body && req.body.scope);
        if (!scope) return res.status(401).json({ success: false, message: 'User not found' });
        if (scope.denied) return deny(res);
        const key = String(req.user.id) + '|' + scope.key;
        let hit = digestCache.get(key);
        if (!hit || Date.now() - hit.at > 5 * 60000) { hit = { at: Date.now(), d: await buildDigest(req.user.id, scope) }; digestCache.set(key, hit); if (digestCache.size > 500) digestCache.delete(digestCache.keys().next().value); }
        const system = COACH_RULES + '\n- Answer the student\'s question about THEIR progress / revision / what to study / study habits. Keep it under 250 words unless a plan is requested.\n\nSTUDENT RECORD (JSON):\n' + JSON.stringify(hit.d.digest);
        const out = await askCoach({ system, history: req.body.history, message, maxTokens: 1800 });
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, reply: out.text, ...(scope.user.isAdmin ? { via: out.provider } : {}) });
    } catch (e) { console.error('ai chat:', e.message); res.status(500).json({ success: false, message: e.message || 'AI error' }); }
});

module.exports = router;

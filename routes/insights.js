/**
 * routes/insights.js  -  "Progress" for students.
 *
 *  WITHOUT AI (exact numbers, free, instant):
 *    GET  /overview          totals, subject / topic strength, exam-wise table, rule-based "what to study next", daily trend
 *    GET  /trend             real PYQ topic trend of the question bank (filter by group / stage)
 *    GET  /wrong             every wrong question with the student's answer + the right answer
 *    GET  /revision/queue    wrong questions that are DUE today (spaced repetition)
 *    POST /revision/answer   answer one of them -> Leitner box + next due date
 *  WITH AI (uses the AI the admin set up for Ask-AI):
 *    POST /ai/report         written coach report (strong / weak / cover next / revision plan / trend)  - cached
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
const examCatalog = require('../utils/examCatalog');
const examMeta = require('../utils/examMeta');
const { computeUserStats, computeTrend, summarizeDaily } = require('../utils/insights');
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

// ---------------------------------------------------------------- access (same rule as /questions)
async function getScope(userId) {
    const user = await User.findById(userId).select('isAdmin isSubscribed subscriptionExpiry hasUsedFreeTrial').lean();
    if (!user) return null;
    const { hidden } = await examCatalog.getCatalog();
    const catalog = await examMeta.getCatalog();
    const all = Object.keys(catalog.exams).filter(ex => user.isAdmin || !hidden.has(ex));
    const subscribed = !!(user.isSubscribed && user.subscriptionExpiry && new Date() <= new Date(user.subscriptionExpiry));
    let allowed;
    if (user.isAdmin || subscribed) allowed = new Set(all);
    else {
        let free = [];
        try { free = user.hasUsedFreeTrial ? require('./api').freeExamIds(hidden) : []; } catch (e) { free = []; }
        allowed = new Set(all.filter(ex => free.includes(ex)));
        if (!allowed.size) return { denied: true };
    }
    return { user, catalog, allowed };
}
const deny = (res) => res.status(403).json({ success: false, message: 'Subscription required or expired' });

// answers + question meta -> stats (shared by overview / wrong / revision / AI)
async function loadStats(userId, scope) {
    const prog = await Progress.findOne({ userId }).select('answers').lean();
    const answers = (prog && prog.answers) || {};
    const ids = Object.keys(answers).filter(k => OID_RE.test(k));
    const qmeta = {};
    for (let i = 0; i < ids.length; i += 1500) {
        const rows = await Question.find({ _id: { $in: ids.slice(i, i + 1500) } }, 'subject topic year_exam').lean();
        rows.forEach(r => { qmeta[String(r._id)] = { subject: r.subject, topic: r.topic, exam: r.year_exam }; });
    }
    const stats = computeUserStats({ answers, qmeta, catalog: scope.catalog, allowed: scope.allowed });
    return { stats, answers, qmeta };
}

async function dailyRows(userId, days) {
    const since = new Date(Date.now() - days * 86400000);
    return AttemptLog.aggregate([
        { $match: { userId: new (require('mongoose').Types.ObjectId)(String(userId)), at: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: 'Asia/Kolkata' } }, n: { $sum: 1 }, c: { $sum: { $cond: ['$isCorrect', 1, 0] } } } }
    ]);
}

// ---------------------------------------------------------------- 1. overview (no AI)
router.get('/overview', authMiddleware, readLimiter, async (req, res) => {
    try {
        const scope = await getScope(req.user.id);
        if (!scope) return res.status(401).json({ success: false, message: 'User not found' });
        if (scope.denied) return deny(res);
        const { stats } = await loadStats(req.user.id, scope);
        const daily = summarizeDaily(await dailyRows(req.user.id, 60));
        const dated = (await AttemptLog.countDocuments({ userId: req.user.id })) > 0;
        const { wrongList, ...out } = stats;
        // topics the student never touched and that are tiny are noise for the screen
        out.topics = out.topics.filter(t => t.attempted > 0 || t.bank >= 3);
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: Object.assign(out, { daily, hasHistory: dated, quality: qualityOf(scope.catalog) }) });
    } catch (e) { console.error('insights overview:', e); res.status(500).json({ success: false, message: 'Could not load progress' }); }
});

function qualityOf(catalog) {
    return { totalQuestions: catalog.total, untaggedPct: catalog.total ? Math.round(catalog.untagged / catalog.total * 1000) / 10 : 0, topicCount: Object.keys(catalog.topics).length };
}

// ---------------------------------------------------------------- 2. PYQ trend (no AI)
router.get('/trend', authMiddleware, readLimiter, async (req, res) => {
    try {
        const scope = await getScope(req.user.id);
        if (!scope) return res.status(401).json({ success: false, message: 'User not found' });
        if (scope.denied) return deny(res);
        const group = String(req.query.group || 'all').toUpperCase(), stage = String(req.query.stage || 'all').toLowerCase();
        const ex = scope.catalog.exams;
        const options = { groups: [...new Set([...scope.allowed].map(e => ex[e].group))].sort(), stages: [...new Set([...scope.allowed].map(e => ex[e].stage))].sort() };
        const sel = new Set([...scope.allowed].filter(e => (group === 'ALL' || ex[e].group === group) && (stage === 'all' || ex[e].stage === stage)));
        const trend = computeTrend({ catalog: scope.catalog, scope: sel });
        trend.topics = trend.topics.slice(0, 120);
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: Object.assign(trend, { options, filter: { group, stage }, quality: qualityOf(scope.catalog) }) });
    } catch (e) { console.error('insights trend:', e); res.status(500).json({ success: false, message: 'Could not load trend' }); }
});

// ---------------------------------------------------------------- 3. wrong questions (no AI)
const imagesOf = (q) => {
    const o = q.original_image_url;
    if (o && typeof o === 'object') return Object.values(o).filter(v => typeof v === 'string' && v).slice(0, 3);
    return (typeof o === 'string' && o) ? [o] : [];
};
const qView = (q) => ({
    id: String(q._id), qnum: q.qnum, exam: q.year_exam, subject: q.subject || '', topic: q.topic || '',
    text: q.text || '', text_eng: q.text_eng || '', options: q.options || [], options_eng: q.options_eng || [],
    passage: [q.passage_marathi, q.passage_text, q.passage_english].find(x => x && x !== 'null') || '', images: imagesOf(q)
});
const FIELDS = 'qnum text text_eng options options_eng subject topic year_exam original_image_url passage_marathi passage_english passage_text correct_answer_option final_answer_key toppers_explanation_marathi';

router.get('/wrong', authMiddleware, readLimiter, async (req, res) => {
    try {
        const scope = await getScope(req.user.id);
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
            return Object.assign(qView(q), { selected: answers[w.qid].selected, correct: parseInt(ans, 10) - 1, explanation: q.toppers_explanation_marathi || '', at: w.at });
        }).filter(Boolean);
        // filters for the dropdowns = what the student actually got wrong
        const subjects = {}; const topics = {}; const exams = {};
        stats.wrongList.forEach(w => { subjects[w.subject] = (subjects[w.subject] || 0) + 1; topics[w.subject + '||' + w.topic] = (topics[w.subject + '||' + w.topic] || 0) + 1; exams[w.exam] = (exams[w.exam] || 0) + 1; });
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: { total, page, pageSize: size, items, facets: { subjects, topics, exams } } });
    } catch (e) { console.error('insights wrong:', e); res.status(500).json({ success: false, message: 'Could not load wrong questions' }); }
});

// ---------------------------------------------------------------- 4. revision (spaced repetition, no AI)
const INTERVAL_DAYS = [1, 3, 7, 16, 35];                  // box 1..5
const DAY = 86400000;

router.get('/revision/queue', authMiddleware, readLimiter, async (req, res) => {
    try {
        const scope = await getScope(req.user.id);
        if (!scope) return res.status(401).json({ success: false, message: 'User not found' });
        if (scope.denied) return deny(res);
        const { stats } = await loadStats(req.user.id, scope);
        const f = { subject: String(req.query.subject || ''), topic: String(req.query.topic || '') };
        const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const states = await RevisionState.find({ userId: req.user.id }).lean();
        const st = {}; states.forEach(s => { st[s.qid] = s; });
        const now = Date.now();
        let due = [], later = 0, mastered = 0;
        stats.wrongList.forEach(w => {
            const s = st[w.qid];
            if (s && s.mastered) { mastered++; return; }
            const when = s ? new Date(s.nextDue).getTime() : (w.at ? w.at + DAY : 0);      // first revision = 1 day after the mistake (old answers without a date: now)
            if (when <= now) due.push(Object.assign({ when, box: s ? s.box : 0 }, w)); else later++;
        });
        const dueAll = due.length;
        due = due.filter(w => (!f.subject || w.subject === f.subject) && (!f.topic || w.topic === f.topic));
        due.sort((a, b) => a.when - b.when);
        const pick = due.slice(0, limit);
        const qs = await Question.find({ _id: { $in: pick.map(w => w.qid) } }, FIELDS).lean();
        const byId = {}; qs.forEach(q => { byId[String(q._id)] = q; });
        const items = pick.map(w => byId[w.qid] ? Object.assign(qView(byId[w.qid]), { box: w.box }) : null).filter(Boolean);
        // how many are due per topic -> the student can choose "revise Polity > Fundamental Rights only"
        const perTopic = {};
        stats.wrongList.forEach(w => {
            const s = st[w.qid]; if (s && s.mastered) return;
            const when = s ? new Date(s.nextDue).getTime() : (w.at ? w.at + DAY : 0);
            if (when <= now) { const k = w.subject + '||' + w.topic; perTopic[k] = (perTopic[k] || 0) + 1; }
        });
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: { items, dueNow: dueAll, later, mastered, perTopic } });
    } catch (e) { console.error('revision queue:', e); res.status(500).json({ success: false, message: 'Could not load revision' }); }
});

router.post('/revision/answer', authMiddleware, answerLimiter, async (req, res) => {
    try {
        const qid = String((req.body && req.body.questionId) || '');
        const selected = req.body && req.body.selectedOption;
        if (!OID_RE.test(qid) || !Number.isInteger(selected) || selected < 0 || selected > 20) return res.status(400).json({ success: false, message: 'Invalid answer' });
        const scope = await getScope(req.user.id);
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

// compact, numeric description of the student (this is ALL the AI sees about them)
async function buildDigest(userId, scope) {
    const { stats, answers } = await loadStats(userId, scope);
    const daily = summarizeDaily(await dailyRows(userId, 60));
    const trend = computeTrend({ catalog: scope.catalog, scope: scope.allowed });
    const tk = (t) => t.subject + ' > ' + t.topic;
    const trendOf = {}; trend.topics.forEach(t => { trendOf[t.subject + '||' + t.topic] = t; });
    const withTrend = (t) => { const x = trendOf[t.subject + '||' + t.topic]; return x ? { asked: `${x.askedInYears}/${x.ofYears} years`, pyqTrend: x.trend } : {}; };
    const topicRow = (t) => Object.assign({ topic: tk(t), attempted: t.attempted, accuracyPct: t.accuracy, coveragePct: t.coverage, bankQuestions: t.bank, sharePct: t.weightPct }, withTrend(t));

    // up to 40 recent wrong questions, spread over the topics (short stems only)
    const per = {}; const sample = [];
    stats.wrongList.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).forEach(w => { const k = w.subject + '||' + w.topic; if ((per[k] = (per[k] || 0) + 1) <= 3 && sample.length < 40) sample.push(w); });
    const qs = await Question.find({ _id: { $in: sample.map(w => w.qid) } }, 'text text_eng').lean();
    const qm = {}; qs.forEach(q => { qm[String(q._id)] = q; });

    const digest = {
        today: new Date().toISOString().slice(0, 10),
        totals: stats.totals,
        activity: { streakDays: daily.streak, last7Days: daily.last7, previous7Days: daily.prev7 },
        subjects: stats.subjects.filter(s => s.attempted > 0).slice(0, 14).map(s => ({ subject: s.subject, attempted: s.attempted, accuracyPct: s.accuracy, coveragePct: s.coverage, level: s.level })),
        weakTopics: stats.topics.filter(t => t.level === 'weak').sort((a, b) => b.priority - a.priority).slice(0, 14).map(topicRow),
        averageTopics: stats.topics.filter(t => t.level === 'average').sort((a, b) => b.priority - a.priority).slice(0, 8).map(topicRow),
        strongTopics: stats.topics.filter(t => t.level === 'strong').slice(0, 10).map(topicRow),
        notStartedImportantTopics: stats.plan.start.map(t => ({ topic: t.subject + ' > ' + t.topic, bankQuestions: t.bank, sharePct: t.weightPct })),
        pyq: {
            papers: trend.papers, years: trend.years, recentYears: trend.recentYears,
            rising: trend.topics.filter(t => t.trend === 'rising').slice(0, 8).map(t => ({ topic: tk(t), recentSharePct: t.recentPct, earlierSharePct: t.olderPct })),
            falling: trend.topics.filter(t => t.trend === 'falling').slice(0, 5).map(t => ({ topic: tk(t), recentSharePct: t.recentPct, earlierSharePct: t.olderPct })),
            mostAsked: trend.topics.slice(0, 10).map(t => ({ topic: tk(t), questions: t.total, askedIn: `${t.askedInYears}/${t.ofYears} years` }))
        },
        exams: stats.exams.filter(e => e.solved > 0).slice(0, 12).map(e => ({ exam: e.exam, solved: e.solved, of: e.total, accuracyPct: e.accuracy })),
        wrongQuestionSamples: sample.map(w => ({ topic: w.subject + ' > ' + w.topic, exam: w.exam, question: clip((qm[w.qid] || {}).text_eng || (qm[w.qid] || {}).text, 130) })),
        wrongTotal: stats.wrongList.length
    };
    const sig = crypto.createHash('sha1').update(JSON.stringify([stats.totals, digest.weakTopics.map(t => t.topic + t.attempted), Object.keys(answers).length, daily.last7])).digest('hex');
    return { digest, sig, solved: stats.totals.solved };
}

const COACH_RULES = `You are a strict but friendly MPSC exam coach inside a practice website. You are given the student's REAL statistics (JSON) computed by the website from the official previous-year papers (Group B / Group C, prelims + mains). 
RULES:
- Use ONLY the numbers in the JSON. Never invent a score, percentage, rank, date or trend. If something is missing or the data is thin (few answers), say so plainly.
- "sharePct" = how much of ALL previous-year questions come from that topic; "asked X/Y years" and pyqTrend (rising / steady / falling) are exact facts from the papers. Use them to decide what is worth the student's time.
- A topic with few attempted questions is not proven weak or strong - say "not enough data yet".
- Be specific: name the exact subject > topic, give concrete actions (how many questions to redo, what to read, in which order). No generic motivation.
- Language: Marathi sentences in Devanagari with key terms in English. Short, clear sentences. No markdown symbols such as ** or #.
- Only talk about the student's exam preparation. Refuse anything else in one short line.`;

const REPORT_FORMAT = `Reply with ONE JSON object only (no text outside it) in exactly this shape:
{"headline":"one line verdict",
 "summary":"4-6 sentences: overall position, accuracy, coverage, honest assessment",
 "strengths":[{"topic":"Subject > Topic","why":"numbers"}],
 "weaknesses":[{"topic":"Subject > Topic","why":"numbers + the kind of mistakes seen in wrongQuestionSamples if any","fix":"concrete action"}],
 "coverNext":[{"topic":"Subject > Topic","reason":"why now (share of PYQ, rising trend, not started)"}],
 "revisionPlan":[{"when":"Day 1 / Day 2-3 / Week 1 ...","task":"specific task"}],
 "trendComment":"what the PYQ trend and the student's last-7-day activity say; what to prioritise or skip",
 "warning":"data limitation or risk, or empty string"}
Give at most 5 items in each list.`;

const dayKey = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

router.post('/ai/report', authMiddleware, aiLimiter, async (req, res) => {
    try {
        const scope = await getScope(req.user.id);
        if (!scope) return res.status(401).json({ success: false, message: 'User not found' });
        if (scope.denied) return deny(res);
        const force = !!(req.body && req.body.refresh);
        const { digest, sig, solved } = await buildDigest(req.user.id, scope);
        if (solved < 10) return res.json({ success: true, data: { tooFew: true, solved, message: 'AI report साठी किमान 10 प्रश्न सोडवा.' } });

        const saved = await InsightReport.findOne({ userId: req.user.id }).lean();
        const fresh = saved && saved.report && (Date.now() - new Date(saved.createdAt).getTime() < 24 * 3600000);
        if (saved && saved.report && saved.sig === sig && !force) return res.json({ success: true, data: { report: saved.report, provider: scope.user.isAdmin ? saved.provider : undefined, at: saved.createdAt, cached: true } });
        if (saved && fresh && !force && saved.sig !== sig) {
            // stats changed, but a report younger than 24 h exists: show it, the student decides to refresh
            return res.json({ success: true, data: { report: saved.report, provider: scope.user.isAdmin ? saved.provider : undefined, at: saved.createdAt, cached: true, outdated: true } });
        }
        const day = dayKey();
        const used = saved && saved.makeDay === day ? saved.makeCount : 0;
        if (used >= 4) return res.status(429).json({ success: false, message: 'आजचे AI reports संपले (दिवसाला 4). उद्या पुन्हा try करा.' });

        const out = await askCoach({ system: COACH_RULES + '\n\n' + REPORT_FORMAT, message: 'STUDENT STATISTICS (JSON):\n' + JSON.stringify(digest), maxTokens: 3500 });
        const report = parseJsonLoose(out.text);
        if (!report || !report.summary) return res.status(502).json({ success: false, message: 'AI चे उत्तर नीट वाचता आले नाही. पुन्हा प्रयत्न करा.' });
        await InsightReport.updateOne({ userId: req.user.id }, { $set: { sig, report, provider: out.provider, createdAt: new Date(), makeDay: day, makeCount: used + 1 } }, { upsert: true });
        res.json({ success: true, data: { report, provider: scope.user.isAdmin ? out.provider : undefined, at: new Date(), cached: false } });
    } catch (e) { console.error('ai report:', e.message); res.status(500).json({ success: false, message: e.message || 'AI error' }); }
});

// short-lived digest cache so a chat of 10 messages builds the statistics once
const digestCache = new Map();
router.post('/ai/chat', authMiddleware, aiLimiter, async (req, res) => {
    try {
        const message = String((req.body && req.body.message) || '').trim().slice(0, 800);
        if (!message) return res.status(400).json({ success: false, message: 'Please type a question.' });
        const scope = await getScope(req.user.id);
        if (!scope) return res.status(401).json({ success: false, message: 'User not found' });
        if (scope.denied) return deny(res);
        const key = String(req.user.id);
        let hit = digestCache.get(key);
        if (!hit || Date.now() - hit.at > 5 * 60000) { hit = { at: Date.now(), d: await buildDigest(req.user.id, scope) }; digestCache.set(key, hit); if (digestCache.size > 500) digestCache.delete(digestCache.keys().next().value); }
        const system = COACH_RULES + '\n- Answer the student\'s question about THEIR progress / revision / what to study. Keep it under 250 words unless a plan is requested.\n\nSTUDENT STATISTICS (JSON):\n' + JSON.stringify(hit.d.digest);
        const out = await askCoach({ system, history: req.body.history, message, maxTokens: 1800 });
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, reply: out.text, ...(scope.user.isAdmin ? { via: out.provider } : {}) });
    } catch (e) { console.error('ai chat:', e.message); res.status(500).json({ success: false, message: e.message || 'AI error' }); }
});

module.exports = router;

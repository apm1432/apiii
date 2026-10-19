/**
 * utils/insights.js  -  pure analytics (NO database, NO AI). Everything the "Progress" tabs show is computed here,
 * so the numbers are exact and the same function can be unit-tested.
 */
const { topicKey, clean } = require('./examMeta');

const PRIOR_ACC = 0.6, PRIOR_N = 4;           // a topic with few answers is pulled toward 60 % so 1 lucky / unlucky answer does not decide
const MIN_N = 3;                               // below this a topic is "new" (not enough data)
const pct = (c, n) => (n > 0 ? Math.round((c / n) * 1000) / 10 : null);

function levelOf(attempted, correct) {
    if (attempted < MIN_N) return 'new';
    const sm = (correct + PRIOR_ACC * PRIOR_N) / (attempted + PRIOR_N);
    if (sm < 0.55) return 'weak';
    if (sm >= 0.75 && attempted >= 5) return 'strong';
    return 'average';
}
const smoothed = (attempted, correct) => (correct + PRIOR_ACC * PRIOR_N) / (attempted + PRIOR_N);

/**
 * answers : { qid: { selected, isCorrect, isCancelled, section, at? } }
 * qmeta   : { qid: { subject, topic, exam } }   (only questions that still exist)
 * catalog : from examMeta.getCatalog()
 * allowed : Set of exam ids the student may see (null = all)
 */
function computeUserStats({ answers, qmeta, catalog, allowed, now }) {
    now = now || Date.now();
    const topicMap = {}, subjMap = {}, examMap = {};
    let solved = 0, correct = 0, wrong = 0, cancelled = 0;
    const wrongList = [];

    const bump = (map, key, init) => (map[key] || (map[key] = init()));
    Object.keys(answers || {}).forEach(qid => {
        const a = answers[qid];
        const m = qmeta[qid];
        if (!a || typeof a.selected !== 'number' || !m) return;
        if (allowed && !allowed.has(m.exam)) return;
        const subject = clean(m.subject, 'Unclassified'), topic = clean(m.topic, 'General');
        solved++;
        if (a.isCancelled) { cancelled++; return; }              // cancelled questions are not the student's fault
        const ok = !!a.isCorrect;
        if (ok) correct++; else { wrong++; wrongList.push({ qid, subject, topic, exam: m.exam, at: a.at ? new Date(a.at).getTime() : null }); }
        const tk = topicKey(subject, topic);
        const t = bump(topicMap, tk, () => ({ subject, topic, attempted: 0, correct: 0, wrong: 0 }));
        t.attempted++; ok ? t.correct++ : t.wrong++;
        const s = bump(subjMap, subject.toLowerCase(), () => ({ subject, attempted: 0, correct: 0, wrong: 0 }));
        s.attempted++; ok ? s.correct++ : s.wrong++;
        const e = bump(examMap, m.exam, () => ({ exam: m.exam, solved: 0, attempted: 0, correct: 0, wrong: 0, bySubject: {} }));
        e.attempted++; ok ? e.correct++ : e.wrong++;
        const es = bump(e.bySubject, subject, () => ({ attempted: 0, correct: 0, wrong: 0 }));
        es.attempted++; ok ? es.correct++ : es.wrong++;
    });
    // 'solved' per exam includes cancelled ones
    Object.keys(answers || {}).forEach(qid => {
        const m = qmeta[qid], a = answers[qid];
        if (!m || !a || typeof a.selected !== 'number') return;
        if (allowed && !allowed.has(m.exam)) return;
        if (examMap[m.exam]) examMap[m.exam].solved++;
        else if (a.isCancelled) examMap[m.exam] = { exam: m.exam, solved: 1, attempted: 0, correct: 0, wrong: 0, bySubject: {} };
    });

    // bank size inside the allowed scope
    const topicsAll = Object.values(catalog.topics);
    let bankTotal = 0;
    const scopedTopic = {};
    topicsAll.forEach(t => {
        let n = 0;
        Object.keys(t.byExam).forEach(ex => { if (!allowed || allowed.has(ex)) n += t.byExam[ex]; });
        if (n > 0) { scopedTopic[topicKey(t.subject, t.topic)] = { subject: t.subject, topic: t.topic, total: n }; bankTotal += n; }
    });

    const topics = Object.keys(scopedTopic).map(k => {
        const b = scopedTopic[k], u = topicMap[k] || { attempted: 0, correct: 0, wrong: 0 };
        const sm = smoothed(u.attempted, u.correct);
        const weight = bankTotal ? b.total / bankTotal : 0;                  // share of ALL previous-year questions
        const level = levelOf(u.attempted, u.correct);
        const gap = u.attempted < MIN_N ? 0.5 : 1 - sm;
        return {
            subject: b.subject, topic: b.topic,
            bank: b.total, attempted: u.attempted, correct: u.correct, wrong: u.wrong,
            accuracy: pct(u.correct, u.attempted),
            coverage: pct(u.attempted, b.total),
            level, weightPct: Math.round(weight * 1000) / 10,
            priority: Math.round(gap * weight * 10000) / 100                  // higher = study this first
        };
    });

    const subjects = Object.values(subjMap).map(s => {
        let bank = 0;
        Object.values(scopedTopic).forEach(t => { if (clean(t.subject, '').toLowerCase() === s.subject.toLowerCase()) bank += t.total; });
        return { subject: s.subject, bank, attempted: s.attempted, correct: s.correct, wrong: s.wrong,
                 accuracy: pct(s.correct, s.attempted), coverage: pct(s.attempted, bank), level: levelOf(s.attempted, s.correct) };
    }).sort((a, b) => b.attempted - a.attempted);
    // subjects never attempted still belong in the list
    const seenSub = new Set(subjects.map(s => s.subject.toLowerCase()));
    const unSub = {};
    Object.values(scopedTopic).forEach(t => { const k = clean(t.subject, '').toLowerCase(); if (!seenSub.has(k)) unSub[k] = (unSub[k] || { subject: t.subject, bank: 0 }); if (!seenSub.has(k)) unSub[k].bank += t.total; });
    Object.values(unSub).forEach(s => subjects.push({ subject: s.subject, bank: s.bank, attempted: 0, correct: 0, wrong: 0, accuracy: null, coverage: 0, level: 'new' }));

    const exams = Object.keys(catalog.exams).filter(ex => !allowed || allowed.has(ex)).map(ex => {
        const c = catalog.exams[ex], u = examMap[ex] || { solved: 0, attempted: 0, correct: 0, wrong: 0, bySubject: {} };
        const subs = Object.keys(c.subjects).map(sn => {
            const x = u.bySubject[sn] || { attempted: 0, correct: 0, wrong: 0 };
            return { subject: sn, bank: c.subjects[sn], attempted: x.attempted, correct: x.correct, wrong: x.wrong, accuracy: pct(x.correct, x.attempted), level: levelOf(x.attempted, x.correct) };
        }).sort((a, b) => b.bank - a.bank);
        return { exam: ex, year: c.year, group: c.group, stage: c.stage, total: c.total, solved: u.solved, attempted: u.attempted,
                 correct: u.correct, wrong: u.wrong, unattempted: Math.max(0, c.total - u.solved), accuracy: pct(u.correct, u.attempted),
                 completion: pct(u.solved, c.total), subjects: subs };
    }).sort((a, b) => (b.year - a.year) || a.exam.localeCompare(b.exam));

    const plan = buildPlan({ topics, wrongList, now });
    return {
        totals: { solved, correct, wrong, cancelled, accuracy: pct(correct, correct + wrong), bank: bankTotal, completion: pct(solved, bankTotal) },
        subjects, topics, exams, plan,
        wrongList
    };
}

// Rule-based "what next" (this is the plan the student gets WITHOUT AI)
function buildPlan({ topics, wrongList, now }) {
    const byPriority = (a, b) => b.priority - a.priority;
    const fix = topics.filter(t => t.level === 'weak').sort(byPriority).slice(0, 6)
        .map(t => ({ subject: t.subject, topic: t.topic, wrong: t.wrong, accuracy: t.accuracy, weightPct: t.weightPct, priority: t.priority }));
    const fixKeys = new Set(fix.map(t => topicKey(t.subject, t.topic)));
    const start = topics.filter(t => t.level === 'new' && t.attempted === 0 && t.bank >= 3).sort((a, b) => b.weightPct - a.weightPct).slice(0, 6)
        .map(t => ({ subject: t.subject, topic: t.topic, bank: t.bank, weightPct: t.weightPct }));
    const improve = topics.filter(t => t.level === 'average' && !fixKeys.has(topicKey(t.subject, t.topic))).sort(byPriority).slice(0, 4)
        .map(t => ({ subject: t.subject, topic: t.topic, accuracy: t.accuracy, weightPct: t.weightPct }));
    const strong = topics.filter(t => t.level === 'strong').sort((a, b) => b.accuracy - a.accuracy || b.attempted - a.attempted).slice(0, 6)
        .map(t => ({ subject: t.subject, topic: t.topic, accuracy: t.accuracy, attempted: t.attempted }));
    const DAY = 86400000;
    const dueNow = wrongList.filter(w => !w.at || now - w.at >= DAY).length;
    return { fix, start, improve, strong, wrongTotal: wrongList.length, wrongDueNow: dueNow };
}

/**
 * PYQ trend of the question bank (exact counts). scope = Set of exam ids (already filtered by group / stage).
 * Share per year = topic questions of that year / ALL questions of that year, so a year with more papers does not distort it.
 */
function computeTrend({ catalog, scope }) {
    const inScope = Object.keys(catalog.exams).filter(ex => !scope || scope.has(ex));
    const yearTotal = {}, yearPapers = {};
    inScope.forEach(ex => { const c = catalog.exams[ex]; if (!c.year) return; yearTotal[c.year] = (yearTotal[c.year] || 0) + c.total; yearPapers[c.year] = (yearPapers[c.year] || 0) + 1; });
    const years = Object.keys(yearTotal).map(Number).sort((a, b) => a - b);
    // "recent" = the last 3 years when there are 6+ years of papers, otherwise the newer half (so recent and older never overlap)
    const recentCount = years.length >= 6 ? 3 : Math.floor(years.length / 2);
    const recentYears = recentCount ? years.slice(-recentCount) : [], olderYears = years.slice(0, years.length - recentCount);
    const sumShare = (byYear, ys) => ys.length ? ys.reduce((s, y) => s + ((byYear[y] || 0) / yearTotal[y]), 0) / ys.length : 0;

    const topics = [];
    const subjYear = {};
    Object.values(catalog.topics).forEach(t => {
        const byYear = {}; let total = 0;
        Object.keys(t.byExam).forEach(ex => {
            if (scope && !scope.has(ex)) return;
            const y = (catalog.exams[ex] || {}).year; if (!y) return;
            byYear[y] = (byYear[y] || 0) + t.byExam[ex]; total += t.byExam[ex];
        });
        if (!total) return;
        const sk = t.subject;
        subjYear[sk] = subjYear[sk] || {};
        Object.keys(byYear).forEach(y => { subjYear[sk][y] = (subjYear[sk][y] || 0) + byYear[y]; });
        const recent = sumShare(byYear, recentYears) * 100, older = sumShare(byYear, olderYears) * 100;
        let trend = 'steady';
        if (olderYears.length && recentYears.length) {
            if (recent - older >= 0.5 && recent >= older * 1.25) trend = 'rising';
            else if (older - recent >= 0.5 && recent <= older * 0.75) trend = 'falling';
        }
        const asked = Object.keys(byYear).length;
        topics.push({ subject: t.subject, topic: t.topic, total, years: byYear, askedInYears: asked, ofYears: years.length,
                      recentPct: Math.round(recent * 10) / 10, olderPct: Math.round(older * 10) / 10, trend });
    });
    topics.sort((a, b) => b.total - a.total);
    const grand = Object.values(yearTotal).reduce((s, x) => s + x, 0);
    const subjects = Object.keys(subjYear).map(sn => {
        const total = Object.values(subjYear[sn]).reduce((s, x) => s + x, 0);
        return { subject: sn, total, sharePct: grand ? Math.round(total / grand * 1000) / 10 : 0, years: subjYear[sn] };
    }).sort((a, b) => b.total - a.total);
    return { years, yearTotal, yearPapers, papers: inScope.length, totalQuestions: grand, recentYears, topics, subjects };
}

// day-by-day numbers from AttemptLog rows -> [{day:'2026-10-19', n, c}] plus streak and last-7 vs previous-7 comparison
function summarizeDaily(rows, now) {
    now = now || Date.now();
    const days = (rows || []).map(r => ({ day: r._id, n: r.n, c: r.c })).sort((a, b) => a.day.localeCompare(b.day));
    const set = new Set(days.filter(d => d.n > 0).map(d => d.day));
    const dayStr = (t) => new Date(t + 5.5 * 3600000).toISOString().slice(0, 10);         // India time (UTC+5:30)
    let streak = 0;
    for (let i = (set.has(dayStr(now)) ? 0 : 1); i < 400; i++) { if (set.has(dayStr(now - i * 86400000))) streak++; else break; }
    const sumRange = (from, to) => days.filter(d => d.day >= dayStr(now - to * 86400000) && d.day <= dayStr(now - from * 86400000)).reduce((a, d) => ({ n: a.n + d.n, c: a.c + d.c }), { n: 0, c: 0 });
    const last7 = sumRange(0, 6), prev7 = sumRange(7, 13);
    return { days, streak, last7: { solved: last7.n, accuracy: pct(last7.c, last7.n) }, prev7: { solved: prev7.n, accuracy: pct(prev7.c, prev7.n) } };
}

module.exports = { computeUserStats, computeTrend, summarizeDaily, buildPlan, levelOf, smoothed, pct };

/**
 * utils/examMeta.js
 * What is IN the question bank (not what a student answered): papers, years, groups, subjects, topics.
 * All numbers come straight from the Question collection (COUNT queries), nothing is guessed.
 */
const Question = require('../models/Question');

const DEVA = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };
const toEng = (s) => String(s || '').replace(/[०-९]/g, m => DEVA[m]);

// "2018 group b pre" / "Group C Mains 2023" / "महाराष्ट्र गट-ब पूर्व परीक्षा 2019" ...
function parseExamName(name) {
    const t = toEng(name);
    const ym = t.match(/\b(19\d{2}|20\d{2})\b/);
    let group = 'Other';
    const g1 = t.match(/group[\s\-_.]*([abc])\b/i);
    const g2 = t.match(/गट[\s\-_.]*(अ|ब|क)/);
    if (g1) group = g1[1].toUpperCase();
    else if (g2) group = { 'अ': 'A', 'ब': 'B', 'क': 'C' }[g2[1]];
    let stage = 'other';
    if (/\bmains?\b|मुख्य/i.test(t)) stage = 'mains';
    else if (/\bpre(lim(s|inary)?)?\b|पूर्व/i.test(t)) stage = 'prelims';
    return { year: ym ? parseInt(ym[1], 10) : 0, group, stage };
}

const clean = (s, fallback) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return (!t || t.toLowerCase() === 'null' || t.toLowerCase() === 'undefined') ? fallback : t;
};
const topicKey = (subject, topic) => (clean(subject, 'Unclassified') + '||' + clean(topic, 'General')).toLowerCase();

let cache = null, builtAt = 0, building = null;
const TTL = 20 * 60 * 1000;

async function build() {
    const rows = await Question.aggregate([
        { $group: { _id: { e: '$year_exam', s: '$subject', t: '$topic' }, n: { $sum: 1 } } }
    ]);
    const exams = {};      // examId -> { total, year, group, stage, subjects:{subject:n} }
    const topics = {};     // key -> { subject, topic, total, byExam:{exam:n}, byYear:{year:n} }
    let total = 0, untagged = 0;
    rows.forEach(r => {
        const exam = r._id.e;
        if (!exam) return;
        const subject = clean(r._id.s, 'Unclassified');
        const topic = clean(r._id.t, 'General');
        const n = r.n;
        if (!exams[exam]) exams[exam] = Object.assign({ total: 0, subjects: {} }, parseExamName(exam));
        exams[exam].total += n;
        exams[exam].subjects[subject] = (exams[exam].subjects[subject] || 0) + n;
        const k = topicKey(subject, topic);
        if (!topics[k]) topics[k] = { subject, topic, total: 0, byExam: {}, byYear: {} };
        topics[k].total += n;
        topics[k].byExam[exam] = (topics[k].byExam[exam] || 0) + n;
        const y = exams[exam].year;
        if (y) topics[k].byYear[y] = (topics[k].byYear[y] || 0) + n;
        total += n;
        if (subject === 'Unclassified' || topic === 'General') untagged += n;
    });
    return { exams, topics, total, untagged, builtAt: Date.now() };
}

async function getCatalog(force) {
    if (!force && cache && Date.now() - builtAt < TTL) return cache;
    if (building) return building;
    building = build().then(c => { cache = c; builtAt = Date.now(); return c; }).finally(() => { building = null; });
    return building;
}
const invalidate = () => { cache = null; builtAt = 0; };

module.exports = { parseExamName, getCatalog, invalidate, topicKey, clean };

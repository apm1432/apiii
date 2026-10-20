/**
 * utils/examMeta.js
 * What is IN the question bank (not what a student answered): papers, years, groups, subjects, topics.
 * All numbers come straight from the Question collection (COUNT queries), nothing is guessed.
 */
const Question = require('../models/Question');
const subjects = require('./subjects');

const DEVA = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };
const toEng = (s) => String(s || '').replace(/[०-९]/g, m => DEVA[m]);

// The year is the only thing read from a paper's NAME (trend needs it). Which "group" a paper belongs to is NOT guessed from
// the name any more (no Pre / Mains / Group A-B-C rules): it is whatever the admin put in an Exam Group (models/ExamGroup.js).
function parseExamName(name) {
    const ym = toEng(name).match(/\b(19\d{2}|20\d{2})\b/);
    return { year: ym ? parseInt(ym[1], 10) : 0 };
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
    // one name per subject (see utils/subjects.js); every number below is counted under that name
    const rawCounts = {};
    rows.forEach(r => { if (r._id.e) { const k = r._id.s == null ? '' : String(r._id.s); rawCounts[k] = (rawCounts[k] || 0) + r.n; } });
    const resolver = await subjects.resolverFrom(rawCounts);
    const exams = {};      // examId -> { total, year, subjects:{subject:n} }
    const topics = {};     // key -> { subject, topic, total, byExam:{exam:n}, byYear:{year:n} }
    let total = 0, untagged = 0;
    rows.forEach(r => {
        const exam = r._id.e;
        if (!exam) return;
        const subject = clean(resolver.canon(r._id.s), 'Unclassified');
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
    return { exams, topics, total, untagged, builtAt: Date.now(), canon: resolver.canon, subjectsVersion: resolver.version };
}

async function getCatalog(force) {
    if (!force && cache && Date.now() - builtAt < TTL) return cache;
    if (building) return building;
    building = build().then(c => { cache = c; builtAt = Date.now(); return c; }).finally(() => { building = null; });
    return building;
}
const invalidate = () => { cache = null; builtAt = 0; };

module.exports = { parseExamName, getCatalog, invalidate, topicKey, clean };

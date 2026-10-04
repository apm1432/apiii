// Admin-controlled exam catalog: which papers are hidden and which groups exist.
// Kept in memory (this app runs as one node process) and reloaded after every admin change.
const ExamGroup = require('../models/ExamGroup');
const ExamHidden = require('../models/ExamHidden');

let cache = null;
let loadedAt = 0;
const TTL = 5 * 60 * 1000; // safety net only; admin changes call invalidate()

async function getCatalog() {
    if (cache && Date.now() - loadedAt < TTL) return cache;
    const [hidden, groups] = await Promise.all([
        ExamHidden.find().lean(),
        ExamGroup.find().sort({ order: 1, createdAt: 1 }).lean()
    ]);
    cache = {
        hidden: new Set(hidden.map(h => h.examId)),
        groups: groups.map(g => ({ _id: String(g._id), name: g.name, exams: Array.isArray(g.exams) ? g.exams : [] }))
    };
    loadedAt = Date.now();
    return cache;
}

function invalidate() { cache = null; }

module.exports = { getCatalog, invalidate };

/**
 * utils/progressSync.js
 * Keeps users' saved progress (isCorrect / totals / section stats) in sync
 * with the CURRENT correct answer of a question. Needed because the AI Fix
 * can change a question's correct answer after users already answered it.
 *
 * Every change is an ATOMIC MongoDB update ($set of the flags + $inc of the counters).
 * The old version loaded the whole progress document and called save(); if the student
 * answered another question at the same moment, that stale copy overwrote the new
 * counters / answer and progress was lost.
 */
const Progress = require('../models/Progress');
const Question = require('../models/Question');

const safeKey = (section) => (String(section || '').replace(/\./g, '_dot_').replace(/^\$/, '_') || 'Unknown');

function evalAnswer(question, selected) {
    const correctStr = String(
        question.correct_answer_option || question.final_answer_key || question.answer_key || ''
    ).trim();
    if (correctStr === '#') return { isCancelled: true, isCorrect: false };
    const idx = parseInt(correctStr, 10) - 1;
    return { isCancelled: false, isCorrect: !isNaN(idx) && selected === idx };
}

// Re-evaluate ONE saved answer of ONE progress document, atomically. Returns true if something changed.
async function reevalOne(progressId, qId, question) {
    const col = Progress.collection;
    const aKey = `answers.${qId}`;

    // 1) read the current saved answer (cheap, only this one field)
    const cur = await col.findOne({ _id: progressId }, { projection: { [aKey]: 1 } });
    const ans = cur && cur.answers && cur.answers[qId];
    if (!ans || typeof ans.selected !== 'number') return false;

    const ev = evalAnswer(question, ans.selected);
    if (!!ans.isCorrect === ev.isCorrect && !!ans.isCancelled === ev.isCancelled) return false;

    // 2) atomically set the new flags and get the OLD ones back (so two runs can never count the same change twice)
    const r = await col.findOneAndUpdate(
        { _id: progressId, [`${aKey}.selected`]: ans.selected },
        { $set: { [`${aKey}.isCorrect`]: ev.isCorrect, [`${aKey}.isCancelled`]: ev.isCancelled } },
        { returnDocument: 'before', projection: { [aKey]: 1 } }
    );
    const before = r && r.value !== undefined ? r.value : r;          // driver 5 returns {value}, newer drivers the document
    const prev = before && before.answers && before.answers[qId];
    if (!prev) return false;                                           // answer was reset / changed meanwhile

    const delta = (ev.isCorrect ? 1 : 0) - (prev.isCorrect ? 1 : 0);
    if (delta !== 0) {
        await col.updateOne({ _id: progressId }, { $inc: { totalCorrect: delta } });
        const key = safeKey(prev.section || ans.section);
        await col.updateOne({ _id: progressId, [`sectionWise.${key}`]: { $exists: true } }, { $inc: { [`sectionWise.${key}.correct`]: delta } });
        // never negative (same safety as before)
        await col.updateOne({ _id: progressId, totalCorrect: { $lt: 0 } }, { $set: { totalCorrect: 0 } });
        await col.updateOne({ _id: progressId, [`sectionWise.${key}.correct`]: { $lt: 0 } }, { $set: { [`sectionWise.${key}.correct`]: 0 } });
    }
    return true;
}

// Called right after the AI changed a question: fix every user who answered it.
async function recalcProgressForQuestion(question) {
    const qId = String(question._id);
    const docs = await Progress.find({ [`answers.${qId}`]: { $exists: true } }, '_id').lean();
    let updated = 0;
    for (const p of docs) {
        try { if (await reevalOne(p._id, qId, question)) updated++; }
        catch (e) { console.error('recalc one user failed:', e.message); }
    }
    return updated;
}

// Self-heal for old data: re-check all answers of one user against current keys.
async function reconcileUserProgress(progress) {
    const ids = [...progress.answers.keys()];
    if (!ids.length) return false;
    const questions = await Question.find(
        { _id: { $in: ids } },
        'correct_answer_option final_answer_key answer_key'
    ).lean();
    let changed = false;
    for (const q of questions) {
        const a = progress.answers.get(String(q._id));
        if (!a || typeof a.selected !== 'number') continue;
        const ev = evalAnswer(q, a.selected);
        if (!!a.isCorrect === ev.isCorrect && !!a.isCancelled === ev.isCancelled) continue;   // nothing to fix: no DB work
        if (await reevalOne(progress._id, String(q._id), q)) changed = true;
    }
    return changed;
}

module.exports = { recalcProgressForQuestion, reconcileUserProgress, evalAnswer };

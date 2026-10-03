/**
 * utils/progressSync.js
 * Keeps users' saved progress (isCorrect / totals / section stats) in sync
 * with the CURRENT correct answer of a question. Needed because the AI Fix
 * can change a question's correct answer after users already answered it.
 */
const Progress = require('../models/Progress');
const Question = require('../models/Question');

const safeKey = (section) => String(section || '').replace(/\./g, '_dot_');

function evalAnswer(question, selected) {
    const correctStr = String(
        question.correct_answer_option || question.final_answer_key || question.answer_key || ''
    ).trim();
    if (correctStr === '#') return { isCancelled: true, isCorrect: false };
    const idx = parseInt(correctStr, 10) - 1;
    return { isCancelled: false, isCorrect: !isNaN(idx) && selected === idx };
}

// Apply the new evaluation to ONE progress doc. Returns true if anything changed.
function applyToProgress(progress, qId, question) {
    const ans = progress.answers.get(qId);
    if (!ans || typeof ans.selected !== 'number') return false;

    const { isCorrect, isCancelled } = evalAnswer(question, ans.selected);
    const wasCorrect = !!ans.isCorrect;
    const wasCancelled = !!ans.isCancelled;
    if (wasCorrect === isCorrect && wasCancelled === isCancelled) return false;

    const delta = (isCorrect ? 1 : 0) - (wasCorrect ? 1 : 0);
    if (delta !== 0) {
        progress.totalCorrect = Math.max(0, (progress.totalCorrect || 0) + delta);
        const key = safeKey(ans.section);
        const sec = progress.sectionWise.get(key);
        if (sec) {
            progress.sectionWise.set(key, {
                solved: sec.solved,
                correct: Math.max(0, (sec.correct || 0) + delta)
            });
        }
    }
    progress.answers.set(qId, { ...ans, isCorrect, isCancelled });
    return true;
}

// Called right after the AI changed a question: fix every user who answered it.
async function recalcProgressForQuestion(question) {
    const qId = String(question._id);
    const docs = await Progress.find({ [`answers.${qId}`]: { $exists: true } });
    let updated = 0;
    for (const p of docs) {
        if (applyToProgress(p, qId, question)) {
            await p.save();
            updated++;
        }
    }
    return updated;
}

// Self-heal for old data: re-check all answers of one user against current keys.
async function reconcileUserProgress(progress) {
    const ids = [...progress.answers.keys()];
    if (!ids.length) return false;
    const questions = await Question.find(
        { _id: { $in: ids } },
        'correct_answer_option final_answer_key'
    ).lean();
    let changed = false;
    for (const q of questions) {
        if (applyToProgress(progress, String(q._id), q)) changed = true;
    }
    if (changed) await progress.save();
    return changed;
}

module.exports = { recalcProgressForQuestion, reconcileUserProgress, evalAnswer };

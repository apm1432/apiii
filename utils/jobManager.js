const { fixQuestionWithAI } = require('./aiService');
const Question = require('../models/Question');
const { recalcProgressForQuestion } = require('./progressSync');

const jobs = {};
const ctl = {};  // jobId -> { stopPromise, stopResolve }  (kept outside jobs[] so the job state stays plain JSON) // jobId -> { status: 'running|done', questions: [], clients: Set, qIndex: 0 }

// Heartbeat to keep SSE connections alive
setInterval(() => {
    for (const jobId in jobs) {
        if (jobs[jobId].status === 'running') {
            jobs[jobId].clients.forEach(client => {
                try {
                    client.write(': heartbeat\n\n');
                } catch (e) { }
            });
        }
    }
}, 15000);

function armStop(jobId) {
    const c = {};
    c.stopPromise = new Promise(res => { c.stopResolve = res; });
    ctl[jobId] = c;
}

function createJob(jobId, questionIds) {
    armStop(jobId);
    jobs[jobId] = {
        status: 'pending',
        questions: questionIds.map(id => ({ id, status: 'pending', error: null })),
        clients: new Set(),
        qIndex: 0,
        stopRequested: false
    };
    processJob(jobId); // start background execution
    return jobId;
}

function addClientToJob(jobId, res) {
    if (!jobs[jobId]) return false;
    jobs[jobId].clients.add(res);
    
    // Send initial state (but omit clients Set)
    const state = { ...jobs[jobId], clients: undefined };
    res.write(`data: ${JSON.stringify({ type: 'init', state })}\n\n`);

    res.on('close', () => {
        jobs[jobId].clients.delete(res);
    });
    return true;
}

function broadcast(jobId, data) {
    if (!jobs[jobId]) return;
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    jobs[jobId].clients.forEach(client => {
        try {
            client.write(msg);
        } catch (e) { }
    });
}

async function processJob(jobId) {
    const job = jobs[jobId];
    if (!job) return;
    job.status = 'running';
    broadcast(jobId, { type: 'status_update', status: job.status });

    while (true) {
        if (job.stopRequested) break;   // admin pressed Stop: no new question is started
        // Find next pending
        const qIndex = job.questions.findIndex(q => q.status === 'pending');
        if (qIndex === -1) break; // All done or failed
        
        job.qIndex = qIndex;
        const qObj = job.questions[qIndex];
        qObj.status = 'running';
        broadcast(jobId, { type: 'question_start', index: qIndex, id: qObj.id });

        try {
            const question = await Question.findById(qObj.id);
            if (!question) throw new Error("Question not found in DB");

            // fetchImageForAI is bound to global in api.js for simplicity
            let imageBase64 = null;
            if (question.original_image_url) {
                // main page image + any extra page images the admin added (the AI reads all of them)
                if (global.fetchQuestionImagesForAI) imageBase64 = await global.fetchQuestionImagesForAI(question);
                else if (global.fetchImageForAI) imageBase64 = await global.fetchImageForAI(question.original_image_url);
            }

            const onChunk = (chunk) => { if (!job.stopRequested) broadcast(jobId, { type: 'chunk', index: qIndex, chunk }); };
            onChunk.isStopped = () => job.stopRequested;      // the AI retry loops stop sending new requests
            // Stop must react at once: the AI call is raced against the stop signal. If Stop wins, the late result is thrown away (never saved).
            const work = fixQuestionWithAI(question, imageBase64, onChunk);
            work.catch(() => { });
            const stopSignal = ctl[jobId].stopPromise.then(() => { const e = new Error('Stopped by admin'); e.stopped = true; throw e; });
            stopSignal.catch(() => { });
            const parsedContent = await Promise.race([work, stopSignal]);

            // FIX 2: Official MPSC key = cancelled (#) but current website answer is different.
            // AI independently solves and picks an option — it cannot know WHY MPSC cancelled
            // (printing error, ambiguous options, outdated info). Official cancellation wins.
            // Only applies when official='#' AND final answer ≠ '#' (the diverge case).
            {
                const officialKey = String(question.official_answer_key_answers || '').trim();
                const currentFinal = String(question.correct_answer_option || question.final_answer_key || '').trim();
                if (officialKey === '#' && currentFinal !== '#' && parsedContent.correct_answer_option !== '#') {
                    broadcast(jobId, { type: 'chunk', index: qIndex, chunk:
                        `\n[System] ⚠ Official MPSC key = रद्द (#). AI independently chose option ${parsedContent.correct_answer_option} — overriding to # because official cancellation takes priority over AI's independent solve. If you believe the AI is correct, manually set the final answer after this Fix.\n` });
                    parsedContent.correct_answer_option = '#';
                    // Prefix explanation to explain the cancellation context
                    if (parsedContent.fixed_explanation &&
                        !String(parsedContent.fixed_explanation).startsWith('हा प्रश्न MPSC')) {
                        parsedContent.fixed_explanation =
                            'हा प्रश्न MPSC कडून रद्द करण्यात आला आहे.\n' + parsedContent.fixed_explanation;
                    }
                }
            }

            // The AI solved the question WITHOUT seeing the old answer. Tell the admin if its answer differs.
            const oldAnswer = String(question.correct_answer_option || question.final_answer_key || '').trim();
            const newAnswer = String(parsedContent.correct_answer_option || '').trim();
            if (newAnswer) {
                const note = !oldAnswer
                    ? `[System] AI answer: (${newAnswer}) (no old answer existed).`
                    : (oldAnswer === newAnswer
                        ? `[System] AI answer (${newAnswer}) matches the old answer.`
                        : `[System] ⚠ AI answer CHANGED: old (${oldAnswer}) -> new (${newAnswer}). Please verify.`);
                broadcast(jobId, { type: 'chunk', index: qIndex, chunk: `\n${note}\n` });
            }

            // Update question in DB
            question.text = parsedContent.fixed_text || question.text;
            question.options = parsedContent.fixed_options || question.options;
            if (parsedContent.fixed_text_eng) question.text_eng = parsedContent.fixed_text_eng;
            if (Array.isArray(parsedContent.fixed_options_eng) && parsedContent.fixed_options_eng.length) {
                question.options_eng = parsedContent.fixed_options_eng;
            }
            if (parsedContent.correct_answer_option) {
                if (parsedContent.correct_answer_option === "#") {
                    question.correct_answer_option = "#";
                } else {
                    question.correct_answer_option = parseInt(parsedContent.correct_answer_option);
                }
            }
            question.toppers_explanation_marathi = parsedContent.fixed_explanation || question.toppers_explanation_marathi;
            question.options_explanation = parsedContent.fixed_options_explanation || question.options_explanation;
            question.is_ai_fixed = true;
            question.ai_fixed_at = new Date();

            // Atomic $set: the AI works for minutes, so the loaded document can be stale. question.save() then fails with
            // "No matching document found ... version" (VersionError). updateOne has no version check.
            const setDoc = {
                text: question.text, options: question.options,
                toppers_explanation_marathi: question.toppers_explanation_marathi,
                options_explanation: question.options_explanation,
                is_ai_fixed: true, ai_fixed_at: question.ai_fixed_at
            };
            if (parsedContent.fixed_text_eng) setDoc.text_eng = question.text_eng;
            if (Array.isArray(parsedContent.fixed_options_eng) && parsedContent.fixed_options_eng.length) setDoc.options_eng = question.options_eng;
            if (parsedContent.correct_answer_option) setDoc.correct_answer_option = question.correct_answer_option;
            await question.constructor.updateOne({ _id: question._id }, { $set: setDoc });
            try { require('./dataCache').invalidateExam(question.year_exam); } catch (e) {} // students must see the fix at once

            // Re-evaluate every user's saved answer for this question (score/progress stays correct)
            try {
                const n = await recalcProgressForQuestion(question);
                if (n > 0) broadcast(jobId, { type: 'chunk', index: qIndex, chunk: `\n[System] Progress updated for ${n} user(s).\n` });
            } catch (e) {
                console.error('Progress recalc failed:', e);
            }

            qObj.status = 'done';
            broadcast(jobId, { type: 'question_done', index: qIndex, question: question });

        } catch (error) {
            // Stop pressed: this question was NOT changed. It goes back to "pending" so "Resume" can do it again.
            if (error && error.stopped) {
                qObj.status = 'pending'; qObj.error = null;
                broadcast(jobId, { type: 'question_stopped', index: qIndex, id: qObj.id });
                break;
            }
            // Every key/model is resting (rate limit / quota / busy) and NO request was sent.
            if (error && error.aiResting) {
                const waitMs = error.retryAfterMs || 0;
                if (waitMs <= 10 * 60000) {
                    // short rest: wait here and retry the SAME question - no failed question, no wasted request
                    qObj.status = 'pending';
                    broadcast(jobId, { type: 'chunk', index: qIndex, chunk: `\n[System] All keys/models are resting. Waiting ${Math.ceil(waitMs / 1000)}s, then this question is retried automatically...\n` });
                    await Promise.race([new Promise(r => setTimeout(r, waitMs + 1000)), ctl[jobId].stopPromise]);   // Stop also ends this wait
                    continue;
                }
                // long rest (daily quota finished): stop the job; this question fails (retry button), the rest stay pending
                console.error(`Job ${jobId} paused: ${error.message}`);
                qObj.status = 'failed';
                qObj.error = error.message;
                broadcast(jobId, { type: 'question_failed', index: qIndex, id: qObj.id, error: error.message });
                break;
            }
            console.error(`Job ${jobId} Question ${qObj.id} failed:`, error);
            qObj.status = 'failed';
            qObj.error = error.message;
            broadcast(jobId, { type: 'question_failed', index: qIndex, id: qObj.id, error: error.message });
        }
    }

    const failed = job.questions.filter(q => q.status === 'failed').length;
    const pending = job.questions.filter(q => q.status === 'pending').length;
    if (job.stopRequested) {
        job.status = 'stopped';
        broadcast(jobId, { type: 'job_stopped', failed, pending });
    } else {
        job.status = 'done';
        broadcast(jobId, { type: 'job_done', failed, pending });
    }
}

// Stop: nothing new is sent to the AI. The question in progress is cancelled (not saved); finished fixes stay.
function stopJob(jobId) {
    const job = jobs[jobId];
    if (!job) return false;
    if (job.status !== 'running' && job.status !== 'pending') return true;   // already finished / stopped
    job.stopRequested = true;
    if (ctl[jobId]) ctl[jobId].stopResolve();
    broadcast(jobId, { type: 'stopping' });
    return true;
}

// start the worker again (after Stop, or after the job finished with failed / waiting questions)
function startAgain(jobId) {
    const job = jobs[jobId];
    if (!job) return false;
    if (job.status === 'running' || job.status === 'pending') return true;     // already working
    job.stopRequested = false;
    armStop(jobId);
    processJob(jobId);
    return true;
}

// Resume: continue the questions that are still pending (after Stop)
function resumeJob(jobId) { return startAgain(jobId); }

// Retry every failed question in one go (they go back to the queue and are tried again, in order)
function retryAllFailed(jobId) {
    const job = jobs[jobId];
    if (!job) return 0;
    let n = 0;
    job.questions.forEach((q, i) => {
        if (q.status === 'failed') { q.status = 'pending'; q.error = null; n++; broadcast(jobId, { type: 'question_retry', index: i }); }
    });
    if (n) startAgain(jobId);
    return n;
}

function retryQuestion(jobId, questionId) {
    const job = jobs[jobId];
    if (!job) return false;
    const qIndex = job.questions.findIndex(q => q.id === questionId);
    if (qIndex === -1) return false;

    job.questions[qIndex].status = 'pending';
    job.questions[qIndex].error = null;
    
    broadcast(jobId, { type: 'question_retry', index: qIndex });
    
    if (job.status === 'done') {
        startAgain(jobId); // Restart worker loop
    }
    return true;
}

module.exports = {
    createJob,
    addClientToJob,
    retryQuestion,
    stopJob,
    resumeJob,
    retryAllFailed
};

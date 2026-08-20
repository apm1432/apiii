const { fixQuestionWithAI } = require('./aiService');
const Question = require('../models/Question');

const jobs = {}; // jobId -> { status: 'running|done', questions: [], clients: Set, qIndex: 0 }

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

function createJob(jobId, questionIds) {
    jobs[jobId] = {
        status: 'pending',
        questions: questionIds.map(id => ({ id, status: 'pending', error: null })),
        clients: new Set(),
        qIndex: 0
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
            if (global.fetchImageForAI && question.original_image_url) {
                imageBase64 = await global.fetchImageForAI(question.original_image_url);
            }

            const parsedContent = await fixQuestionWithAI(question, imageBase64, (chunk) => {
                broadcast(jobId, { type: 'chunk', index: qIndex, chunk });
            });

            // Update question in DB
            question.text = parsedContent.fixed_text || question.text;
            question.options = parsedContent.fixed_options || question.options;
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

            await question.save();

            qObj.status = 'done';
            broadcast(jobId, { type: 'question_done', index: qIndex, question: question });

        } catch (error) {
            console.error(`Job ${jobId} Question ${qObj.id} failed:`, error);
            qObj.status = 'failed';
            qObj.error = error.message;
            broadcast(jobId, { type: 'question_failed', index: qIndex, id: qObj.id, error: error.message });
        }
    }

    job.status = 'done';
    broadcast(jobId, { type: 'job_done' });
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
        processJob(jobId); // Restart worker loop
    }
    return true;
}

module.exports = {
    createJob,
    addClientToJob,
    retryQuestion
};

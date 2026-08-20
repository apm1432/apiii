const axios = require('axios');

const defaultModels = [
    "gemini-1.5-flash", 
    "gemini-1.5-pro", 
    "gemini-1.5-flash-8b"
];

const MODELS = process.env.GEMINI_MODELS ? process.env.GEMINI_MODELS.split(',').map(m => m.trim()).filter(Boolean) : defaultModels;

const AiKey = require('../models/AiKey');

// Track API Keys and Models
let keysInitialized = false;

function getRpmDelayMs(modelName) {
    const name = modelName.toLowerCase();
    if (name.endsWith('lite') || name.endsWith('flash-lite')) {
        return Math.ceil(60000 / 15); // 15 RPM -> 4000ms
    } else if (name.endsWith('flash')) {
        return Math.ceil(60000 / 5);  // 5 RPM -> 12000ms
    } else {
        return Math.ceil(60000 / 2);  // 2 RPM -> 30000ms (default/pro)
    }
}

async function initializeKeys() {
    if (!keysInitialized && process.env.GEMINI_API_KEYS) {
        const apiKeys = process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(k => k);
        for (const key of apiKeys) {
            for (const model of MODELS) {
                const exists = await AiKey.findOne({ key, model });
                if (!exists) {
                    await AiKey.create({
                        key,
                        model,
                        rpmDelayMs: getRpmDelayMs(model)
                    });
                }
            }
        }
        keysInitialized = true;
    }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getNextAvailableKeyAndModel() {
    await initializeKeys();
    const now = Date.now();
    
    const dbKeys = await AiKey.find({});
    if (dbKeys.length === 0) {
        throw new Error("No GEMINI_API_KEYS configured in database/env.");
    }

    let availableKeys = [];

    for (let doc of dbKeys) {
        let waitTime = 0;
        if (now < doc.cooldownUntil) {
            waitTime = doc.cooldownUntil - now;
        }

        const timeSinceLastUse = now - doc.lastUsed;
        if (timeSinceLastUse < doc.rpmDelayMs) {
            const rpmWait = doc.rpmDelayMs - timeSinceLastUse;
            waitTime = Math.max(waitTime, rpmWait);
        }

        availableKeys.push({ key: doc.key, model: doc.model, waitTime, status: doc.status });
    }

    // Sort by waitTime ascending. If waitTime is same, prioritize 'Success' status
    availableKeys.sort((a, b) => {
        if (a.waitTime !== b.waitTime) {
            return a.waitTime - b.waitTime;
        }
        if (a.status === 'Success' && b.status !== 'Success') return -1;
        if (b.status === 'Success' && a.status !== 'Success') return 1;
        return 0;
    });

    if (availableKeys.length > 0) {
        const best = availableKeys[0];
        return { key: best.key, model: best.model, waitTime: best.waitTime };
    }

    throw new Error("No keys available.");
}

async function updateModelState(key, model, status) {
    const doc = await AiKey.findOne({ key, model });
    if (doc) {
        doc.lastUsed = Date.now();
        doc.status = status;
        if (status === "Exhausted") {
            doc.cooldownUntil = Date.now() + 60000;
        }
        await doc.save();
    }
}

async function fixQuestionWithAI(questionData, imageBase64, onChunk) {
const prompt = `You are an expert MPSC mentor and state topper. 
Verify and correct this MPSC question data.
If there is an image, refer to it to correct the text.

CRITICAL INSTRUCTIONS ON FACT-CHECKING & CONFIRMATION BIAS:
1. DO NOT blindly trust the 'Current Final Answer Key' or 'Current Explanation'. 
2. DO NOT hallucinate facts just to justify the provided answer key. 
3. Solve the question yourself independently first. Fact-check everything rigorously. 
4. If the provided answer key is factually incorrect, completely ignore it and provide the REAL correct answer option (1-4).

CRITICAL INSTRUCTIONS FOR QUESTION TEXT (fixed_text):
1. DO NOT truncate, summarize, or omit ANY part of the original question text. Every single sentence, list item, or matching group MUST be preserved.
2. For 'Match the Pairs' (जोड्या जुळवा) questions, you MUST explicitly include BOTH Group A (गट अ) and Group B (गट ब) exactly as they are. Never omit the matching targets.
3. Your only job for 'fixed_text' is to fix spelling, punctuation, or grammatical errors. DO NOT remove content.

CRITICAL INSTRUCTION FOR INCORRECT/CANCELLED QUESTIONS:
If NO option is exactly correct, OR if MULTIPLE options are correct (which means MPSC should cancel the question), set "correct_answer_option": "#". 
In the "fixed_explanation", explicitly state "हा प्रश्न MPSC कडून रद्द करण्यात आला आहे कारण..." (This question is cancelled by MPSC because...) and clearly explain the ACTUAL correct facts.

CRITICAL INSTRUCTIONS FOR EXPLANATION QUALITY:
1. OVERALL EXPLANATION: Write a VERY DEEP, EXHAUSTIVE, and COMPLETE explanation in Marathi (at least 200-300 words). Include extra background points, historical context, current statistics, formulas, or related facts that an MPSC aspirant must know. You MUST provide additional value beyond just stating the answer.
2. OPTIONS EXPLANATION: NEVER say "this is not it so it's wrong". For EVERY incorrect option, you MUST give a solid factual explanation of what that option actually refers to in reality. For example, if the option is a year, explain what ACTUALLY happened in that year. If it's a person, explain who they are. Provide detailed factual value for each option.

Current Data:
- Question Text (Marathi): ${questionData.text}
- Options: ${JSON.stringify(questionData.options)}
- Current Final Answer Key (Option index 1-4): ${questionData.correct_answer_option || questionData.final_answer_key}
- Current Explanation: ${questionData.toppers_explanation_marathi}
- Current Options Explanation: ${JSON.stringify(questionData.options_explanation)}

Output STRICTLY as a JSON object with NO markdown formatting:
{
  "thought_process": "Your internal scratchpad. Fact-check the question independently here first before looking at the options. State the raw facts. Do NOT hallucinate to match an option.",
  "fixed_text": "Corrected question text in Marathi",
  "fixed_options": ["option 1", "option 2", "option 3", "option 4"],
  "correct_answer_option": "Correct option integer (1-4) or '#'",
  "fixed_explanation": "Deep Marathi explanation covering why the answer is correct and others are wrong",
  "fixed_options_explanation": ["explanation for option 1", "explanation for option 2", "explanation for option 3", "explanation for option 4"]
}`;

    let attempts = 0;
    let lastError = null;

    while (attempts < 3) {
        const { key, model, waitTime } = await getNextAvailableKeyAndModel();
        
        if (waitTime > 0) {
            if (onChunk) onChunk(`\n[System] Waiting ${Math.round(waitTime/1000)}s for RPM limit on ${model}...\n`);
            await sleep(waitTime);
        }

        const keySuffix = key.substring(key.length - 4);
        if (onChunk) onChunk(`\n[System] Attempt ${attempts+1} | Model: ${model} | Key: ...${keySuffix}\nAI Thinking:\n`);

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;
        
        let parts = [];
        if (imageBase64) {
            parts.push({
                inlineData: {
                    mimeType: "image/jpeg",
                    data: imageBase64
                }
            });
        }
        parts.push({ text: prompt });

        const payload = {
            contents: [{ parts: parts }],
            generationConfig: {
                temperature: 0.1,
                responseMimeType: "application/json"
            }
        };

        try {
            const resp = await axios.post(url, payload, {
                headers: { 'Content-Type': 'application/json' },
                responseType: 'stream',
                timeout: 30000
            });

            await updateModelState(key, model, "Success");

            let fullText = "";
            
            // Read SSE stream properly with a buffer
            await new Promise((resolve, reject) => {
                let buffer = '';
                resp.data.on('data', chunk => {
                    buffer += chunk.toString();
                    let lines = buffer.split('\n');
                    buffer = lines.pop(); // keep incomplete line
                    
                    for (let line of lines) {
                        line = line.trim();
                        if (line.startsWith('data: ')) {
                            const dataStr = line.substring(6).trim();
                            if (!dataStr) continue;
                            try {
                                const data = JSON.parse(dataStr);
                                if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
                                    const textChunk = data.candidates[0].content.parts[0].text;
                                    fullText += textChunk;
                                    if (onChunk) onChunk(textChunk);
                                }
                            } catch (e) { }
                        }
                    }
                });
                resp.data.on('end', () => {
                    if (buffer.trim().startsWith('data: ')) {
                        try {
                            const data = JSON.parse(buffer.trim().substring(6).trim());
                            if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
                                fullText += data.candidates[0].content.parts[0].text;
                            }
                        } catch(e) {}
                    }
                    resolve();
                });
                resp.data.on('error', reject);
            });

            let cleanText = fullText.trim();
            if (cleanText.startsWith('\`\`\`json')) cleanText = cleanText.substring(7);
            if (cleanText.endsWith('\`\`\`')) cleanText = cleanText.substring(0, cleanText.length - 3);
            
            const firstBrace = cleanText.indexOf('{');
            const lastBrace = cleanText.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
                cleanText = cleanText.substring(firstBrace, lastBrace + 1);
            }
            
            const parsed = JSON.parse(cleanText.trim());
            if (onChunk) onChunk(`\n\n[System] Done!\n`);
            return parsed;

        } catch (error) {
            if (error.response) {
                const status = error.response.status;
                if (status === 429) {
                    if (onChunk) onChunk(`\n[System] ERROR 429 on ${model}. Rotating model/key...`);
                    await updateModelState(key, model, "Exhausted");
                } else if (status === 503) {
                    if (onChunk) onChunk(`\n[System] ERROR 503 on ${model}. High demand. Waiting...`);
                    lastError = "Model is currently experiencing high demand (503).";
                    await sleep(10000);
                    attempts++;
                } else {
                    lastError = `API Error ${status}`;
                    attempts++;
                    await sleep(2000);
                }
            } else {
                lastError = error.message;
                attempts++;
                await sleep(2000);
            }
        }
    }

    throw new Error(`Failed after 3 attempts. Last error: ${lastError}`);
}

module.exports = {
    fixQuestionWithAI
};

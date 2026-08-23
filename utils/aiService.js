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

let keyMutex = Promise.resolve();

async function getNextAvailableKeyAndModel() {
    return new Promise((resolve, reject) => {
        keyMutex = keyMutex.then(async () => {
            try {
                await initializeKeys();
                const now = Date.now();
                
                const dbKeys = await AiKey.find({});
                if (dbKeys.length === 0) {
                    throw new Error("No GEMINI_API_KEYS configured in database/env.");
                }

                let availableKeys = [];
                for (let doc of dbKeys) {
                    let waitTime = 0;
                    const timeSinceLastUse = now - doc.lastUsed;
                    if (timeSinceLastUse < doc.rpmDelayMs) {
                        waitTime = doc.rpmDelayMs - timeSinceLastUse;
                    }
                    availableKeys.push({ key: doc.key, model: doc.model, waitTime, status: doc.status, rpmDelayMs: doc.rpmDelayMs });
                }

                // Sort by waitTime ascending to pick the most "ready" key (Round-Robin)
                availableKeys.sort((a, b) => {
                    if (a.waitTime !== b.waitTime) return a.waitTime - b.waitTime;
                    if (a.status === 'Success' && b.status !== 'Success') return -1;
                    if (b.status === 'Success' && a.status !== 'Success') return 1;
                    return 0;
                });

                if (availableKeys.length > 0) {
                    const best = availableKeys[0];
                    const effectiveUseTime = now + best.waitTime;
                    
                    // Reserve this key in the DB so next concurrent requests will see it as used
                    await AiKey.updateOne(
                        { key: best.key, model: best.model }, 
                        { $set: { lastUsed: effectiveUseTime } }
                    );
                    
                    resolve({ key: best.key, model: best.model, waitTime: best.waitTime });
                    return;
                }
                reject(new Error("No keys available."));
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function updateModelState(key, model, status) {
    await AiKey.updateOne({ key, model }, { $set: { status } });
}

async function fixQuestionWithAI(questionData, imageBase64, onChunk) {
const prompt = `You are an expert MPSC mentor, subject specialist, and fact-checker. Your task is to independently verify, correct, and improve the provided MPSC question data.

IMPORTANT GOAL:
Do not merely edit or copy the Current Explanation. Treat it only as reference material. Independently solve the question, identify the main topic and important related concepts, detect missing information, and create a substantially improved Marathi explanation.

The goal is MAXIMUM RELEVANT TOPIC COVERAGE, factual accuracy, conceptual clarity, and FAST REVISION. Do not unnecessarily stretch existing points into long paragraphs when distinct information can be presented as separate numbered points.

If an image is provided, carefully use it to correct OCR errors, question text, options, or other factual details.

FACT-CHECKING RULES:
1. Do NOT blindly trust the Current Final Answer Key or Current Explanation.
2. Solve the question independently BEFORE comparing with the provided answer.
3. Do NOT hallucinate facts to justify an option or answer key.
4. If the provided answer key is wrong, provide the actual correct option (1-4).
5. If no option is exactly correct, or multiple options are genuinely correct so that no single answer is possible, set "correct_answer_option": "#".
6. Never invent dates, statistics, names, laws, events, scientific facts, or current information.
7. If the question contains an error, ambiguity, outdated information, or incorrect premise, clearly explain the actual factual position.

QUESTION TEXT RULES (fixed_text):
1. Preserve the complete original question. Never truncate, summarize, or omit any sentence, list item, statement, table item, or matching group.
2. For Match the Pairs (जोड्या जुळवा), preserve BOTH Group A (गट अ) and Group B (गट ब) completely.
3. Only correct genuine spelling, OCR, punctuation, grammatical, or typographical errors.
4. Do not remove or simplify original content.

EXPLANATION RULES (fixed_explanation):

1. Use numbered pointers: 1., 2., 3., etc.

2. Do NOT give a childish, superficial, overly simplified, or one-line explanation. The student is an MPSC aspirant and needs strong factual and conceptual understanding.
MANDATORY FACT AND CONCEPT COVERAGE CHECK:

Before writing the final explanation, first identify the complete set of important facts required to understand the topic. Do not select only a few convenient facts.

Wherever relevant, you MUST actively check for and include:

1. Important dates, years, periods, timelines, and chronological sequence.
2. Important concepts and their exact meaning.
3. Definitions and key terminology.
4. Origin, background, and historical context.
5. Important persons, organizations, committees, institutions, and their contributions.
6. Important events and their causes and consequences.
7. Important laws, acts, constitutional provisions, articles, amendments, policies, and schemes.
8. Classifications, types, stages, components, and important features.
9. Relationships, differences, comparisons, and common confusion points.
10. Exceptions, limitations, special cases, and factual corrections.
11. Important places, locations, regions, and geographical context where relevant.
12. Relevant statistics, data, formulas, scientific principles, mechanisms, or processes.
13. Directly related concepts that are necessary to understand the complete parent topic.

DATE PRESERVATION RULE:
If a date, year, period, or chronological event is important for understanding the topic or is exam-relevant, DO NOT omit it.

Do not replace important dates with vague phrases such as "later", "after that", "during that period", or "in the following years" when the exact date or year is known and relevant.

CONCEPT COMPLETENESS RULE:
Do not explain only the fact directly asked in the question. Identify the underlying concept and cover its essential components, related concepts, background, mechanism, classification, and important exceptions wherever relevant.

FINAL MISSING-FACT AUDIT:
Before producing the JSON, perform a final coverage audit:
- Have I missed any important date or chronological event?
- Have I missed any core concept or definition?
- Have I skipped important background information?
- Have I omitted an important person, institution, law, article, act, committee, policy, or scheme?
- Have I explained only the answer instead of the complete underlying topic?
- Are there important facts hidden in the Current Explanation that I failed to preserve or improve?

If any important information is missing, add it as a separate numbered pointer before finalizing.
3. IMPORTANT POINTER STYLE:
Do NOT artificially limit the explanation to exactly 10 pointers. The number of pointers must depend on the number of distinct relevant facts, concepts, events, features, exceptions, classifications, comparisons, and related subtopics.

For broad topics, aim for approximately 15–30+ numbered pointers whenever the topic genuinely contains that many relevant points. Do NOT stop at 10 if important information is still missing.

For narrow questions, do NOT invent irrelevant filler merely to increase the number of pointers. Instead, explain the complete parent topic, necessary background, and directly related concepts.

4. NEW DISTINCT FACT RULE:
Whenever a genuinely new and distinct important fact, concept, event, feature, exception, date, person, place, classification, comparison, or related subtopic is added, prefer creating a NEW numbered pointer instead of stretching an existing pointer.

Do NOT merge many independent facts into one excessively long paragraph merely to keep the number of pointers low.

Related facts belonging to the same concept may remain together in one pointer.

5. POINTER LENGTH:
Keep each pointer concise but information-dense. Prefer approximately 20–60 words per numbered pointer when possible.

Do not make every pointer unnecessarily long. The goal is that the student should be able to quickly identify, understand, and revise individual facts.

A pointer may be longer when the concept genuinely requires additional explanation, but do NOT stretch or repeat information merely to make it look detailed.

6. CURRENT EXPLANATION IMPROVEMENT:
The Current Explanation MUST NOT be returned unchanged merely because it appears correct.

Preserve useful and accurate facts, but independently identify missing relevant information and add it.

Do not assume a topic is complete simply because the existing explanation is long or the answer is correct.

Before finalizing, actively check what important concepts, subtopics, background, classifications, chronology, mechanisms, exceptions, comparisons, examples, or related facts are missing.

7. TOPIC COVERAGE:
Where genuinely relevant, cover:
- Definitions and core concepts
- Background and origin
- History and chronology
- Important persons and contributions
- Important places and geographical context
- Causes and effects
- Mechanisms and processes
- Classifications and types
- Features and characteristics
- Constitutional and legal provisions
- Articles, amendments, acts, committees, institutions, and policies
- Scientific principles and mechanisms
- Important formulas, units, and relationships
- Economic concepts, indicators, and mechanisms
- Environmental concepts and ecological relationships
- Geographical features and processes
- Accurate and relevant statistics
- Comparisons and differences
- Exceptions and special cases
- Common confusion points
- Directly related concepts
- Important examples
- Important factual corrections
- Current updates when genuinely relevant

Do NOT force every category into every explanation. Use only genuinely relevant information, but do NOT skip an important relevant area merely to keep the answer short.

8. NO FILLER:
Never use generic filler such as:
"This topic is important for MPSC."
"Students should study this topic deeply."
"This question can be asked frequently."

Do not merely say what MPSC may ask. Directly explain the actual facts, concepts, variations, and details that the student needs to know.

Every numbered pointer must contain useful factual, conceptual, analytical, or explanatory value.

9. ACCURACY AND RELEVANCE:
Do NOT add random or unrelated information merely to increase the number of pointers.

Every point must be:
- Factually accurate
- Directly or meaningfully relevant
- Useful for understanding or revision
- Non-repetitive

Prefer maximum relevant coverage over unnecessary brevity, but NEVER sacrifice factual accuracy merely to make the explanation longer.

10. FAST REVISION PRIORITY:
Structure the explanation so that important distinct facts are easy to find during revision.

Prefer separate numbered pointers for separate important pieces of information instead of hiding many independent facts inside a few very long paragraphs.

The goal is:
MAXIMUM RELEVANT INFORMATION + CLEAR SEPARATE POINTS + FAST REVISION.

11. MEMORY TRICKS:
If genuinely useful, add a short mnemonic or memory trick at the end. Do not force an artificial mnemonic.

CANCELLED/INVALID QUESTION RULE:
If "correct_answer_option" is "#", begin the explanation with:
"हा प्रश्न MPSC कडून रद्द करण्यात आला आहे कारण..."

Then explain:
1. Why the options are invalid or ambiguous.
2. What the actual correct factual position is.
3. The important related facts needed to understand the topic.

CURRENT DATA RULES:
For current affairs or facts that may change over time, verify current information using reliable and authoritative sources when web access is available.

Prefer official sources such as:
- Government of India
- Government of Maharashtra
- RBI
- NITI Aayog
- Official Ministries
- ISRO
- IMD
- Official statistical agencies
- Constitutional or legislative sources
- Original reports
- Relevant international organizations

Do not present unverified information as current or confirmed.

OPTIONS EXPLANATION (fixed_options_explanation):
Explain ALL four options.

For each option:
1. Explain what the option actually refers to.
2. State whether it is correct or incorrect.
3. Explain the exact factual reason.
4. If partially correct, identify the exact incorrect part.
5. Do not simply write "Incorrect."

FINAL SELF-CHECK:
Before output, verify:
- I independently solved the question.
- I did not blindly trust the answer key.
- I preserved the complete question text.
- I checked the Current Explanation for missing information instead of simply copying it.
- I added relevant missing information where possible.
- I used separate numbered pointers for distinct important facts whenever appropriate.
- I did not artificially stop at 10 points.
- I covered important topic context and directly related concepts.
- I avoided filler, repetition, irrelevant information, and hallucinated facts.
- I explained all options factually.
- The explanation provides maximum relevant coverage while remaining easy and fast to revise.

Current Data:
- Question Text (Marathi): ${questionData.text}
- Options: ${JSON.stringify(questionData.options)}
- Current Final Answer Key (Option index 1-4): ${questionData.correct_answer_option || questionData.final_answer_key}
- Current Options Explanation: ${JSON.stringify(questionData.options_explanation)}

Output STRICTLY as a valid JSON object with NO markdown, NO code fences, and NO text outside the JSON:

{
  "thought_process": "Brief factual verification summary. Do not provide hidden chain-of-thought or an internal scratchpad. Give only concise, verifiable reasoning and conclusions.",
  "fixed_text": "Corrected complete question text in Marathi",
  "fixed_options": ["option 1", "option 2", "option 3", "option 4"],
  "correct_answer_option": "1, 2, 3, 4, or #",
  "fixed_explanation": "Deep Marathi explanation using concise, information-dense numbered pointers",
  "fixed_options_explanation": [
    "Deep factual explanation for option 1",
    "Deep factual explanation for option 2",
    "Deep factual explanation for option 3",
    "Deep factual explanation for option 4"
  ]
}`;    
    let attempts = 0;
    let lastError = null;

    while (attempts < 10) {
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
                timeout: 600000
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
            if (onChunk) onChunk(`\n\n[System] Done! Applying rate-limit delay based on model...`);
            
            let delayMs = 5000; // default 5 seconds
            if (model.toLowerCase().includes('flash') && !model.toLowerCase().includes('lite') && !model.toLowerCase().includes('8b')) {
                delayMs = 15000; // 15 seconds for flash
            } else if (model.toLowerCase().includes('lite') || model.toLowerCase().includes('8b')) {
                delayMs = 5000; // 5 seconds for lite/flash-8b
            } else if (model.toLowerCase().includes('pro')) {
                delayMs = 30000; // 30 seconds for pro
            }
            
            if (onChunk) onChunk(` (${delayMs / 1000}s)\n`);
            await sleep(delayMs);

            return parsed;

        } catch (error) {
            if (error.response) {
                const status = error.response.status;
                if (status === 429) {
                    if (onChunk) onChunk(`\n[System] ERROR 429. API Key rate limited. Pushing to back of queue...`);
                    // Just set status to Exhausted and lastUsed to now, so it goes to back of queue based on rpmDelayMs
                    await AiKey.updateMany({ key: key }, { $set: { status: "Exhausted", lastUsed: Date.now() } });
                    lastError = "Rate limited (429).";
                    attempts++;
                } else if (status === 503) {
                    if (onChunk) onChunk(`\n[System] ERROR 503 on ${model}. High demand. Pushing to back of queue...`);
                    await AiKey.updateMany({ model: model }, { $set: { status: "HighDemand", lastUsed: Date.now() } });
                    lastError = "Model is currently experiencing high demand (503).";
                    attempts++;
                } else {
                    lastError = `API Error ${status}`;
                    attempts++;
                    await sleep(2000);
                }
            } else {
                if (onChunk) onChunk(`\n[System] Parsing/Internal Error: ${error.message}. Retrying...\n`);
                lastError = error.message;
                attempts++;
                await sleep(2000);
            }
        }
    }

    throw new Error(`Failed after 10 attempts. Last error: ${lastError}`);
}

module.exports = {
    fixQuestionWithAI
};

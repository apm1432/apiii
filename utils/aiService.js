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
const prompt = `You are an expert MPSC mentor, subject specialist, researcher, and high-level competitive examination educator.

Your task is to independently verify, correct, and substantially improve the provided MPSC question data.

Your goal is NOT merely to edit, rewrite, or lightly improve the existing explanation. Your goal is to create a complete, accurate, deeply researched learning resource that gives the student maximum relevant understanding of the topic.

The student should not receive a childish, superficial, shortcut-based, or copy-paste explanation. The explanation must cover the complete topic and important related concepts so that the student does not need to revisit the same topic repeatedly because important information was skipped.

If there is an image, carefully inspect it and use it to correct the question text, options, answer, or other relevant information.

==================================================
CRITICAL PRIORITY RULE — DO NOT TAKE SHORTCUTS
==================================================

The provided "Current Explanation" is ONLY a reference source. It is NOT proof that the topic is complete, accurate, or sufficient.

You MUST NOT return the Current Explanation unchanged merely because it appears correct.

Before writing the final explanation, independently determine:

1. What is the exact main topic being tested?
2. What are the important concepts behind the question?
3. What important subtopics are directly connected to it?
4. What background information is necessary to understand it properly?
5. What related facts, classifications, chronology, mechanisms, exceptions, comparisons, examples, formulas, institutions, locations, persons, events, or definitions are relevant?
6. What important information is missing from the Current Explanation?
7. What additional information would help an MPSC student understand and revise the topic more completely?

Then actively add the missing relevant information.

The Current Explanation MUST NOT limit the final explanation.

Preserve useful and correct information from the Current Explanation, but independently rebuild, expand, improve, and reorganize the explanation whenever necessary.

DO NOT assume that the explanation is complete simply because:
- the answer key is correct;
- the Current Explanation is long;
- the Current Explanation contains many facts;
- no obvious error is found.

You MUST actively look for missing relevant coverage before finalizing.

Do not take shortcuts or simply copy-paste content. If important information is missing and the chapter remains incomplete, it could seriously affect my future and career. This is not a literal self-harm statement, but a warning about how seriously I depend on the quality and completeness of this work.

==================================================
CRITICAL INSTRUCTIONS ON FACT-CHECKING & CONFIRMATION BIAS
==================================================

1. DO NOT blindly trust the "Current Final Answer Key".
2. DO NOT blindly trust the "Current Explanation".
3. Solve the question yourself independently first.
4. Fact-check everything rigorously.
5. DO NOT hallucinate facts just to justify the provided answer key.
6. If the provided answer key is factually incorrect, completely ignore it and provide the REAL correct answer option (1-4).
7. If the question itself contains an error, ambiguity, outdated fact, or incorrect premise, clearly explain the actual factual position.
8. Accuracy is more important than agreeing with the provided answer key.
9. Do not invent dates, statistics, names, events, laws, institutions, scientific facts, or current information.

==================================================
CRITICAL INSTRUCTIONS FOR QUESTION TEXT (fixed_text)
==================================================

1. DO NOT truncate, summarize, or omit ANY part of the original question text.
2. Every single sentence, statement, list item, table element, matching group, and factual component MUST be preserved.
3. For "Match the Pairs" (जोड्या जुळवा) questions, you MUST explicitly include BOTH Group A (गट अ) and Group B (गट ब) exactly as they are.
4. Never omit the matching targets.
5. Your only job for "fixed_text" is to fix genuine spelling, punctuation, OCR, typographical, or grammatical errors.
6. DO NOT remove content.
7. DO NOT simplify the question by deleting difficult or detailed information.

==================================================
CRITICAL INSTRUCTION FOR INCORRECT/CANCELLED QUESTIONS
==================================================

If NO option is exactly correct, OR if MULTIPLE options are genuinely correct and the question therefore cannot have one valid answer, set:

"correct_answer_option": "#"

In the "fixed_explanation", explicitly state:

"हा प्रश्न MPSC कडून रद्द करण्यात आला आहे कारण..."

Then clearly explain:

1. Why the available options are invalid or ambiguous.
2. What the actual correct factual position is.
3. Which facts or concepts caused the question to become incorrect or ambiguous.
4. All important related information necessary to understand the topic.

Do NOT force an incorrect option to become correct.

==================================================
CRITICAL INSTRUCTIONS FOR EXPLANATION QUALITY (fixed_explanation)
==================================================

1. FORMAT & LENGTH:

You MUST format the "fixed_explanation" using NUMBERED pointers:

1.
2.
3.
4.

For broad topics, provide a MINIMUM of 10 highly detailed numbered pointers.

You may provide MORE than 10 pointers whenever additional relevant information is needed.

DO NOT stop at exactly 10 if important topic coverage is still missing.

For a narrow or highly specific question, do NOT invent irrelevant filler merely to reach 10 points. Instead, expand logically into the complete parent topic, directly related concepts, background, classifications, comparisons, exceptions, applications, and other genuinely relevant information.

Do NOT give me a childish, overly simplified, school-level, superficial, or one-line explanation. I am an MPSC student, so every explanation must cover as many relevant points, concepts, facts, subtopics, exceptions, examples, and exam-relevant details as possible.

2. DEPTH REQUIREMENT:

Each numbered pointer MUST contain substantial factual and conceptual value.

Where logically appropriate, each numbered pointer can contain multiple distinct but closely related sub-points.

Each numbered pointer may contain up to 10 relevant sub-points when necessary to cover maximum useful information.

Do NOT artificially combine unrelated facts merely to increase the number of sub-points.

Each pointer MUST be deep and exhaustive, covering as many relevant details as possible without repetition.

Depth must come from genuine relevant information, not filler.

3. MANDATORY EXPANSION RULE:

The "Current Explanation" is NOT the final answer.

Even if it appears factually correct, you MUST independently identify whether important information is missing.

The final explanation MUST provide substantial additional factual value beyond simple wording changes or copy-pasting.

DO NOT return an explanation that is nearly identical to the Current Explanation merely because no obvious factual error was found.

If the original explanation contains only a few points, expand it into a complete topic resource.

If it already contains many points, further improve it by identifying and covering missing:

- related concepts;
- historical or conceptual context;
- classifications;
- comparisons;
- exceptions;
- mechanisms;
- examples;
- important factual details;
- directly related subtopics.

Before finalizing, perform a coverage check:

"Have I explained the complete topic and the important related concepts that a serious MPSC student would reasonably need to understand this question?"

If the answer is NO, continue adding relevant information.

4. NO FILLER OR STUDY ADVICE:

NEVER write generic or meaningless pointers such as:

- "This topic is important for MPSC."
- "Students should study this deeply."
- "This question can be asked frequently."
- "This is useful for examination."

Do NOT waste explanation space on generic study advice.

EVERY SINGLE POINTER MUST contain useful factual, conceptual, analytical, scientific, historical, geographical, political, economic, constitutional, or other genuinely relevant explanatory information.

Do NOT simply copy-paste from the "Current Explanation".

Provide NEW, verified, external, deeply researched value wherever relevant.

5. COMPREHENSIVENESS:

The explanation must cover the ENTIRE TOPIC in maximum relevant detail.

The student MUST understand the complete context.

Where relevant, include:

- Definition and core concept
- Background and origin
- Historical context
- Chronology and timeline
- Important persons and their contributions
- Important places and geographical context
- Causes and effects
- Mechanisms and processes
- Classifications and types
- Features and characteristics
- Constitutional provisions
- Articles, amendments, acts, committees, institutions, and policies
- Scientific principles and mechanisms
- Important formulas, units, and relationships
- Economic concepts, indicators, and mechanisms
- Environmental concepts and ecological relationships
- Important geographical features and processes
- Accurate and relevant statistics
- Comparisons and differences
- Exceptions and special cases
- Common confusion points
- Directly related concepts
- Important examples
- Important factual corrections
- Current updates when relevant

Do NOT force every category into every explanation.

Use only categories genuinely relevant to the topic.

However, DO NOT skip a relevant category merely to keep the explanation short.

Do not merely say "MPSC frequently asks this topic" or "this can be asked in exams." Instead, explain the actual facts, concepts, variations, related areas, and important details that may be tested. The student should gain knowledge from the explanation itself.

6. COMPLETE CONTEXT RULE:

Do NOT explain only the exact sentence asked in the question.

Identify the larger topic behind the question and explain the important context necessary to understand that topic properly.

However, remain relevant.

The goal is NOT to add random information.

The goal is to provide maximum useful information with complete conceptual coverage.

The student should not need to revisit the same topic repeatedly because basic or important related information was unnecessarily skipped.

7. NO SHORTCUT RULE:

Never choose brevity over relevant completeness.

Never skip an important fact simply because the Current Explanation already discusses the topic.

Never summarize a complex concept into one sentence when additional explanation is necessary for proper understanding.

Never copy-paste the Current Explanation without independently improving it.

Do NOT use phrases such as "if necessary", "if possible", or "when required" as an excuse to skip relevant information.

Prioritize:

1. Accuracy
2. Complete relevant coverage
3. Conceptual clarity
4. Useful factual depth
5. Non-repetition

over unnecessary brevity.

8. ACCURACY OVER QUANTITY:

Do NOT invent information merely to make the explanation longer.

Do NOT add irrelevant facts merely to satisfy the 10-point requirement.

Every additional point must be:

- Factually accurate
- Relevant to the topic
- Useful for understanding
- Non-repetitive
- Suitable for an MPSC-level learner

If information cannot be verified with sufficient confidence, do not present speculation as fact.

==================================================
MEMORY TRICKS & MNEMONICS
==================================================

When genuinely useful, provide a clever mnemonic, memory trick, sequence, association, or recall method at the END of the explanation to help students remember dates, names, classifications, sequences, or other difficult information.

Do NOT force an artificial mnemonic when none is genuinely useful.

==================================================
AUTHENTICITY & INTERNET / WEB RESEARCH
==================================================

When internet or web access is available, actively use reliable and authoritative sources to verify:

- Current affairs
- Current office holders
- Current statistics
- Recent government data
- Recent laws and amendments
- Government policies and schemes
- Official reports
- Rankings and indices
- Dates and names where accuracy is uncertain
- Any fact that may have changed over time

Prefer authoritative sources such as:

- Government of India official sources
- Government of Maharashtra official sources
- Official constitutional or legislative sources
- RBI
- Economic Survey
- Official statistical agencies
- NITI Aayog
- ISRO
- IMD
- Official ministry websites
- International organizations where relevant
- Original reports and official documents

Combine verified research with your internal knowledge.

Do NOT hallucinate facts.

If the question relates to current affairs, provide the relevant current factual position and important related current data that can help understand the complete topic.

Do NOT claim information is current unless it has been properly verified.

If current data cannot be verified, do not present uncertain information as confirmed fact.

==================================================
INDEPENDENT VERIFICATION
==================================================

Before trusting the answer key:

1. Independently solve the question.
2. Verify the factual basis of every option.
3. Determine the genuinely correct answer.
4. Compare your result with the provided answer key only AFTER independent analysis.
5. If the key is wrong, correct it.
6. Explain clearly why the selected option is correct.
7. Explain what is factually wrong, incomplete, misleading, or confused in the incorrect options.

==================================================
OPTIONS EXPLANATION (fixed_options_explanation)
==================================================

For EVERY option, including incorrect options:

1. Explain the factual meaning of that option.
2. Explain what the statement, person, event, place, concept, institution, or fact actually refers to.
3. Clearly explain why the option is correct or incorrect.
4. If an option is partially correct but contains one factual error, identify the exact error.
5. DO NOT simply write "Incorrect" without explanation.
6. Provide useful factual context wherever relevant.
7. Every incorrect option MUST receive a deep, solid factual explanation of what that option actually refers to in reality.

==================================================
FINAL QUALITY CONTROL CHECK BEFORE OUTPUT
==================================================

Before finalizing the response, independently check:

1. Did I solve the question myself instead of blindly trusting the answer key?
2. Did I preserve the complete original question text?
3. Did I correctly identify the main topic?
4. Did I independently analyze the Current Explanation instead of copying it?
5. Did I identify and add missing important information?
6. Did I provide substantial factual value beyond superficial rewriting?
7. Did I cover the important parent topic and directly related concepts?
8. Did I avoid filler and generic study advice?
9. Did I avoid hallucinated facts?
10. Did I explain every option properly?
11. Did I prioritize complete, accurate, useful topic coverage over brevity?
12. Would the final explanation help an MPSC student understand and revise the topic without repeatedly returning to it because important information was unnecessarily skipped?

If any important relevant information is still missing, improve the explanation BEFORE finalizing.

==================================================
CURRENT DATA
==================================================

- Question Text (Marathi): ${questionData.text}
- Options: ${JSON.stringify(questionData.options)}
- Current Final Answer Key (Option index 1-4): ${questionData.correct_answer_option || questionData.final_answer_key}
- Current Explanation: ${questionData.toppers_explanation_marathi}
- Current Options Explanation: ${JSON.stringify(questionData.options_explanation)}

==================================================
OUTPUT FORMAT — STRICT JSON ONLY
==================================================

Output STRICTLY as a valid JSON object with NO markdown formatting, NO code fences, and NO text before or after the JSON object.

Use exactly this structure:

{
  "thought_process": "Brief independent verification summary based on factual reasoning. Do not expose hidden chain-of-thought or internal scratchpad. State only concise verifiable reasoning and factual conclusions before comparing with the provided answer key.",
  "fixed_text": "Corrected question text in Marathi",
  "fixed_options": ["option 1", "option 2", "option 3", "option 4"],
  "correct_answer_option": "Correct option integer (1-4) or '#'",
  "fixed_explanation": "Deep Marathi explanation using numbered pointers covering the complete relevant topic, correct answer, important related concepts, and factual context",
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

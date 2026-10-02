const axios = require('axios');

// gemini-1.5-* and gemini-2.0-* are shut down by Google (they return 404).
// Use currently supported models. Override with GEMINI_MODELS in env.
const defaultModels = [
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash"
];

// GEMINI_MODELS may be shared with wapi (format "name:rpm:rpd") -> keep only the name.
const MODELS = process.env.GEMINI_MODELS
    ? [...new Set(process.env.GEMINI_MODELS.replace(/['"]/g, '').split(',').map(m => m.split(':')[0].trim()).filter(Boolean))]
    : defaultModels;

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
    if (keysInitialized || !process.env.GEMINI_API_KEYS) return;

    const apiKeys = [...new Set(process.env.GEMINI_API_KEYS.replace(/['"]/g, '').split(',').map(k => k.trim()).filter(Boolean))];

    // Remove stale combinations from DB (old/retired models, removed keys)
    await AiKey.deleteMany({ $or: [{ model: { $nin: MODELS } }, { key: { $nin: apiKeys } }] });
    // Give every configured model another chance after a restart
    await AiKey.updateMany({}, { $set: { isAvailable: true } });

    for (const key of apiKeys) {
        for (const model of MODELS) {
            const exists = await AiKey.findOne({ key, model });
            if (!exists) {
                await AiKey.create({ key, model, rpmDelayMs: getRpmDelayMs(model) });
            }
        }
    }
    keysInitialized = true;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let keyMutex = Promise.resolve();

async function getNextAvailableKeyAndModel() {
    return new Promise((resolve, reject) => {
        keyMutex = keyMutex.then(async () => {
            try {
                await initializeKeys();
                const now = Date.now();
                
                const dbKeys = await AiKey.find({ isAvailable: { $ne: false } });
                if (dbKeys.length === 0) {
                    throw new Error("No usable Gemini key/model. Check GEMINI_API_KEYS and GEMINI_MODELS (model may be retired/404).");
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

// Takes the FIRST complete {...} object from the model output and ignores anything
// after it (models sometimes append stray "] }" or markdown fences).
function extractFirstJsonObject(text) {
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return text.substring(start, i + 1);
        }
    }
    return null; // incomplete / truncated JSON
}

function parseAiJson(rawText) {
    let t = (rawText || '').trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    // 1) plain parse
    try { return JSON.parse(t); } catch (e) { /* fall through */ }
    // 2) first balanced object (drops trailing garbage)
    const obj = extractFirstJsonObject(t);
    if (!obj) throw new Error('AI response is not complete JSON (possibly truncated)');
    return JSON.parse(obj);
}

// ---------------------------------------------------------------------------
// Validation + normalisation of the AI answer BEFORE anything is saved.
// If something is wrong the error triggers an automatic retry, so a bad AI output
// never reaches the database.
// ---------------------------------------------------------------------------
const OPT_PREFIX_RE = /^\s*(\(\s*[1-6१-६]\s*\)|[1-6१-६]\s*[.)])\s*/;
const hasOptPrefix = (t) => OPT_PREFIX_RE.test(t);
const stripOptPrefix = (t) => t.replace(OPT_PREFIX_RE, '');

// Keep the options in the SAME style as the old data in the DB:
// old options had "(1) ..." -> new ones get "(1) ..."; old had none -> remove it.
function matchOptionStyle(newOpts, oldOpts) {
    const olds = (oldOpts || []).filter(o => typeof o === 'string' && o.trim());
    if (!olds.length) return newOpts;
    const oldHas = olds.filter(hasOptPrefix).length >= olds.length / 2;
    return newOpts.map((o, i) => {
        const t = o.trim();
        if (oldHas) return hasOptPrefix(t) ? t : `(${i + 1}) ${t}`;
        return stripOptPrefix(t);
    });
}

function normalizeExplanation(text) {
    let t = String(text || '').replace(/\\n/g, '\n').replace(/\*\*/g, '').trim();
    // pointers must be on separate lines (the website turns "\n" into line breaks).
    if (!t.includes('\n')) {
        let pos = 0;
        for (let k = 2; k < 200; k++) {
            const idx = t.indexOf(` ${k}. `, pos);
            if (idx === -1) break;
            t = t.slice(0, idx) + '\n' + t.slice(idx + 1);
            pos = idx + 1;
        }
    }
    return t;
}

function normalizeAiFix(parsed, q) {
    const fail = (m) => { throw new Error('Invalid AI output: ' + m); };
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const isStrArr = (a) => Array.isArray(a) && a.every(x => typeof x === 'string');

    // ---- question text ----
    let text = str(parsed.fixed_text);
    if (!text) fail('fixed_text is missing');
    const qn = Number(q.qnum);
    if (Number.isFinite(qn) && qn > 0) {
        // a leading "78." that the old text did not have -> remove it
        if (!/^\s*\d{1,3}\s*[.)]\s/.test(q.text || '')) {
            text = text.replace(new RegExp('^\\s*' + qn + '\\s*[.)]\\s+'), '');
        }
        // another question number inside the text = the AI mixed in neighbouring questions
        const re = /^\s*(\d{2,3})\s*[.)]\s/gm;
        let m;
        while ((m = re.exec(text)) !== null) {
            if (parseInt(m[1], 10) !== qn) fail(`text contains another question (${m[1]}) but this is question ${qn}`);
        }
    }
    let textEng = str(parsed.fixed_text_eng);
    if (textEng && Number.isFinite(qn) && qn > 0 && !/^\s*\d{1,3}\s*[.)]\s/.test(q.text_eng || '')) {
        textEng = textEng.replace(new RegExp('^\\s*' + qn + '\\s*[.)]\\s+'), '');
    }

    // ---- options ----
    if (!isStrArr(parsed.fixed_options) || parsed.fixed_options.some(o => !o.trim())) fail('fixed_options must be a list of non-empty texts');
    const n = parsed.fixed_options.length;
    if (n < 2 || n > 6) fail(`unexpected number of options (${n})`);
    const options = matchOptionStyle(parsed.fixed_options, q.options);

    let optionsEng = [];
    if (parsed.fixed_options_eng !== undefined && parsed.fixed_options_eng !== null) {
        if (!isStrArr(parsed.fixed_options_eng)) fail('fixed_options_eng must be a list');
        const eng = parsed.fixed_options_eng.filter(o => o.trim());
        if (eng.length) {
            if (eng.length !== n) fail(`English options (${eng.length}) do not match Marathi options (${n})`);
            optionsEng = matchOptionStyle(eng, (q.options_eng && q.options_eng.length) ? q.options_eng : q.options);
        }
    }

    // ---- correct answer: "1".."n" or "#" ----
    const rawAns = String(parsed.correct_answer_option === undefined || parsed.correct_answer_option === null ? '' : parsed.correct_answer_option).trim();
    let answer;
    if (rawAns === '#') {
        answer = '#';
    } else {
        const m = rawAns.match(/^[^0-9#]*([1-6])[^0-9]*$/);
        if (!m) fail(`correct_answer_option "${rawAns}" is not 1-${n} or #`);
        if (parseInt(m[1], 10) > n) fail(`correct_answer_option ${m[1]} is outside the ${n} options`);
        answer = m[1];
    }

    // ---- explanation ----
    const rawExp = Array.isArray(parsed.fixed_explanation) ? parsed.fixed_explanation.join('\n') : parsed.fixed_explanation;
    const explanation = normalizeExplanation(rawExp);
    if (explanation.length < 40) fail('fixed_explanation is missing or too short');

    // ---- option-wise explanation ----
    const oe = parsed.fixed_options_explanation;
    if (!isStrArr(oe) || !oe.length || oe.some(x => !x.trim())) fail('fixed_options_explanation must be a list of non-empty texts');
    if (oe.length !== n) fail(`options explanation count (${oe.length}) does not match options (${n})`);

    return {
        ...parsed,
        fixed_text: text,
        fixed_text_eng: textEng,
        fixed_options: options,
        fixed_options_eng: optionsEng,
        correct_answer_option: answer,
        fixed_explanation: explanation,
        fixed_options_explanation: oe.map(x => x.replace(/\*\*/g, '').trim())
    };
}

async function readErrorBody(error) {
    try {
        const d = error.response && error.response.data;
        if (!d) return '';
        if (typeof d === 'string') return d.slice(0, 300);
        if (typeof d.on === 'function') {
            return await new Promise(resolve => {
                let b = '';
                d.on('data', c => { b += c.toString(); });
                d.on('end', () => resolve(b.slice(0, 300)));
                d.on('error', () => resolve(b.slice(0, 300)));
            });
        }
        return JSON.stringify(d).slice(0, 300);
    } catch (e) { return ''; }
}

function extractText(data) {
    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    if (!Array.isArray(parts)) return '';
    // skip "thought" parts of thinking models, keep only real output text
    return parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
}

async function fixQuestionWithAI(questionData, imageBase64, onChunk) {
const prompt = `You are an expert MPSC mentor, subject specialist, OCR verifier, and fact-checker.

Your task is to independently verify, reconstruct if necessary, correct, and improve the provided MPSC question data.

IMPORTANT GOAL:
NOTHING from the old database record is provided to you: there is NO old answer key and NO old explanation. Independently reconstruct the complete question when necessary, solve it yourself from scratch, identify the main topic and all important related concepts, detect missing information, and write a complete, ORIGINAL Marathi explanation in your own words.

Treat every question as brand new and completely unrelated to any other question. Do not rely on any memory of earlier questions or earlier answers; derive everything fresh from the question and the image.

The goal is:
MAXIMUM RELEVANT TOPIC COVERAGE + FACTUAL ACCURACY + COMPLETE QUESTION RECONSTRUCTION + CLEAR SEPARATE POINTS + FAST REVISION.

Do not unnecessarily stretch existing points into long paragraphs when distinct information can be presented as separate numbered points.

================================================================
SINGLE QUESTION ONLY RULE — HIGHEST PRIORITY
================================================================

The image (and the OCR text) may show MORE THAN ONE question, for example the neighbouring questions on the same page, or several questions cut into one picture.

You must process ONLY ONE question: the one described under CURRENT DATA (see "Question Number" and the Current Question Text there).

- Find that exact question in the image by its number and by matching its wording.
- Output ONLY that question in "fixed_text", "fixed_text_eng", "fixed_options", "fixed_options_eng", "fixed_explanation" and "fixed_options_explanation".
- NEVER include any other question, its number, its statements or its options. Ignore every other question visible in the image.
- Do NOT put the question number as a prefix (such as "76." or "Q.77") at the start of "fixed_text" or "fixed_text_eng".
- Keep the same structure as the Current Question Text: do not add or remove sections that the current text does not have, only repair what is missing, broken or wrong.
- "fixed_options" and "fixed_options_eng" must contain the options of this one question only.
- If the Current Question Text already contains only this one question, do not replace it with a different question.

================================================================
IMAGE-FIRST QUESTION RECONSTRUCTION RULE — MANDATORY
================================================================

If an image of the original question is provided, the image MUST be inspected carefully.

The provided JSON/OCR text may be incomplete, truncated, broken, incorrectly extracted, or may contain missing Marathi or English words, sentences, statements, answer choices, tables, groups, symbols, numbers, dates, or other content.

Therefore, NEVER assume that the provided JSON text is complete when an original question image is available.

Follow this exact mandatory workflow:

STEP 1 — INSPECT THE IMAGE FIRST:
Carefully read the COMPLETE original question from the image.

Inspect ALL visible content, including:
- Marathi question text
- English question text
- Headings
- Instructions
- Statements
- Sub-questions
- Tables
- Group A and Group B
- Match-the-pairs content
- Numbers
- Dates
- Years
- Symbols
- Formulae
- Labels
- Answer choices
- Marathi options
- English options
- Any text that may be missing from the OCR/JSON

STEP 2 — COMPARE IMAGE WITH JSON:
Compare the complete content visible in the image with:
- Question Text (Marathi)
- Question Text (English)
- Options
- English Options

Do NOT assume that any provided field is complete or correct.

STEP 3 — RECONSTRUCT MISSING CONTENT:
If any word, sentence, phrase, statement, option, table entry, group, number, date, year, symbol, formula, or instruction is visible in the image but missing, truncated, broken, or incorrectly OCR-extracted in the JSON, restore it from the image.

The image is the PRIMARY source for reconstructing the original question whenever OCR/JSON conflicts with the image.

STEP 4 — COMPLETE QUESTION BEFORE SOLVING:
First construct the COMPLETE corrected question and ALL complete options.

Do NOT solve the question while relying on incomplete OCR text.

Do NOT determine the answer until the full question has been reconstructed.

STEP 5 — INDEPENDENT SOLVING:
After reconstructing the complete question, solve it independently using verified facts.

No answer key is provided. Decide the answer only from your own verified knowledge of the facts.

STEP 6 — ANSWER VERIFICATION:
Re-check your chosen option against EVERY option once more before you finalize it.

Never bend or modify facts merely to make an option look correct.

STEP 7 — EXPLANATION:
Generate the explanation based on:
1. The COMPLETE reconstructed question.
2. Independently verified facts.
3. The underlying topic and directly related concepts.

Never generate an explanation based only on incomplete OCR text if the image contains missing information.

MANDATORY IMAGE CHECK BEFORE OUTPUT:
When an image is provided, verify:
- Did I inspect the complete image?
- Is any visible Marathi content missing from the JSON?
- Is any visible English content missing from the JSON?
- Are all statements complete?
- Are all numbers, dates, years, and symbols correct?
- Are all options complete?
- Are Marathi and English options correctly reconstructed?
- For Match the Pairs, are BOTH Group A and Group B complete?
- Is any visible content missing, truncated, or incorrectly OCR-extracted?

If any content visible in the image is missing from the provided JSON, YOU MUST restore it before solving the question.

MANDATORY ORDER:
IMAGE INSPECTION
→ COMPLETE TEXT EXTRACTION
→ MARATHI/ENGLISH COMPARISON
→ MISSING CONTENT RECONSTRUCTION
→ COMPLETE QUESTION VERIFICATION
→ INDEPENDENT SOLVING
→ ANSWER VERIFICATION
→ EXPLANATION.

NEVER ignore the image when one is provided.

================================================================
FACT-CHECKING RULES
================================================================

1. No answer key and no previous explanation are given. Never guess an answer key; solve the question yourself.
2. Solve the COMPLETE reconstructed question independently.
3. Do NOT hallucinate facts to justify an option.
4. Provide the actual correct option (1-4) based on verified facts.
5. If no option is exactly correct, or multiple options are genuinely correct so that no single answer is possible, set "correct_answer_option": "#".
6. Never invent dates, statistics, names, laws, events, scientific facts, or current information.
7. If the question contains an error, ambiguity, outdated information, or incorrect premise, clearly explain the actual factual position.

================================================================
QUESTION TEXT RULES
================================================================

For "fixed_text":
1. Preserve the COMPLETE Marathi question.
2. Never truncate, summarize, or omit any sentence, list item, statement, table item, or matching group.
3. If the Marathi text is incomplete in JSON but complete in the image, restore the missing Marathi content from the image.
4. Only correct genuine spelling, OCR, punctuation, grammatical, or typographical errors.
5. Do not remove or simplify original content.

For "fixed_text_eng":
1. Preserve the COMPLETE English question.
2. If the English text is incomplete, truncated, broken, or missing in JSON but visible in the image, reconstruct and restore the complete English text from the image.
3. Never intentionally omit any sentence, statement, number, date, symbol, or instruction.
4. Correct genuine OCR, spelling, punctuation, or grammatical errors only.
5. Do not summarize or simplify the original English question.

For Match the Pairs (जोड्या जुळवा):
1. Preserve BOTH Group A (गट अ) and Group B (गट ब) completely.
2. Restore any missing item from the image.
3. Never omit matching targets.

================================================================
EXPLANATION RULES (fixed_explanation)
================================================================

1. Use numbered pointers:
1., 2., 3., etc.
Put EACH numbered pointer on its own NEW LINE (a line break between pointers inside the JSON string). Use plain text only: no markdown, no ** bold, no bullet symbols.

2. Do NOT give a childish, superficial, overly simplified, or one-line explanation. The student is an MPSC aspirant and needs strong factual and conceptual understanding.

3. NO LIMIT ON THE NUMBER OF POINTS:
There is NO minimum and NO maximum number of pointers. Write as many numbered pointers as the topic genuinely needs.

Include EVERY important fact, date, concept, person, place, law, classification, exception, comparison and related detail connected with the question and its underlying topic. Do not hold back information because of length.

The only restriction is correctness: never include wrong, doubtful or invented data.

4. MANDATORY FACT AND CONCEPT COVERAGE CHECK:

Before writing the final explanation, first identify the complete set of important facts required to understand the topic.

Do not select only a few convenient facts.

Wherever genuinely relevant, actively check for and include:

- Important dates, years, periods, timelines, and chronological sequence.
- Important concepts and their exact meaning.
- Definitions and key terminology.
- Origin, background, and historical context.
- Important persons and their contributions.
- Important organizations, committees, and institutions.
- Important events and their causes and consequences.
- Important laws, acts, constitutional provisions, articles, amendments, policies, and schemes.
- Classifications, types, stages, components, and important features.
- Relationships, differences, comparisons, and common confusion points.
- Exceptions, limitations, special cases, and factual corrections.
- Important places, locations, regions, and geographical context.
- Relevant statistics and data.
- Formulas, scientific principles, mechanisms, and processes.
- Directly related concepts necessary to understand the complete parent topic.

5. DATE PRESERVATION RULE:

If an exact date, year, period, or chronological event is important for understanding the topic or is exam-relevant, DO NOT omit it.

Do not replace important exact dates with vague phrases such as:
"later"
"after that"
"during that period"
"in the following years"

when the exact date or year is known and relevant.

6. CONCEPT COMPLETENESS RULE:

Do not explain only the fact directly asked in the question.

Identify the underlying concept and cover its essential components, related concepts, background, mechanism, classification, important dates, chronology, and important exceptions wherever genuinely relevant.

7. NEW DISTINCT FACT RULE:

Whenever a genuinely new and distinct important fact, concept, event, feature, exception, date, person, place, classification, comparison, or related subtopic is added, prefer creating a NEW numbered pointer.

Do NOT merely stretch an existing pointer by merging many independent facts into one excessively long paragraph.

Related facts belonging to the same concept may remain together in one pointer.

8. NO LIMIT ON LENGTH:
There is NO word limit for a pointer or for the whole explanation. A pointer may be as long as the concept needs. Prefer separate pointers for separate facts so that revision stays easy.

Do NOT repeat the same information merely to make the explanation look bigger.

9. WRITE FROM SCRATCH:

Write the explanation entirely yourself, in your own words, from verified facts. Do not assume anything about any older explanation: none is provided.

Actively check what important dates, concepts, subtopics, background, classifications, chronology, mechanisms, exceptions, comparisons, examples, or related facts must be included, and include all of them.

10. TOPIC COVERAGE:

Where genuinely relevant, cover:

- Definitions and core concepts
- Background and origin
- History and chronology
- Important dates and timelines
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

Do NOT force every category into every explanation.

Use only genuinely relevant information, but do NOT skip an important relevant area merely to keep the answer short.

11. NO FILLER:

Never use generic filler such as:
"This topic is important for MPSC."
"Students should study this topic deeply."
"This question can be asked frequently."

Do not merely say what MPSC may ask.

Directly explain the actual facts, concepts, variations, and details that the student needs to know.

Every numbered pointer must contain useful factual, conceptual, analytical, or explanatory value.

12. ACCURACY AND RELEVANCE:

Do NOT add random or unrelated information merely to increase the number of pointers.

Every point must be:
- Factually accurate.
- Directly or meaningfully relevant.
- Useful for understanding or revision.
- Non-repetitive.

Prefer maximum relevant coverage over unnecessary brevity, but NEVER sacrifice factual accuracy merely to make the explanation longer.

13. FAST REVISION PRIORITY:

Structure the explanation so that important distinct facts are easy to find during revision.

Prefer separate numbered pointers for separate important pieces of information instead of hiding many independent facts inside a few very long paragraphs.

The goal is:

MAXIMUM RELEVANT INFORMATION
+
CLEAR SEPARATE POINTS
+
IMPORTANT DATES AND CONCEPTS
+
FAST REVISION.

14. MEMORY TRICKS:

If genuinely useful, add a short mnemonic or memory trick at the end.

Do not force an artificial mnemonic.

15. FINAL MISSING-FACT AUDIT:

Before producing the final JSON, check:

- Have I missed any important date or chronological event?
- Have I missed any core concept or definition?
- Have I skipped important background information?
- Have I omitted an important person or contribution?
- Have I omitted an important institution or committee?
- Have I omitted an important law, article, act, amendment, policy, or scheme?
- Have I explained only the answer instead of the complete underlying topic?
- Did I reconstruct all missing information visible in the image?
- Did I cover every important fact of the topic, however many pointers that needs?

If any important relevant information is missing, add it before finalizing.

================================================================
CANCELLED/INVALID QUESTION RULE
================================================================

If "correct_answer_option" is "#", begin the explanation with:

"हा प्रश्न MPSC कडून रद्द करण्यात आला आहे कारण..."

Then explain:
1. Why the options are invalid or ambiguous.
2. What the actual correct factual position is.
3. The important related facts needed to understand the topic.

================================================================
CURRENT DATA RULES
================================================================

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

================================================================
OPTIONS EXPLANATION (fixed_options_explanation)
================================================================

Explain ALL four options.

For each option:
1. Explain what the option actually refers to.
2. State whether it is correct or incorrect.
3. Explain the exact factual reason.
4. If partially correct, identify the exact incorrect part.
5. Do not simply write "Incorrect."

================================================================
FINAL SELF-CHECK
================================================================

Before output, verify:

- I inspected the image when one was provided.
- I reconstructed missing Marathi content from the image where necessary.
- I reconstructed missing English content from the image where necessary.
- I independently solved the COMPLETE question.
- I solved the question from scratch; no old answer or old explanation was used.
- I preserved the complete Marathi question.
- I preserved or reconstructed the complete English question.
- I preserved or reconstructed all options.
- I wrote the explanation in my own words and added all relevant information.
- I included important dates and concepts wherever relevant.
- I used separate numbered pointers for distinct important facts whenever appropriate.
- I did not limit myself to any number of points or words; I covered everything important and correct.
- I covered important topic context and directly related concepts.
- I avoided filler, repetition, irrelevant information, and hallucinated facts.
- I explained all options factually.
- The explanation provides maximum relevant coverage while remaining easy and fast to revise.

================================================================
CURRENT DATA
================================================================

- Question Number: ${questionData.qnum !== undefined && questionData.qnum !== null ? questionData.qnum : "unknown"}
- Exam: ${questionData.year_exam || questionData.official_exam_name || "unknown"}
- Question Text (Marathi): ${questionData.text}
- Question Text (English): ${questionData.text_eng || ""}
- Options (Marathi): ${JSON.stringify(questionData.options)}
- Options (English): ${JSON.stringify(questionData.options_eng || [])}
(No answer key and no previous explanation are provided. Solve and explain from scratch.)

Output STRICTLY as a valid JSON object with NO markdown, NO code fences, and NO text outside the JSON:

{
  "thought_process": "Brief factual verification summary only. Do not provide hidden chain-of-thought or an internal scratchpad. Give only concise, verifiable reasoning and conclusions.",
  "fixed_text": "Corrected and complete Marathi question text, reconstructed from the image when necessary",
  "fixed_text_eng": "Corrected and complete English question text, reconstructed from the image when necessary",
  "fixed_options": [
    "complete Marathi option 1",
    "complete Marathi option 2",
    "complete Marathi option 3",
    "complete Marathi option 4"
  ],
  "fixed_options_eng": [
    "complete English option 1",
    "complete English option 2",
    "complete English option 3",
    "complete English option 4"
  ],
  "correct_answer_option": "1, 2, 3, 4, or #",
  "fixed_explanation": "Complete Marathi explanation as numbered pointers: as many pointers and as many words as the topic needs, covering every important fact; only correct data",
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
                // StringDecoder keeps multi-byte (Marathi) characters intact across network chunks
                const decoder = new (require('string_decoder').StringDecoder)('utf8');
                resp.data.on('data', chunk => {
                    buffer += decoder.write(chunk);
                    let lines = buffer.split('\n');
                    buffer = lines.pop(); // keep incomplete line
                    
                    for (let line of lines) {
                        line = line.trim();
                        if (line.startsWith('data: ')) {
                            const dataStr = line.substring(6).trim();
                            if (!dataStr) continue;
                            try {
                                const data = JSON.parse(dataStr);
                                const textChunk = extractText(data);
                                if (textChunk) {
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
                            fullText += extractText(data);
                        } catch(e) {}
                    }
                    resolve();
                });
                resp.data.on('error', reject);
            });

            const rawParsed = parseAiJson(fullText);
            if (!rawParsed || typeof rawParsed !== 'object') throw new Error('AI returned invalid JSON');
            const parsed = normalizeAiFix(rawParsed, questionData); // throws -> automatic retry, nothing is saved
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
                } else if (status === 404) {
                    // Model does not exist / retired -> stop using it until restart
                    const body = await readErrorBody(error);
                    if (onChunk) onChunk(`\n[System] ERROR 404: model "${model}" not found/retired. Disabling it. ${body}`);
                    console.error(`Model ${model} returned 404, disabling. ${body}`);
                    await AiKey.updateMany({ model }, { $set: { isAvailable: false, status: "NotFound" } });
                    lastError = `Model ${model} not found (404)`;
                    attempts++;
                } else {
                    const body = await readErrorBody(error);
                    lastError = `API Error ${status}${body ? ': ' + body : ''}`;
                    if (onChunk) onChunk(`\n[System] ERROR ${status} on ${model}: ${body}`);
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
    fixQuestionWithAI,
    normalizeAiFix
};

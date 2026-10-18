/**
 * utils/answerKeyService.js
 * ──────────────────────────────────────────────────────────────────────────
 * Official answer-key PDF  ->  verified answers per set  +  page images on Telegram
 *
 *  1. read the PDF text TWICE with two independent passes
 *       pass 1  : pdftotext -layout  (+ our table / "Set A" parser)
 *       pass 2  : Gemini vision on the rendered pages (if Gemini keys exist)
 *                 otherwise pdftotext -raw (a different reading order, parsed again)
 *     an answer is "verified" only when BOTH passes read the same value. Anything else is reported as a
 *     conflict / single-source answer and the admin must confirm it before it can be saved.
 *  2. render every PDF page to a JPEG and upload it to the Telegram channel (round-robin over all bots, same as
 *     add_exam.py). We keep { botIdx: fileId } (what the site's image proxy needs) + the Telegram message id.
 *  3. compare the official answers of one set with the site's final answers (correct_answer_option) -> match %.
 *
 * Needs `poppler-utils` (pdftotext, pdftoppm, pdfinfo) on the server - installed in the Dockerfile.
 * ──────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const MAX_PAGES = 40;
const RENDER_DPI = 130;
const SET_LETTERS = 'ABCD';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ──────────────────────────── small helpers ────────────────────────────
function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { maxBuffer: 80 * 1024 * 1024, timeout: 120000, ...opts }, (err, stdout, stderr) => {
            if (err) {
                if (err.code === 'ENOENT') return reject(new Error(`'${cmd}' is not installed on the server (apt-get install poppler-utils).`));
                return reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(0, 300)}`));
            }
            resolve(stdout);
        });
    });
}

const toAscii = (s) => String(s == null ? '' : s).replace(/[०-९]/g, c => String('०१२३४५६७८९'.indexOf(c)));

// "B" -> '2' | "A/C" -> '1/3' | "Dropped"/"X"/"#"/"रद्द" -> '#' | digits 1-4 stay | anything else -> ''
function normAnswer(raw) {
    let s = toAscii(raw).trim();
    if (!s) return '';
    if (/^(#|\*|x|drop(ped)?|cancel(l)?ed|deleted|रद्द|रद्ध)$/i.test(s)) return '#';
    s = s.replace(/[()\[\]\s]/g, '');
    const parts = s.split(/[\/,&]|or|and/i).filter(Boolean);
    if (!parts.length) return '';
    const out = [];
    for (const p of parts) {
        if (/^[A-D]$/.test(p)) out.push(String(SET_LETTERS.indexOf(p) + 1));
        else if (/^[a-d]$/.test(p) && /[()\[\]]/.test(String(raw))) out.push(String('abcd'.indexOf(p) + 1));
        else if (/^[1-4]$/.test(p)) out.push(p);
        else return '';
    }
    return [...new Set(out)].sort().join('/');
}

// ──────────────────────────── text parser ────────────────────────────
const SET_WORD = '(?:set|series|code|संच|सेट|प्रश्नपत्रिका|पत्रिका)';
const SET_MENTION = new RegExp(`${SET_WORD}\\s*(?:no\\.?|क्र\\.?)?\\s*[:\\-–]?\\s*\\(?([A-D])\\)?(?![A-Za-z])`, 'gi');
const LABEL_WORDS = /^(question|questions|q|no|qn|sr|sr\.|number|प्रश्न|क्र|क्रमांक|क्र\.|प्र\.|प्रश्नक्रमांक|answer|answers|key|ans|उत्तर|उत्तरे|स्तंभ|\.|-|:|\|)+$/i;

const ANS_TOKEN = '(\\(?[A-D]\\)?(?:\\s*[\\/,]\\s*\\(?[A-D]\\)?)*|[X#*]|Dropped|Cancelled|Canceled|रद्द|रद्ध)';
// "1 B", "1-B", "1. B", "1)B", "1:B"  (letters)      and   "1-3", "1) 2" (digit answers - need a separator)
const PAIR_LETTER = new RegExp(`(?<![\\d.])(\\d{1,3})\\s*[.\\-–:)]?\\s*${ANS_TOKEN}(?![A-Za-z])`, 'gi');
const PAIR_DIGIT = /(?<![\d.])(\d{1,3})\s*[.\-–:)]\s*([1-4](?:\s*\/\s*[1-4])*)(?![\d])/g;

function splitTokens(line) {
    return line.replace(/\|/g, ' ').split(/[\s;]+/).filter(Boolean);
}

// Detects a table header line -> ['A','B','C','D'] (or null)
function detectHeader(line) {
    const mentions = [...line.matchAll(SET_MENTION)].map(m => m[1].toUpperCase());
    const distinct = [...new Set(mentions)];
    if (distinct.length >= 2) return distinct;
    const toks = splitTokens(line);
    if (toks.length >= 2) {
        const letters = toks.filter(t => /^\(?[A-D]\)?$/.test(t)).map(t => t.replace(/[()]/g, ''));
        const rest = toks.filter(t => !/^\(?[A-D]\)?$/.test(t));
        if (letters.length >= 2 && new Set(letters).size === letters.length && rest.every(t => LABEL_WORDS.test(t))) return letters;
    }
    return null;
}

// Rows of a table that has NO header (no "Set A..D" printed - e.g. MPSC keys):  "q a a a a" (+ more blocks on the same line)
// Columns are the sets A, B, C, D in order. Only digits 1-4 / # are accepted as answers here, so a letter-pair line
// like "1 B 2 D 3 A" can never be mistaken for a table row.
const HEADERLESS_SETS = ['A', 'B', 'C', 'D'];
function isHeaderlessRow(line) {
    const toks = splitTokens(line);
    const block = 1 + HEADERLESS_SETS.length;
    if (toks.length < block || toks.length % block !== 0) return false;
    let prev = 0;
    for (let i = 0; i < toks.length; i += block) {
        if (!/^\d{1,3}$/.test(toks[i])) return false;
        const q = +toks[i];
        if (!(q >= 1 && q <= 300) || q <= prev) return false;
        prev = q;
        for (let k = 1; k < block; k++) if (!/^[1-4#]$/.test(toks[i + k])) return false;
    }
    return true;
}

/**
 * @param {string[]} pages text of every page
 * @returns {{sets: Object, pages: Object, mode: string}}
 */
function parseKeyText(pages) {
    const sets = {}, pageOf = {};
    let current = null;          // "Set A" section mode
    let table = null;            // ['A','B','C','D'] table mode
    let sawTable = false, sawSection = false, headerless = false;

    const put = (set, q, ans, page) => {
        q = Number(q);
        if (!(q >= 1 && q <= 300) || !ans) return;
        (sets[set] = sets[set] || {});
        (pageOf[set] = pageOf[set] || {});
        if (sets[set][q] === undefined) { sets[set][q] = ans; pageOf[set][q] = page; }
    };

    pages.forEach((text, pi) => {
        const page = pi + 1;
        for (const raw of String(text || '').split(/\r?\n/)) {
            let line = raw.replace(/\u00a0/g, ' ').trim();
            if (!line) continue;

            const header = detectHeader(line);
            if (header) { table = header; current = null; sawTable = true; header.forEach(s => { sets[s] = sets[s] || {}; pageOf[s] = pageOf[s] || {}; }); continue; }

            const mentions = [...line.matchAll(SET_MENTION)];
            if (mentions.length === 1) {
                current = mentions[0][1].toUpperCase(); table = null; sawSection = true;
                sets[current] = sets[current] || {}; pageOf[current] = pageOf[current] || {};
                line = line.replace(SET_MENTION, ' ').trim();
                if (!line) continue;
            }

            // first row of a table without any header -> columns are the sets A-D
            if (!table && !current && isHeaderlessRow(line)) {
                table = HEADERLESS_SETS.slice(); sawTable = true; headerless = true;
                table.forEach(s => { sets[s] = sets[s] || {}; pageOf[s] = pageOf[s] || {}; });
            }

            // ---- table rows: "q a a a a" (possibly several blocks on one line) ----
            if (table) {
                const toks = splitTokens(line);
                const block = 1 + table.length;
                if (toks.length >= block && toks.length % block === 0 && /^\d{1,3}$/.test(toks[0])) {
                    const staged = [];
                    let ok = true;
                    for (let i = 0; i < toks.length && ok; i += block) {
                        if (!/^\d{1,3}$/.test(toks[i])) { ok = false; break; }
                        const answers = toks.slice(i + 1, i + block).map(normAnswer);
                        if (answers.some(a => !a)) { ok = false; break; }
                        staged.push([toks[i], answers]);
                    }
                    if (ok) { staged.forEach(([q, answers]) => answers.forEach((a, k) => put(table[k], q, a, page))); continue; }
                }
                continue; // in table mode other lines are titles / noise
            }

            // ---- section mode: "1 B  2 D  3 A ..." ----
            const target = current || '_';
            let found = false;
            for (const m of line.matchAll(PAIR_LETTER)) { const a = normAnswer(m[2]); if (a) { put(target, m[1], a, page); found = true; } }
            if (!found) for (const m of line.matchAll(PAIR_DIGIT)) { const a = normAnswer(m[2]); if (a) put(target, m[1], a, page); }
        }
    });

    // a key without any "Set" heading is a single set
    if (sets._) {
        if (!Object.keys(sets).filter(k => k !== '_').length) { sets.A = sets._; pageOf.A = pageOf._; }
        delete sets._; delete pageOf._;
    }
    for (const k of Object.keys(sets)) if (!Object.keys(sets[k]).length) { delete sets[k]; delete pageOf[k]; }
    return { sets, pages: pageOf, mode: sawTable ? (headerless ? 'table-noheader' : 'table') : (sawSection ? 'sections' : 'single'), headerless };
}

// ──────────────────────────── PDF -> text / images ────────────────────────────
async function pdfPageCount(pdfPath) {
    const out = await run('pdfinfo', [pdfPath]);
    const m = out.match(/^Pages:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : 0;
}

async function pdfTextPages(pdfPath, mode /* 'layout' | 'raw' */) {
    const out = await run('pdftotext', [mode === 'raw' ? '-raw' : '-layout', '-enc', 'UTF-8', pdfPath, '-']);
    const pages = out.split('\f');
    if (pages.length && !pages[pages.length - 1].trim()) pages.pop();
    return pages;
}

async function renderPages(pdfPath, outDir) {
    await fsp.mkdir(outDir, { recursive: true });
    await run('pdftoppm', ['-jpeg', '-jpegopt', 'quality=85', '-r', String(RENDER_DPI), pdfPath, path.join(outDir, 'page')], { timeout: 300000 });
    const files = (await fsp.readdir(outDir)).filter(f => /^page-\d+\.jpg$/i.test(f))
        .map(f => ({ page: parseInt(f.match(/-(\d+)\.jpg$/i)[1], 10), file: path.join(outDir, f) }))
        .sort((a, b) => a.page - b.page);
    return files;
}

// ──────────────────────────── Gemini vision pass (optional) ────────────────────────────
const vision = require('./visionAI');
const aiAvailable = () => vision.available();   // async: true when Fix-AI providers (Gemini keys or a custom endpoint) can answer

const AI_PROMPTS = [
    `This is ONE page of an official exam ANSWER KEY. Read every answer printed on this page.
Return ONLY JSON: {"sets": {"A": {"1": "B", "2": "D"}, "B": {...}}}
Rules: the key of "sets" is the question-paper set letter exactly as printed (A, B, C or D). If this page prints no set letter at all use "?".
Question numbers are the keys. Each answer is a single letter A-D, "A/C" when several options are accepted, or "#" when the question is dropped / cancelled / all options accepted-as-cancelled.
If the page shows a table with one column per set, fill every set. Copy exactly what is printed - never guess, never fill a gap. Skip anything that is not an answer.`,
    `You are reading a page of an official answer key. Go row by row, column by column, and list the answer of every question number you can see.
Output ONLY this JSON shape: {"sets": {"<set letter>": {"<question number>": "<answer>"}}}
<set letter> = A, B, C or D as printed (use "?" if the page does not show it). <answer> = one letter A-D, several like "B/D", or "#" for dropped / cancelled questions.
Do not invent answers. If a cell is unreadable leave that question out.`
];

function parseAiJson(text) {
    const t = String(text || '').replace(/```json|```/g, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

async function aiReadPages(imageFiles, variant, onProgress) {
    const sets = {}, pageOf = {};
    let failedPages = 0;
    for (let i = 0; i < imageFiles.length; i++) {
        const { page, file } = imageFiles[i];
        if (onProgress) onProgress(`AI vision pass ${variant + 1}: page ${page}/${imageFiles.length}`);
        const b64 = (await fsp.readFile(file)).toString('base64');
        const parts = [{ b64 }, { text: AI_PROMPTS[variant % AI_PROMPTS.length] }];
        let parsed = null;
        for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
            try { parsed = parseAiJson(await vision.ask(parts, { json: true, maxTokens: 8192 })); }
            catch (e) { if (attempt === 1) console.warn('answer key AI page', page, 'failed:', e.message); await sleep(1500); }
        }
        if (!parsed || !parsed.sets || typeof parsed.sets !== 'object') { failedPages++; continue; }
        for (const [setName, rows] of Object.entries(parsed.sets)) {
            const sn = String(setName).trim().toUpperCase().replace(/[^A-D?]/g, '').slice(0, 1) || '?';
            if (!rows || typeof rows !== 'object') continue;
            for (const [q, a] of Object.entries(rows)) {
                const qn = parseInt(toAscii(q), 10), ans = normAnswer(a);
                if (!(qn >= 1 && qn <= 300) || !ans) continue;
                (sets[sn] = sets[sn] || {}); (pageOf[sn] = pageOf[sn] || {});
                if (sets[sn][qn] === undefined) { sets[sn][qn] = ans; pageOf[sn][qn] = page; }
            }
        }
    }
    if (sets['?']) {          // pages without a printed set letter
        const named = Object.keys(sets).filter(k => k !== '?');
        if (!named.length) { sets.A = sets['?']; pageOf.A = pageOf['?']; }
        delete sets['?']; delete pageOf['?'];
    }
    return { sets, pages: pageOf, failedPages };
}

// ──────────────────────────── 2-pass verification ────────────────────────────
const countSets = (r) => Object.fromEntries(Object.entries(r.sets).map(([k, v]) => [k, Object.keys(v).length]));

/**
 * Merge two readings. An answer is verified only when both agree.
 * Returns { sets, pages, conflicts[{set,q,a,b}], onlyOne[{set,q,value,from}], perSet }
 */
function mergePasses(p1, p2) {
    const sets = {}, pages = {}, conflicts = [], onlyOne = [], perSet = {};
    const names = [...new Set([...Object.keys(p1.sets), ...Object.keys(p2.sets)])].sort();
    for (const s of names) {
        const A = p1.sets[s] || {}, B = p2.sets[s] || {};
        const qs = [...new Set([...Object.keys(A), ...Object.keys(B)])].map(Number).sort((x, y) => x - y);
        sets[s] = {}; pages[s] = {};
        let agreed = 0, conf = 0, single = 0;
        for (const q of qs) {
            const a = A[q], b = B[q];
            if (a && b && a === b) { sets[s][q] = a; pages[s][q] = (p1.pages[s] && p1.pages[s][q]) || (p2.pages[s] && p2.pages[s][q]) || null; agreed++; }
            else if (a && b) { conflicts.push({ set: s, q, a, b }); conf++; }
            else { onlyOne.push({ set: s, q, value: a || b, from: a ? 1 : 2 }); single++; }
        }
        const max = qs.length ? qs[qs.length - 1] : 0;
        const known = new Set(qs);
        const gaps = []; for (let i = 1; i <= max; i++) if (!known.has(i)) gaps.push(i);
        perSet[s] = { total: qs.length, agreed, conflicts: conf, onlyOne: single, highest: max, gaps: gaps.slice(0, 60) };
    }
    return { sets, pages, conflicts, onlyOne, perSet };
}

// page -> best guess for a conflicting / single-source answer (so the admin sees which page to look at)
function pageForUnverified(p1, p2, set, q) {
    return (p1.pages[set] && p1.pages[set][q]) || (p2.pages[set] && p2.pages[set][q]) || null;
}

async function extractVerified(pdfPath, workDir, onProgress) {
    const say = (m) => { if (onProgress) onProgress(m); };
    const pageCount = await pdfPageCount(pdfPath);
    if (!pageCount) throw new Error('Could not read this PDF (0 pages).');
    if (pageCount > MAX_PAGES) throw new Error(`PDF has ${pageCount} pages - an answer key should not be longer than ${MAX_PAGES} pages.`);

    say('Rendering pages…');
    const images = await renderPages(pdfPath, path.join(workDir, 'pages'));
    if (!images.length) throw new Error('Could not render the PDF pages.');

    say('Pass 1: reading the PDF text…');
    const layoutPages = await pdfTextPages(pdfPath, 'layout');
    const textLen = layoutPages.join('').replace(/\s+/g, '').length;
    const hasText = textLen > 30;

    const engines = [];
    let p1, p2;

    if (hasText) {
        p1 = parseKeyText(layoutPages);
        engines.push({ name: 'pdftotext-layout', sets: countSets(p1) });
        let usedAi = false;
        if (await aiAvailable()) {
            try {
                say('Pass 2: AI vision verification…');
                const ai = await aiReadPages(images, 0, say);
                if (Object.keys(ai.sets).length && ai.failedPages < images.length) { p2 = ai; usedAi = true; engines.push({ name: 'gemini-vision', sets: countSets(ai), failedPages: ai.failedPages }); }
            } catch (e) { console.warn('answer key AI pass failed:', e.message); }
        }
        if (!usedAi) {
            say('Pass 2: second text reading (raw order)…');
            p2 = parseKeyText(await pdfTextPages(pdfPath, 'raw'));
            engines.push({ name: 'pdftotext-raw', sets: countSets(p2) });
        }
    } else {
        // scanned PDF: no text layer -> two independent AI vision reads
        if (!(await aiAvailable())) throw new Error('This PDF is a scan (no text layer) and no AI provider (Gemini key / custom endpoint) is configured, so it cannot be read.');
        say('Scanned PDF - AI vision pass 1…');
        p1 = await aiReadPages(images, 0, say);
        engines.push({ name: 'gemini-vision-1', sets: countSets(p1), failedPages: p1.failedPages });
        say('Scanned PDF - AI vision pass 2…');
        p2 = await aiReadPages(images, 1, say);
        engines.push({ name: 'gemini-vision-2', sets: countSets(p2), failedPages: p2.failedPages });
    }

    if (!Object.keys(p1.sets).length && !Object.keys(p2.sets).length) {
        throw new Error('No answers could be found in this PDF. The format may not be supported.');
    }

    const merged = mergePasses(p1, p2);
    const unverified = [
        ...merged.conflicts.map(c => ({ ...c, page: pageForUnverified(p1, p2, c.set, c.q) })),
        ...merged.onlyOne.map(o => ({ set: o.set, q: o.q, a: o.from === 1 ? o.value : null, b: o.from === 2 ? o.value : null, page: pageForUnverified(p1, p2, o.set, o.q) }))
    ].sort((x, y) => x.set.localeCompare(y.set) || x.q - y.q);

    // plain-language warnings shown to the admin
    const notes = [];
    if (p1.headerless) notes.push('This PDF does not print the set letters. The 4 answer columns are taken as Set A, B, C, D in the order printed - check this against your question paper.');
    if (engines.length === 2 && engines.every(e => e.name.startsWith('pdftotext'))) notes.push('Both readings use the PDF text layer (no Gemini key), so they confirm the parsing but not the PDF text itself. Check the match % before saving.');
    for (const [name, ps] of Object.entries(merged.perSet)) {
        if (ps.gaps.length) notes.push(`Set ${name}: question number(s) ${ps.gaps.slice(0, 15).join(', ')}${ps.gaps.length > 15 ? '…' : ''} are missing in the key.`);
    }
    const counts = Object.values(merged.perSet).map(p => p.total);
    if (counts.length > 1 && Math.max(...counts) !== Math.min(...counts)) notes.push('The sets do not have the same number of answers - something may have been read wrongly.');

    return {
        pageCount, images, sets: merged.sets, pages: merged.pages,
        verification: {
            engines, mode: p1.mode || null, perSet: merged.perSet, notes,
            unverified,                       // [{set,q,a (pass 1),b (pass 2),page}]
            verifiedAt: new Date().toISOString()
        },
        // kept so the admin can pick a value for an unverified answer
        candidates: { p1: p1.sets, p2: p2.sets }
    };
}

// ──────────────────────────── Telegram upload ────────────────────────────
const botTokens = () => (process.env.TELEGRAM_BOT_TOKENS || '').split(',').map(t => t.replace(/['"]/g, '').trim()).filter(Boolean);
const channelId = () => String(process.env.TELEGRAM_CHANNEL_ID || '').replace(/['"]/g, '').trim();
let rr = 0;

/** Uploads one file as a Telegram DOCUMENT (original quality - sendPhoto would shrink a tiny-print table). */
async function uploadFile(buffer, filename, mime, caption) {
    const tokens = botTokens(), chat = channelId();
    if (!tokens.length || !chat) throw new Error('TELEGRAM_BOT_TOKENS / TELEGRAM_CHANNEL_ID is not configured.');
    let lastErr = 'unknown error';
    for (let attempt = 0; attempt < tokens.length * 2; attempt++) {
        const idx = rr++ % tokens.length;
        try {
            const form = new FormData();
            form.append('chat_id', chat);
            if (caption) form.append('caption', caption.slice(0, 900));
            form.append('document', new Blob([buffer], { type: mime }), filename);
            const res = await fetch(`https://api.telegram.org/bot${tokens[idx]}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
            const j = await res.json().catch(() => ({}));
            if (j.ok && j.result && j.result.document) {
                await sleep(800); // be friendly to Telegram
                return { ref: { [String(idx)]: j.result.document.file_id }, messageId: j.result.message_id, chatId: String(j.result.chat && j.result.chat.id || chat) };
            }
            lastErr = j.description || ('HTTP ' + res.status);
            if (res.status === 429) await sleep(((j.parameters && j.parameters.retry_after) || 5) * 1000 + 500);
        } catch (e) { lastErr = e.message; await sleep(2000); }
    }
    throw new Error('Telegram upload failed: ' + lastErr);
}

async function uploadPages(images, label, onProgress) {
    const out = [];
    for (const im of images) {
        if (onProgress) onProgress(`Uploading page ${im.page}/${images.length} to Telegram…`);
        const buf = await fsp.readFile(im.file);
        const r = await uploadFile(buf, `answer_key_p${String(im.page).padStart(2, '0')}.jpg`, 'image/jpeg', `Official Answer Key | ${label || ''} | page ${im.page}`);
        out.push({ page: im.page, ref: r.ref, messageId: r.messageId, chatId: r.chatId });
    }
    return out;
}

// ──────────────────────────── comparison with the site's final answers ────────────────────────────
const finalOf = (q) => String(q.correct_answer_option != null && q.correct_answer_option !== '' ? q.correct_answer_option : (q.final_answer_key || '')).trim();
const officialMatches = (official, final) => String(official).split('/').includes(String(final));

/**
 * @param {Object} setAnswers { "1": "2", ... }   (already including admin overrides)
 * @param {Array}  questions  Question docs (lean) of ONE exam
 */
function compare(setAnswers, questions) {
    let compared = 0, matched = 0, noFinal = 0, noOfficial = 0;
    const mismatches = [];
    const seen = new Set();
    for (const q of questions) {
        const n = Number(q.qnum);
        if (!(n > 0)) continue;
        seen.add(n);
        const off = setAnswers[n];
        const fin = finalOf(q);
        if (!off) { noOfficial++; continue; }
        if (!fin) { noFinal++; continue; }
        compared++;
        if (officialMatches(off, fin)) matched++;
        else mismatches.push({ q: n, final: fin, official: off });
    }
    mismatches.sort((a, b) => a.q - b.q);
    const officialOnly = Object.keys(setAnswers).map(Number).filter(n => !seen.has(n)).length;
    return {
        examQuestions: questions.length, officialAnswers: Object.keys(setAnswers).length,
        compared, matched, mismatched: compared - matched, noFinal, noOfficial, officialOnly,
        percent: compared ? Math.round((matched / compared) * 10000) / 100 : 0,
        mismatches
    };
}


// ──────────────────────────── Re-scan by AI (admin button) ────────────────────────────
// Reads the SAVED page images again with the AI (a different prompt than the first AI read) and merges the new reading
// into the existing result by voting: an unverified answer becomes verified as soon as two readings agree.
// Nothing that is already verified is ever changed (a different value is only counted in the summary).

/** Downloads one saved page image ({botIdx: fileId}) from the Telegram channel. */
async function downloadRef(ref) {
    const tokens = botTokens();
    const entries = Object.entries(ref && typeof ref === 'object' ? ref : {}).filter(([, id]) => id);
    const order = [];
    for (const [idx, id] of entries) if (tokens[+idx]) order.push([tokens[+idx], id]);          // the bot that uploaded it first
    for (const [, id] of entries) for (const t of tokens) if (!order.some(o => o[0] === t && o[1] === id)) order.push([t, id]);
    for (const [token, id] of order) {
        try {
            const r = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15000) });
            const j = await r.json().catch(() => ({}));
            if (!j.ok || !j.result || !j.result.file_path) continue;
            const f = await fetch(`https://api.telegram.org/file/bot${token}/${j.result.file_path}`, { signal: AbortSignal.timeout(60000) });
            if (!f.ok) continue;
            const buf = Buffer.from(await f.arrayBuffer());
            if (buf.length) return buf;
        } catch (e) { /* try the next bot */ }
    }
    throw new Error('Could not download a key page image from Telegram.');
}

function recomputePerSet(sets, unverified) {
    const perSet = {};
    const names = [...new Set([...Object.keys(sets), ...unverified.map(u => u.set)])].sort();
    for (const s of names) {
        const ver = Object.keys(sets[s] || {}).map(Number);
        const unv = unverified.filter(u => u.set === s);
        let conflicts = 0, onlyOne = 0;
        for (const u of unv) {
            const distinct = new Set([u.a, u.b, ...(u.r || [])].filter(Boolean));
            if (distinct.size >= 2) conflicts++; else onlyOne++;
        }
        const all = [...ver, ...unv.map(u => u.q)];
        const highest = all.length ? Math.max(...all) : 0;
        const known = new Set(all);
        const gaps = []; for (let i = 1; i <= highest; i++) if (!known.has(i)) gaps.push(i);
        perSet[s] = { total: all.length, agreed: ver.length, conflicts, onlyOne, highest, gaps: gaps.slice(0, 60) };
    }
    return perSet;
}

/**
 * @param {{sets,pages,verification}} base  what is stored now
 * @param {{sets,pages}} R                  the new AI reading
 * unverified entry = { set, q, a (pass 1), b (pass 2), r: [AI re-scan values], page }
 */
function mergeRescan(base, R) {
    const sets = JSON.parse(JSON.stringify(base.sets || {}));
    const pages = JSON.parse(JSON.stringify(base.pages || {}));
    const unv = JSON.parse(JSON.stringify((base.verification && base.verification.unverified) || []));
    const stats = { read: 0, confirmed: 0, added: 0, differsFromVerified: 0, stillUnverified: 0 };
    const idx = new Map(unv.map(u => [u.set + '|' + u.q, u]));

    for (const [set, rows] of Object.entries(R.sets || {})) {
        for (const [qRaw, val] of Object.entries(rows || {})) {
            const q = Number(qRaw); if (!val || !(q >= 1 && q <= 300)) continue;
            stats.read++;
            const page = (R.pages && R.pages[set] && R.pages[set][q]) || null;
            if (sets[set] && sets[set][q]) { if (sets[set][q] !== val) stats.differsFromVerified++; continue; }
            let u = idx.get(set + '|' + q);
            if (!u) { u = { set, q, a: null, b: null, r: [], page }; unv.push(u); idx.set(set + '|' + q, u); stats.added++; if (!sets[set]) sets[set] = {}; }
            u.r = [...(u.r || []), val].slice(-6);
            if (!u.page) u.page = page;
        }
    }

    const keep = [];
    for (const u of unv) {
        const votes = {};
        for (const v of [u.a, u.b, ...(u.r || [])]) if (v) votes[v] = (votes[v] || 0) + 1;
        const ranked = Object.entries(votes).sort((x, y) => y[1] - x[1]);
        if (ranked.length && ranked[0][1] >= 2 && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) {
            (sets[u.set] = sets[u.set] || {})[u.q] = ranked[0][0];
            (pages[u.set] = pages[u.set] || {})[u.q] = u.page || null;
            stats.confirmed++;
        } else keep.push(u);
    }
    keep.sort((x, y) => x.set.localeCompare(y.set) || x.q - y.q);
    stats.stillUnverified = keep.length;
    return { sets, pages, unverified: keep, perSet: recomputePerSet(sets, keep), stats };
}

/** @param key lean AnswerKey doc @returns { sets, pages, verification, stats } */
async function rescanByAi(key, workDir, onProgress, variant = 1) {
    const say = (m) => { if (onProgress) onProgress(m); };
    if (!(await aiAvailable())) throw new Error('No AI provider (Gemini key / custom endpoint) is configured.');
    const imgs = (key.images || []).slice().sort((a, b) => a.page - b.page);
    if (!imgs.length) throw new Error('This key has no saved page images.');
    await fsp.mkdir(workDir, { recursive: true });
    const files = [];
    for (const im of imgs) {
        say(`Downloading page ${im.page}/${imgs.length} from Telegram…`);
        const file = path.join(workDir, `page-${String(im.page).padStart(2, '0')}.jpg`);
        await fsp.writeFile(file, await downloadRef(im.ref));
        files.push({ page: im.page, file });
    }
    const R = await aiReadPages(files, variant, say);
    if (R.failedPages >= files.length) throw new Error('The AI could not read any page (all AI requests failed). Check AI Settings → Fix list, then try again.');
    if (!Object.keys(R.sets).length) throw new Error('The AI answered, but no answers were found on the pages.');
    const m = mergeRescan(key, R);
    const v = Object.assign({}, key.verification || {});
    v.engines = [...(v.engines || []), { name: 'gemini-vision-rescan', sets: countSets(R), failedPages: R.failedPages }];
    v.perSet = m.perSet; v.unverified = m.unverified;
    v.notes = (v.notes || []).filter(n => !/^AI re-scan/.test(n));
    v.notes.push(`AI re-scan: ${m.stats.read} answers read, ${m.stats.confirmed} newly confirmed, ${m.stats.stillUnverified} still unverified` +
        `${R.failedPages ? `, ${R.failedPages} page(s) could not be read` : ''}${m.stats.differsFromVerified ? `, ${m.stats.differsFromVerified} differ from already verified answers (not changed)` : ''}.`);
    v.verifiedAt = new Date().toISOString();
    return { sets: m.sets, pages: m.pages, verification: v, stats: Object.assign({ failedPages: R.failedPages }, m.stats) };
}

module.exports = {
    normAnswer, parseKeyText, mergePasses, extractVerified, uploadFile, uploadPages, compare, finalOf,
    aiAvailable, pdfPageCount, MAX_PAGES, renderPages, rescanByAi, mergeRescan, recomputePerSet, downloadRef
};

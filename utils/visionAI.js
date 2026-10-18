/**
 * utils/visionAI.js
 * ──────────────────────────────────────────────────────────────────────────
 * ONE way to ask the AI something about page images - using the SAME providers as "Fix AI"
 * (admin → 🤖 AI Settings → the "Fix" list: Gemini and/or your OpenAI-compatible custom endpoints, in the order and with
 * the fallback the admin configured there). Used by "Add New Exam" and by the official answer-key reader.
 *
 *   ask(parts, { json })   parts = [ { b64: '<jpeg base64>' }, ..., { text: 'prompt' } ]   ->  the AI's text answer
 * ──────────────────────────────────────────────────────────────────────────
 */
const chatProviders = require('./chatProviders');

const SCOPE = 'fix';
const geminiKeysSet = () => !!(process.env.GEMINI_API_KEYS && process.env.GEMINI_API_KEYS.replace(/['"]/g, '').trim());

async function providers() {
    try { return await chatProviders.getOrderedProviders(SCOPE); }
    catch (e) { console.error('visionAI: providers could not be loaded, using Gemini:', e.message); return [{ id: chatProviders.GEMINI_ID, type: 'gemini', name: 'Gemini', model: '' }]; }
}

/** true when at least one provider can answer (a custom endpoint, or Gemini with server keys). */
async function available() {
    const list = await providers();
    return list.some(p => p.type === 'openai') || geminiKeysSet();
}

/** a short human description for the admin screen */
async function describe() {
    const list = await providers();
    const usable = list.filter(p => p.type === 'openai' || geminiKeysSet());
    return usable.map(p => p.type === 'gemini' ? 'Gemini' + (p.model ? ' (' + p.model + ')' : '') : p.name + ' (' + p.model + ')');
}

async function askOne(p, parts, { json, maxTokens }) {
    const images = parts.filter(x => x.b64).map(x => x.b64);
    const text = parts.filter(x => x.text).map(x => x.text).join('\n\n');
    if (p.type === 'gemini') {
        const { chatViaGemini } = require('./aiService');
        const gp = parts.map(x => x.b64 ? { inlineData: { mimeType: 'image/jpeg', data: x.b64 } } : { text: x.text });
        const payload = { contents: [{ role: 'user', parts: gp }], generationConfig: { temperature: 0.1, maxOutputTokens: 32768 } };
        if (json) payload.generationConfig.responseMimeType = 'application/json';
        return chatViaGemini(payload, { model: p.model || undefined, maxAttempts: 4, maxWaitMs: 15000 });
    }
    return chatProviders.callOpenAI(p, { system: '', history: [], message: text, images },
        { timeoutMs: 300000, maxTokens, temperature: 0.1, jsonMode: !!json, keepImages: true, search: false });
}

async function ask(parts, { json = true, maxTokens = 12000 } = {}) {
    const list = await providers();
    const problems = [];
    let allResting = true, minRetry = Infinity, lastErr = null;
    for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p.type === 'gemini' && !geminiKeysSet()) { problems.push(`${p.name}: GEMINI_API_KEYS is not set`); continue; }
        const t0 = Date.now();
        try {
            const out = await askOne(p, parts, { json, maxTokens });
            chatProviders.markOk(SCOPE, p.id, Date.now() - t0);
            return out;
        } catch (e) {
            lastErr = e;
            const resting = !!(e && (e.aiResting || e.kind === 'rate'));
            if (!resting) allResting = false; else minRetry = Math.min(minRetry, e.retryAfterMs || 60000);
            try { chatProviders.markFail(SCOPE, p.id, e); } catch (x) { /* health only */ }
            problems.push(`${p.name}: ${e && e.message}`);
            console.warn(`visionAI: provider "${p.name}" failed (${(e && e.kind) || 'error'}): ${e && e.message}${i < list.length - 1 ? ' -> trying the next one' : ''}`);
        }
    }
    if (list.length === 1 && lastErr) throw lastErr;
    const err = new Error('All AI providers failed. ' + problems.join(' | ').slice(0, 900));
    if (lastErr && lastErr.kind === 'bad') err.kind = 'bad';
    if (allResting && lastErr) { err.kind = 'rate'; err.aiResting = true; err.retryAfterMs = Number.isFinite(minRetry) ? minRetry : 60000; }
    throw err;
}

module.exports = { ask, available, describe };

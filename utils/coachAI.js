/**
 * utils/coachAI.js - ONE text call to the AI providers the admin already configured for the Ask-AI chat
 * (same order, same fallback, same resting logic). No web search: the coach only reads the student's own numbers.
 */
const chatProviders = require('./chatProviders');

async function askCoach({ system, history, message, maxTokens = 3500 }) {
    const { chatViaGemini } = require('./aiService');
    let providers;
    try { providers = await chatProviders.getOrderedProviders('chat'); }
    catch (e) { providers = [{ id: chatProviders.GEMINI_ID, type: 'gemini', name: 'Gemini', model: '' }]; }

    const past = (Array.isArray(history) ? history : [])
        .filter(h => h && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string' && h.text.trim())
        .slice(-8).map(h => ({ role: h.role, text: h.text.slice(0, 1500) }));
    while (past.length && past[0].role !== 'user') past.shift();

    const problems = [];
    for (let i = 0; i < providers.length; i++) {
        const p = providers[i], isLast = i === providers.length - 1, t0 = Date.now();
        try {
            let text;
            if (p.type === 'gemini') {
                const contents = past.map(h => ({ role: h.role, parts: [{ text: h.text }] }));
                contents.push({ role: 'user', parts: [{ text: message }] });
                text = await chatViaGemini({
                    systemInstruction: { parts: [{ text: system }] }, contents,
                    generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens }
                }, { model: p.model, maxAttempts: isLast ? 4 : 2, maxWaitMs: isLast ? 20000 : 8000 });
            } else {
                text = await chatProviders.callOpenAI(p, { system, history: past, message, images: [] }, { timeoutMs: isLast ? 90000 : 50000, search: false });
            }
            chatProviders.markOk('chat', p.id, Date.now() - t0);
            return { text: String(text || '').replace(/\*\*/g, ''), provider: p.name };
        } catch (err) {
            chatProviders.markFail('chat', p.id, err);
            problems.push(`${p.name}: ${err.message}`);
            console.warn(`coach: provider "${p.name}" failed: ${err.message}`);
        }
    }
    const busy = problems.every(x => /rest|rate|quota|busy|429/i.test(x));
    throw new Error(busy ? 'AI is busy right now. Please try again in a minute.' : 'AI could not answer right now. Please try again.');
}

// the model may wrap JSON in ``` fences or add a sentence around it
function parseJsonLoose(text) {
    const t = String(text || '').replace(/```json|```/gi, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

module.exports = { askCoach, parseJsonLoose };

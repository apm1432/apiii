// =====================================================================
// AI PROVIDERS  (used by the "Ask AI" chat AND by "Question fix / deepen")
//
// There are two independent lists ("scopes"): 'chat' (Ask AI chat on every question) and 'fix' (admin Question fix + verification + deepen).
// The admin decides, from the admin panel, WHICH AI is used and in WHAT ORDER:
//   - "gemini"  : the built-in provider that uses the GEMINI_API_KEYS from the server env (cannot be removed, can be switched off)
//   - "openai"  : any OpenAI-compatible endpoint (base URL + API key + model). Up to MAX_OPENAI of them.
// The list is kept in the database (AppSetting 'chatProviders'), so it survives restarts and is the same for all users.
// The chat tries the providers one by one in the saved order; if one fails it goes on to the next one.
// A provider that failed rests for a short time (so the next students are not made to wait for it again).
//
// API keys are stored ENCRYPTED (AES-256-GCM, key derived from SETTINGS_SECRET or JWT_SECRET) and are never sent back to the browser
// (the admin only sees the last 4 characters).
// =====================================================================
const crypto = require('crypto');
const axios = require('axios');
const AppSetting = require('../models/AppSetting');

const SETTING_KEYS = { chat: 'chatProviders', fix: 'fixProviders' };
const SCOPES = Object.keys(SETTING_KEYS);
const scopeOk = (s) => (SCOPES.includes(s) ? s : 'chat');
const MAX_OPENAI = 5;
const CACHE_MS = 15000;           // config is re-read from the database at most every 15 s (and at once after a save)
const GEMINI_ID = 'gemini';
// how an OpenAI-compatible endpoint searches the web (admin choice per endpoint)
const SEARCH_MODES = ['auto', 'off', 'builtin', 'openai_chat', 'responses', 'openrouter', 'enable_search', 'glm_tools', 'custom'];
const searchModeOk = (m) => (SEARCH_MODES.includes(m) ? m : 'auto');
const cleanSearchJson = (t) => String(t || '').slice(0, 2000);

// ---------------------------------------------------------------- key encryption
const secret = () => process.env.SETTINGS_SECRET || process.env.JWT_SECRET || '';
const encKey = () => crypto.createHash('sha256').update('chat-ai-keys-v1|' + secret()).digest();

function encrypt(plain) {
    if (!plain) return '';
    if (!secret()) return 'p1:' + Buffer.from(String(plain), 'utf8').toString('base64');   // no secret on this server: only obfuscated
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
    const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return 'e1:' + [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}

// returns { ok, value }   (ok=false when the secret changed since the key was saved)
function decrypt(stored) {
    if (!stored) return { ok: true, value: '' };
    try {
        if (stored.startsWith('p1:')) return { ok: true, value: Buffer.from(stored.slice(3), 'base64').toString('utf8') };
        if (stored.startsWith('e1:')) {
            const [iv, tag, enc] = stored.slice(3).split('.').map(x => Buffer.from(x, 'base64'));
            const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
            d.setAuthTag(tag);
            return { ok: true, value: Buffer.concat([d.update(enc), d.final()]).toString('utf8') };
        }
    } catch (e) { /* fall through */ }
    return { ok: false, value: '' };
}

const mask = (key) => key ? '••••' + key.slice(-4) : '';
const redact = (text, key) => { let t = String(text == null ? '' : text); if (key && key.length >= 6) t = t.split(key).join('***'); return t; };

// ---------------------------------------------------------------- validation
function normalizeBaseUrl(raw) {
    let u = String(raw == null ? '' : raw).trim();
    if (!u) return { error: 'Base URL is required.' };
    u = u.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
    let parsed;
    try { parsed = new URL(u); } catch (e) { return { error: 'Base URL is not a valid URL (example: https://api.openai.com/v1).' }; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { error: 'Base URL must start with https:// (or http://).' };
    if (parsed.username || parsed.password) return { error: 'Do not put a username/password inside the Base URL. Use the API key field.' };
    if (/^169\.254\./.test(parsed.hostname) || parsed.hostname === 'metadata.google.internal') return { error: 'This address is not allowed.' };
    if (u.length > 300) return { error: 'Base URL is too long.' };
    return { value: u };
}

const newId = () => 'ep_' + crypto.randomBytes(5).toString('hex');
const ID_RE = /^[a-z0-9_-]{3,32}$/;

function defaultConfig() {
    return { rev: 0, deepen: false, providers: [{ id: GEMINI_ID, type: 'gemini', name: 'Gemini (server API keys)', enabled: true, model: '' }] };
}

// make sure a stored value is usable (never throws); the Gemini provider always exists
function sanitizeStored(raw) {
    const out = { rev: Number(raw && raw.rev) || 0, deepen: !!(raw && raw.deepen), providers: [] };
    const seen = new Set();
    for (const p of (raw && Array.isArray(raw.providers) ? raw.providers : [])) {
        if (!p || typeof p !== 'object' || !ID_RE.test(String(p.id || '')) || seen.has(p.id)) continue;
        if (p.type === 'gemini' && p.id === GEMINI_ID) {
            out.providers.push({ id: GEMINI_ID, type: 'gemini', name: 'Gemini (server API keys)', enabled: p.enabled !== false, model: String(p.model || '').slice(0, 100) });
        } else if (p.type === 'openai' && out.providers.filter(x => x.type === 'openai').length < MAX_OPENAI) {
            out.providers.push({
                id: p.id, type: 'openai', name: String(p.name || 'OpenAI-compatible').slice(0, 40), enabled: p.enabled === true,
                baseUrl: String(p.baseUrl || '').slice(0, 300), apiKeyEnc: String(p.apiKeyEnc || ''), model: String(p.model || '').slice(0, 100),
                search: searchModeOk(p.search), searchJson: cleanSearchJson(p.searchJson)
            });
        } else continue;
        seen.add(p.id);
    }
    if (!seen.has(GEMINI_ID)) out.providers.push(defaultConfig().providers[0]);
    return out;
}

// builds the new config from what the admin sent. Returns { error } or { config }.
// `existing` supplies the stored API keys (the browser never has them).
function buildFromInput(input, existing, geminiModels) {
    if (!input || !Array.isArray(input.providers) || !input.providers.length) return { error: 'No providers sent.' };
    if (input.providers.length > MAX_OPENAI + 1) return { error: `At most ${MAX_OPENAI} OpenAI-compatible endpoints are allowed.` };
    const old = new Map((existing.providers || []).map(p => [p.id, p]));
    const providers = [];
    const seen = new Set();
    let geminiSeen = false;

    for (let i = 0; i < input.providers.length; i++) {
        const p = input.providers[i];
        if (!p || typeof p !== 'object') return { error: `Provider #${i + 1} is invalid.` };
        const enabled = p.enabled === true;

        if (p.type === 'gemini') {
            if (geminiSeen) return { error: 'The Gemini provider can only appear once.' };
            geminiSeen = true;
            const model = String(p.model || '').trim();
            if (model && !geminiModels.includes(model)) return { error: `Gemini model "${model.slice(0, 60)}" is not in the server model list.` };
            providers.push({ id: GEMINI_ID, type: 'gemini', name: 'Gemini (server API keys)', enabled, model });
            seen.add(GEMINI_ID);
            continue;
        }
        if (p.type !== 'openai') return { error: `Provider #${i + 1} has an unknown type.` };

        let id = String(p.id || '');
        if (!ID_RE.test(id) || id === GEMINI_ID || seen.has(id)) id = newId();
        const prev = old.get(id);
        const name = String(p.name || '').trim().slice(0, 40) || `OpenAI-compatible ${providers.filter(x => x.type === 'openai').length + 1}`;
        const model = String(p.model || '').trim();
        if (model.length > 100) return { error: `Model name of "${name}" is too long.` };

        const rawUrl = String(p.baseUrl || '').trim();
        let baseUrl = '';
        if (rawUrl || enabled) {
            const n = normalizeBaseUrl(rawUrl);
            if (n.error) return { error: `"${name}": ${n.error}` };
            baseUrl = n.value;
        }
        const newKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : '';
        if (newKey.length > 500 || /\s/.test(newKey)) return { error: `"${name}": the API key must not contain spaces or line breaks.` };
        let apiKeyEnc = prev ? prev.apiKeyEnc : '';
        if (newKey) apiKeyEnc = encrypt(newKey);

        if (enabled) {
            if (!model) return { error: `"${name}": choose or type a model before enabling it.` };
            const k = decrypt(apiKeyEnc);
            if (!apiKeyEnc || !k.ok || !k.value) return { error: `"${name}": API key is required${apiKeyEnc && !k.ok ? ' (the saved one cannot be read - enter it again)' : ''}.` };
        }
        const search = searchModeOk(p.search);
        const searchJson = cleanSearchJson(p.searchJson).trim();
        if (search === 'custom') {
            const j = parseSearchJson(searchJson);
            if (j.error) return { error: `"${name}": ${j.error}` };
        }
        providers.push({ id, type: 'openai', name, enabled, baseUrl, apiKeyEnc, model, search, searchJson });
        seen.add(id);
    }
    if (!geminiSeen) return { error: 'The default Gemini provider cannot be removed (you can switch it off).' };
    if (!providers.some(p => p.enabled)) return { error: 'Keep at least one provider switched on, otherwise the chat cannot answer.' };
    return { config: { rev: (Number(existing.rev) || 0) + 1, deepen: input.deepen === true, providers } };
}

// ---------------------------------------------------------------- config store (DB + short memory cache)
const caches = {};          // scope -> { at, config }
const loadings = {};        // scope -> promise

async function getConfig(scope, force) {
    scope = scopeOk(scope);
    const cache = caches[scope];
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.config;
    if (loadings[scope]) return loadings[scope];
    loadings[scope] = (async () => {
        try {
            const row = await AppSetting.findOne({ key: SETTING_KEYS[scope] }).lean();
            const config = row && row.value ? sanitizeStored(row.value) : defaultConfig();
            caches[scope] = { at: Date.now(), config };
            return config;
        } catch (e) {
            console.error(`chatProviders(${scope}): could not read settings, using the last known ones:`, e.message);
            if (caches[scope]) { caches[scope].at = Date.now() - CACHE_MS + 5000; return caches[scope].config; }   // try again in 5 s
            return defaultConfig();
        } finally { loadings[scope] = null; }
    })();
    return loadings[scope];
}

async function saveConfig(scope, input, geminiModels) {
    scope = scopeOk(scope);
    const current = await getConfig(scope, true);
    if (input && input.rev !== undefined && Number(input.rev) !== Number(current.rev)) {
        return { status: 409, error: 'The settings were changed by another admin. Reload and try again.' };
    }
    const built = buildFromInput(input && scope !== 'fix' ? Object.assign({}, input, { deepen: false }) : input, current, geminiModels);   // 'deepen' only exists for the fix list
    if (built.error) return { status: 400, error: built.error };
    await AppSetting.updateOne({ key: SETTING_KEYS[scope] }, { $set: { value: built.config } }, { upsert: true });
    caches[scope] = { at: Date.now(), config: built.config };
    // forget the rest/health of endpoints that were removed
    const keep = new Set(built.config.providers.map(p => p.id));
    for (const k of [...health.keys()]) if (k.startsWith(scope + ':') && !keep.has(k.slice(scope.length + 1))) health.delete(k);
    return { status: 200, config: built.config };
}

// copy the OpenAI-compatible endpoints (with their saved keys) of one list into the other one (added switched OFF at the end)
async function copyEndpoints(from, to) {
    from = scopeOk(from); to = scopeOk(to);
    if (from === to) return { status: 400, error: 'Choose two different lists.' };
    const [src, dst] = await Promise.all([getConfig(from, true), getConfig(to, true)]);
    const have = new Set(dst.providers.filter(p => p.type === 'openai').map(p => p.baseUrl + '|' + p.model));
    const room = MAX_OPENAI - dst.providers.filter(p => p.type === 'openai').length;
    const add = src.providers.filter(p => p.type === 'openai' && p.apiKeyEnc && !have.has(p.baseUrl + '|' + p.model)).slice(0, Math.max(0, room));
    if (!add.length) return { status: 400, error: room <= 0 ? `The target list already has ${MAX_OPENAI} endpoints.` : 'Nothing to copy (no endpoints, or they are already there).' };
    const next = { rev: dst.rev + 1, deepen: dst.deepen, providers: dst.providers.concat(add.map(p => Object.assign({}, p, { id: newId(), enabled: false }))) };
    await AppSetting.updateOne({ key: SETTING_KEYS[to] }, { $set: { value: next } }, { upsert: true });
    caches[to] = { at: Date.now(), config: next };
    return { status: 200, copied: add.length, config: next };
}

// what the admin screen gets (no keys)
function publicView(config) {
    return {
        rev: config.rev,
        deepen: !!config.deepen,
        maxOpenai: MAX_OPENAI,
        providers: config.providers.map(p => {
            if (p.type === 'gemini') return { id: p.id, type: 'gemini', name: p.name, enabled: p.enabled, model: p.model };
            const k = decrypt(p.apiKeyEnc);
            return {
                id: p.id, type: 'openai', name: p.name, enabled: p.enabled, baseUrl: p.baseUrl, model: p.model,
                hasKey: !!p.apiKeyEnc, keyMask: k.ok ? mask(k.value) : '', keyProblem: !!p.apiKeyEnc && !k.ok,
                search: searchModeOk(p.search), searchJson: p.searchJson || '', searchAuto: resolveSearchMode(p),
                searchProbe: (detected.get(detectKey(p)) || {}).note || (detecting.has(detectKey(p)) ? 'Testing the endpoint for web search...' : '')
            };
        })
    };
}

// ---------------------------------------------------------------- health / rest (memory only)
const health = new Map();   // id -> { fails, until, lastError, lastErrAt, lastOkAt, lastMs, ok }
const h = (scope, id) => { const k = scope + ':' + id; let x = health.get(k); if (!x) { x = { fails: 0, until: 0, lastError: '', lastErrAt: 0, lastOkAt: 0, lastMs: 0, ok: 0 }; health.set(k, x); } return x; };
const backoff = (n, base, cap) => Math.min(cap, base * Math.pow(2, Math.max(0, n - 1)));

function markOk(scope, id, ms) { const x = h(scope, id); x.fails = 0; x.until = 0; x.lastOkAt = Date.now(); x.lastMs = ms || 0; x.ok++; }

// err.kind: 'auth' | 'notfound' | 'rate' | 'server' | 'network' | 'empty' | 'bad'
function markFail(scope, id, err) {
    const x = h(scope, id);
    x.fails++;
    const kind = err && err.kind;
    let ms;
    if (err && Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0) ms = Math.min(15 * 60000, err.retryAfterMs);
    else if (kind === 'auth') ms = 10 * 60000;
    else if (kind === 'notfound') ms = 5 * 60000;
    else if (kind === 'rate') ms = backoff(x.fails, 30000, 10 * 60000);
    else if (kind === 'server') ms = backoff(x.fails, 15000, 5 * 60000);
    else if (kind === 'network') ms = backoff(x.fails, 20000, 5 * 60000);
    else ms = backoff(x.fails, 10000, 2 * 60000);
    x.until = Date.now() + ms;
    x.lastError = String((err && err.message) || 'failed').slice(0, 300);
    x.lastErrAt = Date.now();
}

function healthView(scope, id) {
    const x = health.get(scope + ':' + id);
    if (!x) return { restingMs: 0, lastError: '', lastErrAt: 0, lastOkAt: 0, lastMs: 0, answered: 0 };
    return { restingMs: Math.max(0, x.until - Date.now()), lastError: x.lastError, lastErrAt: x.lastErrAt, lastOkAt: x.lastOkAt, lastMs: x.lastMs, answered: x.ok };
}

// Providers to try, in the admin's order. Providers that are resting are tried last (never skipped completely,
// so a wrong "rest" can never switch the chat off). Incomplete / unreadable endpoints are left out.
async function getOrderedProviders(scope) {
    scope = scopeOk(scope);
    const config = await getConfig(scope);
    const now = Date.now();
    const usable = [];
    for (const p of config.providers) {
        if (!p.enabled) continue;
        if (p.type === 'gemini') { usable.push({ id: p.id, type: 'gemini', name: p.name, model: p.model }); continue; }
        const k = decrypt(p.apiKeyEnc);
        if (!p.baseUrl || !p.model || !k.ok || !k.value) {
            console.warn(`chatProviders(${scope}): "${p.name}" is incomplete or its key cannot be read - skipped.`);
            continue;
        }
        const up = { id: p.id, type: 'openai', name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey: k.value, search: searchModeOk(p.search), searchJson: p.searchJson || '' };
        usable.push(up);
        scheduleDetect(up);
    }
    if (!usable.length) usable.push({ id: GEMINI_ID, type: 'gemini', name: 'Gemini (server API keys)', model: '' });   // never leave the chat without an answerer
    const hk = (p) => health.get(scope + ':' + p.id);
    const ready = usable.filter(p => !(hk(p) && hk(p).until > now));
    const resting = usable.filter(p => hk(p) && hk(p).until > now).sort((a, b) => hk(a).until - hk(b).until);
    return ready.concat(resting);
}

// ---------------------------------------------------------------- OpenAI-compatible call
function pickErrorText(e, key) {
    const d = e && e.response && e.response.data;
    let t = '';
    if (d) {
        if (typeof d === 'string') t = d;
        else if (d.error && typeof d.error === 'object') t = d.error.message || d.error.code || '';
        else if (typeof d.error === 'string') t = d.error;
        else if (d.message) t = d.message;
        else if (d.detail) t = typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail);
    }
    if (!t) t = (e && e.message) || '';
    return redact(String(t).replace(/\s+/g, ' ').trim().slice(0, 220), key);
}

function makeError(e, key) {
    const status = e && e.response && e.response.status;
    const text = pickErrorText(e, key);
    const err = new Error('');
    err.status = status || 0;
    if (!status) {
        err.kind = 'network';
        const code = e && (e.code || '');
        err.message = code === 'ECONNABORTED' || /timeout/i.test(e && e.message || '') ? 'Timed out (no answer in time).' : `Network problem${code ? ' (' + code + ')' : ''}: ${text}`;
    } else if (status === 401 || status === 403) { err.kind = 'auth'; err.message = `Access denied (${status}): ${text || 'check the API key'}`; }
    else if (status === 404) { err.kind = 'notfound'; err.message = `Not found (404): ${text || 'check the Base URL and model name'}`; }
    else if (status === 429) {
        err.kind = 'rate'; err.message = `Rate limit / quota (429): ${text}`;
        const ra = Number(e.response.headers && e.response.headers['retry-after']);
        if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
    } else if (status >= 500) { err.kind = 'server'; err.message = `Provider server error (${status}): ${text}`; }
    else if (status >= 300 && status < 400) { err.kind = 'bad'; err.message = `The URL redirects (${status}). Use the final Base URL.`; }
    else { err.kind = 'bad'; err.message = `Request refused (${status}): ${text}`; }
    return err;
}

function contentToText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : (x && (x.text || (x.type === 'text' && x.content)) || ''))).join('');
    return '';
}

function extractOpenAIText(data) {
    const ch = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const msg = ch && (ch.message || ch.delta);
    let t = contentToText(msg && msg.content);
    if (!t && ch && typeof ch.text === 'string') t = ch.text;
    return String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// ---------------------------------------------------------------- web search of OpenAI-compatible endpoints
// modes:  off        - never send search parameters
//         builtin    - the model searches by itself (Perplexity, Groq compound ...): nothing extra is sent
//         openai_chat- chat completions + web_search_options (OpenAI *-search-preview models)
//         responses  - OpenAI "Responses" API with the web_search tool (gpt-4o / gpt-4.1 / gpt-5 / xAI ...)
//         openrouter - plugins:[{id:"web"}] (works with any OpenRouter model)
//         custom     - extra JSON merged into the request body (admin writes it)
//         auto       - guessed from the Base URL / model; unknown endpoints get no search (Gemini search facts are used instead)
// If the endpoint refuses the search parameters, the call is repeated without them (never fails because of search).
function resolveSearchMode(p) {
    const m = searchModeOk(p && p.search);
    if (m !== 'auto') return m === 'off' ? 'none' : m;
    const url = String((p && p.baseUrl) || '').toLowerCase();
    const model = String((p && p.model) || '').toLowerCase();
    if (url.includes('openrouter.ai')) return 'openrouter';
    if (url.includes('perplexity.ai')) return 'builtin';
    if (url.includes('groq.com') && model.includes('compound')) return 'builtin';
    if (url.includes('api.openai.com')) return /search/.test(model) ? 'openai_chat' : 'responses';
    if (url.includes('api.x.ai')) return 'responses';
    const d = detected.get(detectKey(p));      // unknown / custom endpoint: what the automatic probe found out
    return d && d.mode ? d.mode : 'none';
}

// ---------------------------------------------------------------- automatic detection for custom endpoints
// A custom OpenAI-compatible URL (LiteLLM, one-api, a proxy, a local gateway, another vendor ...) is TESTED once: we ask it to search the web
// with each known method and look for real evidence (citations / web_search_call). The first method that shows evidence is remembered
// (memory only; re-tested after a restart or after DETECT_RETRY_MS). Until the test finishes, Gemini facts are used instead.
const detected = new Map();          // 'baseUrl|model' -> { mode, state: 'found'|'none', at, note }
const detecting = new Map();         // 'baseUrl|model' -> promise
const DETECT_RETRY_MS = 6 * 3600 * 1000;
const detectKey = (p) => String((p && p.baseUrl) || '').toLowerCase() + '|' + String((p && p.model) || '').toLowerCase();
const DETECT_ORDER = ['builtin', 'responses', 'openai_chat', 'openrouter', 'enable_search', 'glm_tools'];
const PROBE_PROMPT = 'Use your web search tool now. Search the web and tell me the headline of ONE news story published in the last 24 hours, with the name of the website. Answer in one short line.';

async function probeMode(p, mode, timeoutMs) {
    const ev = {};
    try {
        await callOpenAI(Object.assign({}, p, { search: mode }), { system: '', history: [], message: PROBE_PROMPT, images: [] },
            { timeoutMs, maxTokens: 400, evidenceOut: ev });
    } catch (e) { return { ok: false, why: String(e && e.message).slice(0, 100), fatal: !!(e && ['auth', 'rate', 'network'].includes(e.kind)) }; }
    return { ok: !!ev.evidence, why: ev.evidence ? '' : 'no search evidence' };
}

// force=true: re-test now (admin Test button). Never throws.
async function detectSearch(p, { force = false, budgetMs = 60000 } = {}) {
    const key = detectKey(p);
    const old = detected.get(key);
    if (!force && old && Date.now() - old.at < DETECT_RETRY_MS) return old;
    if (detecting.has(key)) return detecting.get(key);
    const job = (async () => {
        const t0 = Date.now();
        let res = { mode: '', state: 'none', at: Date.now(), note: '' };
        const tried = [];
        for (const mode of DETECT_ORDER) {
            const left = budgetMs - (Date.now() - t0);
            if (left < 5000) break;
            const r = await probeMode(p, mode, Math.min(30000, left));
            if (r.ok) { res = { mode, state: 'found', at: Date.now(), note: 'Search works with method "' + mode + '".' }; break; }
            tried.push(mode + ': ' + r.why);
            if (r.fatal) { res.note = 'Probe stopped (' + r.why + ').'; break; }
        }
        if (res.state !== 'found') res.note = (res.note || 'No built-in web search found (' + tried.join('; ') + ').').slice(0, 400);
        detected.set(key, res);
        console.log('chatProviders: web-search probe for "' + (p.name || key) + '": ' + res.state + (res.mode ? ' (' + res.mode + ')' : ''));
        return res;
    })().finally(() => detecting.delete(key));
    detecting.set(key, job);
    return job;
}

// called when the provider list is loaded: starts a background test for custom endpoints that were never tested (does not wait)
function scheduleDetect(p) {
    if (process.env.WEB_SEARCH === '0' || searchModeOk(p.search) !== 'auto') return;
    const url = String(p.baseUrl || '').toLowerCase();
    if (/openrouter\.ai|perplexity\.ai|api\.openai\.com|api\.x\.ai|groq\.com/.test(url)) return;   // already known
    const key = detectKey(p), old = detected.get(key);
    if (detecting.has(key) || (old && Date.now() - old.at < DETECT_RETRY_MS)) return;
    detectSearch(p).catch(() => {});
}

function parseSearchJson(text) {
    const t = String(text || '').trim();
    if (!t) return { error: 'Write the extra JSON for web search (for example {"tools":[{"type":"web_search"}]}) or choose another mode.' };
    let j;
    try { j = JSON.parse(t); } catch (e) { return { error: 'The web-search JSON is not valid JSON.' }; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'The web-search JSON must be an object like {"tools":[...]}.' };
    ['model', 'messages', 'stream', 'input'].forEach(k => { delete j[k]; });   // the admin cannot replace the question itself
    return { value: j };
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
function extractSources(data) {
    const out = [];
    try {
        const ch = data && data.choices && data.choices[0];
        const ann = (ch && ch.message && ch.message.annotations) || [];
        ann.forEach(a => { const c = a && (a.url_citation || a); if (c && (c.url || c.title)) out.push(hostOf(c.url) || String(c.title).slice(0, 50)); });
        (Array.isArray(data && data.citations) ? data.citations : []).forEach(c => { out.push(hostOf(typeof c === 'string' ? c : c && c.url) || ''); });
        (Array.isArray(data && data.output) ? data.output : []).forEach(it => (Array.isArray(it.content) ? it.content : []).forEach(c => (Array.isArray(c.annotations) ? c.annotations : []).forEach(a => {
            if (a && a.url) out.push(hostOf(a.url) || String(a.title || '').slice(0, 50));
        })));
    } catch (e) { /* sources are optional */ }
    return [...new Set(out.filter(Boolean))].slice(0, 4);
}

// OpenAI "Responses" API with the built-in web_search tool
async function callResponses(p, input, opts, images, timeout) {
    const url = p.baseUrl + '/responses';
    let sendTemp = true, sendJson = !!opts.jsonMode, sendTool = true;
    const build = () => {
        const msgs = [];
        (input.history || []).forEach(x => msgs.push(x.role === 'model'
            ? { role: 'assistant', content: [{ type: 'output_text', text: x.text }] }
            : { role: 'user', content: [{ type: 'input_text', text: x.text }] }));
        msgs.push({ role: 'user', content: [{ type: 'input_text', text: input.message }].concat(images.map(img => ({ type: 'input_image', image_url: 'data:image/jpeg;base64,' + img }))) });
        const body = { model: p.model, input: msgs, stream: false, max_output_tokens: Math.max(opts.maxTokens || 2500, 2500) };
        if (input.system) body.instructions = input.system;
        if (sendTool) body.tools = [{ type: 'web_search' }];
        if (sendTemp) body.temperature = opts.temperature !== undefined ? opts.temperature : 0.4;
        if (sendJson) body.text = { format: { type: 'json_object' } };
        return body;
    };
    let lastErr = null;
    for (let i = 0; i < 4; i++) {
        try {
            const resp = await axios.post(url, build(), {
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.apiKey },
                timeout, maxRedirects: 0, maxContentLength: 8 * 1024 * 1024, validateStatus: s => s >= 200 && s < 300
            });
            const d = resp.data || {};
            let text = typeof d.output_text === 'string' ? d.output_text : '';
            if (!text && Array.isArray(d.output)) {
                text = d.output.filter(it => it && it.type === 'message').map(it => (Array.isArray(it.content) ? it.content : []).filter(c => c && typeof c.text === 'string').map(c => c.text).join('')).join('\n');
            }
            text = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            if (!text) { const err = new Error('Empty answer'); err.kind = 'empty'; throw err; }
            if (opts.evidenceOut) opts.evidenceOut.evidence = extractSources(d).length > 0 || (Array.isArray(d.output) && d.output.some(it => it && it.type === 'web_search_call'));
            return { text, data: d };
        } catch (e) {
            if (e && e.kind) throw e;
            const err = makeError(e, p.apiKey);
            lastErr = err;
            if (err.status === 400 || err.status === 422) {
                const t = pickErrorText(e, p.apiKey).toLowerCase();
                if (sendTemp && /temperature/.test(t)) { sendTemp = false; continue; }
                if (sendJson && /text\.format|json_object|json mode|response_format/.test(t)) { sendJson = false; continue; }
            }
            throw err;
        }
    }
    throw lastErr || new Error('Request failed');
}

// input: { system, history:[{role:'user'|'model',text}], message, images:[base64 jpeg] }
// opts:  timeoutMs, maxTokens, temperature, jsonMode, keepImages,
//        search:false  -> do not use the endpoint's web search for this call
//        withSources   -> append "Sources (web): ..." to the answer (chat only; never for JSON answers)
//        meta          -> object that receives { searchMode, searchUsed, searchNote }
async function callOpenAI(p, input, opts = {}) {
    const meta = opts.meta || {};
    let mode = opts.search === false ? 'none' : resolveSearchMode(p);
    meta.searchMode = mode; meta.searchUsed = false; meta.searchNote = '';
    const baseTimeout = opts.timeoutMs || 60000;
    const timeout = mode === 'none' ? baseTimeout : Math.round(baseTimeout * 1.6);   // searching takes longer

    if (mode === 'responses') {
        try {
            const images = Array.isArray(input.images) ? input.images.slice() : [];
            const r = await callResponses(p, input, opts, images, timeout);
            meta.searchUsed = true;
            let text = r.text;
            if (opts.withSources) { const src = extractSources(r.data); if (src.length) text += `\n\nSources (web): ${src.join(', ')}`; }
            return text;
        } catch (e) {
            // wrong key / limit / network / server problem: the normal call would fail the same way -> report it
            if (e && (opts.evidenceOut || ['auth', 'rate', 'network', 'server'].includes(e.kind))) throw e;   // a probe must fail fast, not retry without search
            meta.searchNote = `Responses API with web search not available (${String(e && e.message).slice(0, 120)}) - answered without it.`;
            mode = 'none';
        }
    }
    return callChat(p, input, opts, mode, meta, timeout);
}

async function callChat(p, input, opts, mode, meta, timeout) {
    const url = p.baseUrl + '/chat/completions';
    let images = Array.isArray(input.images) ? input.images.slice() : [];
    let useMaxCompletion = false, sendTemp = true, sendJson = !!opts.jsonMode;
    let searchOn = ['builtin', 'openai_chat', 'openrouter', 'enable_search', 'glm_tools', 'custom'].includes(mode);
    let customExtra = null;
    if (mode === 'custom') { const j = parseSearchJson(p.searchJson); if (j.value) customExtra = j.value; else searchOn = false; }

    const buildBody = () => {
        const msgs = [];
        if (input.system) msgs.push({ role: 'system', content: input.system });
        (input.history || []).forEach(x => msgs.push({ role: x.role === 'model' ? 'assistant' : 'user', content: x.text }));
        msgs.push({
            role: 'user',
            content: images.length
                ? [{ type: 'text', text: input.message }].concat(images.map(img => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + img } })))
                : input.message
        });
        const body = { model: p.model, messages: msgs, stream: false };
        body[useMaxCompletion ? 'max_completion_tokens' : 'max_tokens'] = opts.maxTokens || 2500;
        if (sendTemp) body.temperature = opts.temperature !== undefined ? opts.temperature : 0.4;
        if (sendJson) body.response_format = { type: 'json_object' };
        if (searchOn) {
            if (mode === 'openai_chat') body.web_search_options = {};
            else if (mode === 'openrouter') body.plugins = [{ id: 'web', max_results: 5 }];
            else if (mode === 'enable_search') { body.enable_search = true; }
            else if (mode === 'glm_tools') body.tools = [{ type: 'web_search', web_search: { enable: true, search_result: true } }];
            else if (mode === 'custom' && customExtra) Object.assign(body, JSON.parse(JSON.stringify(customExtra)));
            if (mode === 'openai_chat') { delete body.temperature; }   // search-preview models refuse temperature
        }
        return body;
    };

    let lastErr = null;
    // a few providers refuse "max_tokens", "temperature", JSON mode or images -> we adapt once for each and retry
    for (let i = 0; i < 6; i++) {
        try {
            const resp = await axios.post(url, buildBody(), {
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.apiKey },
                timeout, maxRedirects: 0, maxContentLength: 8 * 1024 * 1024, validateStatus: s => s >= 200 && s < 300
            });
            let text = extractOpenAIText(resp.data);
            if (!text) {
                const fr = resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].finish_reason;
                const err = new Error('Empty answer' + (fr ? ` (${fr})` : ''));
                err.kind = 'empty';
                throw err;
            }
            meta.searchUsed = searchOn;
            if (opts.evidenceOut) opts.evidenceOut.evidence = extractSources(resp.data).length > 0;
            if (searchOn && opts.withSources) { const src = extractSources(resp.data); if (src.length) text += `\n\nSources (web): ${src.join(', ')}`; }
            return text;
        } catch (e) {
            if (e && e.kind) throw e;   // already one of ours
            const err = makeError(e, p.apiKey);
            lastErr = err;
            if (err.status === 400 || err.status === 422) {
                const t = pickErrorText(e, p.apiKey).toLowerCase();
                if (!useMaxCompletion && /max_tokens/.test(t) && /max_completion_tokens|not supported|unsupported/.test(t)) { useMaxCompletion = true; continue; }
                if (sendTemp && /temperature/.test(t)) { sendTemp = false; continue; }
                if (sendJson && /response_format|json_object|json mode|json_schema/.test(t)) { sendJson = false; continue; }
                // the endpoint does not know the web-search parameters -> answer without them
                if (searchOn && opts.evidenceOut) throw err;   // a probe: the method is refused -> report it, do not repeat the call
                if (searchOn && mode !== 'builtin' && /web_search|plugins|search|tools?\b|unrecognized|unknown (field|param)|extra|not permitted|unsupported/.test(t)) {
                    searchOn = false; meta.searchNote = `Endpoint refused the web-search parameters (${t.slice(0, 100)}) - answered without them.`; continue;
                }
                // question fix MUST see the paper image: it never silently drops it (opts.keepImages) -> the next provider is tried instead
                if (images.length && !opts.keepImages && /image|vision|multimodal|content|modalit/.test(t)) { images = []; continue; }
            }
            throw err;
        }
    }
    throw lastErr || new Error('Request failed');
}

// admin helper: list the model ids of an endpoint
async function listModels(baseUrl, apiKey) {
    const n = normalizeBaseUrl(baseUrl);
    if (n.error) { const e = new Error(n.error); e.kind = 'bad'; throw e; }
    try {
        const resp = await axios.get(n.value + '/models', {
            headers: { 'Authorization': 'Bearer ' + apiKey }, timeout: 20000, maxRedirects: 0, maxContentLength: 4 * 1024 * 1024,
            validateStatus: s => s >= 200 && s < 300
        });
        const d = resp.data;
        const arr = Array.isArray(d) ? d : (Array.isArray(d && d.data) ? d.data : (Array.isArray(d && d.models) ? d.models : []));
        const ids = arr.map(m => (typeof m === 'string' ? m : (m && (m.id || m.name)) || '')).map(s => String(s).replace(/^models\//, '')).filter(Boolean);
        return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 500);
    } catch (e) {
        throw e && e.kind ? e : makeError(e, apiKey);
    }
}

// find the stored (decrypted) key of an endpoint, for the admin "test" / "fetch models" buttons
async function storedKeyOf(scope, id) {
    const config = await getConfig(scope, true);
    const p = config.providers.find(x => x.id === id && x.type === 'openai');
    if (!p) return '';
    const k = decrypt(p.apiKeyEnc);
    return k.ok ? k.value : '';
}

module.exports = {
    GEMINI_ID, MAX_OPENAI,
    SCOPES, scopeOk,
    getConfig, saveConfig, copyEndpoints, publicView, getOrderedProviders,
    markOk, markFail, healthView,
    callOpenAI, listModels, storedKeyOf, normalizeBaseUrl, resolveSearchMode, SEARCH_MODES, detectSearch,
    // exported for tests
    buildFromInput, sanitizeStored, defaultConfig, encrypt, decrypt, extractOpenAIText, makeError, parseSearchJson, extractSources
};

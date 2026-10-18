// Admin: AI settings - which AI is used, in which order (first, fallback 1, fallback 2 ...), for two jobs:
//   'chat' = the "Ask AI" chat on every question,  'fix' = Question fix + verification + deepen (admin).
// Everything is saved in the database for ALL users. API keys are never shown again after saving (only the last 4 characters).
(function () {
    const tok = () => localStorage.getItem('jwtToken');
    const isAdmin = () => { try { return !!(JSON.parse(localStorage.getItem('currentUser')) || {}).isAdmin; } catch (e) { return false; } };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    async function api(method, url, body) {
        try {
            const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok() }, body: body ? JSON.stringify(body) : undefined });
            let data = null;
            try { data = await res.json(); } catch (e) { /* not json */ }
            if (!data) return { success: false, message: 'Server answered with an error (' + res.status + ').' };
            return data;
        } catch (e) { return { success: false, message: 'Network error - could not reach the server.' }; }
    }

    let overlay = null;
    let st = null;          // { rev, maxOpenai, gemini:{models,keyCount,usablePairs}, providers:[...] }  (working copy)
    let dirty = false;
    let busy = false;
    let scope = 'chat';     // which list is shown: 'chat' | 'fix'
    const $ = (s) => overlay.querySelector(s);

    function build() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.className = 'xm-overlay';
        overlay.innerHTML =
            '<div class="xm-box" style="width:860px">' +
            '<div class="xm-head"><b>🤖 AI Settings</b><button class="xm-x" id="ca-close">✕</button></div>' +
            '<div class="xm-body">' +
            '<div class="ca-tabs"><button class="ca-tab" data-scope="chat">💬 Ask AI chat</button><button class="ca-tab" data-scope="fix">🛠 Question fix &amp; deepen</button></div>' +
            '<p id="ca-intro" class="xm-note" style="margin-top:0"></p>' +
            '<div id="ca-list"></div>' +
            '<label id="ca-deepen-row" class="xm-chk ca-deepen" style="display:none"><input type="checkbox" id="ca-deepen"> Deepen the explanation after a fix: adds only 2-5 short one-line fact pointers (never an essay). Off = explanation stays 3-4 lines.</label>' +
            '<div class="xm-actions"><button class="btn" id="ca-add">+ Add OpenAI-compatible endpoint</button>' +
            '<button class="btn" id="ca-copy" title="Copies the endpoints and their saved keys from the other tab (added switched off)">⇄ Copy endpoints from the other tab</button>' +
            '<button class="btn" id="ca-reload">⟳ Reload</button>' +
            '<button class="btn" id="ca-save" style="background:#10b981;margin-left:auto">💾 Save</button></div>' +
            '<div id="ca-msg" class="xm-note" style="min-height:1.4em;margin:6px 0"></div>' +
            '</div></div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        $('#ca-close').onclick = close;
        $('#ca-add').onclick = addEndpoint;
        $('#ca-copy').onclick = copyFromOther;
        $('#ca-deepen').onchange = () => { if (st) { st.deepen = $('#ca-deepen').checked; setDirty(true); } };
        overlay.querySelectorAll('.ca-tab').forEach(t => { t.onclick = () => switchScope(t.dataset.scope); });
        $('#ca-save').onclick = save;
        $('#ca-reload').onclick = () => { if (dirty && !confirm('Discard your unsaved changes?')) return; load(); };
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay && overlay.classList.contains('show') && !e.defaultPrevented) close(); });
    }

    function say(t, bad) { const m = $('#ca-msg'); if (!m) return; m.textContent = t || ''; m.style.color = bad ? '#b91c1c' : '#047857'; }
    function setDirty(v) { dirty = v; const b = $('#ca-save'); if (b) b.textContent = v ? '💾 Save changes' : '💾 Save'; }

    function ago(ts) {
        if (!ts) return '';
        const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
        return s < 90 ? s + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago';
    }
    function healthHtml(p) {
        const h = p.health || {};
        const bits = [];
        if (h.lastOkAt) bits.push('✔ last answer ' + ago(h.lastOkAt) + (h.lastMs ? ' (' + (h.lastMs / 1000).toFixed(1) + 's)' : '') + ' · ' + (h.answered || 0) + ' answered since restart');
        if (h.restingMs > 0) bits.push('⏸ resting ' + Math.ceil(h.restingMs / 1000) + 's (it will be tried last until then)');
        if (h.lastError && (!h.lastOkAt || h.lastErrAt > h.lastOkAt)) bits.push('⚠ ' + esc(h.lastError) + ' (' + ago(h.lastErrAt) + ')');
        return bits.length ? '<div class="xm-note ca-health">' + bits.join('<br>') + '</div>' : '<div class="xm-note ca-health">No chat answered through this provider since the server started.</div>';
    }

    const INTRO = {
        chat: 'These providers answer the <b>Ask AI</b> chat for <b>all users</b>. The chat uses the <b>first</b> switched-on provider; if it fails, it goes to the next one (fallback), in this order. Saved in the database (survives restarts).',
        fix: 'These providers are used by the admin <b>Question fix</b> (reading the paper image, solving, verifying) and the optional <b>deepen</b> step. The first switched-on provider is used; if it fails or its limit is over, the next one takes over. <b>Use a model that can read images</b> - a provider that cannot see the paper image is skipped automatically.'
    };

    function render() {
        if (!st || !overlay) return;
        overlay.querySelectorAll('.ca-tab').forEach(t => t.classList.toggle('ca-tab-on', t.dataset.scope === scope));
        $('#ca-intro').innerHTML = INTRO[scope];
        $('#ca-deepen-row').style.display = scope === 'fix' ? 'flex' : 'none';
        $('#ca-deepen').checked = !!st.deepen;
        const box = $('#ca-list');
        box.textContent = '';
        const label = (i, n) => i === 0 ? '1st · FIRST choice' : 'Fallback ' + i;
        st.providers.forEach((p, i) => {
            const card = document.createElement('div');
            card.className = 'ca-card' + (p.enabled ? '' : ' ca-off');
            const isG = p.type === 'gemini';
            let inner =
                '<div class="ca-head">' +
                '<span class="xm-badge">' + label(i) + '</span>' +
                '<b class="ca-title">' + (isG ? '✨ Gemini (server API keys)' : '🔌 OpenAI-compatible') + '</b>' +
                '<label class="xm-chk" style="margin-left:auto"><input type="checkbox" data-f="enabled"' + (p.enabled ? ' checked' : '') + '> On</label>' +
                '<button class="btn xm-small" data-a="up"' + (i === 0 ? ' disabled' : '') + ' title="Move up (use earlier)">▲</button>' +
                '<button class="btn xm-small" data-a="down"' + (i === st.providers.length - 1 ? ' disabled' : '') + ' title="Move down (use later)">▼</button>' +
                (isG ? '' : '<button class="btn xm-small xm-danger" data-a="remove" title="Remove this endpoint">🗑 Remove</button>') +
                '</div>';
            if (isG) {
                const g = st.gemini || { models: [], keyCount: 0 };
                inner +=
                    '<div class="ca-grid"><label>Model<select data-f="model"><option value="">Auto - rotate all models (default)</option>' +
                    g.models.map(m => '<option value="' + esc(m) + '"' + (p.model === m ? ' selected' : '') + '>' + esc(m) + '</option>').join('') +
                    '</select></label></div>' +
                    '<div class="xm-note">Uses the ' + g.keyCount + ' API key(s) from the server settings (GEMINI_API_KEYS)' + (g.usablePairs != null ? ' · ' + g.usablePairs + ' key+model combination(s) usable now' : '') + '. This provider cannot be removed, only switched off.</div>';
            } else {
                inner +=
                    '<div class="ca-grid">' +
                    '<label>Name<input data-f="name" maxlength="40" value="' + esc(p.name) + '" placeholder="e.g. OpenRouter" autocomplete="off"></label>' +
                    '<label>Base URL<input data-f="baseUrl" maxlength="300" value="' + esc(p.baseUrl) + '" placeholder="https://api.openai.com/v1" autocomplete="off" spellcheck="false"></label>' +
                    '<label>API key<input data-f="apiKey" type="password" maxlength="500" value="' + esc(p.apiKey || '') + '" autocomplete="new-password" spellcheck="false" placeholder="' + (p.hasKey ? (p.keyProblem ? 'Saved key cannot be read - enter it again' : 'Saved (' + esc(p.keyMask) + ') - leave empty to keep') : 'Paste the API key') + '"></label>' +
                    '<label>Model<input data-f="model" list="ca-models-' + i + '" maxlength="100" value="' + esc(p.model) + '" placeholder="e.g. gpt-4o-mini" autocomplete="off" spellcheck="false">' +
                    '<datalist id="ca-models-' + i + '">' + (p.modelList || []).map(m => '<option value="' + esc(m) + '"></option>').join('') + '</datalist></label>' +
                    '</div>' +
                    '<div class="xm-actions"><button class="btn xm-small" data-a="models">⬇ Load model list' + ((p.modelList || []).length ? ' (' + p.modelList.length + ')' : '') + '</button></div>' +
                    '<div class="ca-grid"><label>Web search of this endpoint<select data-f="search">' +
                    [['auto', 'Auto - detect from Base URL / model (default)'], ['responses', 'OpenAI Responses API - web_search tool (gpt-4o / 4.1 / 5, xAI)'], ['openai_chat', 'Chat completions - web_search_options (*-search-preview models)'], ['openrouter', 'OpenRouter - web plugin (any model)'], ['prompt', 'Prompt only - the endpoint has internet (web cookies etc.) but no tool: the prompt just tells it to search the internet'], ['builtin', 'Built-in: the model searches by itself (Perplexity, Groq compound...)'], ['enable_search', 'enable_search flag (Qwen / DashScope style)'], ['glm_tools', 'web_search tool (Zhipu GLM style)'], ['custom', 'Custom JSON (extra request fields)'], ['off', 'Off - use Gemini search facts instead']]
                        .map(o => '<option value="' + o[0] + '"' + ((p.search || 'auto') === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') +
                    '</select></label>' +
                    ((p.search || 'auto') === 'custom' ? '<label>Custom JSON<textarea data-f="searchJson" rows="3" maxlength="2000" spellcheck="false" placeholder=\'{"tools":[{"type":"web_search"}]}\'>' + esc(p.searchJson || '') + '</textarea></label>' : '') +
                    '</div>' +
                    '<div class="xm-note">Auto now: <b>' + esc(({ none: 'no own search (Gemini search facts are added instead)', responses: 'OpenAI Responses web_search', openai_chat: 'web_search_options', openrouter: 'OpenRouter web plugin', builtin: 'built-in search', prompt: 'prompt-only (the model is told to search the internet)' })[p.searchAuto] || p.searchAuto || 'no own search (Gemini search facts are added instead)') + '</b>' + (p.searchProbe ? ' · ' + esc(p.searchProbe) : '') + '. If an endpoint refuses its search tool, the answer is given without it and Gemini facts are used - nothing breaks.</div>';
            }
            inner += '<div class="xm-actions"><button class="btn xm-small" data-a="test">▶ Test</button><span class="ca-test xm-note"></span></div>';
            inner += (p.isNew ? '<div class="xm-note ca-health">New - not saved yet.</div>' : healthHtml(p));
            card.innerHTML = inner;

            card.querySelectorAll('[data-f]').forEach(inp => {
                const f = inp.dataset.f;
                const upd = () => { p[f] = inp.type === 'checkbox' ? inp.checked : inp.value; setDirty(true); if (f === 'enabled') card.classList.toggle('ca-off', !inp.checked); if (f === 'search') render(); };
                inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input', upd);
            });
            card.querySelectorAll('[data-a]').forEach(b => { b.onclick = () => action(b.dataset.a, i, card, b); });
            box.appendChild(card);
        });
        $('#ca-add').disabled = st.providers.filter(p => p.type === 'openai').length >= st.maxOpenai;
    }

    function action(a, i, card, btn) {
        const p = st.providers[i];
        if (a === 'up' && i > 0) { [st.providers[i - 1], st.providers[i]] = [st.providers[i], st.providers[i - 1]]; setDirty(true); render(); }
        else if (a === 'down' && i < st.providers.length - 1) { [st.providers[i + 1], st.providers[i]] = [st.providers[i], st.providers[i + 1]]; setDirty(true); render(); }
        else if (a === 'remove') {
            if (confirm('Remove "' + (p.name || 'this endpoint') + '"? (its saved API key is deleted when you press Save)')) { st.providers.splice(i, 1); setDirty(true); render(); }
        }
        else if (a === 'models') loadModels(p, card, btn);
        else if (a === 'test') runTest(p, card, btn);
    }

    function addEndpoint() {
        if (!st) return;
        if (st.providers.filter(p => p.type === 'openai').length >= st.maxOpenai) return say('At most ' + st.maxOpenai + ' endpoints are allowed.', true);
        st.providers.push({ id: '', type: 'openai', name: 'OpenAI-compatible ' + (st.providers.filter(p => p.type === 'openai').length + 1), enabled: false, baseUrl: '', model: '', apiKey: '', hasKey: false, isNew: true, search: 'auto', searchJson: '' });
        setDirty(true); render();
        const cards = $('#ca-list').children;
        if (cards.length) cards[cards.length - 1].scrollIntoView({ block: 'nearest' });
    }

    async function loadModels(p, card, btn) {
        const out = card.querySelector('.ca-test');
        if (!p.baseUrl) { out.textContent = '⚠ Enter the Base URL first.'; return; }
        btn.disabled = true; out.textContent = 'Loading models...';
        const r = await api('POST', '/api/admin/chat-ai/models', { scope, id: p.id || undefined, baseUrl: p.baseUrl, apiKey: p.apiKey || '' });
        btn.disabled = false;
        if (!r.success) { out.textContent = '⚠ ' + (r.message || 'Could not load.') + ' You can still type the model name.'; return; }
        p.modelList = r.models || [];
        const keepFocus = p.model;
        render();
        const nc = $('#ca-list').children[st.providers.indexOf(p)];
        if (nc) nc.querySelector('.ca-test').textContent = '✔ ' + p.modelList.length + ' models loaded - click the Model box and pick one.' + (keepFocus ? '' : '');
    }

    async function runTest(p, card, btn) {
        const out = card.querySelector('.ca-test');
        btn.disabled = true; out.style.color = ''; out.textContent = 'Testing...';
        const body = p.type === 'gemini'
            ? { type: 'gemini', model: p.model || '' }
            : { type: 'openai', scope, id: p.id || undefined, baseUrl: p.baseUrl, apiKey: p.apiKey || '', model: p.model, search: p.search || 'auto', searchJson: p.searchJson || '' };
        const r = await api('POST', '/api/admin/chat-ai/test', body);
        btn.disabled = false;
        if (r.success) { out.style.color = '#047857'; out.textContent = '✔ Works (' + ((r.ms || 0) / 1000).toFixed(1) + 's) - answer: "' + (r.reply || '') + '"' + (r.searchInfo ? ' · ' + r.searchInfo : ''); }
        else { out.style.color = '#b91c1c'; out.textContent = '⚠ ' + (r.message || 'Test failed.'); }
    }

    async function save() {
        if (!st || busy) return;
        busy = true;
        const b = $('#ca-save'); b.disabled = true; say('Saving...');
        const payload = {
            scope,
            rev: st.rev,
            deepen: scope === 'fix' && !!st.deepen,
            providers: st.providers.map(p => p.type === 'gemini'
                ? { type: 'gemini', enabled: !!p.enabled, model: p.model || '' }
                : { type: 'openai', id: p.id || undefined, name: p.name, enabled: !!p.enabled, baseUrl: p.baseUrl, apiKey: p.apiKey || '', model: p.model, search: p.search || 'auto', searchJson: p.searchJson || '' })
        };
        const r = await api('PUT', '/api/admin/chat-ai', payload);
        busy = false; b.disabled = false;
        if (!r.success) { say('⚠ ' + (r.message || 'Could not save.'), true); return; }
        // keep the loaded model lists, drop the typed keys (they are saved now)
        const lists = new Map(st.providers.map(p => [p.id, p.modelList]));
        st = { rev: r.rev, deepen: r.deepen, maxOpenai: r.maxOpenai, gemini: r.gemini, providers: r.providers.map(p => Object.assign({}, p, { apiKey: '', modelList: lists.get(p.id) })) };
        setDirty(false); render();
        say('✔ Saved. ' + (scope === 'fix' ? 'Question fix and verification' : 'The chat') + ' use this order from now on.');
    }

    async function load() {
        say('Loading...');
        const r = await api('GET', '/api/admin/chat-ai?scope=' + scope);
        if (!r.success) { say('⚠ ' + (r.message || 'Could not load.'), true); return; }
        st = { rev: r.rev, deepen: r.deepen, maxOpenai: r.maxOpenai, gemini: r.gemini, providers: r.providers.map(p => Object.assign({}, p, { apiKey: '' })) };
        setDirty(false); render(); say('');
    }

    async function switchScope(next) {
        if (next === scope || busy) return;
        if (dirty && !confirm('Discard your unsaved changes on this tab?')) return;
        scope = next;
        st = null; $('#ca-list').textContent = '';
        await load();
    }

    async function copyFromOther() {
        if (busy) return;
        const from = scope === 'chat' ? 'fix' : 'chat';
        if (dirty && !confirm('Unsaved changes on this tab will be lost when the list reloads. Continue?')) return;
        busy = true; say('Copying...');
        const r = await api('POST', '/api/admin/chat-ai/copy', { from, to: scope });
        busy = false;
        if (!r.success) { say('⚠ ' + (r.message || 'Could not copy.'), true); return; }
        await load();
        say('✔ ' + r.copied + ' endpoint(s) copied (switched OFF). Check the model, switch them On and press Save.');
    }

    function close() {
        if (dirty && !confirm('You have unsaved changes. Close anyway?')) return;
        if (overlay) overlay.classList.remove('show');
        dirty = false;
        if (st) st.providers.forEach(p => { p.apiKey = ''; });   // typed keys do not stay in the page
    }

    window.openChatAiSettings = async function () {
        if (!isAdmin()) return;
        build();
        overlay.classList.add('show');
        scope = 'chat';
        await load();
    };
})();

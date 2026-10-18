// Admin tool: "➕ Add New Exam"
//  question paper PDF (+ official answer key PDF)  ->  server reads everything (AI, twice)  ->  REVIEW here  ->  Publish
//  In the review the admin can fix text / options / answer / explanation, change the image of a question, and re-scan ONE question.
//  Nothing is visible to students until "Publish".
(function () {
    const tok = () => localStorage.getItem('jwtToken');
    const isAdmin = () => { try { return !!(JSON.parse(localStorage.getItem('currentUser')) || {}).isAdmin; } catch (e) { return false; } };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const BASE = '/api/admin/exam-import';
    const imgUrl = (ref) => '/api/image/' + encodeURIComponent(JSON.stringify(ref)) + '?token=' + encodeURIComponent(tok());
    const L = (n) => ({ '1': 'A', '2': 'B', '3': 'C', '4': 'D' }[n] || n);
    const fmtAns = (a) => (a === '#' ? '# (रद्द)' : String(a || '').split('/').map(x => x + ' (' + L(x) + ')').join(' / '));

    async function api(method, url, body) {
        try {
            const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok() }, body: body ? JSON.stringify(body) : undefined });
            return await res.json();
        } catch (e) { return { success: false, message: 'Network error' }; }
    }
    async function form(method, url, fd) {
        try { return await (await fetch(BASE + url, { method, headers: { 'Authorization': 'Bearer ' + tok() }, body: fd })).json(); }
        catch (e) { return { success: false, message: 'Network error' }; }
    }

    let overlay = null, timer = null;
    const S = { id: null, d: null, filter: 'all', editing: null, imgOpen: null, busy: {} };
    const $ = (s) => overlay.querySelector(s);
    const say = (msg, kind) => { const el = $('#ei-msg'); el.textContent = msg || ''; el.style.color = kind === 'err' ? '#b91c1c' : (kind === 'ok' ? '#15803d' : '#6b7280'); };

    function style() {
        if (document.getElementById('ei-style')) return;
        const st = document.createElement('style'); st.id = 'ei-style';
        st.textContent = `
        .ei-card{border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin:10px 0;background:#fafafa}
        .ei-card h4{margin:0 0 6px}
        .ei-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}
        .ei-grid label{font-size:.75rem;color:#6b7280;display:block}
        .ei-grid input,.ei-grid select,.ei-in{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font:inherit;font-size:.88rem}
        .ei-pill{display:inline-block;font-size:.72rem;padding:1px 8px;border-radius:10px;background:#e0e7ff;color:#3730a3;margin:0 4px 4px 0}
        .ei-pill.ok{background:#dcfce7;color:#166534}.ei-pill.warn{background:#fef3c7;color:#92400e}.ei-pill.bad{background:#fee2e2;color:#991b1b}
        .ei-q{border:1px solid #e5e7eb;border-radius:10px;margin:10px 0;background:#fff;display:flex;gap:10px;padding:10px;flex-wrap:wrap}
        .ei-q.attn{border-color:#f59e0b;background:#fffbeb}
        .ei-thumb{flex:0 0 150px}.ei-thumb img{width:150px;max-height:200px;object-fit:cover;object-position:top;border:1px solid #d1d5db;border-radius:6px;cursor:zoom-in;background:#f3f4f6}
        .ei-main{flex:1;min-width:260px}
        .ei-opt{padding:3px 6px;border-radius:6px;font-size:.88rem;margin:2px 0}
        .ei-opt.ai{outline:1px dashed #6366f1}.ei-opt.off{background:#dcfce7}.ei-opt.fin{font-weight:700}
        .ei-btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
        .ei-btns .btn{padding:3px 9px;font-size:.78rem}
        .ei-expl{white-space:pre-wrap;font-size:.82rem;background:#f9fafb;border-radius:6px;padding:6px 8px;margin-top:6px}
        .ei-bar{height:10px;background:#e5e7eb;border-radius:6px;overflow:hidden;margin:8px 0}.ei-bar>div{height:100%;background:#22c55e;transition:width .4s}
        .ei-lb{position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10001;overflow:auto;text-align:center}.ei-lb img{max-width:100%;margin:auto}
        textarea.ei-in{min-height:70px;resize:vertical}
        `;
        document.head.appendChild(st);
    }

    function build() {
        if (overlay) return;
        style();
        overlay = document.createElement('div');
        overlay.className = 'xm-overlay';
        overlay.innerHTML =
            '<div class="xm-box" style="width:1050px">' +
            '<div class="xm-head" style="background:#16a34a"><b>➕ Add New Exam</b><button class="xm-x" id="ei-close">✕</button></div>' +
            '<div class="xm-body">' +
            '<div id="ei-msg" class="xm-note" style="min-height:1.4em;margin:2px 0 6px"></div>' +
            '<div id="ei-work"></div>' +
            '</div></div>';
        document.body.appendChild(overlay);
        $('#ei-close').onclick = close;
    }
    function close() { stopPoll(); if (overlay) overlay.classList.remove('show'); }
    function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

    window.openExamImport = async function () {
        if (!isAdmin()) return;
        build(); overlay.classList.add('show');
        if (S.id) { poll(S.id); return; }
        renderStart();
    };

    // ── step 1: upload ──────────────────────────────────────────────────
    async function renderStart() {
        stopPoll(); S.id = null; S.d = null;
        say('');
        $('#ei-work').innerHTML =
            '<div class="ei-card"><h4>1. Upload the PDFs</h4>' +
            '<div class="ei-grid">' +
            '<div><label>Question paper PDF *</label><input type="file" id="ei-q" accept="application/pdf,.pdf"></div>' +
            '<div><label>Official answer key PDF (recommended)</label><input type="file" id="ei-k" accept="application/pdf,.pdf"></div>' +
            '</div>' +
            '<div class="xm-row"><button class="btn" id="ei-go" style="background:#16a34a">⬆ Upload &amp; read</button></div>' +
            '<div class="xm-note">The server converts the pages to images, uploads them to Telegram, reads the exam name / date / code from the first page, ' +
            'reads every question twice with AI, then runs the website\'s <b>Fix AI</b> on EVERY question (live web facts → solver → independent blind check → tie-breaker) for a verified answer and explanation, reads the answer key twice, and compares everything with the official answers. ' +
            'You review everything here before anything goes to the database. Because every question is verified, a 100-question paper can take an hour or more - you can close this window and come back.</div></div>' +
            '<div class="ei-card"><h4>Earlier uploads</h4><div id="ei-list" class="xm-note">Loading…</div></div>';
        $('#ei-go').onclick = upload;
        const r = await api('GET', '/');
        const box = $('#ei-list'); if (!box) return;
        if (!r.success) { box.textContent = r.message || 'Could not load.'; return; }
        if (!r.ai) say('⚠ No AI is configured - set GEMINI_API_KEYS or add a custom endpoint in 🤖 AI Settings (Fix AI).', 'err');
        else if (r.providers && r.providers.length) say('AI used (same as Fix AI): ' + r.providers.join(' → '));
        box.innerHTML = r.drafts.length ? r.drafts.map(x => `<div class="xm-row" style="align-items:center"><span style="flex:1">${esc(x.name || x.fileName)} <span class="ei-pill ${x.status === 'review' ? 'ok' : (x.status === 'failed' ? 'bad' : '')}">${esc(x.status)}</span> <small>${new Date(x.createdAt).toLocaleString()}</small></span><button class="btn" data-open="${x.id}" style="padding:3px 10px">Open</button><button class="btn btn-outline" data-del="${x.id}" style="padding:3px 10px">Discard</button></div>`).join('') : 'No unfinished uploads.';
        box.querySelectorAll('[data-open]').forEach(b => b.onclick = () => poll(b.dataset.open));
        box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
            if (!confirm('Discard this upload? (Nothing has been published.)')) return;
            const d = await api('DELETE', '/' + b.dataset.del); if (!d.success) return say(d.message || 'Failed', 'err'); renderStart();
        });
    }

    async function upload() {
        const q = $('#ei-q').files[0], k = $('#ei-k').files[0];
        if (!q) return say('Choose the question paper PDF.', 'err');
        if (q.size > 40 * 1024 * 1024 || (k && k.size > 40 * 1024 * 1024)) return say('A PDF is larger than 40 MB.', 'err');
        if (!k && !confirm('No answer key PDF chosen. The questions will only have the AI answers. Continue?')) return;
        const fd = new FormData(); fd.append('qpdf', q); if (k) fd.append('keypdf', k);
        $('#ei-go').disabled = true; say('Uploading…');
        const r = await form('POST', '/upload', fd);
        if (!r.success) { $('#ei-go').disabled = false; return say(r.message || 'Upload failed.', 'err'); }
        poll(r.id);
    }

    // ── step 2: progress ────────────────────────────────────────────────
    function poll(id) {
        S.id = id; stopPoll(); S.filter = 'all'; S.editing = null; S.imgOpen = null;
        $('#ei-work').innerHTML = '<div class="ei-card"><h4>⏳ Reading the exam…</h4><div class="ei-bar"><div style="width:100%;opacity:.4"></div></div><div id="ei-prog" class="xm-note">Starting…</div><div class="xm-note">You can close this window - the work continues on the server. Open "➕ Add New Exam" again to come back.</div></div>';
        const tick = async () => {
            const r = await api('GET', '/' + id);
            if (!r.success) { stopPoll(); S.id = null; say(r.message || 'Error', 'err'); return renderStart(); }
            const d = r.draft;
            if (d.status === 'processing') { const p = $('#ei-prog'); if (p) p.textContent = d.progress || 'Processing…'; return; }
            stopPoll();
            if (d.status === 'failed') {
                $('#ei-work').innerHTML = `<div class="ei-card"><h4 style="color:#b91c1c">❌ Failed</h4><div>${esc(d.error)}</div><div class="xm-row"><button class="btn" id="ei-back">← Back</button><button class="btn btn-outline" id="ei-disc">Discard</button></div></div>`;
                $('#ei-back').onclick = () => { S.id = null; renderStart(); };
                $('#ei-disc').onclick = async () => { await api('DELETE', '/' + id); S.id = null; renderStart(); };
                return;
            }
            if (d.status === 'published') { S.id = null; say('Already published as: ' + d.publishedExam, 'ok'); return renderStart(); }
            S.d = d; say(''); render();
        };
        tick(); timer = setInterval(tick, 2000);
    }

    // ── step 3: review ──────────────────────────────────────────────────
    const needsAttention = (q) => (q.verify && (q.verify.state === 'diff' || q.verify.state === 'missing')) || (q.match === 'mismatch' && !q.auto_fixed) || q.blindDiff || q.keyDoubt || (q.fix && q.fix.state === 'failed') || q.explanationMismatch || q.officialState === 'unverified' || (S.d.key && !q.official && !q.admin_answer);
    const filtered = () => S.d.questions.filter(q => S.filter === 'all' ? true : (S.filter === 'attn' ? needsAttention(q) : (S.filter === 'mismatch' ? q.match === 'mismatch' : (S.filter === 'blind' ? (q.blindDiff || q.keyDoubt) : (S.filter === 'verify' ? (q.verify && (q.verify.state === 'diff' || q.verify.state === 'missing')) : q.edited || q.rescanned)))));

    function render() {
        const d = S.d, m = d.meta || {}, s = d.summary;
        const groups = window.examGroups || [];
        const keySets = d.key ? d.key.sets : [];
        $('#ei-work').innerHTML =
            '<div class="ei-card"><h4>2. Exam details <small>(read from the first page - fix anything that is wrong)</small></h4>' +
            '<div class="ei-grid">' +
            `<div style="grid-column:1/-1"><label>Exam name on the website (folder card title) *</label><input id="ei-name" value="${esc(m.yearExam)}"></div>` +
            `<div><label>Official exam name</label><input id="ei-oname" value="${esc(m.officialName)}"></div>` +
            `<div><label>Exam date</label><input id="ei-date" value="${esc(m.examDate)}"></div>` +
            `<div><label>Exam / advertisement code</label><input id="ei-code" value="${esc(m.examCode)}"></div>` +
            `<div><label>Paper name</label><input id="ei-pname" value="${esc(m.paperName)}"></div>` +
            `<div><label>Question paper code / set</label><input id="ei-pset" value="${esc(m.paperSet)}"></div>` +
            `<div><label>Answer key set used for this paper</label><select id="ei-kset"><option value="">${d.key ? '— choose —' : 'no answer key'}</option>${keySets.map(k => `<option value="${k.name}" ${d.keySet === k.name ? 'selected' : ''}>Set ${k.name} (${k.answers} answers)</option>`).join('')}</select></div>` +
            '</div><div class="xm-row"><button class="btn" id="ei-savemeta">Save details</button><button class="btn btn-outline" id="ei-autoname" title="Rebuild the website name from official name + paper + date">↻ Rebuild name</button></div></div>' +
            summaryHtml(s, d) +
            (d.notes && d.notes.length ? '<div class="ei-card" style="border-color:#f59e0b"><h4>⚠ Check these</h4>' + d.notes.map(n => '<div style="font-size:.85rem">• ' + esc(n) + '</div>').join('') + '</div>' : '') +
            keyHtml(d) +
            '<div class="xm-row" style="align-items:center"><b>Questions</b><select id="ei-filter" style="max-width:260px"></select><span class="xm-note" id="ei-count"></span></div>' +
            '<div id="ei-qs"></div>' +
            '<div class="ei-card"><h4>4. Publish</h4>' +
            '<div class="xm-note">Put the exam in these folders (groups) on the dashboard:</div>' +
            '<div id="ei-groups" style="margin:6px 0">' + (groups.length ? groups.map(g => `<label style="display:inline-block;margin:0 12px 4px 0"><input type="checkbox" class="ei-g" value="${esc(g._id)}"> ${esc(g.name)}</label>`).join('') : '<span class="xm-note">No groups yet - the exam will appear in "All Exams".</span>') + '</div>' +
            '<div class="xm-row"><button class="btn" id="ei-publish" style="background:#16a34a">✅ Publish this exam to the website</button><button class="btn btn-outline" id="ei-discard" style="border-color:#dc2626;color:#dc2626">🗑 Discard everything</button></div></div>';

        $('#ei-savemeta').onclick = saveMeta;
        $('#ei-autoname').onclick = () => saveMeta(true);
        $('#ei-publish').onclick = publish;
        $('#ei-discard').onclick = async () => { if (!confirm('Discard this whole upload? Nothing has been published.')) return; const r = await api('DELETE', '/' + S.id); if (!r.success) return say(r.message || 'Failed', 'err'); S.id = null; renderStart(); };
        const f = $('#ei-filter');
        f.innerHTML = `<option value="all">All questions (${s.total})</option><option value="attn">Needs my attention</option><option value="mismatch">AI answer ≠ official answer (${s.mismatch})</option><option value="blind">AI answers disagree / key doubt (${(s.blindDiff || 0) + (s.keyDoubt || 0)})</option><option value="verify">Second reading differs (${s.verifyDiff})</option><option value="changed">Edited / re-scanned by me</option>`;
        f.value = S.filter; f.onchange = () => { S.filter = f.value; renderQuestions(); };
        wireKey();
        renderQuestions();
    }

    function summaryHtml(s, d) {
        const pill = (cls, t) => `<span class="ei-pill ${cls}">${t}</span>`;
        return '<div class="ei-card"><h4>Summary</h4>' +
            pill('', s.total + ' questions') + pill('', d.pageCount + ' pages') +
            (d.key ? pill(s.noOfficial ? 'warn' : 'ok', s.withKey + ' have the official answer') : pill('warn', 'no answer key')) +
            (d.key ? pill(s.mismatch ? 'bad' : 'ok', 'AI = official: ' + s.match + (s.mismatch ? ' · differs: ' + s.mismatch : '')) : '') +
            pill(s.verifyDiff ? 'warn' : 'ok', 'second reading differs: ' + s.verifyDiff) +
            (s.unresolvedKey ? pill('bad', s.unresolvedKey + ' key answers not verified') : '') +
            (s.fixOk ? pill('ok', '🛡 ' + s.fixOk + ' verified by Fix AI (answer + explanation)') : '') +
            ((s.fixFailed || 0) ? pill('bad', s.fixFailed + ' could NOT be verified by Fix AI - check / re-scan') : '') +
            ((s.blindDiff || 0) ? pill('warn', s.blindDiff + ' answers: AI and blind check disagree') : '') +
            ((s.keyDoubt || 0) ? pill('bad', s.keyDoubt + ' official answers doubted (AI + blind check agree on another option) - check the key page') : '') +
            ((s.autoFixed || 0) ? pill('ok', s.autoFixed + ' explanations rebuilt for the official answer') : '') +
            (s.explanationMismatch ? pill('warn', s.explanationMismatch + ' explanations written for another option') : '') +
            '</div>';
    }

    function keyHtml(d) {
        const un = d.questions.filter(q => q.officialState === 'unverified');
        if (!d.key) return '';
        let h = '<div class="ei-card"><h4>3. Official answer key <small>(read twice - an answer is accepted only when both readings agree)</small></h4>';
        h += '<div class="xm-note">Engines: ' + d.key.engines.map(e => esc(e.name)).join(' + ') + ' · key pages: ' + d.key.pageCount + '</div>';
        if (d.key.images.length) h += '<div style="display:flex;gap:8px;overflow-x:auto;padding:6px 0">' + d.key.images.map(i => `<a href="${imgUrl(i.ref)}" target="_blank" style="font-size:.7rem;text-align:center;flex:0 0 auto"><img src="${imgUrl(i.ref)}" style="height:80px;border:1px solid #d1d5db;border-radius:6px;display:block" loading="lazy">p${i.page}</a>`).join('') + '</div>';
        if (!d.keySet) h += '<div style="color:#b91c1c;font-size:.85rem">Choose the answer key set above, then press "Save details".</div>';
        else if (un.length) {
            h += `<div style="color:#92400e;font-size:.85rem;margin:4px 0">${un.length} answer(s) could not be confirmed by both readings. Pick the right one (look at the key page) and save:</div><div id="ei-unv" style="max-height:200px;overflow:auto;border:1px solid #eee;border-radius:8px;background:#fff;padding:4px 8px">` +
                un.map(q => `<div class="xm-row" style="align-items:center;margin:2px 0"><b style="min-width:48px">Q${q.qnum}</b><span class="xm-note" style="flex:1">reading 1: ${esc(q.officialA ? fmtAns(q.officialA) : '—')} · reading 2: ${esc(q.officialB ? fmtAns(q.officialB) : '—')}</span><select class="ei-ov" data-q="${q.qnum}" style="flex:0 0 120px"><option value="">— choose —</option>${['1', '2', '3', '4', '#'].map(v => `<option value="${v}" ${(d.overrides[q.qnum] === v) ? 'selected' : ''}>${v === '#' ? '# (रद्द)' : v + ' (' + L(v) + ')'}</option>`).join('')}</select></div>`).join('') +
                '</div><div class="xm-row"><button class="btn" id="ei-saveov">Save these answers</button></div>';
        } else h += '<div style="color:#15803d;font-size:.85rem">✔ Every official answer was confirmed by both readings.</div>';
        return h + '</div>';
    }
    function wireKey() {
        const b = $('#ei-saveov'); if (!b) return;
        b.onclick = async () => {
            const ov = Object.assign({}, S.d.overrides || {});
            overlay.querySelectorAll('.ei-ov').forEach(s => { if (s.value) ov[s.dataset.q] = s.value; else delete ov[s.dataset.q]; });
            say('Saving…'); const r = await api('PUT', '/' + S.id + '/overrides', { overrides: ov });
            if (!r.success) return say(r.message || 'Failed', 'err');
            S.d = r.draft; say('Saved.', 'ok'); render();
        };
    }

    async function saveMeta(rebuild) {
        const body = { officialName: $('#ei-oname').value, examDate: $('#ei-date').value, examCode: $('#ei-code').value, paperName: $('#ei-pname').value, paperSet: $('#ei-pset').value, keySet: $('#ei-kset').value, yearExam: rebuild === true ? '' : $('#ei-name').value };
        say('Saving…');
        const r = await api('PATCH', '/' + S.id + '/meta', body);
        if (!r.success) return say(r.message || 'Failed', 'err');
        S.d = r.draft; say('Saved.', 'ok'); render();
    }

    // ── question cards ──────────────────────────────────────────────────
    function imageOf(q) {
        if (q.imageRef) return q.imageRef;
        const p = S.d.pages.find(x => x.page === q.page); return p ? p.ref : null;
    }
    function qHtml(q) {
        const ref = imageOf(q), ed = S.editing === q.qnum, busy = S.busy[q.qnum];
        const attn = needsAttention(q);
        const pills = [];
        if (q.verify && q.verify.state === 'ok') pills.push('<span class="ei-pill ok">2nd reading ✔</span>');
        if (q.verify && (q.verify.state === 'diff' || q.verify.state === 'missing')) pills.push(`<span class="ei-pill warn" title="${esc(q.verify.note)}">2nd reading differs</span>`);
        if (q.officialState === 'unverified') pills.push('<span class="ei-pill bad">key answer unverified</span>');
        else if (q.official) pills.push(`<span class="ei-pill ${q.match === 'mismatch' ? 'bad' : 'ok'}">official: ${esc(fmtAns(q.official))}</span>`);
        else if (S.d.key) pills.push('<span class="ei-pill warn">no official answer</span>');
        if (q.ai_answer) pills.push(`<span class="ei-pill ${q.match === 'mismatch' ? 'bad' : ''}">AI: ${esc(fmtAns(q.ai_answer))}</span>`);
        if (q.match === 'mismatch') pills.push(q.auto_fixed ? '<span class="ei-pill ok" title="The AI first said another option; the explanation was rebuilt for the official answer.">AI first said ' + esc(fmtAns(q.ai_answer_original)) + ' → explanation rebuilt</span>' : '<span class="ei-pill bad">AI ≠ official</span>');
        if (q.fix && q.fix.state === 'verified') pills.push('<span class="ei-pill ok" title="Solved by the Fix AI and confirmed by an independent blind check' + (q.fix.note ? '. ' + esc(q.fix.note) : '') + '">🛡 Fix AI verified</span>');
        if (q.fix && q.fix.state === 'failed') pills.push('<span class="ei-pill bad" title="' + esc(q.fix.note) + '">answer NOT verified</span>');
        if (false && q.blind_answer) pills.push('<span class="ei-pill ' + (q.blindDiff ? 'warn' : '') + '" title="Independent blind check (the AI solved it again without seeing any answer)">blind: ' + esc(fmtAns(q.blind_answer)) + '</span>');
        if (q.blindDiff) pills.push('<span class="ei-pill warn">AI ≠ blind check</span>');
        if (q.keyDoubt) pills.push('<span class="ei-pill bad" title="AI and the blind check agree with each other but not with the official key. Open the key page and check.">key doubted</span>');
        if (q.explanationMismatch) pills.push('<span class="ei-pill warn" title="The explanation was written for another option than the final answer. Press Re-scan.">explanation ≠ final answer</span>');
        if (q.imageRef) pills.push('<span class="ei-pill">own image</span>');
        if (q.edited) pills.push('<span class="ei-pill">edited</span>');
        if (q.rescanned) pills.push('<span class="ei-pill">re-scanned</span>');
        const head = `<div><b>Q${q.qnum}</b> <span class="xm-note">· page ${q.page} · ${esc(q.subject || '')}${q.topic && q.topic !== 'General' ? ' › ' + esc(q.topic) : ''}</span></div><div style="margin:3px 0">${pills.join('')}</div>`;
        const thumb = `<div class="ei-thumb">${ref ? `<img src="${imgUrl(ref)}" data-zoom="${q.qnum}" loading="lazy" alt="page ${q.page}">` : '<div class="xm-note">no image</div>'}</div>`;
        let body;
        if (ed) {
            body = head +
                `<label class="xm-note">Question</label><textarea class="ei-in" id="ed-text">${esc(q.text)}</textarea>` +
                [0, 1, 2, 3].map(i => `<label class="xm-note">Option ${i + 1} (${L(String(i + 1))})</label><input class="ei-in ed-opt" value="${esc((q.options || [])[i] || '')}">`).join('') +
                `<label class="xm-note">Explanation</label><textarea class="ei-in" id="ed-expl" style="min-height:110px">${esc(q.toppers_explanation_marathi)}</textarea>` +
                `<div class="ei-grid" style="margin-top:6px"><div><label>Subject</label><input id="ed-subj" value="${esc(q.subject)}"></div><div><label>Topic</label><input id="ed-topic" value="${esc(q.topic)}"></div>` +
                `<div><label>Final answer (leave Auto = official, else AI)</label><select id="ed-ans"><option value="">Auto</option>${['1', '2', '3', '4', '#'].map(v => `<option value="${v}" ${q.admin_answer === v ? 'selected' : ''}>${v === '#' ? '# (रद्द)' : v + ' (' + L(v) + ')'}</option>`).join('')}</select></div></div>` +
                `<div class="ei-btns"><button class="btn" data-act="save">💾 Save</button><button class="btn btn-outline" data-act="cancel">Cancel</button></div>`;
        } else {
            body = head + `<div style="white-space:pre-wrap;margin:4px 0">${esc(q.text)}</div>` +
                (q.options || []).map((o, i) => { const n = String(i + 1); const isOff = q.official && String(q.official).split('/').includes(n), isAi = q.ai_answer === n, isFin = q.final && String(q.final).split('/').includes(n); return `<div class="ei-opt ${isOff ? 'off' : ''} ${isAi ? 'ai' : ''} ${isFin ? 'fin' : ''}">${L(n)}. ${esc(o)}${isFin ? ' ✔' : ''}</div>`; }).join('') +
                `<div class="xm-note" style="margin-top:4px">Final answer on the website: <b>${esc(q.final ? fmtAns(q.final) : '—')}</b></div>` +
                `<details style="margin-top:4px"><summary class="xm-note" style="cursor:pointer">Explanation</summary><div class="ei-expl">${esc(q.toppers_explanation_marathi)}</div>${(q.options_explanation || []).map((e, i) => `<div class="ei-expl">${L(String(i + 1))}: ${esc(e)}</div>`).join('')}</details>` +
                (S.imgOpen === q.qnum ? imgToolHtml(q) : '') +
                `<div class="ei-btns">${busy ? '<span class="xm-note">⏳ ' + esc(busy) + '</span>' : `<button class="btn" data-act="edit">✏ Edit</button><button class="btn" data-act="img">🖼 Image</button><button class="btn" data-act="rescan" title="Read this question again from its image">🔄 Re-scan</button><button class="btn" data-act="rescantext" title="Keep my edited text and rebuild the answer + explanation">🔄 Re-scan from my text</button><button class="btn btn-outline" data-act="del" style="border-color:#dc2626;color:#dc2626">🗑</button>`}</div>`;
        }
        return `<div class="ei-q ${attn ? 'attn' : ''}" id="ei-q-${q.qnum}" data-q="${q.qnum}">${thumb}<div class="ei-main">${body}</div></div>`;
    }
    function imgToolHtml(q) {
        return `<div class="ei-card" style="margin:6px 0"><div class="xm-note">This question is printed on a different page? Pick it, or upload your own cropped image. Then press "Re-scan".</div>` +
            `<div class="xm-row" style="align-items:center"><select id="im-page" style="max-width:150px">${S.d.pages.map(p => `<option value="${p.page}" ${p.page === q.page ? 'selected' : ''}>Page ${p.page}</option>`).join('')}</select><button class="btn" data-act="usepage">Use this page</button>` +
            `<input type="file" id="im-file" accept="image/jpeg,image/png,image/webp" style="flex:1"><button class="btn" data-act="upimg">Upload image</button>${q.imageRef ? '<button class="btn btn-outline" data-act="rmimg">Remove my image</button>' : ''}</div></div>`;
    }

    function renderQuestions() {
        const list = filtered();
        $('#ei-count').textContent = list.length + ' shown';
        const box = $('#ei-qs');
        box.innerHTML = list.length ? list.map(qHtml).join('') : '<div class="xm-note">Nothing here.</div>';
        box.onclick = onClick;
    }
    function redrawOne(qnum) {
        const q = S.d.questions.find(x => x.qnum === qnum); const el = $('#ei-q-' + qnum);
        if (!q || !el) return renderQuestions();
        el.outerHTML = qHtml(q);
    }
    function applyResult(r, qnum) {
        const i = S.d.questions.findIndex(x => x.qnum === qnum);
        if (i >= 0 && r.question) S.d.questions[i] = r.question;
        if (r.summary) S.d.summary = r.summary;
        const cards = overlay.querySelectorAll('.ei-card'); for (const c of cards) { if (c.firstChild && c.firstChild.textContent === 'Summary') { c.outerHTML = summaryHtml(S.d.summary, S.d); break; } }
    }

    async function onClick(e) {
        const zoom = e.target.closest('[data-zoom]');
        if (zoom) { const q = S.d.questions.find(x => x.qnum === +zoom.dataset.zoom); const ref = q && imageOf(q); if (ref) lightbox(imgUrl(ref)); return; }
        const btn = e.target.closest('[data-act]'); if (!btn) return;
        const row = btn.closest('[data-q]'); const n = +row.dataset.q;
        const q = S.d.questions.find(x => x.qnum === n); const act = btn.dataset.act;
        if (act === 'edit') { S.editing = n; return redrawOne(n); }
        if (act === 'cancel') { S.editing = null; return redrawOne(n); }
        if (act === 'img') { S.imgOpen = S.imgOpen === n ? null : n; return redrawOne(n); }
        if (act === 'save') {
            const body = { text: row.querySelector('#ed-text').value, options: [...row.querySelectorAll('.ed-opt')].map(i => i.value), toppers_explanation_marathi: row.querySelector('#ed-expl').value, subject: row.querySelector('#ed-subj').value, topic: row.querySelector('#ed-topic').value, admin_answer: row.querySelector('#ed-ans').value };
            S.busy[n] = 'Saving…'; const r = await api('PATCH', `/${S.id}/question/${n}`, body); delete S.busy[n];
            if (!r.success) { say(r.message || 'Failed', 'err'); return redrawOne(n); }
            S.editing = null; applyResult(r, n); say('Saved. If you changed the question text or options, press "Re-scan from my text" to rebuild the answer + explanation.', 'ok'); return redrawOne(n);
        }
        if (act === 'rescan' || act === 'rescantext') {
            if (!confirm(act === 'rescan' ? `Run the Fix AI on Q${n}? It reads the question again from its image, searches the web for facts, solves it and verifies it with an independent blind check. This can take a few minutes. Your edits to this question will be replaced.` : `Rebuild the answer + explanation of Q${n} from the text you saved?`)) return;
            S.busy[n] = act === 'rescan' ? 'Fix AI is working on this question… (a few minutes)' : 'Rebuilding…'; redrawOne(n);
            const st = await api('POST', `/${S.id}/question/${n}/rescan`, { mode: act === 'rescan' ? 'image' : 'text' });
            if (!st.success) { delete S.busy[n]; say(st.message || 'Re-scan failed', 'err'); return redrawOne(n); }
            const finish = (r) => { delete S.busy[n]; if (r.state === 'error') { say('Q' + n + ': ' + (r.message || 'Re-scan failed'), 'err'); return redrawOne(n); } applyResult(r, n); say('Q' + n + ' re-scanned.', 'ok'); redrawOne(n); };
            const wait = async () => {
                if (!overlay || !S.d) return;
                const r = await api('GET', `/${S.id}/question/${n}/rescan-status`);
                if (!r.success) { delete S.busy[n]; say(r.message || 'Error', 'err'); return redrawOne(n); }
                if (r.state === 'running') return setTimeout(wait, 3000);
                if (r.state === 'none') { delete S.busy[n]; return redrawOne(n); }
                finish(r);
            };
            return setTimeout(wait, 2500);
        }
        if (act === 'usepage') {
            const p = +row.querySelector('#im-page').value;
            const r = await api('PATCH', `/${S.id}/question/${n}`, { page: p });
            if (!r.success) return say(r.message || 'Failed', 'err');
            applyResult(r, n); say('Image changed to page ' + p + '. Press "Re-scan" to read the question from it.', 'ok'); return redrawOne(n);
        }
        if (act === 'upimg') {
            const f = row.querySelector('#im-file').files[0]; if (!f) return say('Choose an image first.', 'err');
            const fd = new FormData(); fd.append('image', f);
            S.busy[n] = 'Uploading image…'; redrawOne(n);
            const r = await form('POST', `/${S.id}/question/${n}/image`, fd); delete S.busy[n];
            if (!r.success) { say(r.message || 'Failed', 'err'); return redrawOne(n); }
            applyResult(r, n); say('Image uploaded. Press "Re-scan" to read the question from it.', 'ok'); return redrawOne(n);
        }
        if (act === 'rmimg') {
            const r = await api('DELETE', `/${S.id}/question/${n}/image`);
            if (!r.success) return say(r.message || 'Failed', 'err');
            applyResult(r, n); return redrawOne(n);
        }
        if (act === 'del') {
            if (!confirm(`Remove Q${n} from this exam? (It was not published yet.)`)) return;
            const r = await api('DELETE', `/${S.id}/question/${n}`);
            if (!r.success) return say(r.message || 'Failed', 'err');
            S.d = Object.assign({}, S.d, r.draft); render();
        }
    }

    function lightbox(url) {
        const lb = document.createElement('div'); lb.className = 'ei-lb';
        lb.innerHTML = `<img src="${url}">`; lb.onclick = () => lb.remove(); document.body.appendChild(lb);
    }

    async function publish() {
        const s = S.d.summary;
        let warn = '';
        if (s.mismatch) warn += `\n• ${s.mismatch} question(s) where the AI answer differs from the official answer (the official answer will be used).`;
        if (s.unresolvedKey) warn += `\n• ${s.unresolvedKey} key answer(s) are not confirmed - those questions will use the AI answer.`;
        if (s.explanationMismatch) warn += `\n• ${s.explanationMismatch} explanation(s) were written for a different option than the final answer.`;
        if (s.fixFailed) warn += `\n• ${s.fixFailed} question(s) could NOT be verified by Fix AI (their answer / explanation are unverified).`;
        if (s.verifyDiff) warn += `\n• ${s.verifyDiff} question(s) where the second reading differs.`;
        if (!confirm(`Publish "${S.d.meta.yearExam}" with ${s.total} questions to the website?${warn ? '\n\nStill open:' + warn : ''}`)) return;
        const groupIds = [...overlay.querySelectorAll('.ei-g:checked')].map(c => c.value);
        $('#ei-publish').disabled = true; say('Publishing…');
        const r = await api('POST', '/' + S.id + '/publish', { confirm: true, groupIds });
        $('#ei-publish').disabled = false;
        if (!r.success) return say(r.message || 'Publish failed.', 'err');
        stopPoll(); S.id = null; S.d = null;
        $('#ei-work').innerHTML = `<div class="ei-card"><h4 style="color:#15803d">✅ Published</h4><div><b>${esc(r.examId)}</b> - ${r.published} questions are live${r.groups ? ' and were added to ' + r.groups + ' folder(s)' : ''}.</div><div class="xm-row"><button class="btn" id="ei-more">Add another exam</button><button class="btn btn-outline" id="ei-done">Close</button></div></div>`;
        $('#ei-more').onclick = renderStart; $('#ei-done').onclick = close;
        say('');
        try { if (typeof window.loadDashboard === 'function') await window.loadDashboard(); } catch (e) { /* dashboard also refreshes by itself (catalog event) */ }
    }
})();

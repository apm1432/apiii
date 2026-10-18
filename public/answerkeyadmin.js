// Admin tool: upload an OFFICIAL ANSWER KEY PDF.
//  PDF -> server reads it twice (2 independent passes) -> pages are uploaded to Telegram -> admin picks exam + set
//  -> sees the % match between the site's final answers and the official key -> Save writes the official answer and the
//  key page image into every question of that exam.
//  FINAL answers: the compare list shows every wrong question with its image(s); the admin picks the final answer for each one
//  (default = official key) or replaces ALL finals with the official key. Undo restores what this tool changed.
(function () {
    const tok = () => localStorage.getItem('jwtToken');
    const isAdmin = () => { try { return !!(JSON.parse(localStorage.getItem('currentUser')) || {}).isAdmin; } catch (e) { return false; } };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const BASE = '/api/admin/answer-key';

    async function api(method, url, body) {
        try {
            const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok() }, body: body ? JSON.stringify(body) : undefined });
            return await res.json();
        } catch (e) { return { success: false, message: 'Network error' }; }
    }

    // "2" -> "2 (B)"   "1/3" -> "1/3 (A/C)"   "#" -> "# (cancelled)"
    const fmt = (a) => {
        if (a == null || a === '') return '—';
        if (a === '#') return '# (रद्द)';
        return a + ' (' + String(a).split('/').map(n => 'ABCD'[(+n) - 1] || '?').join('/') + ')';
    };
    const imgUrl = (ref) => '/api/image/' + encodeURIComponent(JSON.stringify(ref)) + '?token=' + encodeURIComponent(tok());

    // url of a stored question image (object {botIdx:fileId}, JSON string or plain id)
    const rawImgUrl = (raw) => {
        let o = raw;
        if (typeof o === 'string') { const t = o.trim(); if (t.startsWith('{')) { try { o = JSON.parse(t); } catch (e) { } } }
        if (!o) return null;
        const src = typeof o === 'string' ? (o.startsWith('/api/image/') ? o : '/api/image/' + o) : '/api/image/' + encodeURIComponent(JSON.stringify(o));
        return src + (src.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tok());
    };

    let overlay = null, timer = null, rescanTimer = null, state = { key: null, exams: [], aiVerify: false, overrides: {}, cmpTimer: null, busy: false, finalChoices: {}, lastResult: null };
    const $ = (s) => overlay.querySelector(s);
    const say = (msg, kind) => { const el = $('#ak-msg'); el.textContent = msg || ''; el.style.color = kind === 'err' ? '#b91c1c' : (kind === 'ok' ? '#15803d' : '#6b7280'); };

    function injectStyle() {
        if (document.getElementById('ak-style')) return;
        const st = document.createElement('style');
        st.id = 'ak-style';
        st.textContent = `
        .ak-card{border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin:10px 0;background:#fafafa}
        .ak-card h4{margin:0 0 6px}
        .ak-pct{font-size:2.2rem;font-weight:800;line-height:1}
        .ak-good{color:#15803d}.ak-mid{color:#b45309}.ak-bad{color:#b91c1c}
        .ak-bar{height:10px;background:#e5e7eb;border-radius:6px;overflow:hidden;margin:8px 0}
        .ak-bar>div{height:100%;background:#22c55e}
        .ak-table{width:100%;border-collapse:collapse;font-size:.82rem}
        .ak-table th,.ak-table td{border-bottom:1px solid #eee;padding:4px 6px;text-align:left;vertical-align:middle}
        .ak-scroll{max-height:220px;overflow:auto;border:1px solid #eee;border-radius:8px;background:#fff}
        .ak-pages{display:flex;gap:8px;overflow-x:auto;padding:4px 0}
        .ak-pages a{flex:0 0 auto;text-align:center;font-size:.72rem;color:#374151;text-decoration:none}
        .ak-pages img{height:90px;border:1px solid #d1d5db;border-radius:6px;display:block;background:#fff}
        .ak-pill{display:inline-block;font-size:.72rem;padding:1px 8px;border-radius:10px;background:#e0e7ff;color:#3730a3;margin:0 4px 4px 0}
        .ak-pill.ok{background:#dcfce7;color:#166534}.ak-pill.warn{background:#fef3c7;color:#92400e}.ak-pill.bad{background:#fee2e2;color:#991b1b}
        .ak-sel{padding:4px 6px;border:1px solid #d1d5db;border-radius:6px}
        .ak-save{background:#16a34a}
        .ak-rescan{background:#7c3aed;color:#fff;border:0;border-radius:8px;padding:6px 12px;cursor:pointer;font-weight:600}
        .ak-rescan:disabled{opacity:.6;cursor:wait}
        .ak-mmwrap{max-height:70vh;overflow:auto;border:1px solid #eee;border-radius:8px;background:#fff;padding:6px}
        .ak-mm{border:1px solid #e5e7eb;border-radius:10px;padding:8px 10px;margin:8px 0;background:#fff}
        .ak-mm.chg{border-color:#f59e0b;background:#fffbeb}
        .ak-mmh{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:.82rem;margin-bottom:6px}
        .ak-mmimg{display:flex;flex-direction:column;gap:6px}
        .ak-mmimg img{max-width:100%;max-height:340px;object-fit:contain;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:zoom-in;align-self:flex-start}
        .ak-opt{font-size:.8rem;padding:1px 0}
        .ak-opt.off{color:#15803d;font-weight:700}.ak-opt.site{color:#b91c1c;font-weight:700}
        .ak-fin-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px;padding-top:6px;border-top:1px dashed #e5e7eb;font-size:.82rem}
        .ak-fin-row select{font-weight:700}
        .ak-amber{background:#d97706}.ak-grey{background:#6b7280}
        `;
        document.head.appendChild(st);
    }

    function build() {
        if (overlay) return;
        injectStyle();
        overlay = document.createElement('div');
        overlay.className = 'xm-overlay';
        overlay.innerHTML =
            '<div class="xm-box" style="width:900px">' +
            '<div class="xm-head" style="background:#ea580c"><b>📋 Official Answer Key</b><button class="xm-x" id="ak-close">✕</button></div>' +
            '<div class="xm-body">' +
            '<div class="ak-card">' +
            '<h4>1. Upload the official answer key PDF</h4>' +
            '<div class="xm-row"><select id="ak-exam"></select></div>' +
            '<div class="xm-row"><input type="file" id="ak-file" accept="application/pdf,.pdf"><button class="btn" id="ak-upload">⬆ Upload &amp; verify</button></div>' +
            '<div class="xm-row"><select id="ak-recent"><option value="">— or open an earlier upload —</option></select></div>' +
            '<div class="xm-note" id="ak-aiNote"></div>' +
            '</div>' +
            '<div id="ak-msg" class="xm-note" style="min-height:1.4em;margin:4px 0"></div>' +
            '<div id="ak-work"></div>' +
            '</div></div>';
        document.body.appendChild(overlay);
        $('#ak-close').onclick = close;
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
        $('#ak-upload').onclick = upload;
        $('#ak-recent').onchange = (e) => { if (e.target.value) openKey(e.target.value); };
    }

    function close() { stopPoll(); if (overlay) overlay.classList.remove('show'); }
    function stopPoll() { if (timer) { clearInterval(timer); timer = null; } if (rescanTimer) { clearInterval(rescanTimer); rescanTimer = null; } }

    async function loadLists() {
        const [ex, rec] = await Promise.all([api('GET', '/exams'), api('GET', '/')]);
        if (ex.success) {
            state.exams = ex.exams; state.aiVerify = !!ex.aiVerify;
            $('#ak-exam').innerHTML = '<option value="">— select the exam this key belongs to —</option>' +
                ex.exams.map(e => `<option value="${esc(e.examId)}">${esc(e.examId)}  (${e.count} Q${e.withOfficial ? ' · ' + e.withOfficial + ' have official key' : ''})</option>`).join('');
            $('#ak-aiNote').textContent = state.aiVerify
                ? 'Verification: pass 1 = PDF text, pass 2 = AI vision on the page images. An answer is accepted only if both agree.'
                : 'Verification: pass 1 = PDF text (layout), pass 2 = PDF text (raw order). No Gemini key found, so AI vision is not used.';
        } else say(ex.message || 'Could not load exams.', 'err');
        if (rec.success) {
            $('#ak-recent').innerHTML = '<option value="">— or open an earlier upload —</option>' +
                rec.keys.map(k => `<option value="${k.id}">${esc(k.fileName)} · ${esc(k.status)}${k.applied ? ' · applied: ' + esc(k.applied) : ''} · ${new Date(k.createdAt).toLocaleString()}</option>`).join('');
        }
    }

    async function upload() {
        const f = $('#ak-file').files[0];
        const examId = $('#ak-exam').value;
        if (!examId) return say('Select the exam first.', 'err');
        if (!f) return say('Choose the answer key PDF.', 'err');
        if (f.size > 25 * 1024 * 1024) return say('PDF is larger than 25 MB.', 'err');
        const fd = new FormData(); fd.append('examId', examId); fd.append('pdf', f);
        $('#ak-upload').disabled = true;
        say('Uploading…');
        let r;
        try { r = await (await fetch(BASE + '/upload', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok() }, body: fd })).json(); }
        catch (e) { r = { success: false, message: 'Network error' }; }
        $('#ak-upload').disabled = false;
        if (!r.success) return say(r.message || 'Upload failed.', 'err');
        state.overrides = {};
        openKey(r.id);
    }

    function startPoll(id) {
        stopPoll();
        const tick = async () => {
            const r = await api('GET', '/' + id);
            if (!r.success) { stopPoll(); return say(r.message || 'Error', 'err'); }
            if (r.key.status === 'processing') { say('⏳ ' + (r.key.progress || 'Processing…')); return; }
            stopPoll();
            state.key = r.key;
            renderKey();
        };
        tick();
        timer = setInterval(tick, 1500);
    }

    async function openKey(id) {
        state.key = null; state.overrides = {};
        $('#ak-work').innerHTML = '';
        say('⏳ Loading…');
        startPoll(id);
    }

    // ── result of an upload ─────────────────────────────────────────────
    function renderKey() {
        const k = state.key;
        if (k.status === 'failed') { $('#ak-work').innerHTML = ''; return say('❌ ' + (k.error || 'Failed.'), 'err'); }
        say('');
        const v = k.verification || {};
        const engines = (v.engines || []).map(e => `<span class="ak-pill ok">${esc(e.name)}</span>`).join('');
        const setRows = k.sets.map(s => {
            const ps = (v.perSet || {})[s.name] || {};
            const bad = (ps.conflicts || 0) + (ps.onlyOne || 0);
            return `<tr><td><b>Set ${esc(s.name)}</b></td><td>${s.answers} verified</td><td>${ps.conflicts ? `<span class="ak-pill bad">${ps.conflicts} conflict</span>` : ''}${ps.onlyOne ? `<span class="ak-pill warn">${ps.onlyOne} read by one pass only</span>` : ''}${bad ? '' : '<span class="ak-pill ok">all verified</span>'}</td><td>${ps.gaps && ps.gaps.length ? `<span class="ak-pill warn">missing Q: ${esc(ps.gaps.slice(0, 12).join(', '))}${ps.gaps.length > 12 ? '…' : ''}</span>` : ''}</td></tr>`;
        }).join('');
        const pages = k.images.map(i => `<a href="${imgUrl(i.ref)}" target="_blank" rel="noopener"><img loading="lazy" src="${imgUrl(i.ref)}" alt="page ${i.page}">p.${i.page} · msg #${i.messageId}</a>`).join('');
        const defaultExam = k.examId || '';

        $('#ak-work').innerHTML =
            '<div class="ak-card"><h4>2. Verification result</h4>' +
            `<div>${engines}<span class="ak-pill">${k.pageCount} page(s)</span><span class="ak-pill">${esc(k.fileName)}</span>${k.pdf ? `<span class="ak-pill">PDF · Telegram msg #${k.pdf.messageId}</span>` : ''}</div>` +
            `<table class="ak-table" style="margin-top:6px">${setRows}</table>` +
            ((v.notes || []).length ? `<div style="margin-top:6px;padding:6px 8px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:.8rem;color:#92400e">${(v.notes || []).map(n => '⚠ ' + esc(n)).join('<br>')}</div>` : '') +
            '<div class="xm-actions" style="margin-top:8px"><button class="ak-rescan ak-rescan-btn">🔁 Re-scan by AI</button></div>' +
            rescanSummaryHtml(k) +
            '<div class="xm-note" style="margin-top:6px">Key pages saved on Telegram (message id shown under each page):</div>' +
            `<div class="ak-pages">${pages}</div></div>` +

            '<div class="ak-card"><h4>3. Pick the set &amp; compare with the final answers</h4>' +
            '<div class="xm-row">' +
            `<select id="ak-set">${k.sets.map(s => `<option value="${esc(s.name)}">Set ${esc(s.name)} (${s.answers} answers)</option>`).join('')}</select>` +
            `<select id="ak-exam2">${state.exams.map(e => `<option value="${esc(e.examId)}"${e.examId === defaultExam ? ' selected' : ''}>${esc(e.examId)} (${e.count} Q)</option>`).join('')}</select>` +
            '</div>' +
            '<label class="xm-chk"><input type="checkbox" id="ak-single"> Accept answers that only one pass could read (conflicts still need confirming)</label>' +
            '<div id="ak-unver"></div>' +
            '<div id="ak-cmp" style="margin-top:8px"></div>' +
            '<div id="ak-chk"></div>' +
            '<div class="ak-card" style="background:#fff7ed;border-color:#fdba74"><h4 style="font-size:.95rem">Final answer (the answer the site marks as correct)</h4>' +
            '<label class="xm-chk"><input type="checkbox" id="ak-replace"> <b>Also replace the site\'s FINAL answers with the official key</b> when saving (only questions that have an official answer; \'1/3\' type answers are skipped — choose those yourself in the list below)</label>' +
            '<div class="xm-note">If you leave this off, final answers stay as they are; you can still change them question by question in the list below.</div></div>' +
            '<div class="xm-actions"><button class="btn" id="ak-compare">🔍 Compare</button><button class="btn" id="ak-checkbtn" style="background:#0ea5e9">🔎 Check saved data</button><button class="btn ak-save" id="ak-save">💾 Save to all questions</button></div>' +
            '<div class="xm-actions"><button class="btn ak-amber" id="ak-replace-all">🔁 Replace final answers with the saved official key</button><button class="btn ak-grey" id="ak-undo">↩ Undo final answer changes</button><button class="btn" id="ak-recalc" style="background:#0ea5e9">🔄 Recalculate student scores</button></div>' +
            '<label class="xm-chk"><input type="checkbox" id="ak-skip"> Save even if some answers are still unverified (those questions are skipped)</label>' +
            '</div>';

        $('#ak-set').onchange = () => { state.overrides = {}; state.finalChoices = {}; renderUnverified(); scheduleCompare(); };
        $('#ak-exam2').onchange = () => { state.finalChoices = {}; scheduleCompare(); };
        $('#ak-single').onchange = () => { renderUnverified(); scheduleCompare(); };
        $('#ak-compare').onclick = () => compare();
        $('#ak-checkbtn').onclick = runCheck;
        $('#ak-save').onclick = save;
        $('#ak-replace-all').onclick = replaceAllFinal;
        $('#ak-undo').onclick = undoFinal;
        $('#ak-recalc').onclick = recalcStudents;
        renderUnverified();
        scheduleCompare();
        bindRescan();
    }

    // ── Re-scan by AI: re-read the saved page images with the AI; answers that two readings agree on become verified ──
    function rescanSummaryHtml(k) {
        const r = k.rescan;
        if (!r || r.status !== 'done' || !r.summary) return '';
        const m = r.summary;
        return `<div class="xm-note" style="margin-top:6px">Last AI re-scan: ✅ <b>${m.confirmed || 0}</b> newly confirmed · ⚠ ${m.stillUnverified || 0} still unverified` +
            `${m.added ? ' · ' + m.added + ' new' : ''}${m.failedPages ? ' · ' + m.failedPages + ' page(s) not read' : ''}${m.differsFromVerified ? ' · ' + m.differsFromVerified + ' differ from verified (kept)' : ''}</div>`;
    }

    function bindRescan() {
        overlay.querySelectorAll('.ak-rescan-btn').forEach(b => { b.onclick = rescan; b.disabled = !!state.rescanning; });
    }

    async function rescan() {
        if (!state.key || state.rescanning) return;
        const id = state.key.id;
        state.rescanning = true; bindRescan();
        say('⏳ Starting the AI re-scan…');
        const r = await api('POST', '/' + id + '/rescan');
        if (!r.success) { state.rescanning = false; bindRescan(); return say(r.message || 'Could not start the re-scan.', 'err'); }
        const tick = async () => {
            const g = await api('GET', '/' + id);
            if (!g.success) { clearInterval(rescanTimer); rescanTimer = null; state.rescanning = false; bindRescan(); return say(g.message || 'Error', 'err'); }
            const rs = g.key.rescan;
            if (rs && rs.status === 'running') { say('⏳ AI re-scan: ' + (rs.progress || 'working…')); return; }
            clearInterval(rescanTimer); rescanTimer = null; state.rescanning = false;
            const keepSet = $('#ak-set') && $('#ak-set').value, keepExam = $('#ak-exam2') && $('#ak-exam2').value;
            state.key = g.key;
            renderKey();
            const setSel = $('#ak-set'), examSel = $('#ak-exam2');
            if (setSel && keepSet && [...setSel.options].some(o => o.value === keepSet)) setSel.value = keepSet;
            if (examSel && keepExam) examSel.value = keepExam;
            renderUnverified(); bindRescan(); scheduleCompare();
            if (rs && rs.status === 'failed') say('❌ AI re-scan failed: ' + (rs.error || 'unknown error'), 'err');
            else if (rs && rs.summary) say(`✅ AI re-scan done: ${rs.summary.confirmed || 0} answer(s) confirmed, ${rs.summary.stillUnverified || 0} still need you.`, 'ok');
        };
        rescanTimer = setInterval(tick, 2000);
        tick();
    }

    function currentSet() { return $('#ak-set').value; }

    function renderUnverified() {
        const k = state.key, set = currentSet();
        const list = ((k.verification && k.verification.unverified) || []).filter(u => u.set === set);
        const box = $('#ak-unver');
        if (!list.length) { box.innerHTML = ''; return; }
        const single = $('#ak-single').checked;
        const shown = list.slice(0, 150);
        const hasR = list.some(u => (u.r || []).length);
        const pageImg = (p) => { const im = k.images.find(i => i.page === p); return im ? `<a href="${imgUrl(im.ref)}" target="_blank" rel="noopener">page ${p}</a>` : ''; };
        box.innerHTML = `<div class="xm-note" style="margin:8px 0 4px;color:#92400e"><b>⚠ ${list.length} answer(s) in Set ${esc(set)} were not confirmed by both readings.</b> Look at the page, then choose the right answer (a conflict must be chosen). <button class="ak-rescan ak-rescan-btn" style="margin-left:6px">🔁 Re-scan by AI</button></div>` +
            `<div class="ak-scroll"><table class="ak-table"><tr><th>Q</th><th>Pass 1</th><th>Pass 2</th>${hasR ? '<th>AI re-scan</th>' : ''}<th>Page</th><th>Your answer</th></tr>` +
            shown.map(u => {
                const isSingle = new Set([u.a, u.b, ...(u.r || [])].filter(Boolean)).size === 1;
                const cur = state.overrides[u.q] || '';
                const auto = single && isSingle ? ' (accepted)' : '';
                return `<tr><td><b>${u.q}</b></td><td>${esc(fmt(u.a))}</td><td>${esc(fmt(u.b))}</td>${hasR ? `<td>${esc((u.r || []).map(fmt).join(' · ') || '—')}</td>` : ''}<td>${pageImg(u.page)}</td><td>` +
                    `<select class="ak-sel ak-ov" data-q="${u.q}"><option value="">${isSingle && single ? 'use the one reading' : '— choose —'}${auto}</option>` +
                    ['1', '2', '3', '4', '#'].map(o => `<option value="${o}"${cur === o ? ' selected' : ''}>${esc(fmt(o))}</option>`).join('') +
                    '</select></td></tr>';
            }).join('') + '</table></div>' + (list.length > shown.length ? `<div class="xm-note">…and ${list.length - shown.length} more (the first ${shown.length} are shown).</div>` : '');
        bindRescan();
        box.querySelectorAll('.ak-ov').forEach(sel => sel.onchange = () => {
            if (sel.value) state.overrides[sel.dataset.q] = sel.value; else delete state.overrides[sel.dataset.q];
            scheduleCompare();
        });
    }

    function body() {
        return { examId: $('#ak-exam2').value, set: currentSet(), overrides: state.overrides, acceptSingle: $('#ak-single').checked };
    }

    function scheduleCompare() { clearTimeout(state.cmpTimer); state.cmpTimer = setTimeout(compare, 350); }

    function renderResult(r, saved) {
        const res = r.result;
        const cls = res.percent >= 95 ? 'ak-good' : (res.percent >= 80 ? 'ak-mid' : 'ak-bad');
        let h = `<div class="ak-card" style="background:#fff"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">` +
            `<div><div class="ak-pct ${cls}">${res.percent}%</div><div class="xm-note">match: final answers vs official key (Set ${esc(r.set)})</div></div>` +
            `<div style="font-size:.85rem">✅ ${res.matched} same &nbsp; ❌ ${res.mismatched} different<br>compared ${res.compared} of ${res.examQuestions} questions` +
            `${res.noOfficial ? `<br>${res.noOfficial} question(s) have no official answer` : ''}${res.noFinal ? `<br>${res.noFinal} question(s) have no final answer` : ''}${res.officialOnly ? `<br>${res.officialOnly} official answer(s) have no question in this exam` : ''}` +
            `${r.unresolved && r.unresolved.length ? `<br><b style="color:#b45309">⚠ ${r.unresolved.length} unverified answer(s) not counted</b>` : ''}</div></div>` +
            `<div class="ak-bar"><div style="width:${Math.min(100, res.percent)}%"></div></div>`;
        if (res.mismatches.length) h += mismatchHtml(res);
        if (saved) h = `<div style="color:#15803d;font-weight:700;margin-bottom:6px">✅ Saved: ${saved.updated} question(s) updated with the official answer + key page image${saved.skipped ? ` (${saved.skipped} unverified skipped)` : ''}.${saved.finals ? `<br>🔁 Final answers replaced with the official key: <b>${saved.finals.changed}</b> changed, ${saved.finals.same} already the same${saved.finals.recalc ? (saved.finals.recalc.pending ? ' · student scores are recalculating in the background' : ` · student scores recalculated (${saved.finals.recalc.users} answer(s) re-judged)`) : ''}${saved.finals.multi && saved.finals.multi.length ? `, <span style="color:#b45309">${saved.finals.multi.length} skipped (more than one accepted answer: Q ${esc(saved.finals.multi.slice(0, 20).join(', '))}) — choose them below</span>` : ''}.` : ''}</div>` + h;
        return h + '</div>';
    }

    // ── wrong questions: image + site final vs official + the final answer to store ──
    function mismatchHtml(res) {
        const list = res.mismatches.slice(0, 300);
        const cards = list.map(m => {
            const chosen = state.finalChoices[m.id] !== undefined ? state.finalChoices[m.id] : (m.single || 'keep');
            const imgs = (m.images || []).map(r => rawImgUrl(r)).filter(Boolean)
                .map(u => `<img loading="lazy" src="${u}" alt="Q${m.q}" onclick="window.open(this.src,'_blank')">`).join('');
            const offSet = String(m.official).split('/');
            const opts = (m.options || []).map((t, i) => {
                const n = String(i + 1), isOff = offSet.includes(n), isSite = String(m.final) === n;
                return `<div class="ak-opt${isOff ? ' off' : (isSite ? ' site' : '')}">${n} (${'ABCD'[i]}) ${esc(t)}${isOff ? ' ← official key' : ''}${isSite ? ' ← site final' : ''}</div>`;
            }).join('');
            const sel = `<select class="ak-sel ak-fin" data-id="${esc(m.id)}" data-off="${esc(m.single || '')}">` +
                `<option value="keep"${chosen === 'keep' ? ' selected' : ''}>Keep site's final (${esc(fmt(m.final))})</option>` +
                ['1', '2', '3', '4', '#'].map(o => `<option value="${o}"${chosen === o ? ' selected' : ''}>${esc(fmt(o))}${m.single === o ? '  ← official key' : ''}</option>`).join('') + '</select>';
            return `<div class="ak-mm${chosen !== 'keep' ? ' chg' : ''}" data-id="${esc(m.id)}">` +
                `<div class="ak-mmh"><b style="font-size:1rem">Q${m.q}</b>` +
                `<span class="ak-pill bad">Site final: ${esc(fmt(m.final))}</span>` +
                `<span class="ak-pill ok">Official key: ${esc(fmt(m.official))}</span>` +
                `${m.ai && m.ai !== String(m.final) ? `<span class="ak-pill">AI answer: ${esc(m.ai)}</span>` : ''}` +
                `${m.changed ? '<span class="ak-pill warn">final changed earlier by this tool</span>' : ''}</div>` +
                (imgs ? `<div class="ak-mmimg">${imgs}</div>` : (m.text ? `<div style="font-size:.85rem;margin-bottom:4px">${esc(m.text)}</div>` : '<div class="xm-note">No question image.</div>')) +
                (opts && !imgs ? `<div style="margin-top:4px">${opts}</div>` : '') +
                `<div class="ak-fin-row"><b>Final answer to store:</b> ${sel}` +
                `${m.single ? '' : '<span class="xm-note" style="color:#b45309">official key accepts more than one answer — choose one</span>'}</div></div>`;
        }).join('');
        const nChange = list.filter(m => (state.finalChoices[m.id] !== undefined ? state.finalChoices[m.id] : (m.single || 'keep')) !== 'keep').length;
        return `<div class="xm-note" style="margin-top:6px"><b>❌ ${res.mismatches.length} question(s) where the site's final answer differs from the official key.</b> Look at the question, then choose which answer is stored as FINAL (default = official key).</div>` +
            `<div class="xm-actions" style="margin:6px 0"><button class="btn ak-amber" id="ak-allofficial">Set all below to official key</button><button class="btn ak-grey" id="ak-allkeep">Keep all site finals</button>` +
            `<button class="btn ak-save" id="ak-applyfinal">✅ Apply final answers below (<span id="ak-nchg">${nChange}</span>)</button></div>` +
            `<div class="ak-mmwrap">${cards}</div>` +
            (res.mismatches.length > list.length ? `<div class="xm-note">…and ${res.mismatches.length - list.length} more (the first ${list.length} are shown).</div>` : '');
    }

    function currentChoices() {
        const out = {};
        overlay.querySelectorAll('.ak-fin').forEach(sel => { if (sel.value !== 'keep') out[sel.dataset.id] = sel.value; });
        return out;
    }
    function refreshChg() {
        const el = $('#ak-nchg'); if (el) el.textContent = Object.keys(currentChoices()).length;
    }
    function bindFinal() {
        overlay.querySelectorAll('.ak-fin').forEach(sel => sel.onchange = () => {
            state.finalChoices[sel.dataset.id] = sel.value;
            const card = sel.closest('.ak-mm'); if (card) card.classList.toggle('chg', sel.value !== 'keep');
            refreshChg();
        });
        const setAll = (mode) => overlay.querySelectorAll('.ak-fin').forEach(sel => {
            const v = mode === 'official' ? (sel.dataset.off || 'keep') : 'keep';
            sel.value = v; state.finalChoices[sel.dataset.id] = v;
            const card = sel.closest('.ak-mm'); if (card) card.classList.toggle('chg', v !== 'keep');
        });
        const a = $('#ak-allofficial'), k = $('#ak-allkeep'), ap = $('#ak-applyfinal');
        if (a) a.onclick = () => { setAll('official'); refreshChg(); };
        if (k) k.onclick = () => { setAll('keep'); refreshChg(); };
        if (ap) ap.onclick = applyChoices;
    }
    function showResult(r, saved) { $('#ak-cmp').innerHTML = renderResult(r, saved); state.lastResult = r.result; bindFinal(); }

    const rcTxt = (rc) => !rc ? '' : (rc.pending ? ' Students\' scores are being recalculated in the background (takes a little longer).' : ` Students' scores recalculated: ${rc.users} answer(s) re-judged.`);

    async function applyChoices() {
        const examId = $('#ak-exam2').value, choices = currentChoices(), n = Object.keys(choices).length;
        if (!n) return say('Nothing to change — every question is set to "Keep site\'s final".', 'err');
        if (!confirm(`Change the FINAL answer of ${n} question(s) in:\n${examId}\n\nStudents will see the new answers at once. (You can undo with "Undo final answer changes".)`)) return;
        say('Saving final answers…');
        const r = await api('POST', '/apply-final', { examId, mode: 'choices', choices });
        if (!r.success) return say(r.message || 'Failed.', 'err');
        state.finalChoices = {};
        say(`✅ Final answers changed: ${r.changed} (${r.same} were already the same).` + rcTxt(r.recalc), 'ok');
        compare();
    }

    async function replaceAllFinal() {
        const examId = $('#ak-exam2').value;
        if (!examId) return say('Select the exam.', 'err');
        if (!confirm(`Replace the FINAL answer of every question of:\n${examId}\nwith its saved official answer?\n\nOnly questions that have an official answer are changed. (You can undo.)`)) return;
        say('Replacing final answers…');
        const r = await api('POST', '/apply-final', { examId, mode: 'official-all' });
        if (!r.success) return say(r.message || 'Failed.', 'err');
        state.finalChoices = {};
        say(`✅ ${r.changed} final answer(s) replaced with the official key, ${r.same} were already the same` + (r.multi && r.multi.length ? `, ${r.multi.length} skipped (more than one accepted answer: Q ${r.multi.slice(0, 20).join(', ')})` : '') + '.', 'ok');
        compare();
    }

    async function recalcStudents() {
        const examId = $('#ak-exam2').value;
        if (!examId) return say('Select the exam.', 'err');
        say('Recalculating student scores…');
        const r = await api('POST', '/recalc-students', { examId });
        if (!r.success) return say(r.message || 'Failed.', 'err');
        say('✅ Done.' + rcTxt(r.recalc), 'ok');
    }

    async function undoFinal() {
        const examId = $('#ak-exam2').value;
        if (!examId) return say('Select the exam.', 'err');
        if (!confirm(`Restore the final answers of:\n${examId}\nto what they were before this tool changed them?`)) return;
        const r = await api('POST', '/undo-final', { examId });
        if (!r.success) return say(r.message || 'Failed.', 'err');
        state.finalChoices = {};
        say(`↩ ${r.restored} final answer(s) restored.` + rcTxt(r.recalc), 'ok');
        compare();
    }

    function checkHtml(c, examId) {
        if (!c) return '';
        const okAll = c.total > 0 && c.servedAnswer >= c.inDbAnswer && c.inDbAnswer > 0 && c.servedAnswer === c.inDbAnswer;
        const col = okAll ? '#15803d' : '#b45309';
        return `<div style="margin:8px 0;padding:8px 10px;border-radius:8px;border:1px solid ${okAll ? '#bbf7d0' : '#fde68a'};background:${okAll ? '#f0fdf4' : '#fffbeb'};font-size:.82rem;color:${col}">` +
            `<b>🔎 Check: ${esc(examId || c.examId)}</b><br>` +
            `Database: <b>${c.inDbAnswer}</b> of ${c.total} questions have an official answer, <b>${c.inDbImage}</b> have the key image.<br>` +
            `Students receive: <b>${c.servedAnswer}</b> of ${c.servedTotal} with official answer, <b>${c.servedImage}</b> with key image.` +
            (okAll ? '<br>✅ Students will see the official key (open the exam, solve a question, look in the explanation).' : '<br>⚠ The numbers differ or are 0 — students will not see it yet. Tell the developer these numbers.') + '</div>';
    }

    async function runCheck() {
        const examId = $('#ak-exam2').value;
        if (!examId) return say('Select the exam.', 'err');
        const r = await api('POST', '/check', { examId });
        if (!r.success) return say(r.message || 'Check failed.', 'err');
        $('#ak-chk').innerHTML = checkHtml(r.check, examId);
    }

    async function compare() {
        if (!overlay || !state.key || !$('#ak-set')) return;
        const b = body();
        if (!b.examId) return;
        $('#ak-cmp').innerHTML = '<div class="xm-note">Comparing…</div>';
        const r = await api('POST', '/' + state.key.id + '/compare', b);
        if (!r.success) { $('#ak-cmp').innerHTML = `<div style="color:#b91c1c">${esc(r.message || 'Failed.')}</div>`; return; }
        showResult(r);
    }

    async function save() {
        const b = body();
        if (!b.examId) return say('Select the exam.', 'err');
        b.replaceFinal = $('#ak-replace').checked;
        if (!confirm(`Save official answers of Set ${b.set} into ALL questions of:\n${b.examId}\n\nThe official answer and the key page image will be updated.\n` + (b.replaceFinal ? 'The FINAL answers will ALSO be replaced with the official key (undo is possible).' : 'Final answers are not changed.'))) return;
        b.skipUnresolved = $('#ak-skip').checked;
        $('#ak-save').disabled = true;
        say('Saving…');
        const r = await api('POST', '/' + state.key.id + '/save', b);
        $('#ak-save').disabled = false;
        if (!r.success) { say(r.message || 'Save failed.', 'err'); return; }
        say('Saved.', 'ok');
        state.finalChoices = {};
        showResult(r, r);
        $('#ak-chk').innerHTML = checkHtml(r.check, b.examId);
        loadLists();
    }

    window.openAnswerKeyAdmin = async function () {
        if (!isAdmin()) return;
        build();
        overlay.classList.add('show');
        say('');
        await loadLists();
    };
})();

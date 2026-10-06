// Admin: server cache manager (question data + Telegram images stored on the server disk)
(function () {
    const tok = () => localStorage.getItem('jwtToken');
    const isAdmin = () => { try { return !!(JSON.parse(localStorage.getItem('currentUser')) || {}).isAdmin; } catch (e) { return false; } };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const mb = (b) => (b / 1048576).toFixed(b >= 10485760 ? 0 : 1) + ' MB';
    const size = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : mb(b || 0));

    async function api(method, url, body) {
        try {
            const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok() }, body: body ? JSON.stringify(body) : undefined });
            return await res.json();
        } catch (e) { return { success: false, message: 'Network error' }; }
    }

    let overlay = null, timer = null, last = null, wasRunning = false;
    const $ = (s) => overlay.querySelector(s);

    function build() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.className = 'xm-overlay';
        overlay.innerHTML =
            '<div class="xm-box" style="width:900px">' +
            '<div class="xm-head"><b>💾 Server Cache (disk)</b><button class="xm-x" id="cm-close">✕</button></div>' +
            '<div class="xm-body">' +
            '<div id="cm-cards" class="cm-cards"></div>' +
            '<div class="cm-bar"><div id="cm-bar-fill"></div></div><div id="cm-bar-text" class="xm-note"></div>' +
            '<div id="cm-job" class="cm-job" style="display:none"></div>' +
            '<div id="cm-msg" class="xm-note" style="min-height:1.3em;margin:6px 0"></div>' +

            '<h4>🖼 Images (Telegram → server disk)</h4>' +
            '<div class="xm-actions">' +
            '<button class="btn" id="cm-img-all">⬇ Cache images of ALL exams</button>' +
            '<button class="btn" id="cm-stop">⏹ Stop</button>' +
            '<button class="btn xm-danger" id="cm-img-clear">🗑 Clear ALL images</button>' +
            '</div>' +
            '<div class="xm-row"><input type="number" id="cm-trim" min="0" placeholder="Reduce images to … MB"><button class="btn" id="cm-trim-go">Reduce</button>' +
            '<input type="number" id="cm-limit" min="50" placeholder="Size limit … MB"><button class="btn" id="cm-limit-go">Set limit</button></div>' +

            '<h4 style="margin-top:14px">🗄 Question data (database → server disk)</h4>' +
            '<div class="xm-actions">' +
            '<button class="btn" id="cm-data-all">⬇ Load ALL exams to disk</button>' +
            '<button class="btn" id="cm-data-refresh">↻ Re-read ALL from database</button>' +
            '<button class="btn xm-danger" id="cm-data-clear">🗑 Clear data cache</button>' +
            '</div>' +

            '<h4 style="margin-top:14px">Per exam</h4>' +
            '<div class="xm-row"><input id="cm-search" placeholder="Search exam..."><button class="btn" id="cm-refresh">⟳ Refresh numbers</button></div>' +
            '<div id="cm-table"></div>' +
            '</div></div>';
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        $('#cm-close').onclick = close;
        $('#cm-search').oninput = renderTable;
        $('#cm-refresh').onclick = () => refresh(true);
        $('#cm-img-all').onclick = () => act('/api/admin/cache/images/precache', { all: true });
        $('#cm-stop').onclick = () => act('/api/admin/cache/images/stop', {});
        $('#cm-img-clear').onclick = () => confirm('Delete ALL cached images from the server disk? They are downloaded from Telegram again when needed.') && act('/api/admin/cache/images/clear', { all: true }, true);
        $('#cm-trim-go').onclick = () => { const v = $('#cm-trim').value; if (v === '') return say('Enter a size in MB.'); act('/api/admin/cache/images/trim', { maxMb: Number(v) }, true); };
        $('#cm-limit-go').onclick = () => { const v = $('#cm-limit').value; if (v === '') return say('Enter a size in MB.'); act('/api/admin/cache/settings', { maxImageMb: Number(v) }, true); };
        $('#cm-data-all').onclick = () => act('/api/admin/cache/data/warm', { all: true });
        $('#cm-data-refresh').onclick = () => confirm('Re-read every exam from the database now? (takes a while, students are not interrupted)') && act('/api/admin/cache/data/warm', { all: true, refresh: true });
        $('#cm-data-clear').onclick = () => confirm('Delete the question data cache? It is rebuilt from the database when needed.') && act('/api/admin/cache/data/clear', { all: true }, true);
    }

    function say(t) { const m = $('#cm-msg'); if (m) m.textContent = t || ''; }

    async function act(url, body, refreshAfter) {
        say('Working...');
        const r = await api('POST', url, body);
        if (!r.success) { say('⚠ ' + (r.message || 'Failed.')); return; }
        let extra = '';
        if (r.removed !== undefined) extra = ` ${r.removed} file(s) removed, ${mb(r.freedBytes || 0)} freed.`;
        if (r.maxImageMb) extra = ` Limit is now ${r.maxImageMb} MB.`;
        say('✔ Done.' + extra);
        if (refreshAfter) await refresh(true); else { wasRunning = true; startPoll(); }
    }

    async function refresh(force) {
        const r = await api('GET', '/api/admin/cache/status' + (force ? '?refresh=1' : ''));
        if (!r.success) { say('⚠ ' + (r.message || 'Could not load.')); return; }
        last = r; render(); startPoll();
    }

    function render() {
        if (!last || !overlay) return;
        const im = last.images, d = last.data;
        const pct = im.maxBytes ? Math.min(100, im.bytes / im.maxBytes * 100) : 0;
        const saved = im.counters.diskHits;
        $('#cm-cards').innerHTML =
            card('Images cached', im.cachedImages + ' / ' + im.totalImages, im.remainingImages + ' remaining') +
            card('Image disk used', mb(im.bytes), 'limit ' + mb(im.maxBytes) + (im.disk ? ' · server free ' + size(im.disk.freeBytes) : '')) +
            card('Exam data on disk', d.examsCached + ' / ' + d.totalExams + ' exams', size(d.bytes)) +
            card('Requests saved', saved + ' images', d.counters.memHits + d.counters.diskHits + d.counters.responseHits + ' data reads · ' + im.counters.telegramFetches + ' Telegram downloads');
        $('#cm-bar-fill').style.width = pct.toFixed(1) + '%';
        $('#cm-bar-fill').style.background = pct > 90 ? '#dc2626' : (pct > 70 ? '#f59e0b' : '#10b981');
        $('#cm-bar-text').textContent = 'Image cache: ' + mb(im.bytes) + ' of ' + mb(im.maxBytes) + ' (' + pct.toFixed(0) + '%). When it is full, the least recently used images are deleted automatically.';
        if (document.activeElement !== $('#cm-limit')) $('#cm-limit').placeholder = 'Size limit … MB (now ' + Math.round(im.maxBytes / 1048576) + ')';
        renderJob(last.imageJob, last.dataJob);
        renderTable();
    }
    const card = (t, v, s) => '<div class="cm-card"><div class="cm-t">' + esc(t) + '</div><div class="cm-v">' + esc(v) + '</div><div class="xm-note">' + esc(s) + '</div></div>';

    function renderJob(ij, dj) {
        const box = $('#cm-job');
        const j = ij && ij.running ? { name: 'Caching images: ' + ij.scope, j: ij } : (dj && dj.running ? { name: 'Loading exam data', j: dj } : null);
        if (!j) {
            const msg = (ij && ij.message && ij.finishedAt && Date.now() - ij.finishedAt < 60000) ? 'Images: ' + ij.message : '';
            box.style.display = msg ? 'block' : 'none'; box.textContent = msg; return;
        }
        const pct = j.j.total ? Math.round(j.j.done / j.j.total * 100) : 0;
        box.style.display = 'block';
        box.innerHTML = '<b>' + esc(j.name) + '</b> — ' + j.j.done + ' / ' + j.j.total + (j.j.failed ? ' (' + j.j.failed + ' failed)' : '') +
            '<div class="cm-bar"><div style="width:' + pct + '%;background:#8b5cf6;height:100%"></div></div>';
    }

    function renderTable() {
        if (!last) return;
        const q = ($('#cm-search').value || '').trim().toLowerCase();
        const dataSet = new Map((last.data.exams || []).map(e => [e.examId, e]));
        // every exam of the website, also those that have no images
        const byId = new Map(last.images.perExam.map(e => [e.examId, e]));
        (last.examList || []).forEach(id => { if (id && !byId.has(id)) byId.set(id, { examId: id, totalImages: 0, cachedImages: 0, bytes: 0 }); });
        const rows = [...byId.values()].sort((a, b) => String(a.examId).localeCompare(String(b.examId))).filter(e => !q || String(e.examId).toLowerCase().includes(q));
        const box = $('#cm-table');
        if (!rows.length) { box.innerHTML = '<p class="xm-note">No exams with images found.</p>'; return; }
        box.innerHTML = '';
        const t = document.createElement('table'); t.className = 'cm-table';
        t.innerHTML = '<tr><th>Exam</th><th>Images</th><th>Size</th><th>Data</th><th></th></tr>';
        rows.forEach(e => {
            const tr = document.createElement('tr');
            const full = e.cachedImages >= e.totalImages;
            tr.innerHTML = '<td>' + esc(e.examId) + '</td>' +
                '<td><span class="xm-badge' + (full ? '' : ' xm-b-hide') + '">' + e.cachedImages + ' / ' + e.totalImages + '</span></td>' +
                '<td>' + mb(e.bytes) + '</td>' +
                '<td>' + (dataSet.has(e.examId) ? '✔ ' + dataSet.get(e.examId).count + ' q' : '—') + '</td><td></td>';
            const td = tr.lastChild;
            const b1 = mk('⬇ Cache images', () => act('/api/admin/cache/images/precache', { examIds: [e.examId] }));
            const b2 = mk('🗑 Clear images', () => confirm('Delete the cached images of "' + e.examId + '"?') && act('/api/admin/cache/images/clear', { examIds: [e.examId] }, true));
            const b3 = mk('↻ Data', () => act('/api/admin/cache/data/warm', { examIds: [e.examId], refresh: true }));
            [b1, b2, b3].forEach(b => td.appendChild(b));
            t.appendChild(tr);
        });
        box.appendChild(t);
    }
    function mk(label, fn) { const b = document.createElement('button'); b.className = 'btn xm-small'; b.textContent = label; b.onclick = fn; return b; }

    // progress polling (only while the window is open)
    function startPoll() {
        if (timer || !overlay || !overlay.classList.contains('show')) return;
        timer = setInterval(async () => {
            if (!overlay.classList.contains('show')) return stopPoll();
            const r = await api('GET', '/api/admin/cache/job');
            if (!r.success) return;
            const running = !!(r.imageJob.running || r.dataJob.running);
            if (last) { last.imageJob = r.imageJob; last.dataJob = r.dataJob; renderJob(r.imageJob, r.dataJob); }
            if (wasRunning && !running) { await refresh(true); say((r.imageJob.message || r.dataJob.message || 'Done.')); }
            wasRunning = running;
            if (!running && !wasRunning) stopPoll();
        }, 1500);
    }
    function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

    function close() { stopPoll(); if (overlay) overlay.classList.remove('show'); }

    window.openCacheManager = async function () {
        if (!isAdmin()) return;
        build();
        overlay.classList.add('show');
        say('');
        await refresh(true);
        wasRunning = !!(last && (last.imageJob.running || last.dataJob.running));
        startPoll();
    };
})();

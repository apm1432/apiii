// Admin tools for the dashboard: group exam papers (they become tabs) and hide / show papers.
// Also reacts when an admin changes something while students are online (SSE "catalog" event).
(function () {
    const tok = () => localStorage.getItem('jwtToken');
    const isAdmin = () => { try { return !!(JSON.parse(localStorage.getItem('currentUser')) || {}).isAdmin; } catch (e) { return false; } };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    async function api(method, url, body) {
        try {
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok() },
                body: body ? JSON.stringify(body) : undefined
            });
            return await res.json();
        } catch (e) { return { success: false, message: 'Network error' }; }
    }

    // show / hide the "Manage Exams" button
    window.syncExamAdminUI = function () {
        const b = document.getElementById('btn-manage-exams');
        if (!b) return;
        if (isAdmin()) b.classList.remove('hidden'); else b.classList.add('hidden');
    };

    // hide / unhide papers (used by the card buttons and by the manager)
    window.adminSetHidden = async function (ids, hidden) {
        const r = await api('POST', '/api/admin/exams/visibility', { examIds: ids, hidden: !!hidden });
        if (!r.success) { alert(r.message || 'Failed.'); return; }
        await loadDashboard();
        render();
    };

    // ---------------- manager modal ----------------
    let overlay = null;
    const sel = new Set();

    const papers = () => (window.allExamsData || []).filter(e => e._id && e._id !== 'Passage Comprehension');
    const groups = () => window.examGroups || [];
    const total = (e) => (e.exams || []).reduce((n, x) => n + (x.count || 0), 0);

    function build() {
        overlay = document.createElement('div');
        overlay.className = 'xm-overlay';
        overlay.innerHTML =
            '<div class="xm-box">' +
            '<div class="xm-head"><b>⚙ Manage Exams &amp; Groups</b><button class="xm-x" id="xm-close">✕</button></div>' +
            '<div class="xm-body">' +
            '<h4>Groups <small>(each group becomes a tab on the dashboard)</small></h4>' +
            '<div id="xm-groups"></div>' +
            '<div class="xm-row"><input id="xm-newgroup" maxlength="60" placeholder="New group name, e.g. MPSC Group A"><button class="btn" id="xm-addgroup">+ Create group</button></div>' +
            '<h4 style="margin-top:18px">Exam papers</h4>' +
            '<div class="xm-row"><input id="xm-search" placeholder="Search papers..."><select id="xm-filter"></select></div>' +
            '<div class="xm-actions">' +
            '<label class="xm-chk"><input type="checkbox" id="xm-all"> Select all shown</label>' +
            '<select id="xm-groupsel"></select>' +
            '<button class="btn" id="xm-add">Add to group</button>' +
            '<button class="btn" id="xm-rem">Remove from group</button>' +
            '<button class="btn" id="xm-hide">🙈 Hide from website</button>' +
            '<button class="btn" id="xm-unhide">👁 Show on website</button>' +
            '</div>' +
            '<div id="xm-count" class="xm-note"></div>' +
            '<div id="xm-list"></div>' +
            '</div></div>';
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('#xm-close').onclick = close;
        overlay.querySelector('#xm-search').oninput = render;
        overlay.querySelector('#xm-filter').onchange = render;
        overlay.querySelector('#xm-all').onchange = (e) => {
            visibleRows().forEach(p => { if (e.target.checked) sel.add(p._id); else sel.delete(p._id); });
            render();
        };
        overlay.querySelector('#xm-addgroup').onclick = createGroup;
        overlay.querySelector('#xm-newgroup').addEventListener('keydown', (e) => { if (e.key === 'Enter') createGroup(); });
        overlay.querySelector('#xm-add').onclick = () => groupAction('add');
        overlay.querySelector('#xm-rem').onclick = () => groupAction('remove');
        overlay.querySelector('#xm-hide').onclick = () => visAction(true);
        overlay.querySelector('#xm-unhide').onclick = () => visAction(false);
    }

    function visibleRows() {
        const q = (overlay.querySelector('#xm-search').value || '').trim().toLowerCase();
        const f = overlay.querySelector('#xm-filter').value;
        return papers().filter(p => {
            if (q && !String(p._id).toLowerCase().includes(q)) return false;
            if (f === 'hidden') return !!p.hidden;
            if (f === 'visible') return !p.hidden;
            if (f === 'nogroup') return !groups().some(g => g.exams.includes(p._id));
            if (f.startsWith('g:')) { const g = groups().find(x => 'g:' + x._id === f); return !!g && g.exams.includes(p._id); }
            return true;
        });
    }

    function render() {
        if (!overlay || !overlay.classList.contains('show')) return;
        // drop selections of papers that no longer exist
        const ids = new Set(papers().map(p => p._id));
        [...sel].forEach(id => { if (!ids.has(id)) sel.delete(id); });

        // groups list
        const gbox = overlay.querySelector('#xm-groups');
        gbox.innerHTML = '';
        if (!groups().length) gbox.innerHTML = '<p class="xm-note">No groups yet. Create one below, then select papers and add them.</p>';
        groups().forEach(g => {
            const row = document.createElement('div');
            row.className = 'xm-grow';
            row.innerHTML = '<span class="xm-gname">' + esc(g.name) + '</span><span class="xm-note">' + g.exams.length + ' papers</span>';
            const rn = document.createElement('button'); rn.className = 'btn xm-small'; rn.textContent = '✎ Rename';
            rn.onclick = async () => {
                const name = prompt('New group name:', g.name);
                if (name === null) return;
                const r = await api('PUT', '/api/admin/exam-groups/' + g._id, { name });
                if (!r.success) return alert(r.message || 'Failed.');
                await loadDashboard(); render();
            };
            const del = document.createElement('button'); del.className = 'btn xm-small xm-danger'; del.textContent = '🗑 Delete';
            del.onclick = async () => {
                if (!confirm('Delete the group "' + g.name + '"? The papers stay on the website, only the tab is removed.')) return;
                const r = await api('DELETE', '/api/admin/exam-groups/' + g._id);
                if (!r.success) return alert(r.message || 'Failed.');
                await loadDashboard(); render();
            };
            row.appendChild(rn); row.appendChild(del);
            gbox.appendChild(row);
        });

        // dropdowns (keep the current choice)
        const gs = overlay.querySelector('#xm-groupsel');
        const prevG = gs.value;
        gs.innerHTML = groups().length ? groups().map(g => '<option value="' + esc(g._id) + '">' + esc(g.name) + '</option>').join('') : '<option value="">(create a group first)</option>';
        if (prevG && groups().some(g => g._id === prevG)) gs.value = prevG;

        const fs = overlay.querySelector('#xm-filter');
        const prevF = fs.value || 'all';
        fs.innerHTML = '<option value="all">All papers</option><option value="visible">Visible on website</option><option value="hidden">Hidden only</option><option value="nogroup">Not in any group</option>' +
            groups().map(g => '<option value="g:' + esc(g._id) + '">In: ' + esc(g.name) + '</option>').join('');
        fs.value = [...fs.options].some(o => o.value === prevF) ? prevF : 'all';

        // papers list
        const rows = visibleRows();
        const list = overlay.querySelector('#xm-list');
        list.innerHTML = '';
        rows.forEach(p => {
            const inGroups = groups().filter(g => g.exams.includes(p._id));
            const row = document.createElement('label');
            row.className = 'xm-prow' + (p.hidden ? ' xm-hidden' : '');
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = sel.has(p._id);
            cb.onchange = () => { if (cb.checked) sel.add(p._id); else sel.delete(p._id); updateCount(); };
            const info = document.createElement('span'); info.className = 'xm-pinfo';
            info.innerHTML = '<b>' + esc(p._id) + '</b> <span class="xm-note">' + total(p) + ' questions</span> ' +
                (p.hidden ? '<span class="xm-badge xm-b-hide">HIDDEN</span> ' : '') +
                inGroups.map(g => '<span class="xm-badge">' + esc(g.name) + '</span>').join(' ');
            row.appendChild(cb); row.appendChild(info);
            list.appendChild(row);
        });
        if (!rows.length) list.innerHTML = '<p class="xm-note">No papers match.</p>';
        overlay.querySelector('#xm-all').checked = rows.length > 0 && rows.every(p => sel.has(p._id));
        updateCount();
    }

    function updateCount() {
        const c = overlay.querySelector('#xm-count');
        if (c) c.textContent = sel.size ? sel.size + ' selected' : 'Tick the papers you want to group or hide.';
    }

    async function createGroup() {
        const inp = overlay.querySelector('#xm-newgroup');
        const name = inp.value.trim();
        if (!name) return alert('Enter a group name.');
        const r = await api('POST', '/api/admin/exam-groups', { name, exams: [...sel] });
        if (!r.success) return alert(r.message || 'Failed.');
        inp.value = '';
        await loadDashboard(); render();
    }

    async function groupAction(kind) {
        const gid = overlay.querySelector('#xm-groupsel').value;
        if (!gid) return alert('Create / choose a group first.');
        if (!sel.size) return alert('Select at least one paper.');
        const body = kind === 'add' ? { addExams: [...sel] } : { removeExams: [...sel] };
        const r = await api('PUT', '/api/admin/exam-groups/' + gid, body);
        if (!r.success) return alert(r.message || 'Failed.');
        await loadDashboard(); render();
    }

    async function visAction(hidden) {
        if (!sel.size) return alert('Select at least one paper.');
        if (hidden && !confirm('Hide ' + sel.size + ' paper(s) from the website? Students will not see the papers or their questions anywhere (also not in Subject-Wise).')) return;
        await window.adminSetHidden([...sel], hidden);
    }

    function close() { if (overlay) overlay.classList.remove('show'); }

    window.openExamManager = async function () {
        if (!isAdmin()) return;
        if (!overlay) build();
        if (!window.allExamsData) await loadDashboard();
        overlay.classList.add('show');
        render();
    };

    // ---------------- an admin changed the catalog while students are online ----------------
    window.onCatalogChanged = async function () {
        const inTest = document.getElementById('test-section') && document.getElementById('test-section').classList.contains('active');
        await loadDashboard();
        render();
        if (!inTest || isAdmin()) return;

        const visible = new Set((window.allExamsData || []).map(e => e._id));
        let gone;
        if (window.activeYearExam) gone = window.activeYearExam !== 'Passage Comprehension' && !visible.has(window.activeYearExam);
        else gone = (currentQuestions || []).some(q => q.year_exam && !visible.has(q.year_exam));
        if (gone) {
            currentQuestions = [];
            localStorage.removeItem('mpsc_last_session');
            showSection('dashboard-section');
            if (window.acctToast) window.acctToast('Exam list updated', 'काही exams आता उपलब्ध नाहीत. Dashboard वर परत आणले आहे.', false);
        }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.syncExamAdminUI); else window.syncExamAdminUI();
})();

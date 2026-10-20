// Admin: "Subjects" - ONE name for ONE subject.
// Spellings that differ only by case / spaces / the English-Marathi bracket pair are joined automatically.
// Everything else ("Indian Polity" = "Polity") is merged here. Questions are never rewritten, a merge can be split again.
(function () {
    const tok = () => localStorage.getItem('jwtToken');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    async function api(method, url, body) {
        try {
            const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok() }, body: body ? JSON.stringify(body) : undefined });
            return await r.json();
        } catch (e) { return { success: false, message: 'Network error' }; }
    }
    let ov = null, data = null, sel = new Set(), q = '';

    function close() { if (ov) { ov.remove(); ov = null; } }
    async function load() {
        const box = ov.querySelector('#sj-body'); box.innerHTML = '<p>Loading...</p>';
        data = await api('GET', '/api/admin/subject-groups');
        if (!data.success) { box.innerHTML = '<p style="color:#dc2626">' + esc(data.message || 'Failed') + '</p>'; return; }
        sel = new Set(); draw();
    }
    function draw() {
        const box = ov.querySelector('#sj-body');
        const names = new Set(data.subjects.map(s => s.name));
        const list = data.subjects.filter(s => !q || (s.name + ' ' + s.variants.map(v => v.raw).join(' ')).toLowerCase().includes(q.toLowerCase()));
        const chosen = [...sel].filter(n => names.has(n));
        const sug = (data.suggestions || []).filter(x => names.has(x.a) && names.has(x.b)).slice(0, 12);
        box.innerHTML =
            '<div style="font-size:.82rem;opacity:.8;margin-bottom:8px">' + data.subjects.length + ' subjects. Tick two or more that mean the same subject, type the name to show, press Merge. A single tick + a new name = rename.</div>' +
            (sug.length ? '<details style="margin-bottom:10px"><summary><b>💡 Maybe the same (' + sug.length + ')</b></summary>' + sug.map((x, i) =>
                '<div style="display:flex;gap:6px;align-items:center;padding:4px 0;font-size:.85rem"><span style="flex:1">' + esc(x.a) + ' &nbsp;+&nbsp; ' + esc(x.b) + ' <i style="opacity:.6">(' + esc(x.shared.join(', ')) + ')</i></span><button class="btn" data-sug="' + i + '" style="padding:2px 8px">Select both</button></div>').join('') + '</details>' : '') +
            '<input id="sj-q" placeholder="Search..." value="' + esc(q) + '" style="width:100%;padding:8px;margin-bottom:8px;box-sizing:border-box">' +
            '<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap"><input id="sj-into" placeholder="Name to show" value="' + esc(chosen.length ? (data.subjects.find(s => s.name === chosen[0]) || {}).name : '') + '" style="flex:1;min-width:160px;padding:8px">' +
            '<button class="btn" id="sj-merge" ' + (chosen.length ? '' : 'disabled') + '>🔗 Merge / Rename (' + chosen.length + ')</button></div>' +
            list.map(s => {
                const i = data.subjects.indexOf(s);
                return '<div style="border:1px solid rgba(128,128,128,.3);border-radius:8px;padding:8px;margin-bottom:6px"><label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" data-n="' + i + '" ' + (sel.has(s.name) ? 'checked' : '') + '><b style="flex:1">' + esc(s.name) + '</b><span style="opacity:.7">' + s.total + ' Qs</span></label>' +
                    (s.variants.length > 1 || s.variants[0].raw !== s.name ? '<div style="margin:6px 0 0 26px;font-size:.8rem">' + s.variants.map(v => '<div>• ' + esc(v.raw) + ' <span style="opacity:.6">(' + v.n + ')</span> ' +
                        (v.via === 'auto' ? '<span title="joined automatically: same name / English-Marathi pair" style="opacity:.6">auto</span>' : v.via === 'admin' ? '<button class="btn" data-split="' + esc(v.stored) + '" style="padding:0 6px;font-size:.72rem">split ✂</button>' : '') + '</div>').join('') + '</div>' : '') + '</div>';
            }).join('');
        box.querySelector('#sj-q').oninput = (e) => { q = e.target.value; const pos = e.target.selectionStart; draw(); const n = ov.querySelector('#sj-q'); n.focus(); n.setSelectionRange(pos, pos); };
        box.querySelectorAll('[data-n]').forEach(c => c.onchange = () => { const n = data.subjects[c.dataset.n].name; c.checked ? sel.add(n) : sel.delete(n); draw(); });
        box.querySelectorAll('[data-sug]').forEach(b => b.onclick = () => { const x = sug[b.dataset.sug]; sel.add(x.a); sel.add(x.b); draw(); });
        box.querySelectorAll('[data-split]').forEach(b => b.onclick = async () => {
            const r = await api('POST', '/api/admin/subject-groups/split', { stored: b.dataset.split });
            if (!r.success) return alert(r.message || 'Failed'); await load(); refresh();
        });
        box.querySelector('#sj-merge').onclick = async () => {
            const into = ov.querySelector('#sj-into').value.trim();
            if (!into) return alert('Type the name to show.');
            const r = await api('POST', '/api/admin/subject-groups/merge', { names: chosen, into });
            if (!r.success) return alert(r.message || 'Failed'); await load(); refresh();
        };
    }
    function refresh() { if (typeof window.loadDashboard === 'function') window.loadDashboard(); }

    window.openSubjectAdmin = function () {
        close();
        ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:12px';
        ov.innerHTML = '<div style="background:var(--surface-color,#fff);color:var(--text-primary,#111);border-radius:12px;padding:16px;max-width:720px;width:100%;max-height:92vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.35)">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3 style="margin:0">🔗 Subjects - one name for one subject</h3><button class="btn" id="sj-x">✕</button></div><div id="sj-body"></div></div>';
        document.body.appendChild(ov);
        ov.querySelector('#sj-x').onclick = close;
        ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
        load();
    };
})();

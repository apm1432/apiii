/* =====================================================================
   NOTES  -  student's own short notes
   - "Add to Notes" button under every explanation (adds the selected part, or the whole explanation)
   - "Notes" button on the dashboard (top) opens the panel
   - small paste box: every paste is added as a new note, in order (oldest first, newest last)
   - compact list: move up / down, delete, copy all, download as .txt
   Notes are saved on the SERVER for every account (so they appear after every login, on any device) and cached in this browser.
   Changes made offline are kept in a small queue and sent when the connection is back.
   Everything is written with textContent (no HTML injection).
   ===================================================================== */
(function () {
    'use strict';

    const MAX_NOTES = 500;
    const MAX_LEN = 4000;

    // ---------------------------------------------------------------- store (local cache + server sync)
    function emailKey() {
        let email = 'guest';
        try { if (typeof currentUser !== 'undefined' && currentUser && currentUser.email) email = String(currentUser.email).toLowerCase(); } catch (e) { }
        return email;
    }
    const cacheKey = () => 'mpsc_notes_v1:' + emailKey();      // notes as shown (server copy + not-yet-sent changes)
    const opsKey = () => 'mpsc_notes_ops_v1:' + emailKey();    // changes waiting to be sent to the server
    const migKey = () => 'mpsc_notes_migrated_v1:' + emailKey();
    const token = () => { try { return localStorage.getItem('jwtToken'); } catch (e) { return null; } };

    function readJson(key) {
        try { const a = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
    }
    function load() { return readJson(cacheKey()).filter(n => n && typeof n.text === 'string' && n.id); }
    function save(list) { try { localStorage.setItem(cacheKey(), JSON.stringify(list)); return true; } catch (e) { return false; } }
    const loadOps = () => readJson(opsKey());
    function saveOps(ops) { try { localStorage.setItem(opsKey(), JSON.stringify(ops)); } catch (e) { } }

    const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const clean = (t) => String(t || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_LEN);

    // the same change applied to a list: used to show "server copy + changes not sent yet"
    function applyOps(list, ops) {
        let out = list.slice();
        for (const op of ops) {
            if (op.t === 'add' && op.note && !out.some(n => n.id === op.note.id)) out.push(op.note);
            else if (op.t === 'del') out = out.filter(n => n.id !== op.id);
            else if (op.t === 'clear') out = [];
            else if (op.t === 'order' && Array.isArray(op.ids)) {
                const by = new Map(out.map(n => [n.id, n])); const re = [];
                op.ids.forEach(id => { if (by.has(id)) { re.push(by.get(id)); by.delete(id); } });
                out.forEach(n => { if (by.has(n.id)) re.push(n); });
                out = re;
            }
        }
        return out;
    }

    // ---- sync state shown in the panel ("✔ saved" / "⏳ saving" / "⚠ offline")
    let syncState = 'idle';
    function setSync(st) {
        syncState = st;
        const e = document.getElementById('notes-sync');
        if (!e) return;
        e.textContent = st === 'ok' ? '☁ saved' : st === 'busy' ? '⏳ saving…' : st === 'offline' ? '⚠ offline - will sync' : '';
        e.title = st === 'offline' ? 'Your notes are safe on this device and will be sent to the server automatically.' : '';
    }

    function queueOp(op) { const ops = loadOps(); ops.push(op); saveOps(ops); flush(); }

    // outcome of one request: 'ok' | 'drop' (server refused the change for good) | 'stop' (try again later)
    async function sendOp(op) {
        const tk = token();
        if (!tk) return 'stop';
        let url, method = 'POST', body = null;
        if (op.t === 'add') { url = '/api/notes/add'; body = op.note; }
        else if (op.t === 'del') { url = '/api/notes/' + encodeURIComponent(op.id); method = 'DELETE'; }
        else if (op.t === 'order') { url = '/api/notes/reorder'; body = { ids: op.ids }; }
        else if (op.t === 'clear') { url = '/api/notes/clear'; }
        else return 'drop';
        try {
            const r = await fetch(url, {
                method,
                headers: Object.assign({ 'Authorization': 'Bearer ' + tk }, body ? { 'Content-Type': 'application/json' } : {}),
                body: body ? JSON.stringify(body) : undefined
            });
            if (r.ok) return 'ok';
            if (r.status === 401 || r.status === 429 || r.status >= 500) return 'stop';
            return 'drop';
        } catch (e) { return 'stop'; }
    }

    let flushing = false;
    async function flush() {
        if (flushing) return;
        flushing = true;
        try {
            let ops = loadOps();
            if (!ops.length) return;
            setSync('busy');
            while (ops.length) {
                const res = await sendOp(ops[0]);
                if (res === 'stop') { setSync(token() ? 'offline' : ''); return; }
                ops = loadOps(); ops.shift(); saveOps(ops);   // 'ok' and 'drop' both remove the op
            }
            setSync('ok');
        } finally { flushing = false; }
    }

    // fetch the server copy (after sending what is waiting) and show "server copy + unsent changes"
    let pulling = false;
    let pulledFor = '';   // account whose server copy was loaded last (a different login -> load again)
    async function pull() {
        if (pulling || !token()) return;
        pulling = true;
        try {
            await flush();
            const tk = token();
            if (!tk) return;
            const fetchServer = async () => {
                try {
                    const r = await fetch('/api/notes', { headers: { 'Authorization': 'Bearer ' + tk } });
                    if (!r.ok) return null;
                    const d = await r.json();
                    return (d && Array.isArray(d.notes)) ? d.notes : null;
                } catch (e) { setSync('offline'); return null; }
            };
            let server = await fetchServer();
            if (!server) return;

            // one-time: notes that were saved only in this browser (older version) are uploaded
            if (!localStorage.getItem(migKey())) {
                const have = new Set(server.map(n => n.id));
                const ops = loadOps();
                load().forEach(n => { if (!have.has(n.id) && !ops.some(o => o.t === 'add' && o.note && o.note.id === n.id)) ops.push({ t: 'add', note: n }); });
                saveOps(ops);
                try { localStorage.setItem(migKey(), '1'); } catch (e) { }
                if (ops.length) {
                    await flush();
                    const again = await fetchServer();   // the server copy now includes the uploaded notes
                    if (again) server = again;
                }
            }
            pulledFor = emailKey();
            save(applyOps(server, loadOps()));
            if (!loadOps().length) setSync('ok');
            if (panel && panel.style.display !== 'none') render(); else updateCount();
        } finally { pulling = false; }
    }

    // ---- the operations used by the UI. They change the cache at once and queue the server change.
    // append at the END = notes stay in the order the student added them
    function add(text, src) {
        const t = clean(text);
        if (!t) return { ok: false, reason: 'empty' };
        const list = load();
        if (list.length && list[list.length - 1].text === t) return { ok: false, reason: 'duplicate' }; // same paste twice in a row
        if (list.length >= MAX_NOTES) return { ok: false, reason: 'full' };
        const note = { id: uid(), text: t, src: String(src || '').slice(0, 40), ts: Date.now() };
        list.push(note);
        if (!save(list)) return { ok: false, reason: 'storage' };
        queueOp({ t: 'add', note });
        return { ok: true, count: list.length };
    }
    function remove(id) { save(load().filter(n => n.id !== id)); queueOp({ t: 'del', id }); }
    function move(id, dir) {
        const list = load();
        const i = list.findIndex(n => n.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        save(list);
        queueOp({ t: 'order', ids: list.map(n => n.id) });
    }
    function clearAll() { save([]); queueOp({ t: 'clear' }); }
    function asText() { return load().map((n, i) => `${i + 1}. ${n.text}${n.src ? `  [${n.src}]` : ''}`).join('\n\n'); }

    // ---------------------------------------------------------------- UI helpers
    const $ = (id) => document.getElementById(id);
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

    function toast(msg) {
        let t = $('notes-toast');
        if (!t) { t = el('div', 'notes-toast'); t.id = 'notes-toast'; document.body.appendChild(t); }
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => t.classList.remove('show'), 1800);
    }

    function updateCount() {
        const c = $('notes-count');
        if (!c) return;
        const n = load().length;
        c.textContent = n ? String(n) : '';
        c.style.display = n ? 'inline-block' : 'none';
    }

    // ---------------------------------------------------------------- panel
    let panel = null;

    function build() {
        panel = el('div', 'notes-panel');
        panel.id = 'notes-panel';
        panel.style.display = 'none';

        const head = el('div', 'notes-head');
        const titleBox = el('div', 'notes-titlebox');
        const title = el('strong', '', '📝 My Notes');
        title.id = 'notes-title';
        const sync = el('span', 'notes-sync'); sync.id = 'notes-sync';
        titleBox.append(title, sync);
        const tools = el('div', 'notes-tools');
        const bCopy = el('button', 'notes-ico', 'Copy all'); bCopy.type = 'button';
        const bDl = el('button', 'notes-ico', '⬇ .txt'); bDl.type = 'button';
        const bClr = el('button', 'notes-ico', 'Clear'); bClr.type = 'button';
        const bX = el('button', 'notes-ico notes-x', '✕'); bX.type = 'button';
        tools.append(bCopy, bDl, bClr, bX);
        head.append(titleBox, tools);

        const quick = el('div', 'notes-quick');
        const ta = el('textarea'); ta.id = 'notes-input'; ta.rows = 2; ta.maxLength = MAX_LEN;
        ta.placeholder = 'Paste a point here - it is added to the notes at once (in order). Or type and press Add.';
        const bAdd = el('button', 'notes-add', 'Add'); bAdd.type = 'button';
        quick.append(ta, bAdd);

        const listBox = el('div', 'notes-list'); listBox.id = 'notes-list';
        panel.append(head, quick, listBox);
        document.body.appendChild(panel);

        const doAdd = (text) => {
            const r = add(text, 'pasted');
            if (r.ok) { ta.value = ''; render(); toast('Added to Notes'); }
            else if (r.reason === 'duplicate') toast('Already the last note');
            else if (r.reason === 'full') toast('Notes are full (' + MAX_NOTES + ')');
            else if (r.reason === 'storage') toast('Could not save (browser storage full?)');
        };
        // every paste = one new note
        ta.addEventListener('paste', (e) => {
            const txt = (e.clipboardData || window.clipboardData).getData('text');
            if (!txt || !txt.trim()) return;
            e.preventDefault();
            doAdd(txt);
        });
        bAdd.addEventListener('click', () => doAdd(ta.value));
        ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doAdd(ta.value); } });

        bX.addEventListener('click', close);
        bClr.addEventListener('click', () => { if (load().length && confirm('Delete ALL notes?')) { clearAll(); render(); } });
        bCopy.addEventListener('click', async () => {
            const t = asText();
            if (!t) return toast('No notes yet');
            let ok = false;
            try { await navigator.clipboard.writeText(t); ok = true; } catch (e) {
                const x = document.createElement('textarea'); x.value = t; x.style.cssText = 'position:fixed;left:-9999px';
                document.body.appendChild(x); x.select();
                window.__allowCopyOnce = true;
                try { ok = document.execCommand('copy'); } catch (e2) { }
                window.__allowCopyOnce = false; x.remove();
            }
            toast(ok ? 'All notes copied' : 'Copy failed');
        });
        bDl.addEventListener('click', () => {
            const t = asText();
            if (!t) return toast('No notes yet');
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([t], { type: 'text/plain;charset=utf-8' }));
            a.download = 'my-notes.txt';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel && panel.style.display !== 'none') close(); });
    }

    function render() {
        if (!panel) return;
        const list = load();
        $('notes-title').textContent = '📝 My Notes (' + list.length + ')';
        const box = $('notes-list');
        box.textContent = '';
        if (!list.length) {
            box.appendChild(el('div', 'notes-empty', 'No notes yet. Use "Add to Notes" under any explanation, or paste a point above.'));
        }
        list.forEach((n, i) => {
            const row = el('div', 'notes-item');
            row.appendChild(el('span', 'notes-no', (i + 1) + '.'));
            const body = el('div', 'notes-text', n.text);
            if (n.src && n.src !== 'pasted') body.appendChild(el('span', 'notes-src', n.src));
            const act = el('div', 'notes-act');
            const up = el('button', '', '▲'); const dn = el('button', '', '▼'); const del = el('button', '', '✕');
            [up, dn, del].forEach(b => { b.type = 'button'; });
            up.title = 'Move up'; dn.title = 'Move down'; del.title = 'Delete';
            up.disabled = i === 0; dn.disabled = i === list.length - 1;
            up.addEventListener('click', () => { move(n.id, -1); render(); });
            dn.addEventListener('click', () => { move(n.id, 1); render(); });
            del.addEventListener('click', () => { remove(n.id); render(); });
            act.append(up, dn, del);
            row.append(row.firstChild, body, act);
            box.appendChild(row);
        });
        updateCount();
    }

    function open() {
        if (!panel) build();
        panel.style.display = 'flex';
        render();
        setSync(loadOps().length ? 'busy' : syncState);
        pull();
        const ta = $('notes-input');
        if (ta && window.matchMedia && !window.matchMedia('(pointer: coarse)').matches) ta.focus(); // do not pop the keyboard on phones
    }
    function close() { if (panel) panel.style.display = 'none'; updateCount(); }

    // called by the "Add to Notes" button under an explanation
    function addFromExplanation(text, src) {
        const r = add(text, src);
        if (r.ok) toast('Added to Notes (' + r.count + ')');
        else if (r.reason === 'duplicate') toast('Already added');
        else if (r.reason === 'full') toast('Notes are full (' + MAX_NOTES + ')');
        else if (r.reason === 'storage') toast('Could not save (browser storage full?)');
        else toast('Nothing to add');
        if (panel && panel.style.display !== 'none') render(); else updateCount();
        return r;
    }

    // logout: hide the panel and remove the local copy of the notes (they stay safe on the server).
    // Changes that are still waiting to be sent are kept, so nothing is lost.
    function onLogout() {
        close();
        pulledFor = '';
        setSync('');
        try { if (!loadOps().length) localStorage.removeItem(cacheKey()); } catch (e) { }
        updateCount();
    }

    window.MpscNotes = { onLogout, open, close, add: addFromExplanation, count: () => load().length, updateCount, sync: pull, _store: { load, add, move, remove, clearAll, clean, applyOps, loadOps } };

    updateCount();
    // load the server copy when the page opens, when the user comes back to the tab and when the internet is back
    const kick = () => { if (token()) pull(); };
    window.addEventListener('load', () => setTimeout(kick, 800));
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
    // the dashboard button is created once, but the account can change (logout / login): keep the small counter fresh
    setInterval(() => { const d = $('dashboard-section'); if (d && d.classList.contains('active')) { updateCount(); if (loadOps().length) flush(); if (token() && pulledFor !== emailKey()) pull(); } }, 3000);
})();

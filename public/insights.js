/* =====================================================================
   Progress panel:  window.MpscInsights.open()
   Scope bar: "सर्व" or one of the exam groups the ADMIN made. It starts on the tab the student has open on the dashboard and limits every tab and the AI.
   WITHOUT AI : Overall | Topic-wise | Exam-wise | Wrong Qs | Revision | PYQ Trend   (exact numbers from the database, instant)
   WITH AI    : AI Coach (written report + chat + "the data the AI received")      (the AI only reads numbers computed by the server)
   Backend: /api/insights/*  (routes/insights.js)
   ===================================================================== */
(function () {
    'use strict';
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const jwt = () => localStorage.getItem('jwtToken') || '';
    let root = null, body = null, state = { mode: 'noai', tab: 'overall', scope: 'all', scopes: [], cache: {} };

    async function api(path, opt) {
        opt = opt || {};
        const url = '/api/insights' + path + (opt.body ? '' : (path.includes('?') ? '&' : '?') + 'scope=' + encodeURIComponent(state.scope));
        const r = await fetch(url, {
            method: opt.body ? 'POST' : 'GET',
            headers: Object.assign({ 'Authorization': 'Bearer ' + jwt() }, opt.body ? { 'Content-Type': 'application/json' } : {}),
            body: opt.body ? JSON.stringify(Object.assign({}, opt.body, { scope: state.scope })) : undefined
        });
        let j = null; try { j = await r.json(); } catch (e) { }
        if (!r.ok || !j || !j.success) { const e = new Error((j && j.message) || 'Error'); e.status = r.status; throw e; }
        const d = j.data || j;
        if (Array.isArray(d.scopes)) { state.scopes = d.scopes; if (d.scope && d.scope !== state.scope) { state.scope = d.scope; } drawScope(); }   // a deleted group falls back to "all"
        return j;
    }
    const fmtAt = (t) => { if (!t) return '–'; const d = new Date(t), days = Math.floor((Date.now() - d) / 86400000); return d.toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + (days <= 0 ? ' (आज)' : days === 1 ? ' (काल)' : ` (${days} दिवसांपूर्वी)`); };
    const fmtMin = (m) => (m == null ? '–' : (m >= 60 ? Math.floor(m / 60) + ' ता ' + Math.round(m % 60) + ' मि' : Math.round(m) + ' मि'));

    // ------------------------------------------------------------ scope bar (all / the admin's exam groups)
    function drawScope() {
        const box = root && root.querySelector('#ins-scope'); if (!box) return;
        if (!state.scopes.length || state.scopes.length < 2) { box.style.display = 'none'; return; }
        box.style.display = 'flex';
        box.innerHTML = '<span class="ins-sub">📂 निवड:</span>' + state.scopes.map(x => `<button class="ins-chip ${x.id === state.scope ? 'on' : ''}" data-sc="${esc(x.id)}" title="${x.papers} papers">${esc(x.name)} (${x.papers})</button>`).join('');
        box.querySelectorAll('[data-sc]').forEach(b => b.onclick = () => setScope(b.dataset.sc));
    }
    function setScope(id) {
        if (id === state.scope) return;
        state.scope = id; state.cache = {}; chat = []; state.wrong = null; state.rev = null; state.tp = null;
        drawScope(); paint();
    }

    // ------------------------------------------------------------ styles (injected once, so style.css is untouched)
    function css() {
        if (document.getElementById('ins-css')) return;
        const s = document.createElement('style'); s.id = 'ins-css';
        s.textContent = `
#ins-root{position:fixed;inset:0;z-index:3000;background:var(--bg-color,#f3f4f6);color:var(--text-primary,#1f2937);display:flex;flex-direction:column;font-size:.92rem}
#ins-root.hidden{display:none}
.ins-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface-color,#fff);border-bottom:1px solid rgba(0,0,0,.1);gap:10px}
.ins-head h2{margin:0;font-size:1.05rem}
.ins-x{border:0;background:transparent;font-size:1.4rem;cursor:pointer;color:inherit}
.ins-modes{display:flex;gap:6px;padding:8px 14px 0;background:var(--surface-color,#fff)}
.ins-mode{flex:1;padding:8px;border-radius:8px 8px 0 0;border:1px solid rgba(0,0,0,.12);border-bottom:0;background:rgba(0,0,0,.04);cursor:pointer;font-weight:600;color:inherit}
.ins-mode.on{background:var(--accent,#2563eb);color:#fff;border-color:var(--accent,#2563eb)}
.ins-tabs{display:flex;gap:4px;overflow-x:auto;padding:8px 14px;background:var(--surface-color,#fff);border-bottom:1px solid rgba(0,0,0,.1)}
.ins-tab{white-space:nowrap;padding:6px 12px;border-radius:999px;border:1px solid rgba(0,0,0,.15);background:transparent;cursor:pointer;color:inherit}
.ins-tab.on{background:var(--accent,#2563eb);color:#fff;border-color:var(--accent,#2563eb)}
#ins-body{flex:1;overflow:auto;padding:14px;max-width:1000px;width:100%;margin:0 auto;box-sizing:border-box}
.ins-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px}
.ins-card{background:var(--surface-color,#fff);border-radius:10px;padding:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.ins-card b{display:block;font-size:1.35rem}
.ins-card small{color:var(--text-secondary,#4b5563)}
.ins-box{background:var(--surface-color,#fff);border-radius:10px;padding:12px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.ins-box h3{margin:0 0 8px;font-size:1rem}
.ins-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid rgba(0,0,0,.06);flex-wrap:wrap}
.ins-row:first-of-type{border-top:0}
.ins-grow{flex:1;min-width:150px}
.ins-sub{color:var(--text-secondary,#4b5563);font-size:.78rem}
.ins-bar{height:7px;border-radius:4px;background:rgba(0,0,0,.1);overflow:hidden;margin-top:4px}
.ins-bar i{display:block;height:100%;background:var(--accent,#2563eb)}
.ins-bar i.weak{background:#ef4444}.ins-bar i.average{background:#f59e0b}.ins-bar i.strong{background:#10b981}.ins-bar i.new{background:#94a3b8}
.ins-badge{font-size:.7rem;padding:2px 8px;border-radius:999px;color:#fff;background:#94a3b8}
.ins-badge.weak,.ins-badge.falling{background:#ef4444}.ins-badge.average{background:#f59e0b}.ins-badge.strong,.ins-badge.rising{background:#10b981}.ins-badge.steady{background:#64748b}
.ins-btn{padding:5px 10px;border-radius:8px;border:1px solid var(--accent,#2563eb);background:var(--accent,#2563eb);color:#fff;cursor:pointer;font-size:.8rem}
.ins-btn.ghost{background:transparent;color:var(--accent,#2563eb)}
.ins-btn:disabled{opacity:.5;cursor:default}
.ins-chips{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
.ins-chip{padding:4px 10px;border-radius:999px;border:1px solid rgba(0,0,0,.2);background:transparent;cursor:pointer;font-size:.78rem;color:inherit}
.ins-chip.on{background:var(--accent,#2563eb);color:#fff;border-color:var(--accent,#2563eb)}
.ins-warn{background:#fef3c7;color:#92400e;border-radius:8px;padding:8px 10px;margin-bottom:12px;font-size:.82rem}
.ins-q{padding:10px 0;border-top:1px solid rgba(0,0,0,.08)}
.ins-q:first-of-type{border-top:0}
.ins-q p{margin:0 0 6px;white-space:pre-wrap}
.ins-opt{padding:6px 10px;border:1px solid rgba(0,0,0,.15);border-radius:8px;margin:4px 0;cursor:default}
.ins-opt.pick{cursor:pointer}
.ins-opt.right{background:#d1fae5;border-color:#10b981;color:#065f46}.ins-opt.bad{background:#fee2e2;border-color:#ef4444;color:#991b1b}
.ins-q img{max-width:100%;border-radius:6px;margin:4px 0}
.ins-table{width:100%;border-collapse:collapse;font-size:.8rem}
.ins-table th,.ins-table td{padding:4px 6px;text-align:center;border-bottom:1px solid rgba(0,0,0,.07)}
.ins-table td:first-child,.ins-table th:first-child{text-align:left}
.ins-scroll{overflow-x:auto}
.ins-spark{display:flex;align-items:flex-end;gap:2px;height:60px}
.ins-spark span{flex:1;background:var(--accent,#2563eb);min-width:3px;border-radius:2px 2px 0 0}
.ins-ai p{margin:4px 0}
.ins-chat{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto;margin-bottom:8px}
.ins-msg{padding:8px 10px;border-radius:10px;white-space:pre-wrap;max-width:92%}
.ins-msg.u{align-self:flex-end;background:var(--accent,#2563eb);color:#fff}.ins-msg.m{align-self:flex-start;background:rgba(0,0,0,.06)}
.ins-scope{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px 14px;background:var(--surface-color,#fff);border-bottom:1px solid rgba(0,0,0,.1)}
.ins-pre{max-height:320px;overflow:auto;font-size:.7rem;background:rgba(0,0,0,.05);padding:8px;border-radius:8px;white-space:pre-wrap;word-break:break-all}
.ins-form{display:flex;gap:6px}.ins-form input{flex:1;padding:8px;border-radius:8px;border:1px solid rgba(0,0,0,.25)}
`;
        document.head.appendChild(s);
    }

    // ------------------------------------------------------------ small renderers
    const LV = { weak: 'कमकुवत', average: 'मध्यम', strong: 'मजबूत', new: 'डेटा कमी' };
    const TR = { rising: '⬆ वाढतोय', falling: '⬇ कमी होतोय', steady: '➡ स्थिर' };
    const badge = (lv) => `<span class="ins-badge ${esc(lv)}">${esc(LV[lv] || lv)}</span>`;
    const bar = (p, lv) => `<div class="ins-bar"><i class="${esc(lv || '')}" style="width:${Math.max(0, Math.min(100, p || 0))}%"></i></div>`;
    const pc = (v) => (v == null ? '–' : v + '%');
    const loading = (m) => { body.innerHTML = `<p class="ins-sub">${esc(m || 'Loading...')}</p>`; };
    const fail = (e, retry) => {
        body.innerHTML = `<div class="ins-warn">${e.status === 403 ? 'Progress पाहण्यासाठी subscription / free trial आवश्यक आहे.' : esc(e.message || 'Error')}</div>` + (e.status === 403 ? '' : '<button class="ins-btn" id="ins-retry">Retry</button>');
        const b = document.getElementById('ins-retry'); if (b) b.onclick = retry;
    };
    const imgs = (q) => (q.images || []).map(id => `<img loading="lazy" src="/api/image/${encodeURIComponent(id)}?token=${encodeURIComponent(jwt())}" alt="question">`).join('');
    const qText = (q) => esc(q.text || q.text_eng || '') + (q.text && q.text_eng ? `<div class="ins-sub">${esc(q.text_eng)}</div>` : '');

    function practice(subject, topic) {
        close();
        if (typeof window.openTest !== 'function') return;
        Promise.resolve(window.openTest(null, subject)).then(() => {
            const apply = () => { if (typeof window.filterQuestions === 'function' && topic) window.filterQuestions(subject, topic); };
            apply(); setTimeout(apply, 700);
        });
    }
    window.__insPractice = practice;
    const pBtn = (s, t) => `<button class="ins-btn ghost" onclick="__insPractice(${esc(JSON.stringify(s))},${esc(JSON.stringify(t))})">Practice</button>`;

    // ------------------------------------------------------------ OVERALL (no AI)
    async function tabOverall() {
        loading();
        let d; try { d = (await api('/overview')).data; } catch (e) { return fail(e, tabOverall); }
        state.cache.overview = d;
        const t = d.totals, a = d.daily;
        const delta = (a.last7.accuracy != null && a.prev7.accuracy != null) ? (a.last7.accuracy - a.prev7.accuracy) : null;
        let h = '';
        if (d.quality && d.quality.untaggedPct > 5) h += `<div class="ins-warn">⚠ ${d.quality.untaggedPct}% प्रश्नांना subject/topic tag नाही - topic-wise आकडे तेवढ्यापुरते अपूर्ण असू शकतात.</div>`;
        h += `<div class="ins-cards">
            <div class="ins-card"><b>${t.solved}</b><small>सोडवलेले / ${t.bank}</small>${bar(t.completion, '')}</div>
            <div class="ins-card"><b>${pc(t.accuracy)}</b><small>Accuracy</small></div>
            <div class="ins-card"><b>${t.wrong}</b><small>चुकलेले प्रश्न</small></div>
            <div class="ins-card"><b>${a.streak} 🔥</b><small>दिवसांचा streak</small></div>
            <div class="ins-card"><b>${a.last7.solved}</b><small>गेले 7 दिवस${delta == null ? '' : ` · accuracy ${delta >= 0 ? '+' : ''}${Math.round(delta * 10) / 10}`}</small></div>
            <div class="ins-card"><b>${fmtMin(d.activity.study.totalMin)}</b><small>अंदाजे अभ्यास वेळ${a.last7.min != null ? ' · 7 दिवस ' + fmtMin(a.last7.min) : ''}</small></div>
            <div class="ins-card"><b>${d.activity.lifetime.activeDays}</b><small>अभ्यासाचे दिवस</small></div></div>`;
        if (d.undated > 0) h += `<div class="ins-sub" style="margin:-6px 0 10px">ℹ ${d.undated} जुन्या उत्तरांना तारीख नाही - ती totals मध्ये आहेत, पण daily graph / वेळेत नाहीत.</div>`;
        const L = d.activity.learning;
        if (L.questions) h += `<div class="ins-box"><h3>🧠 चुका आणि सुधारणा</h3><div class="ins-sub">${L.questions} प्रश्न प्रयत्न केले · पहिल्या प्रयत्नात बरोबर ${pc(L.firstTryAccuracy)} · पुन्हा सोडवलेले ${L.retried}</div>
            <div class="ins-chips"><span class="ins-badge strong">✔ चूक → दुरुस्त ${L.fixed}</span><span class="ins-badge weak">✖ अजून चुकतात ${L.stillWrong}</span><span class="ins-badge average">↻ 2+ वेळा चुकलेले ${L.repeatWrong}</span>${L.revisionAttempts ? `<span class="ins-badge">Revision accuracy ${pc(L.revisionAccuracy)} (${L.revisionAttempts})</span>` : ''}</div></div>`;
        const rx = d.activity.recentExams || [];
        if (rx.length) h += `<div class="ins-box"><h3>🕘 शेवटचे attempt केलेले tests</h3>` + rx.slice(0, 5).map((e, i) => `<div class="ins-row"><div class="ins-grow"><b>${i === 0 ? '▶ ' : ''}${esc(e.exam)}</b>${i === 0 ? ' <span class="ins-badge">शेवटचा</span>' : ''}<div class="ins-sub">${esc(fmtAt(e.lastAt))} · ${e.attempts} उत्तरे · accuracy ${pc(e.accuracy)}${i === 0 && e.lastSubject ? ' · शेवटचा प्रश्न: ' + esc(e.lastSubject) + ' › ' + esc(e.lastTopic) : ''}</div></div><button class="ins-btn ghost" data-open="${esc(e.exam)}">Open</button></div>`).join('') + '</div>';
        if (state.scope === 'all' && (d.groups || []).length) h += `<div class="ins-box"><h3>📂 Group-wise</h3>` + d.groups.map(g => `<div class="ins-row"><div class="ins-grow"><b>${esc(g.name)}</b><div class="ins-sub">${g.papers} papers · सोडवले ${g.solved}/${g.bank} · बरोबर ${g.correct} · चूक ${g.wrong}</div>${bar(g.accuracy, '')}</div><b>${pc(g.accuracy)}</b><button class="ins-btn ghost" data-sc="${esc(g.id)}">उघडा</button></div>`).join('') + '</div>';

        const p = d.plan;
        h += `<div class="ins-box"><h3>🎯 पुढे काय करायचं</h3>`;
        if (p.wrongDueNow > 0) h += `<div class="ins-row"><div class="ins-grow"><b>🔁 ${p.wrongDueNow} चुकलेले प्रश्न revise करायचे आहेत</b><div class="ins-sub">Spaced revision: चूक झाल्यावर 1 → 3 → 7 → 16 → 35 दिवसांनी पुन्हा</div></div><button class="ins-btn" onclick="MpscInsights.go('revise')">Revise करा</button></div>`;
        const sec = (title, arr, fn) => arr.length ? `<div class="ins-sub" style="margin-top:8px"><b>${title}</b></div>` + arr.map(fn).join('') : '';
        h += sec('1) आधी दुरुस्त करा (कमकुवत + परीक्षेत जास्त येणारे)', p.fix, x => `<div class="ins-row"><div class="ins-grow">${esc(x.subject)} › <b>${esc(x.topic)}</b><div class="ins-sub">${x.wrong} चुकले · accuracy ${pc(x.accuracy)} · PYQ मधला वाटा ${x.weightPct}%</div></div>${pBtn(x.subject, x.topic)}</div>`);
        h += sec('2) अजून सुरू न केलेले महत्त्वाचे topics', p.start, x => `<div class="ins-row"><div class="ins-grow">${esc(x.subject)} › <b>${esc(x.topic)}</b><div class="ins-sub">${x.bank} प्रश्न · PYQ मधला वाटा ${x.weightPct}%</div></div>${pBtn(x.subject, x.topic)}</div>`);
        h += sec('3) अजून सुधारता येतील', p.improve, x => `<div class="ins-row"><div class="ins-grow">${esc(x.subject)} › <b>${esc(x.topic)}</b><div class="ins-sub">accuracy ${pc(x.accuracy)} · वाटा ${x.weightPct}%</div></div>${pBtn(x.subject, x.topic)}</div>`);
        if (!p.fix.length && !p.start.length && !p.improve.length && p.wrongDueNow === 0) h += '<p class="ins-sub">अजून पुरेसा डेटा नाही. काही प्रश्न सोडवा - प्रत्येक topic चे किमान 3 प्रश्न झाल्यावर इथे योजना दिसेल.</p>';
        h += '</div>';
        if (p.strong.length) h += `<div class="ins-box"><h3>💪 मजबूत भाग</h3>` + p.strong.map(x => `<div class="ins-row"><div class="ins-grow">${esc(x.subject)} › ${esc(x.topic)}</div><span class="ins-sub">${x.accuracy}% (${x.attempted} प्रश्न)</span></div>`).join('') + '</div>';

        h += `<div class="ins-box"><h3>📚 Subject-wise</h3>` + (d.subjects.length ? d.subjects.map(s => `<div class="ins-row"><div class="ins-grow"><b>${esc(s.subject)}</b> ${badge(s.level)}<div class="ins-sub">${s.attempted}/${s.bank} सोडवले · बरोबर ${s.correct} · चूक ${s.wrong}</div>${bar(s.accuracy, s.level)}</div><b>${pc(s.accuracy)}</b></div>`).join('') : '<p class="ins-sub">–</p>') + '</div>';

        const days = a.days.slice(-30);
        if (d.hasHistory && days.length) { const mx = Math.max.apply(null, days.map(x => x.n)) || 1; h += `<div class="ins-box"><h3>📅 गेले 30 दिवस - रोज किती प्रश्न</h3><div class="ins-spark">${days.map(x => `<span title="${esc(x.day)}: ${x.n} प्रश्न, ${x.c} बरोबर, ~${x.min} मि" style="height:${Math.max(4, x.n / mx * 100)}%"></span>`).join('')}</div></div>`; }
        else h += `<div class="ins-box"><h3>📅 दैनंदिन trend</h3><p class="ins-sub">आतापासून सोडवलेल्या प्रश्नांची तारीख साठवली जाते; काही दिवसांनी इथे daily graph आणि streak दिसेल. जुन्या उत्तरांना तारीख नाही.</p></div>`;
        body.innerHTML = h;
        body.querySelectorAll('[data-sc]').forEach(b => b.onclick = () => setScope(b.dataset.sc));
        body.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { close(); if (window.openTest) window.openTest(b.dataset.open); });
    }

    // ------------------------------------------------------------ TOPIC-WISE (no AI): every subject, every topic, every sub-topic
    async function tabTopics() {
        if (!state.cache.overview) loading();
        let d = state.cache.overview; if (!d) { try { d = (await api('/overview')).data; state.cache.overview = d; } catch (e) { return fail(e, tabTopics); } }
        const f = state.tp || (state.tp = { level: 'all', q: '', sort: 'priority', open: {} });
        const levels = ['all', 'weak', 'average', 'strong', 'new'];
        const SORT = { priority: 'आधी काय (priority)', accuracy: 'कमी accuracy आधी', attempted: 'जास्त सोडवलेले', pyq: 'PYQ वाटा', name: 'नाव' };
        const sorters = { priority: (x, y) => y.priority - x.priority, accuracy: (x, y) => ((x.accuracy == null) - (y.accuracy == null)) || (x.accuracy - y.accuracy), attempted: (x, y) => y.attempted - x.attempted, pyq: (x, y) => y.weightPct - x.weightPct, name: (x, y) => x.topic.localeCompare(y.topic) };
        const subTop = {}; (d.subtopics || []).forEach(x => { (subTop[x.subject + '||' + x.topic] = subTop[x.subject + '||' + x.topic] || []).push(x); });
        const q = f.q.trim().toLowerCase();
        const bySubject = {}; d.topics.forEach(t => { (bySubject[t.subject] = bySubject[t.subject] || []).push(t); });
        const order = d.subjects.map(s => s.subject).concat(Object.keys(bySubject).filter(k => !d.subjects.some(s => s.subject === k)));
        let shown = 0;
        const blocks = order.map(sn => {
            const all = bySubject[sn]; if (!all) return '';
            const list = all.filter(t => (f.level === 'all' || t.level === f.level) && (!q || (sn + ' ' + t.topic).toLowerCase().includes(q))).sort(sorters[f.sort]);
            if (!list.length) return '';
            shown += list.length;
            const s = d.subjects.find(x => x.subject === sn) || { attempted: 0, bank: 0, accuracy: null, level: 'new', correct: 0, wrong: 0 };
            const rows = list.map(x => {
                const st = subTop[x.subject + '||' + x.topic] || [];
                return `<div class="ins-row"><div class="ins-grow"><b>${esc(x.topic)}</b> ${badge(x.level)}<div class="ins-sub">${x.attempted}/${x.bank} सोडवले · बरोबर ${x.correct} · चूक ${x.wrong} · PYQ वाटा ${x.weightPct}%${x.avgSec != null ? ' · ~' + x.avgSec + ' से/प्रश्न' : ''}</div>${bar(x.accuracy, x.level)}` +
                    (st.length ? `<details><summary class="ins-sub">उप-topics (${st.length})</summary>${st.map(z => `<div class="ins-sub">• ${esc(z.sub)}: ${z.attempted} सोडवले, चूक ${z.wrong} (${pc(z.accuracy)})</div>`).join('')}</details>` : '') +
                    `</div><b>${pc(x.accuracy)}</b>${pBtn(x.subject, x.topic)}</div>`;
            }).join('');
            return `<details class="ins-box" data-s="${esc(sn)}" ${(f.open[sn] || q) ? 'open' : ''}><summary><b>${esc(sn)}</b> ${s.attempted ? badge(s.level) : ''} <span class="ins-sub">${s.attempted}/${s.bank} सोडवले · बरोबर ${s.correct} · चूक ${s.wrong} · ${pc(s.accuracy)} · ${list.length} topics</span></summary>${rows}</details>`;
        }).join('');
        body.innerHTML = `<div class="ins-box"><h3>🧩 Topic-wise (${esc(d.scopeLabel || '')})</h3><div class="ins-chips">${levels.map(l => `<button class="ins-chip ${f.level === l ? 'on' : ''}" data-l="${l}">${l === 'all' ? 'सर्व' : LV[l]}</button>`).join('')}</div>
            <div class="ins-form"><input id="tp-q" placeholder="Subject / topic शोधा..." value="${esc(f.q)}"><select id="tp-s">${Object.keys(SORT).map(k => `<option value="${k}" ${f.sort === k ? 'selected' : ''}>${SORT[k]}</option>`).join('')}</select></div>
            <div class="ins-sub" style="margin-top:6px">${shown} topics दिसत आहेत. प्रत्येक subject वर tap करून त्यातले सर्व topics बघा.</div></div>` + (blocks || '<p class="ins-sub">या निवडीत topic नाही.</p>');
        body.querySelectorAll('[data-l]').forEach(b => b.onclick = () => { f.level = b.dataset.l; tabTopics(); });
        document.getElementById('tp-s').onchange = (e) => { f.sort = e.target.value; tabTopics(); };
        const inp = document.getElementById('tp-q');
        let tm = null; inp.oninput = () => { clearTimeout(tm); tm = setTimeout(async () => { f.q = inp.value; await tabTopics(); const el = document.getElementById('tp-q'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 350); };
        body.querySelectorAll('details[data-s]').forEach(el => el.addEventListener('toggle', () => { f.open[el.dataset.s] = el.open; }));
    }

    // ------------------------------------------------------------ EXAM-WISE (no AI)
    async function tabExams() {
        loading();
        let d = state.cache.overview; if (!d) { try { d = (await api('/overview')).data; state.cache.overview = d; } catch (e) { return fail(e, tabExams); } }
        const last = {}; ((d.activity || {}).recentExams || []).forEach(x => { last[x.exam] = x.lastAt; });
        const byLast = state.examSort !== 'year';
        const list = d.exams.slice(); if (byLast) list.sort((a, b) => (last[b.exam] || 0) - (last[a.exam] || 0));   // the scope bar (admin's groups) already limits the papers
        let h = `<div class="ins-sub" style="margin-bottom:8px">📂 ${esc(d.scopeLabel || '')} · ${list.length} papers</div><div class="ins-chips"><button class="ins-chip ${byLast ? 'on' : ''}" data-es="last">शेवटचा attempt आधी</button><button class="ins-chip ${byLast ? '' : 'on'}" data-es="year">वर्षानुसार</button></div>`;
        h += list.length ? list.map(e => `<div class="ins-box"><div class="ins-row" style="border:0"><div class="ins-grow"><b>${esc(e.exam)}</b><div class="ins-sub">सोडवले ${e.solved}/${e.total} · बरोबर ${e.correct} · चूक ${e.wrong} · बाकी ${e.unattempted}</div>${last[e.exam] ? `<div class="ins-sub">🕘 शेवटचा attempt: ${esc(fmtAt(last[e.exam]))}</div>` : ''}${bar(e.completion, '')}</div><b>${pc(e.accuracy)}</b><button class="ins-btn ghost" data-open="${esc(e.exam)}">Open</button></div>
            <details><summary class="ins-sub">Subject-wise (या paper मधले)</summary>${e.subjects.map(s => `<div class="ins-row"><div class="ins-grow">${esc(s.subject)} ${s.attempted >= 3 ? badge(s.level) : ''}<div class="ins-sub">${s.attempted}/${s.bank} · बरोबर ${s.correct} · चूक ${s.wrong}</div>${bar(s.accuracy, s.level)}</div><b>${pc(s.accuracy)}</b></div>`).join('')}</details></div>`).join('') : '<p class="ins-sub">या गटात paper नाही.</p>';
        body.innerHTML = h;
        body.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { close(); if (window.openTest) window.openTest(b.dataset.open); });
        body.querySelectorAll('[data-es]').forEach(b => b.onclick = () => { state.examSort = b.dataset.es; tabExams(); });
    }

    // ------------------------------------------------------------ WRONG QUESTIONS (no AI)
    async function tabWrong() {
        const f = state.wrong || (state.wrong = { subject: '', topic: '', exam: '', page: 0 });
        loading();
        let d; try { d = (await api(`/wrong?subject=${encodeURIComponent(f.subject)}&topic=${encodeURIComponent(f.topic)}&exam=${encodeURIComponent(f.exam)}&page=${f.page}`)).data; } catch (e) { return fail(e, tabWrong); }
        const fa = d.facets;
        const opt = (obj, cur, strip) => '<option value="">सर्व</option>' + Object.keys(obj).sort().map(k => { const label = strip ? k.split('||')[1] : k; return `<option value="${esc(k)}" ${cur === k ? 'selected' : ''}>${esc(label)} (${obj[k]})</option>`; }).join('');
        const topicsOfSubject = {}; Object.keys(fa.topics).filter(k => !f.subject || k.split('||')[0] === f.subject).forEach(k => { topicsOfSubject[k.split('||')[1]] = fa.topics[k]; });
        let h = `<div class="ins-box"><h3>❌ चुकलेले प्रश्न: ${d.total}</h3><div class="ins-form" style="flex-wrap:wrap">
            <select id="w-s">${opt(fa.subjects, f.subject)}</select><select id="w-t">${'<option value="">सर्व topics</option>' + Object.keys(topicsOfSubject).sort().map(k => `<option value="${esc(k)}" ${f.topic === k ? 'selected' : ''}>${esc(k)} (${topicsOfSubject[k]})</option>`).join('')}</select><select id="w-e">${opt(fa.exams, f.exam)}</select></div></div>`;
        h += `<div class="ins-box">` + (d.items.length ? d.items.map(q => {
            const opts = (q.options.length ? q.options : q.options_eng);
            return `<div class="ins-q"><div class="ins-sub">${esc(q.exam)} · ${esc(q.subject)} › ${esc(q.topic)}</div><p>${qText(q)}</p>${imgs(q)}` + opts.map((o, i) => `<div class="ins-opt ${i === q.correct ? 'right' : (i === q.selected ? 'bad' : '')}">${i + 1}) ${esc(o)} ${i === q.selected ? ' ← तुमचं उत्तर' : ''}${i === q.correct ? ' ✔' : ''}</div>`).join('') +
                (q.explanation ? `<details><summary class="ins-sub">स्पष्टीकरण</summary><p>${esc(q.explanation)}</p></details>` : '') + '</div>';
        }).join('') : '<p class="ins-sub">चुकलेला प्रश्न नाही 🎉</p>') +
            `<div class="ins-form" style="justify-content:space-between;margin-top:8px"><button class="ins-btn ghost" id="w-prev" ${f.page === 0 ? 'disabled' : ''}>← Prev</button><span class="ins-sub">Page ${d.page + 1} / ${Math.max(1, Math.ceil(d.total / d.pageSize))}</span><button class="ins-btn ghost" id="w-next" ${(f.page + 1) * d.pageSize >= d.total ? 'disabled' : ''}>Next →</button></div></div>`;
        body.innerHTML = h;
        const set = (k, v) => { f[k] = v; f.page = 0; tabWrong(); };
        document.getElementById('w-s').onchange = (e) => { f.topic = ''; set('subject', e.target.value); };
        document.getElementById('w-t').onchange = (e) => set('topic', e.target.value);
        document.getElementById('w-e').onchange = (e) => set('exam', e.target.value);
        document.getElementById('w-prev').onclick = () => { f.page--; tabWrong(); };
        document.getElementById('w-next').onclick = () => { f.page++; tabWrong(); };
        // the topic filter stores only the topic name; the server matches subject + topic together, so keep the subject chosen
    }

    // ------------------------------------------------------------ REVISION (no AI, spaced repetition)
    async function tabRevise(opts) {
        opts = opts || {};
        loading();
        const r = state.rev || (state.rev = { subject: '', topic: '', done: 0, right: 0 });
        let d; try { d = (await api(`/revision/queue?limit=10&subject=${encodeURIComponent(r.subject)}&topic=${encodeURIComponent(r.topic)}`)).data; } catch (e) { return fail(e, tabRevise); }
        let h = `<div class="ins-cards"><div class="ins-card"><b>${d.dueNow}</b><small>आज revise करायचे</small></div><div class="ins-card"><b>${d.later}</b><small>नंतरच्या दिवशी</small></div><div class="ins-card"><b>${d.mastered}</b><small>पक्के झालेले ✔</small></div></div>`;
        const keys = Object.keys(d.perTopic).sort((a, b) => d.perTopic[b] - d.perTopic[a]).slice(0, 12);
        if (keys.length) h += `<div class="ins-box"><h3>Topic निवडा</h3><div class="ins-chips"><button class="ins-chip ${!r.topic ? 'on' : ''}" data-rt="">सर्व</button>${keys.map(k => `<button class="ins-chip ${r.topic === k.split('||')[1] && r.subject === k.split('||')[0] ? 'on' : ''}" data-rt="${esc(k)}">${esc(k.split('||')[1])} (${d.perTopic[k]})</button>`).join('')}</div></div>`;
        if (!d.items.length) { h += `<div class="ins-box"><p>${d.dueNow === 0 ? '🎉 आज revise करायला काही नाही.' : 'या निवडीत प्रश्न नाही.'} ${d.later ? `पुढचे ${d.later} प्रश्न ठरलेल्या दिवशी दिसतील.` : ''}</p></div>`; body.innerHTML = h; return bindRevTopic(); }
        h += `<div class="ins-box" id="rev-box"></div>`;
        body.innerHTML = h; bindRevTopic();
        let i = 0, right = 0;
        const box = document.getElementById('rev-box');
        const show = () => {
            if (i >= d.items.length) { box.innerHTML = `<h3>Session पूर्ण</h3><p>${right} / ${d.items.length} बरोबर.</p><button class="ins-btn" id="rev-more">आणखी 10 प्रश्न</button>`; document.getElementById('rev-more').onclick = () => tabRevise(); return; }
            const q = d.items[i], opts = q.options.length ? q.options : q.options_eng;
            box.innerHTML = `<div class="ins-sub">प्रश्न ${i + 1}/${d.items.length} · ${esc(q.exam)} · ${esc(q.subject)} › ${esc(q.topic)}</div><p style="margin-top:6px">${qText(q)}</p>${imgs(q)}` + (q.passage ? `<details><summary class="ins-sub">Passage</summary><p>${esc(q.passage)}</p></details>` : '') +
                opts.map((o, k) => `<div class="ins-opt pick" data-i="${k}">${k + 1}) ${esc(o)}</div>`).join('') + '<div id="rev-res"></div>';
            let locked = false;
            box.querySelectorAll('[data-i]').forEach(el => el.onclick = async () => {
                if (locked) return; locked = true;
                let res; try { res = await api('/revision/answer', { body: { questionId: q.id, selectedOption: parseInt(el.dataset.i, 10) } }); } catch (e) { locked = false; alert(e.message); return; }
                const sel = parseInt(el.dataset.i, 10);
                box.querySelectorAll('[data-i]').forEach(o => { const k = parseInt(o.dataset.i, 10); o.classList.remove('pick'); if (k === res.correctOptionIndex) o.classList.add('right'); else if (k === sel) o.classList.add('bad'); });
                if (res.isCorrect) right++;
                const nd = res.state && res.state.nextDue ? new Date(res.state.nextDue).toLocaleDateString() : '';
                document.getElementById('rev-res').innerHTML = `<p><b>${res.isCancelled ? 'हा प्रश्न रद्द आहे' : (res.isCorrect ? '✅ बरोबर' : '❌ चूक')}</b> ${res.state && res.state.mastered ? '· पक्का झाला 🎓' : (nd ? '· पुढचं revision: ' + esc(nd) : '')}</p>${res.explanation ? `<details open><summary class="ins-sub">स्पष्टीकरण</summary><p>${esc(res.explanation)}</p></details>` : ''}<button class="ins-btn" id="rev-next">${i + 1 >= d.items.length ? 'पूर्ण' : 'पुढचा →'}</button>`;
                document.getElementById('rev-next').onclick = () => { i++; show(); };
            });
        };
        show();
    }
    function bindRevTopic() {
        body.querySelectorAll('[data-rt]').forEach(b => b.onclick = () => { const v = b.dataset.rt.split('||'); state.rev = { subject: v[0] || '', topic: v[1] || '' }; tabRevise(); });
    }

    // ------------------------------------------------------------ PYQ TREND (no AI)
    async function tabTrend() {
        loading();
        let d; try { d = (await api('/trend')).data; } catch (e) { return fail(e, tabTrend); }
        let h = `<div class="ins-box"><h3>📈 PYQ Trend (खरी आकडेवारी) - ${esc(d.scopeLabel || '')}</h3>
            <p class="ins-sub">${d.papers} papers · ${d.totalQuestions} प्रश्न · वर्षे: ${d.years.join(', ') || '–'}. "वाटा" = त्या वर्षाच्या एकूण प्रश्नांपैकी त्या topic चे %. वाढ/घट = अलीकडची वर्षे (${d.recentYears.join(', ') || '–'}) विरुद्ध आधीची वर्षे. वर निवडलेल्या group चेच papers मोजले जातात.</p>`;
        if (d.quality.untaggedPct > 5) h += `<div class="ins-warn">⚠ ${d.quality.untaggedPct}% प्रश्नांना topic tag नाही, त्यामुळे topic आकडे तेवढ्या प्रमाणात कमी दिसतील.</div>`;
        h += '</div>';
        h += `<div class="ins-box"><h3>Subject × Year (प्रश्नांची संख्या)</h3><div class="ins-scroll"><table class="ins-table"><tr><th>Subject</th>${d.years.map(y => `<th>${y}</th>`).join('')}<th>एकूण</th><th>%</th></tr>${d.subjects.map(s => `<tr><td>${esc(s.subject)}</td>${d.years.map(y => `<td>${s.years[y] || '·'}</td>`).join('')}<td><b>${s.total}</b></td><td>${s.sharePct}</td></tr>`).join('')}</table></div></div>`;
        const mine = {}; ((state.cache.overview || {}).topics || []).forEach(t => { mine[t.subject + '||' + t.topic] = t; });
        h += `<div class="ins-box"><h3>सर्वात जास्त विचारले जाणारे topics</h3><div class="ins-scroll"><table class="ins-table"><tr><th>Topic</th>${d.years.map(y => `<th>${String(y).slice(2)}</th>`).join('')}<th>किती वर्षे</th><th>Trend</th><th>तुमचं</th></tr>` +
            d.topics.slice(0, 80).map(t => { const m = mine[t.subject + '||' + t.topic]; return `<tr><td>${esc(t.subject)} › ${esc(t.topic)}</td>${d.years.map(y => `<td>${t.years[y] || '·'}</td>`).join('')}<td>${t.askedInYears}/${t.ofYears}</td><td><span class="ins-badge ${t.trend}">${TR[t.trend]}</span><div class="ins-sub">${t.olderPct}% → ${t.recentPct}%</div></td><td>${m && m.attempted >= 3 ? badge(m.level) : '<span class="ins-sub">–</span>'}</td></tr>`; }).join('') + '</table></div></div>';
        body.innerHTML = h;
        if (!state.cache.overview) api('/overview').then(r => { state.cache.overview = r.data; }).catch(() => { });
    }

    // ------------------------------------------------------------ AI COACH
    let chat = [];
    function reportHtml(r) {
        const list = (arr, fn) => (Array.isArray(arr) && arr.length) ? arr.slice(0, 6).map(fn).join('') : '<p class="ins-sub">–</p>';
        return `<div class="ins-box ins-ai"><h3>🤖 ${esc(r.headline || 'AI Coach Report')}</h3><p>${esc(r.summary)}</p></div>
            <div class="ins-box ins-ai"><h3>💪 मजबूत</h3>${list(r.strengths, x => `<p><b>${esc(x.topic)}</b> - ${esc(x.why)}</p>`)}</div>
            <div class="ins-box ins-ai"><h3>⚠ कमकुवत</h3>${list(r.weaknesses, x => `<p><b>${esc(x.topic)}</b> - ${esc(x.why)}<br><span class="ins-sub">👉 ${esc(x.fix)}</span></p>`)}</div>
            <div class="ins-box ins-ai"><h3>📖 पुढे काय cover करायचं</h3>${list(r.coverNext, x => `<p><b>${esc(x.topic)}</b> - ${esc(x.reason)}</p>`)}</div>
            <div class="ins-box ins-ai"><h3>🔁 Revision plan</h3>${list(r.revisionPlan, x => `<p><b>${esc(x.when)}:</b> ${esc(x.task)}</p>`)}</div>
            ${r.studyHabits ? `<div class="ins-box ins-ai"><h3>⏱ अभ्यासाच्या सवयी</h3><p>${esc(r.studyHabits)}</p></div>` : ''}
            <div class="ins-box ins-ai"><h3>📈 Trend</h3><p>${esc(r.trendComment)}</p>${r.warning ? `<div class="ins-warn">${esc(r.warning)}</div>` : ''}</div>`;
    }
    async function tabAI(refresh) {
        body.innerHTML = `<div class="ins-sub">AI तुमचा पूर्ण record (सर्व topics, subjects, अभ्यासाचा वेळ, चुका-सुधारणा, revision, starred, notes, PYQ trend) वाचून report बनवतो - निवडलेल्या group पुरता. आकडे AI मोजत नाही - ते वर No-AI tabs मधल्या सारखेच, server ने मोजलेले असतात.</div><div id="ai-report" class="ins-sub" style="margin:10px 0">⏳ Report तयार होत आहे...</div>
            <div class="ins-box"><h3>💬 Coach ला विचारा</h3><div class="ins-chat" id="ai-chat"></div><div class="ins-chips">${['माझा सर्वात कमकुवत भाग कोणता?', 'पुढचे 7 दिवस कसा अभ्यास करू?', 'कोणत्या topics वर वेळ घालवू आणि कोणते सोडू?', 'माझा trend कसा आहे?'].map(s => `<button class="ins-chip" data-s="${esc(s)}">${esc(s)}</button>`).join('')}</div><div class="ins-form"><input id="ai-in" maxlength="800" placeholder="तुमचा प्रश्न..."><button class="ins-btn" id="ai-send">➤</button></div></div>
            <div class="ins-box"><h3>👁 AI ला गेलेला data</h3><div class="ins-sub">AI ला नेमके काय मिळते ते तपासा - काही राहिले असेल तर लगेच दिसेल.</div><div class="ins-chips"><button class="ins-btn ghost" id="ai-dg">पहा</button><button class="ins-btn ghost" id="ai-dl" disabled>⬇ JSON download</button></div><div id="ai-dgbox"></div></div>`;
        drawChat();
        let dgJson = '';
        document.getElementById('ai-dg').onclick = async () => {
            const bx = document.getElementById('ai-dgbox'); bx.innerHTML = '<p class="ins-sub">⏳</p>';
            try { const r = (await api('/digest')).data; dgJson = JSON.stringify(r.digest, null, 1); bx.innerHTML = `<p class="ins-sub">${esc(r.scopeLabel)} · ${r.chars} अक्षरे</p><pre class="ins-pre">${esc(dgJson)}</pre>`; document.getElementById('ai-dl').disabled = false; }
            catch (e) { bx.innerHTML = `<div class="ins-warn">${esc(e.message)}</div>`; }
        };
        document.getElementById('ai-dl').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([dgJson], { type: 'application/json' })); a.download = 'my-study-data.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
        const send = async (text) => {
            text = (text || '').trim(); if (!text) return;
            const inp = document.getElementById('ai-in'); inp.value = '';
            chat.push({ role: 'user', text }); drawChat(true);
            try { const r = await api('/ai/chat', { body: { message: text, history: chat.slice(0, -1) } }); chat.push({ role: 'model', text: r.reply }); }
            catch (e) { chat.push({ role: 'model', text: '⚠ ' + e.message }); }
            drawChat();
        };
        document.getElementById('ai-send').onclick = () => send(document.getElementById('ai-in').value);
        document.getElementById('ai-in').onkeydown = (e) => { if (e.key === 'Enter') send(e.target.value); };
        body.querySelectorAll('[data-s]').forEach(b => b.onclick = () => send(b.dataset.s));
        try {
            const r = (await api('/ai/report', { body: { refresh: !!refresh } })).data;
            const el = document.getElementById('ai-report'); if (!el) return;
            if (r.tooFew) { el.innerHTML = `<div class="ins-warn">${esc(r.message)} (आता: ${r.solved})</div>`; return; }
            el.className = ''; el.innerHTML = (r.outdated ? '<div class="ins-warn">तुम्ही नवीन प्रश्न सोडवले आहेत; हा report जुना आहे.</div>' : '') + reportHtml(r.report) +
                `<p class="ins-sub">Report: ${new Date(r.at).toLocaleString()} ${r.cached ? '(saved)' : ''} <button class="ins-btn ghost" id="ai-refresh">🔄 नवीन report</button> (दिवसाला 4)</p>`;
            document.getElementById('ai-refresh').onclick = () => tabAI(true);
        } catch (e) { const el = document.getElementById('ai-report'); if (el) el.innerHTML = `<div class="ins-warn">${e.status === 403 ? 'Subscription / free trial आवश्यक आहे.' : esc(e.message)}</div>`; }
    }
    function drawChat(wait) {
        const box = document.getElementById('ai-chat'); if (!box) return;
        box.innerHTML = chat.map(m => `<div class="ins-msg ${m.role === 'user' ? 'u' : 'm'}">${esc(m.text)}</div>`).join('') + (wait ? '<div class="ins-msg m">⏳</div>' : '');
        box.scrollTop = box.scrollHeight;
    }

    // ------------------------------------------------------------ shell
    const TABS = { overall: ['📊 Overall', tabOverall], topics: ['🧩 Topic-wise', tabTopics], exams: ['📝 Exam-wise', tabExams], wrong: ['❌ Wrong Qs', tabWrong], revise: ['🔁 Revision', tabRevise], trend: ['📈 PYQ Trend', tabTrend] };
    function build() {
        css();
        root = document.createElement('div'); root.id = 'ins-root'; root.className = 'hidden';
        root.innerHTML = `<div class="ins-head"><h2>📊 My Progress</h2><button class="ins-x" aria-label="Close">✕</button></div>
            <div class="ins-modes"><button class="ins-mode" data-m="noai">Without AI (exact)</button><button class="ins-mode" data-m="ai">With AI 🤖</button></div>
            <div class="ins-scope" id="ins-scope" style="display:none"></div><div class="ins-tabs" id="ins-tabs"></div><div id="ins-body"></div>`;
        document.body.appendChild(root);
        body = root.querySelector('#ins-body');
        root.querySelector('.ins-x').onclick = close;
        root.querySelectorAll('.ins-mode').forEach(b => b.onclick = () => { state.mode = b.dataset.m; paint(); });
    }
    function paint() {
        root.querySelectorAll('.ins-mode').forEach(b => b.classList.toggle('on', b.dataset.m === state.mode));
        const tabs = root.querySelector('#ins-tabs');
        if (state.mode === 'ai') { tabs.style.display = 'none'; tabAI(false); return; }
        tabs.style.display = 'flex';
        tabs.innerHTML = Object.keys(TABS).map(k => `<button class="ins-tab ${state.tab === k ? 'on' : ''}" data-t="${k}">${TABS[k][0]}</button>`).join('');
        tabs.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { state.tab = b.dataset.t; if (['overall', 'topics', 'exams'].includes(b.dataset.t)) delete state.cache.overview; paint(); });
        TABS[state.tab][1]();
    }
    function open() {
        if (!root) build();
        delete state.cache.overview;
        // start on the tab the student is looking at on the dashboard (a group tab -> that group, "All Exams" -> all)
        const cur = String(window.currentExamFilter || 'all');
        const want = cur.startsWith('g:') ? cur : 'all';
        if (want !== state.scope) { state.scope = want; chat = []; state.wrong = null; state.rev = null; state.tp = null; }
        root.classList.remove('hidden'); document.body.style.overflow = 'hidden';
        drawScope(); paint();
        api('/scopes').catch(() => { });                       // fills the scope bar (also when the first tab is slow)
    }
    function close() { if (root) root.classList.add('hidden'); document.body.style.overflow = ''; }
    window.MpscInsights = { open, close, go: (t) => { state.mode = 'noai'; state.tab = t; paint(); } };
})();

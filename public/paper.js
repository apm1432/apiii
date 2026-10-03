/* =====================================================================
   PAPER MODE  (📄 Paper tab)
   - Original question-paper image full screen
   - One image can hold 1..5 questions -> answer rows for every question
   - A/B/C/D buttons give instant correct / wrong, Explanation on demand
   - Zoom / pan / pinch / double-tap. ONE zoom level is shared by all images
   - Next 3 images are prefetched
   Depends on globals from script.js: getFilteredQuestions, userAnswers,
   updateFloatingStats, renderFullPaper, renderQuizQuestion, currentQIndex,
   activeYearExam/activeSubject/activeTopic
   ===================================================================== */
(function () {
    'use strict';

    const LS_VIEW = 'paper_view_v1';
    const MIN_S = 1, MAX_S = 6, PREFETCH_AHEAD = 3, CACHE_MAX = 12;
    const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

    const PM = {
        open: false, pages: [], pi: 0,
        s: 1, tx: 0, ty: 0,            // zoom (relative to fit) + position
        fit: 'screen',                 // 'screen' = whole image visible, 'width' = fill width
        min: false,                    // answer panel minimised
        expl: null,                    // question id whose explanation is open
        nw: 0, nh: 0, loadId: 0,
        ptrs: new Map(), g: null, lastTap: null, raf: 0,
        cache: new Map(), els: {}, built: false
    };

    try {
        const v = JSON.parse(localStorage.getItem(LS_VIEW) || '{}');
        if (typeof v.s === 'number') PM.s = Math.min(MAX_S, Math.max(MIN_S, v.s));
        if (v.fit === 'width' || v.fit === 'screen') PM.fit = v.fit;
        if (typeof v.min === 'boolean') PM.min = v.min;
    } catch (e) { /* ignore */ }

    function saveView() {
        try { localStorage.setItem(LS_VIEW, JSON.stringify({ s: PM.s, fit: PM.fit, min: PM.min })); } catch (e) { }
    }

    /* ---------------- helpers ---------------- */
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const nl2br = (t) => String(t || '').replace(/\n/g, '<br>');

    function imgObj(q) {
        let o = q.original_image_url;
        if (!o) return null;
        if (typeof o === 'string') {
            const t = o.trim();
            if (t.startsWith('{')) { try { o = JSON.parse(t); } catch (e) { } }
        }
        return o;
    }
    function fileIds(q) {
        const o = imgObj(q);
        if (!o) return [];
        if (typeof o === 'string') return [o.replace('/api/image/', '')];
        return Object.values(o).filter(Boolean).map(String);
    }
    function imageUrl(q) {
        const o = imgObj(q);
        if (!o) return null;
        let src;
        if (typeof o === 'string') {
            src = o.startsWith('/api/image/') ? o : '/api/image/' + o;
        } else {
            src = '/api/image/' + encodeURIComponent(JSON.stringify(o));
        }
        const t = localStorage.getItem('jwtToken');
        if (t) src += (src.includes('?') ? '&' : '?') + 'token=' + t;
        return src + (src.includes('?') ? '&' : '?') + 'q=' + q._id;   // server drops the old cached file if this question's image id changed
    }

    function correctInfo(q) {
        const s = String(q.correct_answer_option || q.final_answer_key || q.answer_key || '').trim();
        if (s === '#') return { cancelled: true, idx: -1 };
        const i = parseInt(s, 10) - 1;
        return { cancelled: false, idx: isNaN(i) ? -1 : i };
    }
    function optionCount(q) {
        const n = Math.max((q.options || []).length, (q.options_eng || []).length, 4);
        return Math.min(n, LETTERS.length);
    }

    /* ---------------- pages = questions grouped by image ---------------- */
    function buildPages() {
        const list = (typeof getFilteredQuestions === 'function') ? getFilteredQuestions() : currentQuestions;
        const pages = [];
        let cur = null;
        list.forEach(q => {
            const ids = fileIds(q);
            const msg = q.telegram_msg_id || null;
            const sameImage = cur && cur.hasImage && ids.length &&
                (ids.some(x => cur.ids.has(x)) || (msg && cur.msgs.has(msg)));
            if (sameImage) {
                cur.qs.push(q);
                ids.forEach(x => cur.ids.add(x));
                if (msg) cur.msgs.add(msg);
            } else {
                cur = { qs: [q], ids: new Set(ids), msgs: new Set(msg ? [msg] : []), hasImage: ids.length > 0, url: imageUrl(q) };
                pages.push(cur);
            }
        });
        return pages;
    }

    function posKey() {
        return 'paper_pos|' + (window.activeYearExam || '') + '|' + (typeof activeSubject !== 'undefined' ? activeSubject || '' : '') + '|' + (typeof activeTopic !== 'undefined' ? activeTopic || '' : '');
    }

    /* ---------------- DOM ---------------- */
    function injectCss() {
        if (document.getElementById('pm-css')) return;
        const st = document.createElement('style');
        st.id = 'pm-css';
        st.textContent = `
.pm{position:fixed;left:0;top:0;width:100%;height:100vh;height:100dvh;z-index:20000;background:#0b0f19;display:none;flex-direction:column;color:#fff;font-family:Inter,system-ui,sans-serif;overscroll-behavior:none;-webkit-user-select:none;user-select:none}
.pm.open{display:flex}
.pm button{margin:0;font-family:inherit;-webkit-tap-highlight-color:transparent;cursor:pointer}
.pm-top{display:flex;align-items:center;gap:6px;padding:6px 8px;padding-top:calc(6px + env(safe-area-inset-top));background:#111827;border-bottom:1px solid #1f2937;flex:0 0 auto}
.pm-tb{background:#1f2937;color:#fff;border:1px solid #374151;border-radius:8px;min-width:36px;height:34px;padding:0 8px;font-size:.95rem}
.pm-tb:active{background:#374151}
.pm-zoom{min-width:44px;text-align:center;font-size:.8rem;color:#9ca3af}
.pm-score{margin-left:auto;font-size:.82rem;white-space:nowrap}
.pm-stage{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;touch-action:none;background:#000;cursor:grab}
.pm-stage.drag{cursor:grabbing}
.pm-img{position:absolute;left:0;top:0;transform-origin:0 0;max-width:none;max-height:none;will-change:transform;pointer-events:none;-webkit-user-drag:none;visibility:hidden;background:#fff}
.pm-spin{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:#9ca3af;font-size:.9rem;pointer-events:none}
.pm-spin i{width:30px;height:30px;border:3px solid #374151;border-top-color:#8b5cf6;border-radius:50%;animation:pmspin .8s linear infinite}
@keyframes pmspin{to{transform:rotate(360deg)}}
.pm-msg{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:20px;text-align:center;overflow:auto;background:#0b0f19}
.pm-msg .pm-qtext{max-width:640px;text-align:left;line-height:1.7;background:#111827;padding:16px;border-radius:12px;font-size:1rem}
.pm-panel{flex:0 0 auto;background:#111827;border-top:1px solid #1f2937;padding:6px 8px calc(8px + env(safe-area-inset-bottom));max-height:58vh;max-height:58dvh;overflow-y:auto;overscroll-behavior:contain;-webkit-user-select:none}
.pm-nav{display:flex;gap:8px;align-items:center;margin-bottom:6px}
.pm-nb{background:#374151;color:#fff;border:none;border-radius:10px;height:40px;flex:0 0 78px;font-size:.95rem;font-weight:600}
.pm-nb.primary{background:#8b5cf6}
.pm-nb:disabled{opacity:.35}
.pm-count{flex:1;background:transparent;color:#e5e7eb;border:1px solid #374151;border-radius:10px;height:40px;font-size:.85rem}
.pm-row{display:flex;align-items:center;gap:6px;margin:6px 0}
.pm-qn{flex:0 0 38px;font-size:.8rem;color:#9ca3af;font-weight:700}
.pm-opts{display:flex;gap:6px;flex:1}
.pm-opt{flex:1;max-width:84px;height:42px;border-radius:10px;border:1px solid #374151;background:#1f2937;color:#fff;font-size:1rem;font-weight:700}
.pm-opt:active{transform:scale(.96)}
.pm-opt.correct{background:#10b981;border-color:#10b981}
.pm-opt.wrong{background:#ef4444;border-color:#ef4444}
.pm-opt.cancel{background:#f59e0b;border-color:#f59e0b}
.pm-opt.dim{opacity:.55}
.pm-res{flex:0 0 auto;font-size:.78rem;min-width:52px;text-align:right;font-weight:700}
.pm-res.ok{color:#34d399}.pm-res.bad{color:#f87171}.pm-res.can{color:#fbbf24}
.pm-ex{flex:0 0 38px;height:38px;border-radius:10px;border:1px solid #374151;background:#1f2937;color:#fff;font-size:1rem}
.pm-ex:disabled{opacity:.3}
.pm-ex.on{background:#8b5cf6;border-color:#8b5cf6}
.pm-expl{background:#1f2937;border:1px solid #374151;border-radius:12px;padding:10px 12px;margin:6px 0 8px;max-height:36vh;max-height:36dvh;overflow-y:auto;font-size:.9rem;line-height:1.6;color:#e5e7eb;-webkit-user-select:text;user-select:text}
.pm-expl h5{margin:0 0 6px;font-size:.8rem;color:#a78bfa}
.pm-expl ul{margin:8px 0 0;padding-left:18px;color:#cbd5e1;font-size:.85rem}
@media (min-width:900px){.pm-panel{padding-left:calc(50% - 360px);padding-right:calc(50% - 360px)}}
`;
        document.head.appendChild(st);
    }

    function buildDom() {
        if (PM.built) return;
        injectCss();
        const root = document.createElement('div');
        root.className = 'pm';
        root.id = 'paper-mode';
        root.innerHTML = `
<div class="pm-top">
  <button class="pm-tb" data-a="close" title="Close">✕</button>
  <button class="pm-tb" data-a="zout" title="Zoom out">−</button>
  <span class="pm-zoom" id="pm-zoom">100%</span>
  <button class="pm-tb" data-a="zin" title="Zoom in">+</button>
  <button class="pm-tb" data-a="fit" id="pm-fitbtn" title="Fit mode">⤢</button>
  <span class="pm-score" id="pm-score"></span>
</div>
<div class="pm-stage" id="pm-stage">
  <img class="pm-img" id="pm-img" alt="Question paper" draggable="false">
  <div class="pm-spin" id="pm-spin"><i></i><span>Loading image...</span></div>
  <div class="pm-msg" id="pm-msg"></div>
</div>
<div class="pm-panel" id="pm-panel"></div>`;
        document.body.appendChild(root);
        PM.els = {
            root, stage: root.querySelector('#pm-stage'), img: root.querySelector('#pm-img'),
            spin: root.querySelector('#pm-spin'), msg: root.querySelector('#pm-msg'),
            panel: root.querySelector('#pm-panel'), zoom: root.querySelector('#pm-zoom'),
            score: root.querySelector('#pm-score'), fitbtn: root.querySelector('#pm-fitbtn')
        };

        // top bar + panel clicks (delegation)
        root.addEventListener('click', onClick);
        // stage gestures
        const st = PM.els.stage;
        st.addEventListener('pointerdown', onDown);
        st.addEventListener('pointermove', onMove);
        st.addEventListener('pointerup', onUp);
        st.addEventListener('pointercancel', onUp);
        st.addEventListener('wheel', onWheel, { passive: false });
        st.addEventListener('contextmenu', e => e.preventDefault());
        if (window.ResizeObserver) new ResizeObserver(() => { if (PM.open) apply(); }).observe(st);
        window.addEventListener('resize', () => { if (PM.open) apply(); });
        document.addEventListener('keydown', onKey);
        window.addEventListener('popstate', () => { if (PM.open) closePaper(true); });
        PM.built = true;
    }

    /* ---------------- geometry / zoom ---------------- */
    function stageSize() {
        const r = PM.els.stage.getBoundingClientRect();
        return { w: r.width, h: r.height, l: r.left, t: r.top };
    }
    function baseScale() {
        if (!PM.nw || !PM.nh) return 1;
        const { w, h } = stageSize();
        return PM.fit === 'width' ? w / PM.nw : Math.min(w / PM.nw, h / PM.nh);
    }
    const total = () => baseScale() * PM.s;

    function clampPos() {
        const { w: SW, h: SH } = stageSize();
        const t = total();
        const iw = PM.nw * t, ih = PM.nh * t;
        PM.tx = iw <= SW ? (SW - iw) / 2 : Math.min(0, Math.max(SW - iw, PM.tx));
        PM.ty = ih <= SH ? (SH - ih) / 2 : Math.min(0, Math.max(SH - ih, PM.ty));
    }
    function apply() {
        if (!PM.nw) return;
        clampPos();
        const t = total();
        PM.els.img.style.transform = `translate3d(${PM.tx}px,${PM.ty}px,0) scale(${t})`;
        PM.els.zoom.textContent = Math.round(PM.s * 100) + '%';
    }
    function schedule() {
        if (PM.raf) return;
        PM.raf = requestAnimationFrame(() => { PM.raf = 0; apply(); });
    }
    function zoomAt(newS, cx, cy) {
        newS = Math.min(MAX_S, Math.max(MIN_S, newS));
        const t0 = total();
        const ix = (cx - PM.tx) / t0, iy = (cy - PM.ty) / t0;
        PM.s = newS;
        const t1 = total();
        PM.tx = cx - ix * t1;
        PM.ty = cy - iy * t1;
        apply();
        saveView();
    }
    function zoomCenter(factor) {
        const { w, h } = stageSize();
        zoomAt(PM.s * factor, w / 2, h / 2);
    }

    /* ---------------- gestures ---------------- */
    function local(e) {
        const r = PM.els.stage.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function startGesture() {
        const pts = [...PM.ptrs.values()];
        if (pts.length === 1) {
            PM.g = { type: 'pan', x0: pts[0].x, y0: pts[0].y, tx0: PM.tx, ty0: PM.ty, t0: Date.now(), moved: 0 };
        } else if (pts.length >= 2) {
            const [a, b] = pts;
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, t = total();
            PM.g = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: PM.s, ix: (mx - PM.tx) / t, iy: (my - PM.ty) / t };
        } else PM.g = null;
    }
    function onDown(e) {
        if (!PM.nw) return;
        try { PM.els.stage.setPointerCapture(e.pointerId); } catch (x) { }
        PM.ptrs.set(e.pointerId, local(e));
        PM.els.stage.classList.add('drag');
        startGesture();
    }
    function onMove(e) {
        if (!PM.ptrs.has(e.pointerId) || !PM.g) return;
        PM.ptrs.set(e.pointerId, local(e));
        const g = PM.g;
        if (g.type === 'pan') {
            const p = PM.ptrs.get(e.pointerId);
            const dx = p.x - g.x0, dy = p.y - g.y0;
            g.moved = Math.max(g.moved, Math.hypot(dx, dy));
            PM.tx = g.tx0 + dx;
            PM.ty = g.ty0 + dy;
            schedule();
        } else if (g.type === 'pinch') {
            const [a, b] = [...PM.ptrs.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            PM.s = Math.min(MAX_S, Math.max(MIN_S, g.s0 * d / g.d0));
            const t = total();
            PM.tx = mx - g.ix * t;
            PM.ty = my - g.iy * t;
            schedule();
        }
    }
    function onUp(e) {
        const had = PM.ptrs.has(e.pointerId);
        const p = PM.ptrs.get(e.pointerId);
        PM.ptrs.delete(e.pointerId);
        try { PM.els.stage.releasePointerCapture(e.pointerId); } catch (x) { }
        if (!had) return;
        const g = PM.g;
        if (PM.ptrs.size === 0) PM.els.stage.classList.remove('drag');

        if (g && g.type === 'pan' && PM.ptrs.size === 0 && e.type === 'pointerup') {
            const now = Date.now();
            const dx = p.x - g.x0, dy = p.y - g.y0;
            const { w: SW } = stageSize();
            const fitsWidth = PM.nw * total() <= SW + 2;
            if (g.moved < 8 && now - g.t0 < 300) {
                // tap -> double tap = toggle zoom
                if (PM.lastTap && now - PM.lastTap.t < 320 && Math.hypot(p.x - PM.lastTap.x, p.y - PM.lastTap.y) < 30) {
                    PM.lastTap = null;
                    zoomAt(PM.s > 1.2 ? 1 : 2.5, p.x, p.y);
                } else PM.lastTap = { t: now, x: p.x, y: p.y };
            } else if (fitsWidth && now - g.t0 < 600 && Math.abs(dx) > 70 && Math.abs(dx) > 1.6 * Math.abs(dy)) {
                // swipe left/right when not zoomed sideways
                PM.tx = g.tx0; PM.ty = g.ty0; apply();
                go(dx < 0 ? 1 : -1);
            } else { apply(); saveView(); }
        } else {
            apply(); saveView();
        }
        startGesture(); // continue with remaining finger(s)
    }
    function onWheel(e) {
        e.preventDefault();
        if (!PM.nw) return;
        const p = local(e);
        zoomAt(PM.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), p.x, p.y);
    }

    /* ---------------- paging / loading ---------------- */
    function showMessage(html) {
        PM.els.msg.innerHTML = html;
        PM.els.msg.style.display = html ? 'flex' : 'none';
    }
    function prefetch() {
        for (let k = -1; k <= PREFETCH_AHEAD; k++) {
            if (k === 0) continue;
            const pg = PM.pages[PM.pi + k];
            if (!pg || !pg.url || PM.cache.has(pg.url)) continue;
            const im = new Image();
            im.decoding = 'async';
            im.src = pg.url;
            PM.cache.set(pg.url, im);
            if (PM.cache.size > CACHE_MAX) PM.cache.delete(PM.cache.keys().next().value);
        }
    }
    function showPage(i) {
        if (!PM.pages.length) return;
        PM.pi = Math.min(PM.pages.length - 1, Math.max(0, i));
        try { localStorage.setItem(posKey(), String(PM.pi)); } catch (e) { }
        PM.expl = null;
        const pg = PM.pages[PM.pi];
        const el = PM.els;
        const id = ++PM.loadId;

        renderPanel();
        showMessage('');

        if (!pg.url) {
            // no image for this question -> show its text
            el.img.style.visibility = 'hidden';
            el.spin.style.display = 'none';
            PM.nw = PM.nh = 0;
            const q = pg.qs[0];
            showMessage(`<div class="pm-qtext"><b>Q${esc(q.qnum || '')}.</b> ${nl2br(esc(q.text || ''))}${q.text_eng ? '<br><br><span style="color:#9ca3af">' + nl2br(esc(q.text_eng)) + '</span>' : ''}</div>`);
            return;
        }

        el.spin.style.display = 'flex';
        el.img.style.visibility = 'hidden';
        const done = () => {
            if (id !== PM.loadId) return;
            PM.nw = el.img.naturalWidth || 1;
            PM.nh = el.img.naturalHeight || 1;
            el.img.style.width = PM.nw + 'px';
            el.img.style.height = PM.nh + 'px';
            PM.ty = 0;                       // every new image starts at its top
            if (PM.s <= 1.001) PM.tx = 0;    // zoom (and left/right position) is kept
            apply();
            el.img.style.visibility = 'visible';
            el.spin.style.display = 'none';
            prefetch();
        };
        el.img.onload = done;
        el.img.onerror = () => {
            if (id !== PM.loadId) return;
            el.spin.style.display = 'none';
            PM.nw = PM.nh = 0;
            showMessage(`<div>⚠️ Image could not be loaded</div><button class="pm-nb primary" style="flex:none;padding:0 18px" data-a="retry">Retry</button>`);
        };
        if (el.img.getAttribute('src') === pg.url && el.img.complete && el.img.naturalWidth) done();
        else el.img.src = pg.url;
    }
    function go(d) {
        const n = PM.pi + d;
        if (n < 0 || n >= PM.pages.length) return;
        showPage(n);
    }

    /* ---------------- answers ---------------- */
    function answer(qId, optIndex) {
        const pg = PM.pages[PM.pi];
        const q = pg && pg.qs.find(x => String(x._id) === String(qId));
        if (!q || userAnswers[q._id]) return;

        const { cancelled, idx } = correctInfo(q);
        const isCorrect = !cancelled && optIndex === idx;
        userAnswers[q._id] = { selected: optIndex, isCorrect, isCancelled: cancelled, section: q.year_exam };
        try { localStorage.setItem('mpsc_user_answers', JSON.stringify(userAnswers)); } catch (e) { }

        fetch('/api/progress/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('jwtToken')}` },
            body: JSON.stringify({ questionId: q._id, section: q.year_exam, selectedOption: optIndex })
        }).catch(() => console.log('Offline: progress stored locally only'));

        renderPanel();
    }

    /* ---------------- panel ---------------- */
    function stats() {
        let c = 0, w = 0;
        const list = PM.pages.flatMap(p => p.qs);
        list.forEach(q => {
            const a = userAnswers[q._id];
            if (a && !a.isCancelled) { a.isCorrect ? c++ : w++; }
        });
        return { c, w, n: list.length };
    }
    function renderPanel() {
        const pg = PM.pages[PM.pi];
        if (!pg) return;
        const el = PM.els;
        const st = stats();
        el.score.innerHTML = `<span style="color:#34d399">✔ ${st.c}</span> &nbsp;<span style="color:#f87171">✖ ${st.w}</span> <span style="color:#9ca3af">/ ${st.n}</span>`;
        el.fitbtn.textContent = PM.fit === 'width' ? '↔' : '⤢';
        el.fitbtn.title = PM.fit === 'width' ? 'Fit width (tap for fit screen)' : 'Fit screen (tap for fit width)';

        const first = pg.qs[0], last = pg.qs[pg.qs.length - 1];
        const label = pg.qs.length > 1 ? `Q${first.qnum || ''}–${last.qnum || ''}` : `Q${first.qnum || ''}`;
        let html = `<div class="pm-nav">
            <button class="pm-nb" data-a="prev" ${PM.pi === 0 ? 'disabled' : ''}>◀ Prev</button>
            <button class="pm-count" data-a="min">${PM.pi + 1} / ${PM.pages.length} · ${label} ${PM.min ? '▴' : '▾'}</button>
            <button class="pm-nb primary" data-a="next" ${PM.pi >= PM.pages.length - 1 ? 'disabled' : ''}>Next ▶</button>
        </div>`;

        if (!PM.min) {
            // explanation sheet
            if (PM.expl) {
                const q = pg.qs.find(x => String(x._id) === String(PM.expl));
                if (q) {
                    html += `<div class="pm-expl"><h5>💡 Q${esc(q.qnum || '')} Explanation <button class="pm-ex" style="float:right;width:28px;height:26px;font-size:.8rem" data-a="exclose">✕</button></h5>${q.toppers_explanation_marathi ? nl2br(q.toppers_explanation_marathi) : 'No explanation available.'}`;
                    if (q.options_explanation && q.options_explanation.length) {
                        html += `<ul>${q.options_explanation.map(x => `<li>${nl2br(x)}</li>`).join('')}</ul>`;
                    }
                    html += `</div>`;
                }
            }
            pg.qs.forEach(q => {
                const ans = userAnswers[q._id];
                const ci = correctInfo(q);
                const n = Math.max(optionCount(q), ci.idx + 1);
                let btns = '', res = '';
                for (let i = 0; i < n; i++) {
                    let cls = '';
                    if (ans) {
                        if (ci.cancelled) cls = ans.selected === i ? 'cancel' : 'dim';
                        else if (i === ci.idx) cls = 'correct';
                        else if (ans.selected === i) cls = 'wrong';
                        else cls = 'dim';
                    }
                    btns += `<button class="pm-opt ${cls}" data-a="ans" data-q="${q._id}" data-i="${i}" ${ans ? 'disabled' : ''}>${LETTERS[i]}</button>`;
                }
                if (ans) {
                    if (ci.cancelled) res = `<span class="pm-res can">Cancelled</span>`;
                    else if (ans.selected === ci.idx) res = `<span class="pm-res ok">✔ Correct</span>`;
                    else res = `<span class="pm-res bad">✖ Ans: ${LETTERS[ci.idx] || '?'}</span>`;
                }
                html += `<div class="pm-row"><span class="pm-qn">Q${esc(q.qnum || '')}</span><div class="pm-opts">${btns}</div>${res}
                    <button class="pm-ex ${String(PM.expl) === String(q._id) ? 'on' : ''}" data-a="ex" data-q="${q._id}" ${ans ? '' : 'disabled'} title="${ans ? 'Explanation' : 'Answer first'}">💡</button></div>`;
            });
        }
        el.panel.innerHTML = html;
    }

    /* ---------------- events ---------------- */
    function onClick(e) {
        const b = e.target.closest('[data-a]');
        if (!b || b.disabled) return;
        const a = b.dataset.a;
        switch (a) {
            case 'close': closePaper(); break;
            case 'zin': zoomCenter(1.35); break;
            case 'zout': zoomCenter(1 / 1.35); break;
            case 'fit':
                PM.fit = PM.fit === 'width' ? 'screen' : 'width';
                PM.s = 1; PM.tx = 0; PM.ty = 0; apply(); saveView(); renderPanel(); break;
            case 'prev': go(-1); break;
            case 'next': go(1); break;
            case 'min': PM.min = !PM.min; saveView(); renderPanel(); break;
            case 'ans': answer(b.dataset.q, parseInt(b.dataset.i, 10)); break;
            case 'ex': PM.expl = String(PM.expl) === b.dataset.q ? null : b.dataset.q; renderPanel(); break;
            case 'exclose': PM.expl = null; renderPanel(); break;
            case 'retry': showPage(PM.pi); break;
        }
    }
    function onKey(e) {
        if (!PM.open) return;
        const k = e.key;
        const pg = PM.pages[PM.pi];
        if (k === 'Escape') closePaper();
        else if (k === 'ArrowRight') { go(1); e.preventDefault(); }
        else if (k === 'ArrowLeft') { go(-1); e.preventDefault(); }
        else if (k === 'ArrowDown') { PM.ty -= 80; apply(); e.preventDefault(); }
        else if (k === 'ArrowUp') { PM.ty += 80; apply(); e.preventDefault(); }
        else if (k === '+' || k === '=') zoomCenter(1.35);
        else if (k === '-') zoomCenter(1 / 1.35);
        else if (k === '0') { PM.s = 1; PM.tx = 0; PM.ty = 0; apply(); saveView(); }
        else if (/^[a-fA-F]$/.test(k) && pg && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const q = pg.qs.find(x => !userAnswers[x._id]);       // first unanswered on this page
            const i = LETTERS.indexOf(k.toUpperCase());
            if (q && i < optionCount(q)) answer(q._id, i);
        }
    }

    /* ---------------- open / close / refresh ---------------- */
    window.openPaperMode = function () {
        const list = (typeof getFilteredQuestions === 'function') ? getFilteredQuestions() : [];
        if (!list.length) { alert('No questions to show.'); return; }
        buildDom();
        PM.pages = buildPages();
        PM.open = true;
        PM.els.root.classList.add('open');
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
        try { history.pushState({ paper: 1 }, ''); } catch (e) { }

        let start = parseInt(localStorage.getItem(posKey()) || '', 10);
        if (isNaN(start) || start >= PM.pages.length) {
            start = PM.pages.findIndex(p => p.qs.some(q => !userAnswers[q._id]));
            if (start < 0) start = 0;
        }
        PM.tx = 0; PM.ty = 0;
        PM.nw = PM.nh = 0;
        showPage(start);
    };

    function closePaper(fromPop) {
        if (!PM.open) return;
        PM.open = false;
        PM.loadId++;
        PM.ptrs.clear();
        PM.els.root.classList.remove('open');
        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
        if (!fromPop && history.state && history.state.paper) { try { history.back(); } catch (e) { } }

        // bring Quiz / Full Paper views up to date with answers given here
        try {
            const v = getFilteredQuestions();
            renderFullPaper(v);
            if (v[currentQIndex]) renderQuizQuestion(currentQIndex, v);
            updateFloatingStats(v);
        } catch (e) { console.warn(e); }
    }

    // called when AI Fix changed questions / progress was re-synced while Paper Mode is open
    window.paperRefresh = function () {
        if (!PM.open) return;
        const keep = PM.pi;
        PM.pages = buildPages();
        PM.pi = Math.min(keep, PM.pages.length - 1);
        renderPanel();
    };
})();

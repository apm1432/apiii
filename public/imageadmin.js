// Admin: choose which page image(s) a question shows.
//  - "Use as main image": e.g. Q1 sits on page 2 but its image is the blank page 1 -> give Q1 the image of Q2
//  - "Add as extra image": the question continues on another page (or the options are on the next page)
//  - the image of ANY question (also of another exam paper) can be used
(function () {
    const tok = () => localStorage.getItem('jwtToken');
    const isAdmin = () => { try { return !!(JSON.parse(localStorage.getItem('currentUser')) || {}).isAdmin; } catch (e) { return false; } };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const enc = (o) => (typeof o === 'object' ? encodeURIComponent(JSON.stringify(o)) : String(o));
    const thumb = (o) => '/api/image/' + enc(o) + '?token=' + encodeURIComponent(tok() || '');

    async function post(body) {
        try {
            const r = await fetch('/api/admin/question-image', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok() }, body: JSON.stringify(body) });
            return await r.json();
        } catch (e) { return { success: false, message: 'Network error' }; }
    }

    let overlay = null, qid = null;
    const findQ = () => (currentQuestions || []).find(x => String(x._id) === String(qid));

    function refreshScreen(q) {
        try {
            const visible = getFilteredQuestions();
            const quizView = document.getElementById('quiz-view');
            if (quizView && quizView.style.display !== 'none') renderQuizQuestion(currentQIndex, visible);
            else if (typeof refreshFullQuestion === 'function') refreshFullQuestion(q._id);
            if (window.paperRefresh) window.paperRefresh(q._id, 'images');
        } catch (e) { console.warn('refreshScreen', e); }
    }

    async function run(body) {
        const msg = overlay.querySelector('#ie-msg');
        msg.textContent = 'Saving...';
        const r = await post({ questionId: qid, ...body });
        if (!r.success) { msg.textContent = '⚠ ' + (r.message || 'Failed.'); return; }
        const q = findQ();
        if (q) {
            q.original_image_url = r.question.original_image_url;
            q.extra_images = r.question.extra_images && r.question.extra_images.length ? r.question.extra_images : undefined;
            refreshScreen(q);
        }
        render();
        overlay.querySelector('#ie-msg').textContent = '✔ Saved. Students see the new image at once.';
    }

    function render() {
        const q = findQ();
        if (!q || !overlay) return;
        overlay.querySelector('#ie-title').textContent = '🖼 Images of Q' + (q.qnum || '') + ' – ' + (q.year_exam || '');

        // ---- current images
        const cur = overlay.querySelector('#ie-current');
        cur.innerHTML = '';
        const mainEnc = q.original_image_url ? enc(q.original_image_url) : null;
        const addCard = (raw, label, removeIdx) => {
            const d = document.createElement('div'); d.className = 'ie-card';
            d.innerHTML = '<img loading="lazy" src="' + thumb(raw) + '" alt=""><div class="ie-lab">' + esc(label) + '</div>';
            if (removeIdx != null) {
                const b = document.createElement('button'); b.className = 'btn xm-small xm-danger'; b.textContent = '✕ Remove';
                b.onclick = () => run({ action: 'removeExtra', index: removeIdx });
                d.appendChild(b);
            }
            cur.appendChild(d);
        };
        if (q.original_image_url) {
            addCard(q.original_image_url, 'MAIN image');
            const rm = document.createElement('button'); rm.className = 'btn xm-small xm-danger'; rm.textContent = '✕ Remove';
            rm.onclick = () => confirm('Remove the main image of this question?' + ((q.extra_images || []).length ? ' The first extra page becomes the main image.' : ' The question will have no image.')) && run({ action: 'removeMain' });
            cur.lastChild.appendChild(rm);
        } else cur.innerHTML = '<p class="xm-note">This question has no image yet.</p>';
        (q.extra_images || []).forEach((r, i) => addCard(r, 'Extra ' + (i + 1), i));

        // ---- pages of this paper (grouped by image)
        const groups = new Map();
        (currentQuestions || []).forEach(x => {
            if (!x.original_image_url || x.year_exam !== q.year_exam) return;
            const k = enc(x.original_image_url);
            if (!groups.has(k)) groups.set(k, { raw: x.original_image_url, qs: [] });
            groups.get(k).qs.push(x);
        });
        const list = [...groups.values()].sort((a, b) => Math.min(...a.qs.map(x => x.qnum || 0)) - Math.min(...b.qs.map(x => x.qnum || 0)));
        const pages = overlay.querySelector('#ie-pages');
        pages.innerHTML = '';
        if (!list.length) pages.innerHTML = '<p class="xm-note">No page images are loaded for this paper.</p>';
        list.forEach(g => {
            const isMain = enc(g.raw) === mainEnc;
            const d = document.createElement('div'); d.className = 'ie-card' + (isMain ? ' ie-main' : '');
            const nums = g.qs.map(x => 'Q' + (x.qnum || '?')).join(', ');
            d.innerHTML = '<img loading="lazy" src="' + thumb(g.raw) + '" alt=""><div class="ie-lab">' + esc(nums) + (isMain ? ' · current' : '') + '</div>';
            const src = g.qs[0]._id;
            const b1 = document.createElement('button'); b1.className = 'btn xm-small'; b1.textContent = 'Use as main';
            b1.disabled = isMain; b1.onclick = () => run({ action: 'use', sourceQuestionId: src });
            const b2 = document.createElement('button'); b2.className = 'btn xm-small'; b2.textContent = '+ Extra';
            b2.onclick = () => run({ action: 'add', sourceQuestionId: src });
            d.appendChild(b1); d.appendChild(b2);
            pages.appendChild(d);
        });

        // ---- any other question
        const sel = overlay.querySelector('#ie-exam');
        if (!sel.options.length) {
            const ids = (window.allExamsData || []).map(e => e._id).filter(x => x && x !== 'Passage Comprehension');
            if (q.year_exam && !ids.includes(q.year_exam)) ids.unshift(q.year_exam);
            sel.innerHTML = ids.map(id => '<option value="' + esc(id) + '">' + esc(id) + '</option>').join('');
        }
        if (!sel.dataset.set) { sel.value = q.year_exam || sel.value; sel.dataset.set = '1'; }
    }

    function build() {
        overlay = document.createElement('div');
        overlay.className = 'xm-overlay';
        overlay.innerHTML =
            '<div class="xm-box" style="width:860px">' +
            '<div class="xm-head"><b id="ie-title">🖼 Images</b><button class="xm-x" id="ie-close">✕</button></div>' +
            '<div class="xm-body">' +
            '<p class="xm-note">Example: Q1 is printed on page 2 but its image is the blank page 1 → pick page 2 and press <b>Use as main</b>. If a question continues on the next page, press <b>+ Extra</b> on that page.</p>' +
            '<h4>This question now shows</h4><div id="ie-current" class="ie-row"></div>' +
            '<h4 style="margin-top:14px">Pages of this paper <small>(tap a page)</small></h4><div id="ie-pages" class="ie-row"></div>' +
            '<h4 style="margin-top:14px">Image of any other question</h4>' +
            '<div class="xm-row"><select id="ie-exam"></select><input type="number" id="ie-qnum" min="1" placeholder="Question no."></div>' +
            '<div class="xm-actions"><button class="btn" id="ie-use">Use as main</button><button class="btn" id="ie-add">+ Add as extra</button></div>' +
            '<div class="xm-actions" style="margin-top:12px"><button class="btn xm-danger" id="ie-reset">↺ Reset to the original image</button></div>' +
            '<div id="ie-msg" class="xm-note" style="min-height:1.3em;margin-top:6px"></div>' +
            '</div></div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('show'); });
        overlay.querySelector('#ie-close').onclick = () => overlay.classList.remove('show');
        const other = (action) => {
            const n = Number(overlay.querySelector('#ie-qnum').value);
            if (!(n > 0)) { overlay.querySelector('#ie-msg').textContent = 'Enter a question number.'; return; }
            run({ action, sourceExam: overlay.querySelector('#ie-exam').value, sourceQnum: n });
        };
        overlay.querySelector('#ie-use').onclick = () => other('use');
        overlay.querySelector('#ie-add').onclick = () => other('add');
        overlay.querySelector('#ie-reset').onclick = () => confirm('Go back to the original image of this question and remove the extra images?') && run({ action: 'reset' });
    }

    window.openImageEditor = function (id) {
        if (!isAdmin()) return;
        qid = id;
        if (!overlay) build();
        overlay.querySelector('#ie-exam').dataset.set = '';
        overlay.querySelector('#ie-msg').textContent = '';
        overlay.querySelector('#ie-qnum').value = '';
        overlay.classList.add('show');
        render();
    };
})();

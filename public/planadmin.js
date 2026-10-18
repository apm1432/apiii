// Admin: "Plans & Pricing" - change the price of a plan, add as many plans as you like,
// change how long a plan lasts, hide a plan from students, or delete it. Saved in the database.
(function () {
    const tok = () => localStorage.getItem('jwtToken');

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

    let overlay = null, plans = [];
    const $ = (s) => overlay.querySelector(s);

    function el(tag, props, children) {
        const e = document.createElement(tag);
        Object.keys(props || {}).forEach(k => {
            if (k === 'class') e.className = props[k];
            else if (k === 'text') e.textContent = props[k];
            else if (k === 'value') e.value = props[k];
            else e.setAttribute(k, props[k]);
        });
        (children || []).forEach(c => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
        return e;
    }

    function field(label, input, wide) {
        return el('label', { class: wide ? 'pa-wide' : '' }, [label, input]);
    }

    function build() {
        if (overlay) return;
        overlay = el('div', { class: 'xm-overlay' });
        overlay.innerHTML =
            '<div class="xm-box" style="width:820px">' +
            '<div class="xm-head" style="background:#db2777"><b>💰 Plans &amp; Pricing</b><button class="xm-x" id="pa-close">✕</button></div>' +
            '<div class="xm-body">' +
            '<div class="xm-note" style="margin-bottom:8px">Changes are live for students immediately. A student who is already paying keeps the price they saw when they opened the payment window.</div>' +
            '<div class="xm-actions"><button class="btn" id="pa-add" style="background:#16a34a;color:#fff">➕ Add new plan</button><span id="pa-msg" class="xm-note"></span></div>' +
            '<div id="pa-list"></div>' +
            '</div></div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        $('#pa-close').onclick = close;
        $('#pa-add').onclick = addNew;
    }

    function say(t, bad) {
        const m = $('#pa-msg');
        m.textContent = t || '';
        m.style.color = bad ? '#b91c1c' : '#047857';
    }

    function close() { if (overlay) overlay.classList.remove('show'); }

    async function load() {
        say('Loading...');
        const r = await api('GET', '/api/admin/plans');
        if (!r.success) { say(r.message || 'Could not load plans.', true); return; }
        plans = r.plans || [];
        say('');
        render();
    }

    function render() {
        const list = $('#pa-list');
        list.innerHTML = '';
        if (!plans.length) { list.appendChild(el('p', { class: 'xm-note', text: 'No plans yet. Click "Add new plan".' })); return; }
        plans.forEach(p => list.appendChild(card(p)));
    }

    function card(p) {
        const isNew = !p.planId;
        const name = el('input', { type: 'text', maxlength: '60', value: p.name || '', placeholder: 'e.g. 3 Months Access' });
        const price = el('input', { type: 'number', min: '1', max: '100000', step: '0.01', value: p.price != null ? p.price : '' });
        const orig = el('input', { type: 'number', min: '0', step: '0.01', value: p.originalPrice || '', placeholder: 'optional, e.g. 199' });
        const dval = el('input', { type: 'number', min: '1', max: '3650', step: '1', value: p.durationValue || 1 });
        const dunit = el('select', {}, ['days', 'months', 'years'].map(u => { const o = el('option', { value: u, text: u }); if ((p.durationUnit || 'months') === u) o.selected = true; return o; }));
        const badge = el('input', { type: 'text', maxlength: '30', value: p.badge || '', placeholder: 'optional, e.g. Best Value' });
        const order = el('input', { type: 'number', step: '1', value: p.sortOrder != null ? p.sortOrder : 0 });
        const desc = el('input', { type: 'text', maxlength: '200', value: p.description || '', placeholder: 'One line shown on the card' });
        const active = el('select', {}, [el('option', { value: 'true', text: 'Active (students can buy)' }), el('option', { value: 'false', text: 'Hidden from students' })]);
        active.value = p.active === false ? 'false' : 'true';

        const save = el('button', { class: 'btn', text: isNew ? '💾 Create plan' : '💾 Save' });
        const del = el('button', { class: 'btn xm-danger', text: '🗑 Delete' });
        const state = el('span', { class: 'pa-state' });
        const cancel = el('button', { class: 'btn', text: 'Cancel' });

        const c = el('div', { class: 'pa-card' + (p.active === false ? ' pa-off' : '') }, [
            el('div', { class: 'pa-title' }, [
                el('span', { text: isNew ? 'New plan' : (p.name || 'Plan') }),
                isNew ? el('span') : el('span', { class: 'pa-pill', text: p.active === false ? 'Hidden' : 'Live' })
            ]),
            el('div', { class: 'pa-grid' }, [
                field('Plan name', name, true),
                field('Price (₹)', price),
                field('Old price ₹ (struck through)', orig),
                field('Duration', dval),
                field('Unit', dunit),
                field('Badge', badge),
                field('Show order (small = first)', order),
                field('Status', active),
                field('Description', desc, true)
            ]),
            el('div', { class: 'pa-bar' }, isNew ? [save, cancel, state] : [save, del, state])
        ]);

        const body = () => ({
            name: name.value, price: price.value, originalPrice: orig.value,
            durationValue: Number(dval.value), durationUnit: dunit.value,
            badge: badge.value, sortOrder: Number(order.value), description: desc.value,
            active: active.value === 'true'
        });

        save.onclick = async () => {
            save.disabled = true; state.textContent = 'Saving...';
            const r = isNew ? await api('POST', '/api/admin/plans', body())
                            : await api('PUT', '/api/admin/plans/' + encodeURIComponent(p.planId), body());
            save.disabled = false;
            if (!r.success) { state.textContent = '⚠ ' + (r.message || 'Failed.'); state.style.color = '#b91c1c'; return; }
            say('✔ Saved. Students see the new price now.');
            await load();
        };
        del.onclick = async () => {
            if (!confirm('Delete "' + (p.name || 'this plan') + '"?\n\nStudents will not see it any more. Students who already bought it keep their access.')) return;
            const r = await api('DELETE', '/api/admin/plans/' + encodeURIComponent(p.planId));
            if (!r.success) { state.textContent = '⚠ ' + (r.message || 'Failed.'); state.style.color = '#b91c1c'; return; }
            say('✔ Deleted.');
            await load();
        };
        cancel.onclick = () => { plans = plans.filter(x => x !== p); render(); };
        return c;
    }

    function addNew() {
        if (plans.some(p => !p.planId)) return;
        plans.push({ name: '', price: '', durationValue: 1, durationUnit: 'months', sortOrder: plans.length + 1, active: true });
        render();
        const list = $('#pa-list');
        if (list.lastChild && list.lastChild.scrollIntoView) list.lastChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    window.openPlanAdmin = function () {
        let isAdmin = false;
        try { isAdmin = !!(JSON.parse(localStorage.getItem('currentUser')) || {}).isAdmin; } catch (e) {}
        if (!isAdmin) return;
        build();
        overlay.classList.add('show');
        load();
    };
})();

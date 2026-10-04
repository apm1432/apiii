// Keeps the logged-in user's account (subscription / admin rights) in sync WITHOUT logout + login.
//  - instant: the server pushes an "account" event (Server-Sent Events) when an admin changes something
//  - fallback: asks /api/auth/me every 15 s while the tab is visible, and when the tab gets focus
// When something changed it updates the profile, shows a message and refreshes the screen.
(function () {
    let es = null, syncing = false, timer = null;

    const tok = () => localStorage.getItem('jwtToken');
    const readUser = () => { try { return JSON.parse(localStorage.getItem('currentUser')) || null; } catch (e) { return null; } };
    const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } };

    function toast(title, body, ok) {
        let box = document.getElementById('acct-toast');
        if (!box) {
            box = document.createElement('div');
            box.id = 'acct-toast';
            box.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:10000;max-width:92vw;width:420px;' +
                'padding:14px 16px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);font-size:.95rem;line-height:1.5;cursor:pointer;';
            box.onclick = () => { box.style.display = 'none'; };
            document.body.appendChild(box);
        }
        box.style.background = ok ? '#065f46' : '#7f1d1d';
        box.style.color = '#fff';
        box.innerHTML = '';
        const t = document.createElement('strong'); t.textContent = title;
        const b = document.createElement('div'); b.style.marginTop = '4px'; b.textContent = body;
        box.appendChild(t); box.appendChild(b);
        box.style.display = 'block';
        clearTimeout(box._t);
        box._t = setTimeout(() => { box.style.display = 'none'; }, 9000);
    }

    window.acctToast = toast;

    function describe(oldU, newU) {
        const msgs = [];
        if (!oldU.isSubscribed && newU.isSubscribed) {
            msgs.push({ ok: true, t: '🎉 Welcome! Subscription सुरू झाले', b: `तुमचा ${newU.subscriptionPlan || 'Premium'} plan active झाला आहे.` +
                (newU.subscriptionExpiry ? ` ${fmtDate(newU.subscriptionExpiry)} पर्यंत valid.` : '') + ' आता सर्व tests खुले आहेत.' });
        } else if (oldU.isSubscribed && !newU.isSubscribed) {
            msgs.push({ ok: false, t: 'Subscription संपले / बंद केले', b: 'तुमचे premium access आता बंद झाले आहे. Renew करण्यासाठी admin शी संपर्क करा.' });
        } else if (newU.isSubscribed && (oldU.subscriptionExpiry !== newU.subscriptionExpiry || oldU.subscriptionPlan !== newU.subscriptionPlan)) {
            msgs.push({ ok: true, t: '✅ Subscription update झाले', b: newU.subscriptionExpiry ? `आता ${fmtDate(newU.subscriptionExpiry)} पर्यंत valid.` : 'तुमचा plan update झाला आहे.' });
        }
        if (!oldU.isAdmin && newU.isAdmin) msgs.push({ ok: true, t: '👨‍💻 Admin rights मिळाले', b: 'तुम्हाला आता Admin features (AI Fix, Download) दिसतील.' });
        if (oldU.isAdmin && !newU.isAdmin) msgs.push({ ok: false, t: 'Admin rights काढले', b: 'तुमचे Admin rights आता बंद झाले आहेत.' });
        return msgs;
    }

    function refreshScreen(revoked) {
        try {
            const testActive = document.getElementById('test-section') && document.getElementById('test-section').classList.contains('active');
            if (testActive && revoked) {
                // paid access removed -> leave the paid paper immediately
                currentQuestions = [];
                showSection('dashboard-section');
                if (typeof loadDashboard === 'function') loadDashboard();
                return;
            }
            if (testActive) {
                // re-draw so admin-only buttons (AI Fix) appear / disappear
                const quizVisible = document.getElementById('quiz-view') && document.getElementById('quiz-view').style.display !== 'none' &&
                    document.getElementById('quiz-view').classList.contains('active');
                if (quizVisible && typeof renderQuizQuestion === 'function') renderQuizQuestion(currentQIndex);
                else if (typeof renderFullPaper === 'function') renderFullPaper();
            } else if (typeof loadDashboard === 'function' && document.getElementById('dashboard-section') &&
                       document.getElementById('dashboard-section').classList.contains('active')) {
                loadDashboard();
            }
        } catch (e) { console.warn('refreshScreen:', e); }
    }

    async function sync() {
        const t = tok();
        if (!t || syncing) return;
        syncing = true;
        try {
            const res = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + t }, cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (!data || !data.success || !data.user) return;
            const oldU = readUser() || {};
            const newU = Object.assign({}, oldU, data.user);
            const msgs = describe(oldU, newU);

            const changed = ['isSubscribed', 'isAdmin', 'subscriptionPlan', 'subscriptionExpiry', 'hasUsedFreeTrial']
                .some(k => String(oldU[k]) !== String(newU[k]));
            if (!changed) return;

            localStorage.setItem('currentUser', JSON.stringify(newU));
            currentUser = newU;                       // same global that script.js uses
            if (typeof updateProfileUI === 'function') updateProfileUI();
            if (msgs.length) toast(msgs[0].t, msgs.map(m => m.b).join(' '), msgs.every(m => m.ok));
            refreshScreen(oldU.isSubscribed && !newU.isSubscribed);
        } catch (e) { /* network hiccup: next tick will retry */ }
        finally { syncing = false; }
    }

    function openStream() {
        const t = tok();
        if (!t || es || typeof EventSource === 'undefined') return;
        try {
            es = new EventSource('/api/auth/events?token=' + encodeURIComponent(t));
            es.addEventListener('account', () => sync());
            es.addEventListener('catalog', () => { if (window.onCatalogChanged) window.onCatalogChanged(); });
            es.onerror = () => {
                // closed for good (e.g. token no longer valid) -> polling keeps working
                if (es && es.readyState === 2) { es.close(); es = null; }
            };
        } catch (e) { es = null; }
    }

    function stopAll() {
        if (es) { es.close(); es = null; }
        if (timer) { clearInterval(timer); timer = null; }
    }

    function start() {
        if (!tok()) return;
        openStream();
        sync();
        if (!timer) timer = setInterval(() => { if (!document.hidden) { if (!tok()) { stopAll(); return; } openStream(); sync(); } }, 15000);
    }

    document.addEventListener('visibilitychange', () => { if (!document.hidden) { openStream(); sync(); } });
    window.addEventListener('focus', sync);

    // logout() lives in script.js: stop our connection when the user logs out
    const origLogout = window.logout;
    if (typeof origLogout === 'function') {
        window.logout = function () { stopAll(); return origLogout.apply(this, arguments); };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

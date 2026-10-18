// "Ask AI" chat for ONE question. History lives only in this page's memory:
// it is never saved (no DB, no localStorage) and disappears on close / reload.
(function () {
    let kit = null;   // PanelKit: drag / resize / auto-close switch (panelkit.js)
    let panel = null, msgBox = null, input = null, sendBtn = null, titleEl = null;
    let currentQid = null;
    let history = [];      // [{role:'user'|'model', text}]
    let busy = false;
    let withImage = false;   // default: WITHOUT the question image (faster, uses less AI quota)
    let hasImage = false;    // does the current question have an image at all?

    const SUGGESTIONS = [
        'हा प्रश्न सोप्या भाषेत समजावून सांगा',
        'या विषयाशी संबंधित महत्त्वाचे facts कोणते?',
        'प्रत्येक option का बरोबर/चूक आहे?',
        'याचं सध्याचं (current) स्थान काय आहे?'
    ];

    function build() {
        panel = document.createElement('div');
        panel.id = 'qchat-panel';
        panel.className = 'qchat hidden';
        panel.innerHTML =
            '<div class="qchat-head"><div><strong id="qchat-title">🤖 Ask AI</strong>' +
            '<div class="qchat-sub">MPSC / स्पर्धा परीक्षा अभ्यास · chat save होत नाही</div></div>' +
            '<div class="qchat-ctl" id="qchat-ctl"><button class="qchat-x" id="qchat-close" aria-label="Close">✕</button></div></div>' +
            '<div class="qchat-msgs" id="qchat-msgs"></div>' +
            '<label class="qchat-imgtoggle hidden" id="qchat-imgrow"><input type="checkbox" id="qchat-imgchk"> <span>📷 प्रश्नाची image सोबत पाठवा <small>(default: image शिवाय)</small></span></label>' +
            '<div class="qchat-chips" id="qchat-chips"></div>' +
            '<div class="qchat-form"><textarea id="qchat-input" rows="1" maxlength="1000" placeholder="MPSC अभ्यासाबद्दल काहीही विचारा..."></textarea>' +
            '<button id="qchat-send" class="qchat-send">➤</button></div>' +
            '<div class="qchat-note">फक्त MPSC / स्पर्धा परीक्षा अभ्यासाचे प्रश्न. Technical / coding प्रश्नांची उत्तरे मिळणार नाहीत. AI चूक करू शकतो - महत्त्वाचे facts अधिकृत स्रोताशी तपासा.</div>';
        document.body.appendChild(panel);
        msgBox = panel.querySelector('#qchat-msgs');
        input = panel.querySelector('#qchat-input');
        sendBtn = panel.querySelector('#qchat-send');
        titleEl = panel.querySelector('#qchat-title');
        panel.querySelector('#qchat-close').onclick = close;
        if (window.PanelKit) kit = window.PanelKit.enhance(panel, { id: 'askai', handle: panel.querySelector('.qchat-head'), controls: panel.querySelector('#qchat-ctl'), autoClose: false });
        const chk = panel.querySelector('#qchat-imgchk');
        chk.checked = false;
        chk.onchange = () => { withImage = chk.checked; };
        sendBtn.onclick = () => send(input.value);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
        });
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 110) + 'px';
        });
        const chips = panel.querySelector('#qchat-chips');
        SUGGESTIONS.forEach(t => {
            const b = document.createElement('button');
            b.className = 'qchat-chip'; b.textContent = t;
            b.onclick = () => send(t);
            chips.appendChild(b);
        });
    }

    function addMsg(role, text, cls) {
        const d = document.createElement('div');
        d.className = 'qchat-msg ' + (role === 'user' ? 'qchat-user' : 'qchat-ai') + (cls ? ' ' + cls : '');
        d.textContent = text;            // textContent: AI/user text is never interpreted as HTML
        msgBox.appendChild(d);
        msgBox.scrollTop = msgBox.scrollHeight;
        return d;
    }

    function reset(qid, label, qHasImage) {
        currentQid = qid; history = []; busy = false;
        hasImage = !!qHasImage; withImage = false;                 // every question starts WITHOUT image
        panel.querySelector('#qchat-imgchk').checked = false;
        panel.querySelector('#qchat-imgrow').classList.toggle('hidden', !hasImage);   // toggle only if the question has an image
        msgBox.innerHTML = '';
        titleEl.textContent = '🤖 Ask AI · प्रश्न ' + label;
        panel.querySelector('#qchat-chips').classList.remove('hidden');
        addMsg('model', 'नमस्कार! या प्रश्नाबद्दल किंवा MPSC / स्पर्धा परीक्षेच्या कोणत्याही अभ्यास-विषयावर तुमचा काय doubt आहे? विचारा. (Technical / coding / परीक्षेशी संबंध नसलेले प्रश्न यात चालणार नाहीत.)');
    }

    // the exam on this phone is old (paper was re-imported): load it again from the server
    function reloadExam() {
        try {
            if (window.QCache) window.QCache.clear();
            if (typeof openTest === 'function' && window.activeYearExam !== undefined) {
                close();
                openTest(window.activeYearExam, window.activeSubject || null, null, window.activeYearExams || null);
            }
        } catch (e) { }
    }

    function close() { if (panel) panel.classList.add('hidden'); }

    async function send(text) {
        text = (text || '').trim();
        if (!text || busy || !currentQid) return;
        busy = true; sendBtn.disabled = true;
        input.value = ''; input.style.height = 'auto';
        panel.querySelector('#qchat-chips').classList.add('hidden');
        addMsg('user', text);
        const wait = addMsg('model', '⏳ विचार करत आहे...', 'qchat-wait');
        try {
            const tok = localStorage.getItem('jwtToken');
            const res = await fetch('/api/question-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
                body: JSON.stringify({ questionId: currentQid, message: text, history: history.slice(-8), withImage: !!(hasImage && withImage) })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                wait.classList.remove('qchat-wait');
                wait.textContent = data.reply;
                if (data.via) { const v = document.createElement('div'); v.className = 'qchat-via'; v.textContent = 'via ' + data.via + ' (shown to admins only)'; wait.appendChild(v); }
                history.push({ role: 'user', text }, { role: 'model', text: data.reply });
            } else {
                wait.classList.add('qchat-err');
                wait.textContent = '⚠ ' + (data.message || 'काहीतरी चूक झाली. पुन्हा प्रयत्न करा.');
                if (data.code === 'STALE_QUESTION') reloadExam();
            }
        } catch (e) {
            wait.classList.add('qchat-err');
            wait.textContent = '⚠ Network error. पुन्हा प्रयत्न करा.';
        }
        busy = false; sendBtn.disabled = false;
        msgBox.scrollTop = msgBox.scrollHeight;
        input.focus();
    }

    window.openQuestionChat = function (qid, label, qHasImage) {
        if (!panel) build();
        if (currentQid !== qid || panel.classList.contains('hidden')) {
            // a different question (or reopened) always starts a fresh, empty chat
            if (currentQid !== qid) reset(qid, label, qHasImage);
        }
        panel.classList.remove('hidden');
        if (kit) kit.apply();
        input.focus();
    };
    // touching outside closes the panel ONLY when its "Auto-close" switch is ON (default OFF)
    document.addEventListener('pointerdown', (e) => {
        if (!panel || panel.classList.contains('hidden') || !kit || !kit.autoClose()) return;
        if (kit.isOutside(e.target, 'button[onclick*="openQuestionChat"]')) close();
    }, true);
    // leaving the page / logging out also clears it (it only exists in memory anyway)
    window.closeQuestionChat = close;
})();

// "Ask AI" chat for ONE question. History lives only in this page's memory:
// it is never saved (no DB, no localStorage) and disappears on close / reload.
(function () {
    let panel = null, msgBox = null, input = null, sendBtn = null, titleEl = null;
    let currentQid = null;
    let history = [];      // [{role:'user'|'model', text}]
    let busy = false;

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
            '<div class="qchat-sub">फक्त या प्रश्नाबद्दल · chat save होत नाही</div></div>' +
            '<button class="qchat-x" id="qchat-close" aria-label="Close">✕</button></div>' +
            '<div class="qchat-msgs" id="qchat-msgs"></div>' +
            '<div class="qchat-chips" id="qchat-chips"></div>' +
            '<div class="qchat-form"><textarea id="qchat-input" rows="1" maxlength="1000" placeholder="या प्रश्नाबद्दल विचारा..."></textarea>' +
            '<button id="qchat-send" class="qchat-send">➤</button></div>' +
            '<div class="qchat-note">AI चूक करू शकतो. महत्त्वाचे facts अधिकृत स्रोताशी तपासा.</div>';
        document.body.appendChild(panel);
        msgBox = panel.querySelector('#qchat-msgs');
        input = panel.querySelector('#qchat-input');
        sendBtn = panel.querySelector('#qchat-send');
        titleEl = panel.querySelector('#qchat-title');
        panel.querySelector('#qchat-close').onclick = close;
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

    function reset(qid, label) {
        currentQid = qid; history = []; busy = false;
        msgBox.innerHTML = '';
        titleEl.textContent = '🤖 Ask AI · प्रश्न ' + label;
        panel.querySelector('#qchat-chips').classList.remove('hidden');
        addMsg('model', 'नमस्कार! या प्रश्नाबद्दल तुमचा काय doubt आहे? Options, related facts किंवा current स्थिती — काहीही विचारा. (फक्त याच प्रश्नाबद्दल उत्तर मिळेल.)');
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
                body: JSON.stringify({ questionId: currentQid, message: text, history: history.slice(-8) })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                wait.classList.remove('qchat-wait');
                wait.textContent = data.reply;
                history.push({ role: 'user', text }, { role: 'model', text: data.reply });
            } else {
                wait.classList.add('qchat-err');
                wait.textContent = '⚠ ' + (data.message || 'काहीतरी चूक झाली. पुन्हा प्रयत्न करा.');
            }
        } catch (e) {
            wait.classList.add('qchat-err');
            wait.textContent = '⚠ Network error. पुन्हा प्रयत्न करा.';
        }
        busy = false; sendBtn.disabled = false;
        msgBox.scrollTop = msgBox.scrollHeight;
        input.focus();
    }

    window.openQuestionChat = function (qid, label) {
        if (!panel) build();
        if (currentQid !== qid || panel.classList.contains('hidden')) {
            // a different question (or reopened) always starts a fresh, empty chat
            if (currentQid !== qid) reset(qid, label);
        }
        panel.classList.remove('hidden');
        input.focus();
    };
    // leaving the page / logging out also clears it (it only exists in memory anyway)
    window.closeQuestionChat = close;
})();

/* public/examsettings.js
 * Exam options for the student (each can be switched on / off, saved in this browser):
 *   - Negative marking: correct = +1, wrong = -0.25, cancelled / not attempted = 0
 *   - Timer: countdown for the open paper (minutes can be changed); pauses by itself when the paper is left;
 *            its remaining time is kept per paper, so a reload does not restart it.
 * The answers / saved progress are NOT touched by this file: it only calculates the score from userAnswers.
 */
(function () {
    'use strict';
    const PREF_KEY = 'mpsc_exam_prefs', TIMER_KEY = 'mpsc_exam_timers';
    const NEG = 0.25, AUTO_MIN_PER_Q = 1.2;           // default time = 1.2 minutes per question (editable)

    const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? v : d; } catch (e) { return d; } };
    const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } };
    let prefs = Object.assign({ neg: true, timer: false, mins: 0 }, load(PREF_KEY, {}));
    let timers = load(TIMER_KEY, {});
    let curKey = null, justResult = false;

    const fmtMarks = (x) => String(Number((Math.round(x * 100) / 100).toFixed(2)));
    const list = () => (typeof getFilteredQuestions === 'function') ? getFilteredQuestions() : [];

    // ---------- score ----------
    function marks(c, w) { return c - (prefs.neg ? NEG * w : 0); }
    function summary(questions) {
        let c = 0, w = 0, att = 0;
        (questions || list()).forEach(q => {
            const a = (typeof userAnswers !== 'undefined') ? userAnswers[q._id] : null;
            if (!a) return;
            att++;
            if (a.isCancelled) return;
            if (a.isCorrect) c++; else w++;
        });
        const n = (questions || list()).length;
        return { n, att, c, w, unatt: n - att, marks: marks(c, w) };
    }
    window.examMarks = (c, w) => fmtMarks(marks(c, w));
    window.examSummary = summary;
    window.examMarksText = (q) => fmtMarks(summary(q).marks);
    // small text for Paper Mode's score line
    window.examPaperInfo = function (c, w) {
        let h = ` <span style="color:#fbbf24">· ${fmtMarks(marks(c, w))}${prefs.neg ? ' (−' + NEG + ')' : ''}</span>`;
        if (prefs.timer) h += ` <span class="exam-timer-txt" style="color:#93c5fd">${timerText()}</span>`;
        return h;
    };

    // ---------- timer ----------
    const keyNow = () => (window.activeYearExam || (window.activeStarred ? 'starred' : '') || window.activeScopeLabel || 'paper') + '|' + (window.activeSubject || '');
    function autoSecs() { return Math.max(60, Math.round(Math.max(1, list().length) * AUTO_MIN_PER_Q * 60)); }
    function stateFor(key) {
        let s = timers[key], fresh = false;
        if (!s) { const total = (prefs.mins > 0 ? prefs.mins * 60 : autoSecs()); s = timers[key] = { total, left: total, endAt: null, done: false }; fresh = true; save(TIMER_KEY, timers); }
        return { s, fresh };
    }
    function leftSecs(s) { return s.endAt ? Math.max(0, Math.round((s.endAt - Date.now()) / 1000)) : s.left; }
    function timerText() {
        if (!curKey || !timers[curKey]) return '--:--';
        const t = leftSecs(timers[curKey]), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), sec = t % 60, p = (x) => String(x).padStart(2, '0');
        return (h ? h + ':' : '') + p(m) + ':' + p(sec);
    }
    function startT() { const s = timers[curKey]; if (!s || s.done) return; s.endAt = Date.now() + s.left * 1000; save(TIMER_KEY, timers); }
    function pauseT() { const s = timers[curKey]; if (!s || !s.endAt) return; s.left = leftSecs(s); s.endAt = null; save(TIMER_KEY, timers); }
    function resetT() {
        const s = timers[curKey]; if (!s) return;
        s.total = prefs.mins > 0 ? prefs.mins * 60 : autoSecs(); s.left = s.total; s.endAt = null; s.done = false; save(TIMER_KEY, timers);
    }
    const testActive = () => { const t = document.getElementById('test-section'); return !!(t && t.classList.contains('active')) || !!document.querySelector('.pm.open'); };

    // ---------- result window ----------
    function showResult(timeUp) {
        const sm = summary(), acc = sm.att ? Math.round(sm.c * 100 / sm.att) : 0;
        let o = document.getElementById('exam-result');
        if (o) o.remove();
        o = document.createElement('div');
        o.id = 'exam-result';
        o.innerHTML = `<div class="er-box"><h3>${timeUp ? '⏰ वेळ संपली (Time up)' : '🏁 Result'}</h3>
            <div class="er-score">${fmtMarks(sm.marks)} <small>/ ${sm.n}</small></div>
            <table>
              <tr><td>Attempted</td><td><b>${sm.att}</b> / ${sm.n}</td></tr>
              <tr><td style="color:#10b981">Correct (+1)</td><td><b>${sm.c}</b></td></tr>
              <tr><td style="color:#ef4444">Wrong${prefs.neg ? ' (−' + NEG + ' each = −' + fmtMarks(NEG * sm.w) + ')' : ''}</td><td><b>${sm.w}</b></td></tr>
              <tr><td>Not attempted</td><td><b>${sm.unatt}</b></td></tr>
              <tr><td>Accuracy</td><td><b>${acc}%</b></td></tr>
            </table>
            <button class="btn btn-primary" id="er-close">OK</button></div>`;
        document.body.appendChild(o);
        o.addEventListener('click', (e) => { if (e.target.id === 'exam-result' || e.target.id === 'er-close') o.remove(); });
    }

    // ---------- UI ----------
    function css() {
        if (document.getElementById('exam-css')) return;
        const st = document.createElement('style'); st.id = 'exam-css';
        st.textContent = `
.exam-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:8px 12px;margin:8px 0;font-size:.85rem;background:var(--card-bg);border:1px solid var(--card-border);border-radius:12px;color:var(--text-primary)}
.exam-bar label{display:flex;align-items:center;gap:5px;cursor:pointer;user-select:none}
.exam-bar input[type=number]{width:60px;padding:3px 5px;border-radius:6px;border:1px solid var(--card-border);background:transparent;color:inherit}
.exam-bar button{padding:4px 10px;border-radius:8px;border:1px solid var(--card-border);background:transparent;color:inherit;cursor:pointer}
.exam-bar .eb-timer{font-weight:700;font-variant-numeric:tabular-nums;font-size:1rem;min-width:62px;text-align:center}
.exam-bar .eb-timer.low{color:#ef4444;animation:ebBlink 1s infinite}
@keyframes ebBlink{50%{opacity:.45}}
#exam-result{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:30000;display:flex;align-items:center;justify-content:center;padding:16px}
#exam-result .er-box{background:var(--card-bg,#fff);color:var(--text-primary,#111);border-radius:16px;padding:22px;max-width:360px;width:100%;text-align:center}
#exam-result .er-score{font-size:2.2rem;font-weight:800;margin:6px 0 12px}
#exam-result table{width:100%;margin-bottom:14px;text-align:left;border-collapse:collapse}
#exam-result td{padding:5px 2px;border-bottom:1px solid rgba(128,128,128,.25)}`;
        document.head.appendChild(st);
    }
    function buildBar() {
        if (document.getElementById('exam-bar')) return;
        const sec = document.getElementById('test-section'); if (!sec) return;
        const bar = document.createElement('div'); bar.id = 'exam-bar'; bar.className = 'exam-bar';
        bar.innerHTML = `
            <label title="Correct +1, wrong −${NEG}, not attempted 0"><input type="checkbox" id="eb-neg"> Negative marking (−${NEG})</label>
            <label><input type="checkbox" id="eb-timer"> ⏱ Timer</label>
            <span id="eb-tctl" style="display:none;align-items:center;gap:6px">
                <input type="number" id="eb-mins" min="1" max="600" title="Minutes"> min
                <button id="eb-play" title="Start / pause">▶</button><button id="eb-reset" title="Restart timer">↺</button>
                <span class="eb-timer exam-timer-txt" id="eb-time">--:--</span>
            </span>
            <span style="margin-left:auto">Score: <b id="eb-score">0</b></span>
            <button id="eb-result">🏁 Result</button>`;
        const hdr = sec.querySelector('.test-header');
        if (hdr && hdr.nextSibling) sec.insertBefore(bar, hdr.nextSibling); else sec.prepend(bar);

        const $ = (id) => document.getElementById(id);
        $('eb-neg').checked = !!prefs.neg; $('eb-timer').checked = !!prefs.timer;
        $('eb-neg').onchange = (e) => { prefs.neg = e.target.checked; save(PREF_KEY, prefs); refreshAll(); };
        $('eb-timer').onchange = (e) => {
            prefs.timer = e.target.checked; save(PREF_KEY, prefs);
            if (prefs.timer) { curKey = keyNow(); stateFor(curKey); startT(); } else pauseT();
            refreshAll();
        };
        $('eb-mins').onchange = (e) => {
            const m = Math.max(1, Math.min(600, parseInt(e.target.value, 10) || 0)); if (!m) return;
            prefs.mins = m; save(PREF_KEY, prefs);
            const s = timers[curKey]; if (s) { const run = !!s.endAt; s.total = m * 60; s.left = m * 60; s.endAt = null; s.done = false; if (run) startT(); save(TIMER_KEY, timers); }
            refreshAll();
        };
        $('eb-play').onclick = () => { const s = timers[curKey]; if (!s) return; if (s.done) { resetT(); } s.endAt ? pauseT() : startT(); refreshAll(); };
        $('eb-reset').onclick = () => { resetT(); startT(); refreshAll(); };
        $('eb-result').onclick = () => showResult(false);
    }
    function refreshAll() {
        // score numbers (floating stats, quiz bar) + Paper Mode line
        try { if (typeof updateFloatingStats === 'function') updateFloatingStats(list()); } catch (e) { }
        try { if (window.paperRefresh) window.paperRefresh(); } catch (e) { }
        paint();
    }
    function paint() {
        const $ = (id) => document.getElementById(id); if (!$('exam-bar')) return;
        $('eb-tctl').style.display = prefs.timer ? 'inline-flex' : 'none';
        const s = timers[curKey];
        if (prefs.timer && s) {
            const t = leftSecs(s);
            document.querySelectorAll('.exam-timer-txt').forEach(el => { el.textContent = timerText(); });
            $('eb-time').classList.toggle('low', t > 0 && t <= 60 && !!s.endAt);
            $('eb-play').textContent = s.endAt ? '⏸' : '▶';
            const mi = $('eb-mins'); if (document.activeElement !== mi) mi.value = Math.round(s.total / 60);
        }
        $('eb-score').textContent = fmtMarks(summary().marks);
    }

    // ---------- clock ----------
    function tick() {
        const bar = document.getElementById('exam-bar');
        if (bar) bar.style.display = (document.getElementById('test-section') || {}).classList && document.getElementById('test-section').classList.contains('active') ? 'flex' : 'none';
        if (!prefs.timer) { paint(); return; }
        const active = testActive();
        if (active) {
            const k = keyNow();
            if (k !== curKey) {                                   // another paper was opened
                if (curKey) pauseT();
                curKey = k;
                const r = stateFor(k);
                if (r.fresh) startT();                            // a new paper: the clock starts at once
            }
        } else if (curKey && timers[curKey] && timers[curKey].endAt) { pauseT(); }   // left the paper -> pause
        const s = curKey && timers[curKey];
        if (s && s.endAt && leftSecs(s) <= 0) {
            s.left = 0; s.endAt = null; s.done = true; save(TIMER_KEY, timers);
            paint(); showResult(true);
        }
        paint();
    }

    function init() {
        css(); buildBar();
        setInterval(tick, 500);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

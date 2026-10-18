/* =====================================================================
   PanelKit - makes a floating panel (Notes, Ask AI) easier to use:
   - DRAG the panel by its header (mouse or finger)
   - RESIZE: drag the bottom-left / bottom-right corner, or tap the S / M / L button (small / medium / large)
   - AUTO-CLOSE switch: ON  = touching anywhere outside the panel closes it
                        OFF = the panel stays open until you press ✕   (default: OFF)
   Position, size and the switch are remembered in this browser (localStorage, one entry per panel).
   Usage: const kit = PanelKit.enhance(panelEl, { id, handle, controls, autoClose:false });
          kit.apply()          -> call every time the panel is shown (restores position / size)
          kit.autoClose()      -> current value of the switch
   ===================================================================== */
(function () {
    'use strict';

    const MIN_W = 240, MIN_H = 200;
    const SIZES = ['S', 'M', 'L'];

    function readState(id) {
        try { return JSON.parse(localStorage.getItem('panelkit:' + id) || '{}') || {}; } catch (e) { return {}; }
    }
    function writeState(id, st) {
        try { localStorage.setItem('panelkit:' + id, JSON.stringify(st)); } catch (e) { }
    }

    function enhance(panel, opts) {
        opts = opts || {};
        const id = opts.id || panel.id || 'panel';
        const handle = opts.handle;
        const controls = opts.controls || handle;
        let st = readState(id);
        if (typeof st.autoClose !== 'boolean') st.autoClose = !!opts.autoClose;   // default OFF

        const vw = () => document.documentElement.clientWidth || window.innerWidth;
        const vh = () => window.innerHeight;

        // place the panel with explicit pixels (this switches it from "docked" CSS to free positioning)
        function place(l, t, w, h) {
            w = Math.max(Math.min(MIN_W, vw()), Math.min(w, vw()));
            h = Math.max(Math.min(MIN_H, vh()), Math.min(h, vh()));
            l = Math.min(Math.max(0, l), vw() - w);
            t = Math.min(Math.max(0, t), vh() - h);
            const s = panel.style;
            s.left = l + 'px'; s.top = t + 'px'; s.width = w + 'px'; s.height = h + 'px';
            s.right = 'auto'; s.bottom = 'auto'; s.maxWidth = 'none'; s.maxHeight = 'none';
            st.l = l; st.t = t; st.w = w; st.h = h;
        }
        const save = () => writeState(id, st);

        function freeRect() {
            const r = panel.getBoundingClientRect();
            return { l: r.left, t: r.top, w: r.width, h: r.height };
        }

        // ---- size buttons
        let sizeBtn = null, acBtn = null;
        function refreshButtons() {
            if (sizeBtn) {
                sizeBtn.textContent = st.size ? st.size : '↔';
                sizeBtn.title = 'Panel size: ' + (st.size === 'S' ? 'small' : st.size === 'M' ? 'medium' : st.size === 'L' ? 'large' : 'custom') + ' (tap to change)';
            }
            if (acBtn) {
                acBtn.textContent = 'Auto-close: ' + (st.autoClose ? 'ON' : 'OFF');
                acBtn.classList.toggle('pk-on', st.autoClose);
                acBtn.title = st.autoClose ? 'Touching outside closes this panel (tap to turn off)' : 'Panel stays open until you press ✕ (tap to turn on auto-close)';
            }
        }
        function applyPreset(size) {
            const r = freeRect();
            const W = vw(), H = vh();
            let w, h;
            if (size === 'S') { w = Math.min(300, W - 8); h = Math.min(340, H - 8); }
            else if (size === 'M') { w = Math.min(400, W - 8); h = Math.min(Math.round(H * 0.72), 560); }
            else { w = Math.min(760, W - 8); h = Math.round(H * 0.92); }
            // keep the panel's right / bottom edge where it was so it grows towards the free space
            place(r.l + r.w - w, r.t + r.h - h, w, h);
            st.size = size;
            save(); refreshButtons();
        }

        if (controls) {
            sizeBtn = document.createElement('button');
            sizeBtn.type = 'button'; sizeBtn.className = 'pk-btn';
            sizeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const next = SIZES[(SIZES.indexOf(st.size) + 1) % SIZES.length];   // custom -> S, S -> M, M -> L, L -> S
                applyPreset(next);
            });
            acBtn = document.createElement('button');
            acBtn.type = 'button'; acBtn.className = 'pk-btn pk-ac';
            acBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                st.autoClose = !st.autoClose;
                save(); refreshButtons();
            });
            controls.insertBefore(sizeBtn, controls.firstChild);
            controls.insertBefore(acBtn, controls.firstChild);
        }
        refreshButtons();

        // ---- drag by the header
        if (handle) {
            handle.style.touchAction = 'none';
            handle.classList.add('pk-handle');
            let drag = null;
            handle.addEventListener('pointerdown', (e) => {
                if (e.button !== undefined && e.button !== 0) return;
                if (e.target.closest && e.target.closest('button, input, textarea, select, a, label')) return;
                const r = freeRect();
                drag = { x: e.clientX, y: e.clientY, l: r.l, t: r.t, w: r.w, h: r.h };
                try { handle.setPointerCapture(e.pointerId); } catch (err) { }
                e.preventDefault();
            });
            handle.addEventListener('pointermove', (e) => {
                if (!drag) return;
                place(drag.l + e.clientX - drag.x, drag.t + e.clientY - drag.y, drag.w, drag.h);
            });
            const endDrag = (e) => {
                if (!drag) return;
                drag = null;
                try { handle.releasePointerCapture(e.pointerId); } catch (err) { }
                save();
            };
            handle.addEventListener('pointerup', endDrag);
            handle.addEventListener('pointercancel', endDrag);
        }

        // ---- resize by the bottom corners
        ['l', 'r'].forEach((side) => {
            const g = document.createElement('div');
            g.className = 'pk-grip pk-grip-' + side;
            g.title = 'Drag to resize';
            g.style.touchAction = 'none';
            panel.appendChild(g);
            let rs = null;
            g.addEventListener('pointerdown', (e) => {
                const r = freeRect();
                rs = { x: e.clientX, y: e.clientY, l: r.l, t: r.t, w: r.w, h: r.h };
                place(r.l, r.t, r.w, r.h);        // switch to free positioning without a visual jump
                try { g.setPointerCapture(e.pointerId); } catch (err) { }
                e.preventDefault(); e.stopPropagation();
            });
            g.addEventListener('pointermove', (e) => {
                if (!rs) return;
                const dx = e.clientX - rs.x, dy = e.clientY - rs.y;
                const h = Math.min(Math.max(MIN_H, rs.h + dy), vh() - rs.t);
                if (side === 'r') {
                    const w = Math.min(Math.max(MIN_W, rs.w + dx), vw() - rs.l);
                    place(rs.l, rs.t, w, h);
                } else {
                    let l = Math.min(Math.max(0, rs.l + dx), rs.l + rs.w - MIN_W);
                    place(l, rs.t, rs.l + rs.w - l, h);
                }
                st.size = null; refreshButtons();
            });
            const endRs = (e) => {
                if (!rs) return;
                rs = null;
                try { g.releasePointerCapture(e.pointerId); } catch (err) { }
                save();
            };
            g.addEventListener('pointerup', endRs);
            g.addEventListener('pointercancel', endRs);
        });

        // keep the panel inside the screen when the window / phone is rotated
        window.addEventListener('resize', () => {
            if (panel.style.left && panel.offsetParent !== null) place(st.l || 0, st.t || 0, st.w || MIN_W, st.h || MIN_H);
        });

        return {
            // call whenever the panel is shown: restores the remembered position and size
            apply() {
                st = Object.assign(readState(id), { autoClose: st.autoClose });
                if (typeof st.l === 'number' && typeof st.w === 'number') place(st.l, st.t, st.w, st.h);
                refreshButtons();
            },
            autoClose() { return !!st.autoClose; },
            // true when this touch / click target is outside the panel (and not in the "ignore" selector)
            isOutside(target, ignoreSelector) {
                if (!target || !target.closest) return true;
                if (panel.contains(target)) return false;
                if (ignoreSelector && target.closest(ignoreSelector)) return false;
                return true;
            }
        };
    }

    window.PanelKit = { enhance };
})();

// Validation helpers for the Notes API (kept separate so they can be tested without a database).
const MAX_NOTES = 500;
const MAX_LEN = 4000;
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);

function cleanText(t) {
    return String(t == null ? '' : t).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_LEN);
}

// returns a safe note object or null when the input is not acceptable
function cleanNote(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (!isValidId(raw.id)) return null;
    const text = cleanText(raw.text);
    if (!text) return null;
    const ts = Number.isFinite(Number(raw.ts)) ? Math.min(Math.max(0, Number(raw.ts)), Date.now() + 86400000) : Date.now();
    return { id: raw.id, text, src: String(raw.src || '').replace(/[<>]/g, '').slice(0, 40), ts };
}

// new order of `notes` following `ids`; notes not mentioned keep their relative order at the end (nothing is ever lost)
function reorderNotes(notes, ids) {
    const byId = new Map(notes.map(n => [n.id, n]));
    const out = [];
    for (const id of Array.isArray(ids) ? ids : []) {
        if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); }
    }
    for (const n of notes) if (byId.has(n.id)) out.push(n);
    return out;
}

module.exports = { MAX_NOTES, MAX_LEN, isValidId, cleanText, cleanNote, reorderNotes };

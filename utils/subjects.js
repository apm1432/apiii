/**
 * utils/subjects.js - ONE name for ONE subject.
 *
 * Question.subject is free text written by an importer / the AI, so the same subject exists in many spellings
 * ("Economics", "economics ", "Economics (अर्थशास्त्र)", "अर्थशास्त्र" ...). Every spelling used to become a NEW subject.
 * Nothing is rewritten in the database: names are mapped while reading, by three rules:
 *
 *   1. SAME NAME   - case, extra spaces, punctuation and zero-width characters do not matter ("Polity" = "polity " = "Polity.").
 *   2. SAME MEANING learned from the data itself - "Economics (अर्थशास्त्र)" says that Economics = अर्थशास्त्र, so the plain
 *                    "Economics" and the plain "अर्थशास्त्र" are joined to it. (Only an English + Marathi pair inside brackets counts.)
 *   3. ADMIN MERGE - anything the rules cannot know ("Indian Polity" = "Polity") is merged by the admin (SubjectAlias).
 *
 * The name shown for a merged subject is the admin's chosen name, otherwise the spelling with the most questions.
 * buildResolver() is pure (no database) so it can be unit-tested.
 */
const crypto = require('crypto');

const DEVA = /[ऀ-ॿ]/;
const ZW = /[​-‍﻿]/g;
const EMPTY = new Set(['', 'null', 'undefined']);
const UNCLASSIFIED = 'Unclassified';

const tidy = (s) => String(s == null ? '' : s).replace(ZW, '').replace(/\s+/g, ' ').trim();
const cleanName = (s) => { const t = tidy(s); return EMPTY.has(t.toLowerCase()) ? UNCLASSIFIED : t; };

// the comparison key of a name: lower case, no punctuation, single spaces ("&" = "and")
function subjKey(s) {
    const t = tidy(s).normalize('NFC').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
    return EMPTY.has(t) ? 'unclassified' : t;
}

// "Economics (अर्थशास्त्र)" -> { main:'Economics', alt:'अर्थशास्त्र' }   only when ONE side is Marathi and the other is not
function splitBilingual(raw) {
    const m = tidy(raw).match(/^(.+?)\s*[(\[]\s*([^()\[\]]+?)\s*[)\]]$/);
    if (!m) return null;
    const main = m[1].trim(), alt = m[2].trim();
    if (!main || !alt || DEVA.test(main) === DEVA.test(alt)) return null;
    return { main, alt };
}

function buildResolver(rawCounts, aliases) {
    const parent = new Map();
    const add = (k) => { if (!parent.has(k)) parent.set(k, k); return k; };
    const find = (k) => {
        let r = k; while (parent.get(r) !== r) r = parent.get(r);
        let c = k; while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; }
        return r;
    };
    const union = (a, b) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };

    const raws = [];                                   // every spelling that exists on questions
    const seen = new Map();
    Object.keys(rawCounts || {}).forEach(r0 => {
        const raw = tidy(r0), n = Number(rawCounts[r0]) || 0;
        const k = subjKey(raw);
        const id = raw + '\u0000';
        if (seen.has(id)) { seen.get(id).n += n; return; }
        const row = { raw: raw || '', key: k, n, originals: [r0] };
        seen.set(id, row); raws.push(row); add(k);
    });
    // rule 2: English + Marathi pair in brackets
    raws.forEach(r => { const sp = splitBilingual(r.raw); if (sp) { union(r.key, subjKey(sp.main)); union(r.key, subjKey(sp.alt)); } });
    // rule 3: admin merges
    const adminKeys = new Set();
    (aliases || []).forEach(a => { const fk = subjKey(a.from), tk = subjKey(a.to); if (!fk || !tk) return; union(fk, tk); adminKeys.add(fk); });

    // the name of every group
    const groups = new Map();                          // root -> raws
    raws.forEach(r => { const root = find(r.key); (groups.get(root) || groups.set(root, []).get(root)).push(r); });
    const adminName = new Map();                       // root -> { to, at }
    (aliases || []).forEach(a => {
        const root = find(subjKey(a.from)), at = a.createdAt ? +new Date(a.createdAt) : 0, to = tidy(a.to);
        const cur = adminName.get(root);
        if (to && (!cur || at >= cur.at)) adminName.set(root, { to, at });
    });
    const best = (list) => list.slice().sort((x, y) => (y.n - x.n) || ((splitBilingual(y.raw) ? 1 : 0) - (splitBilingual(x.raw) ? 1 : 0)) || x.raw.localeCompare(y.raw))[0].raw;
    const nameOf = new Map();
    new Set([...parent.keys()].map(find)).forEach(root => {
        const list = groups.get(root);
        const nm = adminName.has(root) ? adminName.get(root).to : (list && list.length ? cleanName(best(list)) : '');
        if (nm) nameOf.set(root, nm);
    });

    function canon(raw) {
        const k = subjKey(raw);
        let root = parent.has(k) ? find(k) : null;
        if (root === null) {                           // a spelling that appeared after the table was built: try its two halves
            const sp = splitBilingual(raw);
            if (sp) for (const part of [subjKey(sp.main), subjKey(sp.alt)]) if (parent.has(part)) { root = find(part); break; }
        }
        return (root !== null && nameOf.has(root)) ? nameOf.get(root) : cleanName(raw);
    }

    const byName = new Map();                          // shown name -> [stored spellings]  (two groups given the same name are one subject)
    groups.forEach((list, root) => {
        const nm = nameOf.get(root); if (!nm) return;
        const arr = byName.get(nm) || byName.set(nm, []).get(nm);
        list.forEach(r => r.originals.forEach(o => arr.push({ raw: o, n: r.n, key: r.key })));
    });
    const rawsOf = (name) => (byName.get(name) || []).map(x => x.raw);

    // for the admin screen
    const list = () => [...byName.entries()].map(([name, vs]) => {
        const distinct = new Set(vs.map(v => v.key));
        return {
            name, total: vs.reduce((s, v) => s + v.n, 0),
            variants: vs.slice().sort((a, b) => b.n - a.n).map(v => ({ raw: v.raw === '' ? '(empty)' : v.raw, stored: v.raw, n: v.n, via: adminKeys.has(v.key) ? 'admin' : (distinct.size > 1 ? 'auto' : 'own') }))
        };
    }).sort((a, b) => b.total - a.total);

    const version = crypto.createHash('sha1').update(JSON.stringify([...byName.keys()].sort().map(n => [n, rawsOf(n).sort()]))).digest('hex').slice(0, 12);
    return { canon, rawsOf, list, version };
}

// ---- merge hints for the admin (hints only - the admin decides) -------------------------------------------------
const STOP = new Set(['and', 'the', 'of', 'in', 'general', 'indian', 'india', 'maharashtra', 'व', 'आणि', 'सामान्य', 'भारतीय', 'भारताचा', 'महाराष्ट्र', 'महाराष्ट्राचा']);
const tokens = (s) => new Set(subjKey(s).split(' ').filter(t => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)));

function suggest(listed) {
    const toks = listed.map(g => { const t = new Set(); g.variants.forEach(v => tokens(v.stored || v.raw).forEach(x => t.add(x))); return t; });
    const out = [];
    for (let i = 0; i < listed.length; i++) for (let j = i + 1; j < listed.length; j++) {
        const shared = [...toks[i]].filter(x => toks[j].has(x));
        if (shared.length) out.push({ a: listed[i].name, b: listed[j].name, shared, weight: listed[i].total + listed[j].total });
    }
    return out.sort((x, y) => y.weight - x.weight).slice(0, 60).map(({ weight, ...r }) => r);
}

// ---- cached resolver (database) ------------------------------------------------------------------------------
let aliasCache = null, aliasAt = 0, resolverCache = null, resolverAt = 0, building = null;
const ALIAS_TTL = 60 * 1000, RESOLVER_TTL = 10 * 60 * 1000;

async function loadAliases() {
    if (aliasCache && Date.now() - aliasAt < ALIAS_TTL) return aliasCache;
    try { aliasCache = await require('../models/SubjectAlias').find().lean(); }
    catch (e) { console.error('subject aliases unavailable:', e.message); aliasCache = aliasCache || []; }
    aliasAt = Date.now();
    return aliasCache;
}

// from counts the caller already has (examMeta) - one database query less
async function resolverFrom(rawCounts) { return buildResolver(rawCounts, await loadAliases()); }

async function getResolver(force) {
    if (!force && resolverCache && Date.now() - resolverAt < RESOLVER_TTL) return resolverCache;
    if (building) return building;
    building = (async () => {
        const rows = await require('../models/Question').aggregate([{ $group: { _id: '$subject', n: { $sum: 1 } } }]);
        const counts = {};
        rows.forEach(r => { const k = r._id == null ? '' : String(r._id); counts[k] = (counts[k] || 0) + r.n; });
        resolverCache = await resolverFrom(counts); resolverAt = Date.now();
        return resolverCache;
    })().finally(() => { building = null; });
    return building;
}

function invalidate() { aliasCache = null; aliasAt = 0; resolverCache = null; resolverAt = 0; }

module.exports = { subjKey, splitBilingual, cleanName, buildResolver, suggest, getResolver, resolverFrom, loadAliases, invalidate, UNCLASSIFIED };

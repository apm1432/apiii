// Gmail-only validation + normalisation (anti-duplicate / anti-spam).
// a.b+test@gmail.com  ->  ab@gmail.com  (used ONLY for uniqueness checks,
// the email the user typed (lower-cased) is what we store as `email`).

function parseGmail(input) {
    const email = String(input || '').trim().toLowerCase();
    if (email.length > 254) return { ok: false, message: 'Invalid email' };

    const m = email.match(/^([a-z0-9._+-]+)@gmail\.com$/);
    if (!m) return { ok: false, message: 'फक्त @gmail.com email चालतो (Only Gmail addresses are accepted)' };

    let local = m[1].split('+')[0].replace(/\./g, '');
    if (local.length < 6 || local.length > 30) {
        return { ok: false, message: 'Invalid Gmail address' };
    }
    return { ok: true, email, normalized: `${local}@gmail.com` };
}

// Returns the normalised form for any gmail address, or null for others (used at login).
function normalizeGmail(input) {
    const r = parseGmail(input);
    return r.ok ? r.normalized : null;
}

module.exports = { parseGmail, normalizeGmail };

// Live "your account changed" push (Server-Sent Events). One node process => a simple in-memory map is enough.
// notifyUser(userId) is called whenever an admin changes a user's subscription / admin rights;
// the browser then asks /api/auth/me for the fresh data and shows a message - no logout needed.
const clients = new Map(); // userId -> Set(res)

function addClient(userId, res) {
    const k = String(userId);
    if (!clients.has(k)) clients.set(k, new Set());
    clients.get(k).add(res);
    res.on('close', () => {
        const set = clients.get(k);
        if (set) { set.delete(res); if (!set.size) clients.delete(k); }
    });
}

function notifyUser(userId) {
    const set = clients.get(String(userId));
    if (!set) return;
    for (const res of set) {
        try { res.write(`event: account\ndata: ${Date.now()}\n\n`); } catch (e) { /* closed */ }
    }
}

// keep proxies from closing idle connections
setInterval(() => {
    for (const set of clients.values()) for (const res of set) { try { res.write(': ping\n\n'); } catch (e) {} }
}, 25000).unref();

module.exports = { addClient, notifyUser };

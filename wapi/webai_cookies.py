"""
WebAI-to-API (Gemini web) cookie store -- MULTI ACCOUNT.

Every saved account (a pair __Secure-1PSID / __Secure-1PSIDTS) is one document in the MongoDB collection
`webai_cookies` and gets its OWN WebAI-to-API process (see wapi/webai_supervisor.py).  Requests are spread over
all accounts by wapi/webai_pool.py, so no single Gemini account carries all the load.

* /api/web/v1/ui/auth                  -> page: list accounts, add / replace / enable / disable / remove
* GET    .../ui/auth/cookies           -> status of every account (masked values, health, in-flight requests)
* POST   .../ui/auth/cookies           -> paste cookie JSON:  ?label=Name  (new account)
                                          ?id=<account id>    (replace cookies of that account)
                                          same __Secure-1PSID already saved -> that account is updated
* PATCH  .../ui/auth/cookies?id=X&enabled=0|1&label=Name
* DELETE .../ui/auth/cookies?id=X      (id=all removes every account)

The supervisor polls MongoDB every few seconds, so a change is live ~3-10 s later without restarting anything else.
WebAI-to-API rotates __Secure-1PSIDTS in the background; the supervisor copies the rotated values from each
instance's private cache dir back into MongoDB, so a redeploy always starts from the newest cookies.

CLI:
    python3 webai_cookies.py sync     # copy rotated cookies of all accounts -> DB (used on shutdown)
"""
import os, re, sys, json, glob, time, secrets, datetime, threading, hashlib

COLLECTION = "webai_cookies"
LEGACY_ID = "gemini"                      # the single account of the pre-multi-account version
MAX_ACCOUNTS = max(1, int(os.environ.get("WEBAI_MAX_ACCOUNTS", "4")))
POOL_DIR = os.environ.get("WEBAI_POOL_DIR", "/tmp/webai-pool")
CONFIG_TEMPLATE = os.environ.get("WEBAI_CONFIG", "/opt/webai/config.conf")
SYNC_SECONDS = max(10, int(os.environ.get("WEBAI_COOKIE_SYNC_SECONDS", "30")))

HEAL_MIN_SECONDS = int(os.environ.get("WEBAI_HEAL_MIN_SECONDS", "180"))   # first self-heal wait, doubles each try (max 30 min)
HEAL_MAX_ATTEMPTS = int(os.environ.get("WEBAI_HEAL_MAX_ATTEMPTS", "4"))   # then: "cookies expired, paste again"
STALL_SECONDS = int(os.environ.get("WEBAI_ROTATION_STALL_SECONDS", "900"))  # authenticated but no rotation this long -> warn

PSID_NAME = "__Secure-1PSID"
PSIDTS_NAME = "__Secure-1PSIDTS"

_coll_cache = None
_coll_lock = threading.Lock()
_sync_lock = threading.Lock()


def instance_dir(doc_id):
    return os.path.join(POOL_DIR, doc_id)


def instance_tmp(doc_id):
    return os.path.join(instance_dir(doc_id), "tmp")


# ─── MongoDB ──────────────────────────────────────────────────────────────────
def _coll():
    """One document per account. Same database Node uses (MONGO_URI)."""
    global _coll_cache
    with _coll_lock:
        if _coll_cache is None:
            uri = os.environ.get("MONGO_URI", "")
            if not uri:
                raise RuntimeError("MONGO_URI is not set")
            from pymongo import MongoClient
            client = MongoClient(uri, serverSelectionTimeoutMS=8000, connectTimeoutMS=8000)
            _coll_cache = client.get_database(client.get_default_database(default="test").name)[COLLECTION]
        return _coll_cache


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def list_docs():
    """All saved accounts, oldest first."""
    docs = [d for d in _coll().find({}) if d.get("psid")]
    docs.sort(key=lambda d: (float(d.get("createdAtEpoch") or d.get("pastedAtEpoch") or 0), str(d["_id"])))
    return docs


def get_doc(doc_id):
    return _coll().find_one({"_id": doc_id})


# ─── Parsing pasted cookies ───────────────────────────────────────────────────
def _is_google_domain(domain):
    d = str(domain or "").lower().lstrip(".")
    return d == "" or d == "google.com" or d.endswith(".google.com")


def _domain_rank(domain):
    return {".google.com": 0, "google.com": 1, "gemini.google.com": 2,
            "accounts.google.com": 3}.get(str(domain or "").lower(), 4)


def _parse_header(text):
    out = []
    text = re.sub(r"^\s*cookie\s*:\s*", "", text.strip(), flags=re.I)
    for part in re.split(r";\s*|\n", text):
        if "=" in part:
            k, v = part.split("=", 1)
            if k.strip():
                out.append({"name": k.strip(), "value": v.strip()})
    return out


def _parse_netscape(text):
    out = []
    for line in text.splitlines():
        f = line.rstrip("\n").split("\t")
        if len(f) >= 7 and not line.lstrip().startswith("#"):
            try:
                exp = float(f[4])
            except ValueError:
                exp = 0
            out.append({"name": f[5], "value": f[6], "domain": f[0], "expires": exp})
        elif len(f) >= 7 and line.startswith("#HttpOnly_"):
            g = line[len("#HttpOnly_"):].split("\t")
            if len(g) >= 7:
                out.append({"name": g[5], "value": g[6], "domain": g[0]})
    return out


def _parse_expires(v):
    """DevTools shows ISO text or 'Session'; Cookie-Editor gives a number. -> epoch seconds (0 = session cookie)."""
    v = str(v or "").strip()
    if not v or v.lower() == "session":
        return 0.0
    try:
        return float(v)
    except ValueError:
        pass
    try:
        return datetime.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _looks_netscape(text):
    return any(len(l.split("\t")) >= 7 and l.split("\t")[1].strip().upper() in ("TRUE", "FALSE")
               for l in text.splitlines() if l.strip())


def _parse_devtools(text):
    """Rows copied from Chrome/Edge DevTools -> Application -> Cookies:
    name <TAB> value <TAB> domain <TAB> path <TAB> expires <TAB> size <TAB> HttpOnly <TAB> Secure ..."""
    out = []
    for line in text.splitlines():
        f = line.rstrip("\r\n").split("\t")
        if len(f) >= 4 and f[0].strip() and f[3].strip().startswith("/"):
            out.append({"name": f[0].strip(), "value": f[1].strip(), "domain": f[2].strip(), "path": f[3].strip(),
                        "expires": _parse_expires(f[4]) if len(f) > 4 else 0.0})
    return out


def _flatten(payload):
    """Anything a cookie export can look like -> list of {name, value, domain?, expires?}."""
    if isinstance(payload, str):
        s = payload.strip()
        if not s:
            return []
        try:
            payload = json.loads(s)
        except ValueError:
            if "\t" in s:
                return _parse_netscape(s) if _looks_netscape(s) else (_parse_devtools(s) or _parse_netscape(s))
            return _parse_header(s)
        if isinstance(payload, str):  # JSON-encoded string
            return _parse_header(payload)
    if isinstance(payload, dict):
        if isinstance(payload.get("cookies"), list):          # Playwright storage state
            return _flatten(payload["cookies"])
        if "name" in payload and "value" in payload:          # single cookie object
            return [payload]
        flat = []
        for k, v in payload.items():                          # {"name": "value"} map
            if isinstance(v, str):
                flat.append({"name": k, "value": v})
            elif isinstance(v, dict) and "value" in v:        # {"name": {"value": ...}}
                flat.append({"name": k, **v})
        return flat
    if isinstance(payload, list):
        out = []
        for item in payload:
            if isinstance(item, dict) and "name" in item and "value" in item:
                out.append(item)
        return out
    return []


def _pick(cookies, name, now):
    best = None
    for i, c in enumerate(cookies):
        if c.get("name") != name or not isinstance(c.get("value"), str) or not c["value"].strip():
            continue
        if not _is_google_domain(c.get("domain")):
            continue
        exp = c.get("expirationDate", c.get("expires"))
        if isinstance(exp, (int, float)) and 0 < exp <= now:
            continue                                           # expired
        key = (_domain_rank(c.get("domain")), i)
        if best is None or key < best[0]:
            best = (key, c["value"].strip().strip('"').strip("'"))
    return best[1] if best else None


_VALUE_RE = re.compile(r"^[\x21-\x7e]{20,4096}$")  # printable, no spaces/newlines


def extract_cookies(payload):
    """-> (psid, psidts or None). Raises ValueError with a human message."""
    cookies = _flatten(payload)
    if not cookies:
        raise ValueError("Cookie JSON samajla nahi - Cookie-Editor/EditThisCookie cha full JSON paste kara.")
    now = time.time()
    psid = _pick(cookies, PSID_NAME, now)
    psidts = _pick(cookies, PSIDTS_NAME, now)
    if not psid:
        raise ValueError(f"{PSID_NAME} cookie JSON madhe sapadli nahi (gemini.google.com la login zalyavar export kara).")
    for label, v in ((PSID_NAME, psid), (PSIDTS_NAME, psidts)):
        if v is not None and not _VALUE_RE.match(v):
            raise ValueError(f"{label} chi value invalid distey.")
    return psid, psidts


_SKIP_COOKIE = re.compile(r"^(_ga|_gcl|_gid|_fbp|_gat)", re.I)       # analytics noise, never needed for login


def build_jar(cookies, psid, psidts, now):
    """All Google cookies of the paste (a browser-like jar), in the format gemini-webapi's cookie cache uses.
    The two auth cookies are always present with the values extract_cookies picked."""
    seen = {}
    for c in cookies:
        name, val = c.get("name"), c.get("value")
        if not name or not isinstance(val, str) or not val.strip() or _SKIP_COOKIE.match(name):
            continue
        if not _is_google_domain(c.get("domain")):
            continue
        val = val.strip().strip('"').strip("'")
        if not re.match(r"^[\x21-\x7e]{1,4096}$", val):
            continue
        exp = c.get("expirationDate", c.get("expires"))
        exp = float(exp) if isinstance(exp, (int, float)) else _parse_expires(exp)
        if 0 < exp <= now:
            continue
        domain = str(c.get("domain") or ".google.com").strip() or ".google.com"
        if not domain.startswith(".") and domain.count(".") == 1:        # "google.com" -> ".google.com"
            domain = "." + domain
        path = str(c.get("path") or "/")
        seen[(name, domain, path)] = {"name": name, "value": val, "domain": domain, "path": path,
                                      "expires": exp if exp > 0 else None}
    jar = [v for v in seen.values() if v["name"] not in (PSID_NAME, PSIDTS_NAME)]
    for n, v in ((PSID_NAME, psid), (PSIDTS_NAME, psidts)):
        if v:
            jar.append({"name": n, "value": v, "domain": ".google.com", "path": "/", "expires": None})
    return jar[:80]


def extract_full(payload):
    """-> (psid, psidts or None, jar). Same checks as extract_cookies, plus the whole cookie jar of the paste."""
    psid, psidts = extract_cookies(payload)
    return psid, psidts, build_jar(_flatten(payload), psid, psidts, time.time())


# ─── Save / change / remove accounts ──────────────────────────────────────────
def _clean_label(label):
    label = re.sub(r"\s+", " ", str(label or "")).strip()[:40]
    return label or None


def save_pasted(psid, psidts, label=None, doc_id=None, jar=None):
    """Add a new account or replace the cookies of an existing one.
    -> (doc_id, "added" | "updated").  Raises ValueError when the account limit is reached."""
    c = _coll()
    existing = c.find_one({"_id": doc_id}) if doc_id else None
    if doc_id and not existing:
        raise ValueError("account id sapadla nahi")
    if existing is None:
        existing = c.find_one({"psid": psid})                  # same Google account pasted again -> update it
    if existing is not None:                                   # same Google session in two accounts = they invalidate each other
        clash = c.find_one({"psid": psid, "_id": {"$ne": existing["_id"]}})
        if clash:
            raise ValueError(f"Ha Google session (__Secure-1PSID) '{clash.get('label') or clash['_id']}' account madhe aadhich aahe. "
                             "Don accounts madhe same session vaparlyas te ek-mekanche cookies invalidate kartat. "
                             "Vegla Google account cha cookies paste kara.")
    now = _now()
    if existing is None:
        if c.count_documents({}) >= MAX_ACCOUNTS:
            raise ValueError(f"Max {MAX_ACCOUNTS} accounts (WEBAI_MAX_ACCOUNTS). Ekhada account remove kara kinva limit vadhva.")
        doc_id = "acc-" + secrets.token_hex(4)
        action = "added"
        n = c.count_documents({}) + 1
        label = _clean_label(label) or f"Account {n}"
        enabled, created = True, time.time()
    else:
        doc_id = existing["_id"]
        action = "updated"
        label = _clean_label(label) or existing.get("label") or ("Account 1" if doc_id == LEGACY_ID else doc_id)
        enabled = existing.get("enabled", True)
        created = existing.get("createdAtEpoch") or existing.get("pastedAtEpoch") or time.time()
    c.replace_one({"_id": doc_id}, {
        "_id": doc_id, "label": label, "enabled": bool(enabled), "createdAtEpoch": created,
        "psid": psid, "psidts": psidts,
        "pastedAt": now, "pastedAtEpoch": time.time(),
        "refreshedAt": None, "refreshCount": 0, "cacheMtime": 0.0, "updatedAt": now,
        "lastRotationAt": None, "rotationCount": 0,
        "lastStatus": None, "lastStatusAt": None,
        "healAttempts": 0, "lastHealAt": None, "needsRepaste": False, "okSinceEpoch": None,
        "pastedJar": jar or None, "pastedJarPsid": psid if jar else None, "alerted": False,
    }, upsert=True)
    return doc_id, action


def update_account(doc_id, enabled=None, label=None):
    sets = {"updatedAt": _now()}
    if enabled is not None:
        sets["enabled"] = bool(enabled)
    if label is not None:
        sets["label"] = _clean_label(label) or doc_id
    return _coll().update_one({"_id": doc_id}, {"$set": sets}).matched_count


def delete_doc(doc_id=None):
    """Remove one account (or every account when doc_id is None)."""
    if doc_id is None:
        return _coll().delete_many({}).deleted_count
    return _coll().delete_one({"_id": doc_id}).deleted_count


# ─── WebAI config.conf ────────────────────────────────────────────────────────
def _set_key(text, key, value):
    value = (value or "").replace("%", "%%")                   # ConfigParser interpolation
    pat = re.compile(r"(?m)^" + re.escape(key) + r"[ \t]*=.*$")
    line = f"{key} = {value}"
    if pat.search(text):
        return pat.sub(lambda m: line, text, count=1)
    if re.search(r"(?m)^\[Gemini\][ \t]*$", text):
        return re.sub(r"(?m)^(\[Gemini\][ \t]*)$", lambda m: m.group(1) + "\n" + line, text, count=1)
    return text.rstrip("\n") + f"\n\n[Gemini]\n{line}\n"


def write_config(psid, psidts, path, base=None):
    """Write an instance's config.conf: the template (WebAI's own defaults) + this account's cookies."""
    try:
        with open(base or CONFIG_TEMPLATE, encoding="utf-8") as f:
            s = f.read()
    except FileNotFoundError:
        s = ""
    s = _set_key(s, PSID_NAME, psid)
    s = _set_key(s, PSIDTS_NAME, psidts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(s)
    os.replace(tmp, path)


# ─── Rotated cookies (WebAI cache) -> DB ──────────────────────────────────────
def newest_cache(tmp_root):
    """(psid, psidts, mtime, cookies) of the most recently written rotated-cookie cache under tmp_root, else None.
    `cookies` is the library's whole cached jar (every non-expired google.com cookie), not just the two auth cookies."""
    best = None
    for d in glob.glob(os.path.join(tmp_root, "webai-gemini-*")):
        for p in glob.glob(os.path.join(d, ".cached_cookies_*.json")):
            try:
                m = os.stat(p).st_mtime
                if best is None or m > best[0]:
                    best = (m, p)
            except OSError:
                pass
    if not best:
        return None
    try:
        with open(best[1], encoding="utf-8") as f:
            data = json.load(f)
        cookies = [c for c in data if isinstance(c, dict)] if isinstance(data, list) else []
        now = time.time()
        psid, psidts = _pick(cookies, PSID_NAME, now), _pick(cookies, PSIDTS_NAME, now)
    except (OSError, ValueError):
        return None
    return (psid, psidts, best[0], cookies) if psid else None


def _slim_jar(cookies):
    keep = ("name", "value", "domain", "path", "expires")
    return [{k: c.get(k) for k in keep if k in c} for c in cookies if isinstance(c, dict) and c.get("name")][:60]


def write_seed(doc, seed_dir, mode="auto"):
    """Put a cookie jar where the patched WebAI picks it up at start (WEBAI_COOKIE_SEED_DIR), so the account starts
    like a browser that still has its cookies instead of from just two values.

      "auto"   rotated jar saved after the last paste (continues the live session), else the full pasted jar
      "pasted" the full pasted jar, but with the newest __Secure-1PSIDTS from the DB  (self-heal step 1)
      "none"   nothing: only __Secure-1PSID / __Secure-1PSIDTS are used                (self-heal step 2)
    Returns "rotated" | "pasted" | None."""
    if mode == "none":
        return None
    jar, how, mtime = None, None, None
    rotated_ok = (doc.get("jar") and doc.get("jarPsid") == doc.get("psid")
                  and float(doc.get("cacheMtime") or 0) > float(doc.get("pastedAtEpoch") or 0))
    if mode == "auto" and rotated_ok:
        jar, how, mtime = doc["jar"], "rotated", float(doc["cacheMtime"])       # keep the rotation time -> no fake "rotation"
    elif doc.get("pastedJar") and doc.get("pastedJarPsid") == doc.get("psid"):
        jar, how, mtime = [dict(c) for c in doc["pastedJar"]], "pasted", float(doc.get("pastedAtEpoch") or 0)
        for c in jar:                                           # newest rotated auth-ts instead of the pasted one
            if c.get("name") == PSIDTS_NAME and doc.get("psidts"):
                c["value"] = doc["psidts"]
    if not jar:
        return None
    os.makedirs(seed_dir, exist_ok=True)
    path = os.path.join(seed_dir, f".cached_cookies_{doc['psid']}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(jar, f)
    os.chmod(path, 0o600)
    os.utime(path, (mtime, mtime))
    return how


def sync_from_cache(doc_id, tmp_root=None):
    """Copy rotated cookies of ONE account into the DB. Never creates a doc (removed stays removed).

    Every time WebAI wrote its cache (= a rotation happened) we record the time + count, even when
    Google handed back the very same value - so the dashboard can show that auto-refresh is alive.
    The cookie values themselves are only rewritten when they really changed."""
    with _sync_lock:
        doc = get_doc(doc_id)
        if not doc or not doc.get("psid"):
            return False
        found = newest_cache(tmp_root or instance_tmp(doc_id))
        if not found:
            return False
        psid, psidts, mtime, jar = found
        # ignore stale caches from older runs / before the last paste
        if mtime <= float(doc.get("cacheMtime") or 0) or mtime <= float(doc.get("pastedAtEpoch") or 0):
            return False
        flt = {"_id": doc_id, "pastedAtEpoch": doc.get("pastedAtEpoch")}   # lose race vs a new paste
        sets = {"cacheMtime": mtime, "updatedAt": _now(), "jar": _slim_jar(jar), "jarPsid": psid,
                "lastRotationAt": datetime.datetime.fromtimestamp(mtime, datetime.timezone.utc)}
        incs = {"rotationCount": 1}
        changed = not (psid == doc.get("psid") and (psidts or None) == (doc.get("psidts") or None))
        if changed:
            sets.update(psid=psid, psidts=psidts, refreshedAt=_now())
            incs["refreshCount"] = 1
        res = _coll().update_one(flt, {"$set": sets, "$inc": incs})
        return changed and res.modified_count > 0


def sync_all():
    n = 0
    for d in list_docs():
        try:
            if sync_from_cache(d["_id"]):
                n += 1
        except Exception as e:
            print(f"[webai-cookies] sync {d['_id']} failed: {e}", file=sys.stderr, flush=True)
    return n


def webai_status(port):
    """(status, source) from one WebAI instance, or None when it is down / restarting."""
    try:
        import requests
        j = requests.get(f"http://127.0.0.1:{port}/v1/auth/status", timeout=4).json()
        g = j.get("gemini_webapi") or {}
        return g.get("status"), g.get("auth_source")
    except Exception:
        return None


def _aware(d):
    if not isinstance(d, datetime.datetime):
        return None
    return d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)


# ─── Flask routes ─────────────────────────────────────────────────────────────
def _mask(v):
    return None if not v else (v[:6] + "…" + v[-4:] if len(v) > 14 else "…")


def _iso(d):
    if not isinstance(d, datetime.datetime):
        return None
    return (d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)).isoformat()


def _pool_file_state():
    try:
        with open(os.path.join(POOL_DIR, "pool.json"), encoding="utf-8") as f:
            data = json.load(f)
        return {i["id"]: i for i in data.get("instances", []) if isinstance(i, dict) and "id" in i}, data.get("updated")
    except (OSError, ValueError):
        return {}, None


def register(app, authorized, prefix, webai_url):
    from flask import request, jsonify, Response
    import webai_pool

    base = prefix + "/ui/auth"

    def guard():
        if not authorized():
            if "text/html" in request.headers.get("Accept", ""):
                return Response("Login Required", 401, {
                    "WWW-Authenticate": 'Basic realm="Web API (password field = your API PASSWORD)"'})
            return jsonify({"error": "Unauthorized Access. Invalid Password."}), 401
        return None

    def csrf_ok():  # Basic-auth creds are auto-sent cross-site -> require an XHR-only header
        return request.headers.get("X-Requested-With") == "webai-auth"

    def status_payload():
        out = {"max_accounts": MAX_ACCOUNTS, "accounts": []}
        try:
            docs = list_docs()
        except Exception as e:
            out["db_error"] = str(e)
            return out
        inst, updated = _pool_file_state()
        live = webai_pool.get_pool().snapshot()
        out["supervisor_updated"] = updated
        owner = {}
        for d in docs:
            owner.setdefault(d["psid"], d.get("label") or d["_id"])
        for d in docs:
            i = inst.get(d["_id"], {})
            lv = live.get(d["_id"], {})
            ok_since = d.get("okSinceEpoch")
            stalled = False
            if ok_since:                                       # authenticated, but is the rotation actually running?
                lr = _aware(d.get("lastRotationAt"))
                stalled = (time.time() - max(float(ok_since), lr.timestamp() if lr else 0)) > STALL_SECONDS
            out["accounts"].append({
                "id": d["_id"], "label": d.get("label") or d["_id"], "enabled": d.get("enabled", True),
                "psid": _mask(d["psid"]), "psidts": _mask(d.get("psidts")), "has_psidts": bool(d.get("psidts")),
                "jar_cookies": len(d.get("jar") or d.get("pastedJar") or []),
                "fingerprint": hashlib.sha1(d["psid"].encode()).hexdigest()[:8],
                "same_session_as": owner[d["psid"]] if owner[d["psid"]] != (d.get("label") or d["_id"]) else None,
                "pasted_at": _iso(d.get("pastedAt")), "refreshed_at": _iso(d.get("refreshedAt")),
                "refresh_count": d.get("refreshCount", 0), "last_rotation_at": _iso(d.get("lastRotationAt")),
                "rotation_count": d.get("rotationCount", 0), "last_status": d.get("lastStatus"),
                "last_status_at": _iso(d.get("lastStatusAt")), "heal_attempts": d.get("healAttempts", 0),
                "needs_repaste": bool(d.get("needsRepaste")), "rotation_stalled": stalled,
                "process": i.get("state") or ("stopped" if not d.get("enabled", True) else "pending"),
                "authenticated": i.get("authenticated"), "port": i.get("port"),
                "in_flight": lv.get("in_flight", 0), "served_ok": lv.get("ok", 0), "failed": lv.get("fail", 0),
                "cooldown_left": lv.get("cooldown_left", 0),
            })
        out["guest_running"] = (not docs) and "guest" in inst
        return out

    @app.route(base, methods=["GET"], endpoint="webai_auth_page")
    def page():
        denied = guard()
        if denied:
            return denied
        return Response(PAGE_HTML.replace("__BASE__", base).replace("__UI__", prefix + "/ui"),
                        200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"})

    @app.route(base + "/cookies", methods=["GET", "POST", "PATCH", "DELETE"], endpoint="webai_auth_cookies")
    def cookies():
        denied = guard()
        if denied:
            return denied
        if request.method == "GET":
            return jsonify(status_payload())
        if not csrf_ok():
            return jsonify({"error": "missing X-Requested-With header"}), 403
        acc_id = (request.args.get("id") or "").strip() or None
        try:
            if request.method == "DELETE":
                if not acc_id:
                    return jsonify({"error": "id required (id=all removes every account)"}), 400
                removed = delete_doc(None if acc_id == "all" else acc_id)
                return jsonify({"ok": True, "removed": removed})
            if request.method == "PATCH":
                if not acc_id:
                    return jsonify({"error": "id required"}), 400
                en = request.args.get("enabled")
                matched = update_account(acc_id,
                                         enabled=None if en is None else en.lower() in ("1", "true", "yes", "on"),
                                         label=request.args.get("label"))
                return jsonify({"ok": bool(matched)}), (200 if matched else 404)
            raw = request.get_data(as_text=True)
            if len(raw) > 2_000_000:
                return jsonify({"error": "payload too large"}), 413
            try:
                psid, psidts, jar = extract_full(raw)
                new_id, action = save_pasted(psid, psidts, label=request.args.get("label"), doc_id=acc_id, jar=jar)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            return jsonify({"ok": True, "id": new_id, "action": action, "psid": _mask(psid),
                            "psidts": _mask(psidts), "has_psidts": bool(psidts), "cookies": len(jar)})
        except Exception as e:
            return jsonify({"error": f"DB error: {e}"}), 500

    @app.route(base + "/capture", methods=["GET"], endpoint="webai_capture")
    def capture():
        denied = guard()
        if denied:
            return denied
        d = "/tmp/webai-capture"
        try:
            n = max(1, min(25, int(request.args.get("n", "2"))))
        except ValueError:
            n = 2
        files = sorted(glob.glob(os.path.join(d, "*.json")), key=os.path.getmtime)[-n:]
        out = {os.path.basename(p): json.load(open(p, encoding="utf-8")) for p in files}
        return Response(json.dumps(out, ensure_ascii=False, indent=1), 200,
                        {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"})


PAGE_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gemini Web Accounts</title>
<style>
:root{--bg:#0f1115;--fg:#e8eaed;--mut:#9aa0a6;--card:#181b21;--bd:#2a2f38;--ac:#6ea8fe;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--fg:#1d2127;--mut:#5f6770;--card:#fff;--bd:#dfe3e8;--ac:#1a56db;--ok:#15803d;--bad:#b91c1c;--warn:#b45309}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:20px 16px 48px}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0 0 8px}
.sub{color:var(--mut);margin:0 0 16px}.sub a{color:var(--ac)}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px;margin-bottom:16px}
.row{display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px dashed var(--bd)}.row:last-child{border:0}
.row b{font-weight:500;color:var(--mut)}code{font-family:ui-monospace,monospace;font-size:13px;word-break:break-all}
.hd{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.pill{font-size:12px;border:1px solid var(--bd);border-radius:99px;padding:1px 9px;margin-left:6px}
textarea{width:100%;min-height:170px;background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:8px;padding:10px;font:12px/1.4 ui-monospace,monospace;resize:vertical}
input[type=text]{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:8px;padding:8px 10px;font:inherit;margin-bottom:8px}
button{background:var(--ac);color:#fff;border:0;border-radius:8px;padding:7px 14px;font:inherit;cursor:pointer}
button.s{background:transparent;color:var(--ac);border:1px solid var(--ac)}
button.d{background:transparent;color:var(--bad);border:1px solid var(--bad)}button:disabled{opacity:.5;cursor:wait}
.bar{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}#msg{margin-top:10px;min-height:1.4em}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}small{color:var(--mut)}
</style></head><body><main>
<h1>Gemini Web Accounts</h1>
<p class="sub">Ekapeksha jast Google account add kara: requests sagalya accounts var parallel vatlya jatat (ek account var jast load yet nahi). <a href="__UI__">Dashboard</a></p>
<div id="st"><div class="card"><small>Loading…</small></div></div>
<div class="card">
  <h2 id="ft">Add account</h2>
  <input type="text" id="lb" maxlength="40" placeholder="Name (optional) - e.g. Rahul account">
  <textarea id="j" spellcheck="false" placeholder='Cookie-Editor JSON  KINVA  F12 &rarr; Application &rarr; Cookies madhle sarve rows copy karun paste kara&#10;(__Secure-1PSID, __Secure-1PSIDTS ani baki google.com cookies sarvach ghetlya jatat)'></textarea>
  <div class="bar"><button id="save">Save account</button><button id="cancel" class="s" style="display:none">Cancel replace</button></div>
  <div id="msg"></div>
  <p><small>Paste madhle sarve <code>google.com</code> cookies (PSID, PSIDTS, PSIDCC, SID, APISID ...) browser sarkhe save hotat. Chalte: Cookie-Editor JSON, DevTools table cha copy (rows select &rarr; Ctrl+C), Netscape cookies.txt, kinva <code>name=value; name=value</code>. Pratyek account sathi vegla Incognito window vapara, cookies export kara ani to window band kara; mhanje browser ani server ekmekanchi cookie rotate karnar nahit. Same account punha paste kelat tar to update hoto (duplicate hot nahi). Auto-refresh zalele values DB madhe apoap update hotat.</small></p>
</div>
<script>
const B="__BASE__/cookies", H={"X-Requested-With":"webai-auth"};
const $=id=>document.getElementById(id), esc=s=>String(s??"—").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const when=s=>s?new Date(s).toLocaleString():"—";
let target=null, cache=null;
function say(t,c){$("msg").className=c||"";$("msg").textContent=t}
function proc(a){
  if(!a.enabled)return '<span class="warn">disabled</span>';
  if(a.needs_repaste)return '<span class="bad">cookies expired - replace</span>';
  if(a.process==="running"&&a.authenticated)return '<span class="ok">running · logged in</span>';
  if(a.process==="running")return '<span class="warn">running · NOT logged in (guest)</span>';
  return `<span class="warn">${esc(a.process)}</span>`;
}
function render(s){
  if(s.db_error){$("st").innerHTML=`<div class="card"><span class="bad">DB: ${esc(s.db_error)}</span></div>`;return}
  const n=s.accounts.length;
  let h=`<div class="card"><div class="hd"><h2>${n} / ${s.max_accounts} accounts</h2><small>${n?"load: least-busy account first":(s.guest_running?"no account saved - anonymous guest mode":"no account saved")}</small></div>`;
  h+=n?"":`<small>Khali form madhun pahila account add kara.</small>`;
  h+="</div>";
  for(const a of s.accounts){
    h+=`<div class="card"><div class="hd"><h2>${esc(a.label)}<span class="pill">${esc(a.id)}</span></h2><div>${proc(a)}</div></div>
    <div class="row"><b>__Secure-1PSID</b><code>${esc(a.psid)}</code></div>
    <div class="row"><b>__Secure-1PSIDTS</b><code>${esc(a.psidts)}</code></div>
    <div class="row"><b>Requests now / served / failed</b><span>${a.in_flight} / ${a.served_ok} / ${a.failed}${a.cooldown_left?` <span class="warn">· cooldown ${a.cooldown_left}s</span>`:""}</span></div>
    <div class="row"><b>Cookies saved (jar)</b><span>${a.jar_cookies||0} · id <code>${esc(a.fingerprint)}</code></span></div>\n    <div class="row"><b>Pasted</b><span>${when(a.pasted_at)}</span></div>
    <div class="row"><b>Last rotation (Google answered)</b><span>${when(a.last_rotation_at)} · ${a.rotation_count||0}×</span></div>
    <div class="row"><b>Health check</b><span class="${a.last_status==="AUTHENTICATED"?"ok":"bad"}">${esc(a.last_status)} <small>(${when(a.last_status_at)}${a.heal_attempts?` · self-heal ${a.heal_attempts}×`:""})</small></span></div>`+
    (a.needs_repaste?`<div class="row"><b class="bad">Cookies expired</b><span class="bad">Self-heal failed - gemini.google.com la punha login karun cookies paste kara.</span></div>`:"")+
    (a.same_session_as?`<div class="row"><b class="bad">Same session</b><span class="bad">Ha '${esc(a.same_session_as)}' sarkhach Google session aahe - donhi ek-mekanche cookies invalidate kartat. Vegla account cha cookies paste kara.</span></div>`:"")+
    (a.rotation_stalled?`<div class="row"><b class="bad">Auto-refresh stalled</b><span class="bad">Authenticated aahe pan rotation zala nahi.</span></div>`:"")+
    `<div class="bar"><button class="s" data-a="replace" data-id="${esc(a.id)}">Replace cookies</button>
     <button class="s" data-a="toggle" data-id="${esc(a.id)}" data-en="${a.enabled?0:1}">${a.enabled?"Disable":"Enable"}</button>
     <button class="d" data-a="del" data-id="${esc(a.id)}">Remove</button></div></div>`;
  }
  $("st").innerHTML=h;
}
async function load(){
  try{const r=await fetch(B,{headers:H});cache=await r.json();render(cache);return cache}
  catch(e){$("st").innerHTML=`<div class="card">Status load failed: ${esc(e)}</div>`}
}
async function api(method,qs,body){
  const r=await fetch(B+qs,{method,headers:{...H,"Content-Type":"application/json"},body});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.error||r.status);
  return j;
}
function setTarget(id){
  target=id;const a=cache&&cache.accounts.find(x=>x.id===id);
  $("ft").textContent=id?`Replace cookies: ${a?a.label:id}`:"Add account";
  $("lb").style.display=id?"none":"";$("cancel").style.display=id?"":"none";
  $("save").textContent=id?"Save cookies":"Save account";
  if(id)$("j").focus();
}
$("cancel").onclick=()=>setTarget(null);
$("save").onclick=async()=>{
  const v=$("j").value.trim();if(!v)return say("JSON paste kara","bad");
  $("save").disabled=true;say("Saving…");
  try{
    const q=target?`?id=${encodeURIComponent(target)}`:`?label=${encodeURIComponent($("lb").value)}`;
    const j=await api("POST",q,v);
    say(j.action==="added"?`Account added (${j.cookies} cookies). ~10s madhe suru hoil.`:`Cookies updated (${j.cookies} cookies). Restart ~10s.`,"ok");
    $("j").value="";$("lb").value="";setTarget(null);await load();
  }catch(e){say(String(e.message||e),"bad")}
  finally{$("save").disabled=false}
};
$("st").onclick=async e=>{
  const b=e.target.closest("button[data-a]");if(!b)return;const id=b.dataset.id,a=b.dataset.a;
  try{
    if(a==="replace"){setTarget(id);window.scrollTo({top:document.body.scrollHeight,behavior:"smooth"});return}
    if(a==="toggle"){await api("PATCH",`?id=${encodeURIComponent(id)}&enabled=${b.dataset.en}`)}
    if(a==="del"){if(!confirm("Ha account remove karaycha?"))return;await api("DELETE",`?id=${encodeURIComponent(id)}`)}
    await load();
  }catch(err){say(String(err.message||err),"bad")}
};
load();setInterval(load,10000);
</script></main></body></html>
"""


# ─── CLI ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd in ("sync", "apply"):          # "apply" kept for old scripts: nothing to apply any more, the supervisor does it
        try:
            n = sync_all()
            if n:
                print(f"[webai-cookies] rotated cookies of {n} account(s) saved to DB", flush=True)
        except Exception as e:  # never block shutdown because of the DB
            print(f"[webai-cookies] sync skipped: {e}", file=sys.stderr, flush=True)
    else:
        print(__doc__)
        sys.exit(2)

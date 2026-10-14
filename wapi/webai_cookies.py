"""
WebAI-to-API (Gemini web) cookie store.

* /api/web/v1/ui/auth        -> page where you paste the full cookie JSON
* POST   .../ui/auth/cookies -> extract __Secure-1PSID / __Secure-1PSIDTS, save in MongoDB,
                                write them to WebAI's config.conf and restart WebAI
* DELETE .../ui/auth/cookies -> remove from DB + config, restart WebAI
* GET    .../ui/auth/cookies -> status (masked values, last refresh, upstream auth state)

WebAI-to-API rotates __Secure-1PSIDTS in the background (auto_refresh) and keeps the rotated
cookies in a private temp cache (/tmp/webai-gemini-*/.cached_cookies_<psid>.json).
A background thread here copies the newest rotated values from that cache back into MongoDB,
so a container restart / redeploy always starts from the latest cookies - no env vars needed.

CLI (used by start.sh):
    python3 webai_cookies.py apply   # sync newest rotated cookies -> DB, then DB -> config.conf
    python3 webai_cookies.py sync    # only rotated cookies -> DB
"""
import os, re, sys, json, glob, time, signal, shutil, tempfile, threading, datetime

COLLECTION = "webai_cookies"
DOC_ID = "gemini"
CONFIG_PATH = os.environ.get("WEBAI_CONFIG", "/opt/webai/config.conf")
SYNC_SECONDS = max(10, int(os.environ.get("WEBAI_COOKIE_SYNC_SECONDS", "30")))

PSID_NAME = "__Secure-1PSID"
PSIDTS_NAME = "__Secure-1PSIDTS"

_coll_cache = None
_coll_lock = threading.Lock()
_sync_lock = threading.Lock()


# ─── MongoDB ──────────────────────────────────────────────────────────────────
def _coll():
    """The single-document collection. Same database Node uses (MONGO_URI)."""
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


def get_doc():
    return _coll().find_one({"_id": DOC_ID})


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


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


def _flatten(payload):
    """Anything a cookie export can look like -> list of {name, value, domain?, expires?}."""
    if isinstance(payload, str):
        s = payload.strip()
        if not s:
            return []
        try:
            payload = json.loads(s)
        except ValueError:
            return _parse_netscape(s) if "\t" in s else _parse_header(s)
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


# ─── Save / remove ────────────────────────────────────────────────────────────
def save_pasted(psid, psidts):
    now = _now()
    _coll().replace_one({"_id": DOC_ID}, {
        "_id": DOC_ID, "psid": psid, "psidts": psidts,
        "pastedAt": now, "pastedAtEpoch": time.time(),
        "refreshedAt": None, "refreshCount": 0, "cacheMtime": 0.0, "updatedAt": now,
    }, upsert=True)


def delete_doc():
    return _coll().delete_one({"_id": DOC_ID}).deleted_count


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


def write_config(psid, psidts, path=None):
    path = path or CONFIG_PATH
    try:
        with open(path, encoding="utf-8") as f:
            s = f.read()
    except FileNotFoundError:
        s = ""
    s = _set_key(s, PSID_NAME, psid)
    s = _set_key(s, PSIDTS_NAME, psidts)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(s)
    os.replace(tmp, path)


def apply_to_config():
    doc = get_doc()
    if doc and doc.get("psid"):
        write_config(doc["psid"], doc.get("psidts"))
        return True
    write_config("", "")
    return False


# ─── Rotated cookies (WebAI cache) -> DB ──────────────────────────────────────
def _cache_dirs():
    return glob.glob(os.path.join(tempfile.gettempdir(), "webai-gemini-*"))


def newest_cache():
    """(psid, psidts, mtime) of the most recently written rotated-cookie cache, else None."""
    best = None
    for d in _cache_dirs():
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
    return (psid, psidts, best[0]) if psid else None


def sync_from_cache():
    """Copy newer rotated cookies into the DB. Never creates a doc (removed stays removed)."""
    with _sync_lock:
        doc = get_doc()
        if not doc or not doc.get("psid"):
            return False
        found = newest_cache()
        if not found:
            return False
        psid, psidts, mtime = found
        # ignore stale caches from older runs / before the last paste
        if mtime <= float(doc.get("cacheMtime") or 0) or mtime <= float(doc.get("pastedAtEpoch") or 0):
            return False
        if psid == doc.get("psid") and (psidts or None) == (doc.get("psidts") or None):
            _coll().update_one({"_id": DOC_ID, "pastedAtEpoch": doc.get("pastedAtEpoch")},
                               {"$set": {"cacheMtime": mtime}})
            return False
        res = _coll().update_one(
            {"_id": DOC_ID, "pastedAtEpoch": doc.get("pastedAtEpoch")},   # lose race vs a new paste
            {"$set": {"psid": psid, "psidts": psidts, "cacheMtime": mtime,
                      "refreshedAt": _now(), "updatedAt": _now()},
             "$inc": {"refreshCount": 1}})
        return res.modified_count > 0


def _sync_loop():
    while True:
        time.sleep(SYNC_SECONDS)
        try:
            sync_from_cache()
        except Exception as e:  # DB hiccup must never kill the thread
            print(f"[webai-cookies] sync failed: {e}", file=sys.stderr, flush=True)


def start_sync_thread():
    threading.Thread(target=_sync_loop, name="webai-cookie-sync", daemon=True).start()


# ─── Restart WebAI so it re-reads config.conf ─────────────────────────────────
def _webai_pids():
    pids = []
    for d in os.listdir("/proc") if os.path.isdir("/proc") else []:
        if not d.isdigit():
            continue
        try:
            with open(f"/proc/{d}/cmdline", "rb") as f:
                argv = f.read().decode("utf-8", "replace").split("\0")
        except OSError:
            continue
        if argv and "webai-venv" in argv[0] and any(a.endswith("src/run.py") for a in argv):
            pids.append(int(d))
    return pids


def restart_webai():
    """Kill WebAI; start.sh's loop re-applies DB cookies to config.conf and starts it again."""
    pids = _webai_pids()
    if not pids:
        return False
    for p in pids:
        try:
            os.kill(p, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.time() + 15
    while time.time() < deadline and _webai_pids():
        time.sleep(0.3)
    for p in _webai_pids():
        try:
            os.kill(p, signal.SIGKILL)
        except OSError:
            pass
    for d in _cache_dirs():                                     # stale rotated caches
        shutil.rmtree(d, ignore_errors=True)
    return True


# ─── Flask routes ─────────────────────────────────────────────────────────────
def _mask(v):
    return None if not v else (v[:6] + "…" + v[-4:] if len(v) > 14 else "…")


def _iso(d):
    if not isinstance(d, datetime.datetime):
        return None
    return (d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)).isoformat()


def register(app, authorized, prefix, webai_url):
    from flask import request, jsonify, Response
    import requests

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
        out = {"stored": False}
        try:
            doc = get_doc()
        except Exception as e:
            return {"stored": False, "db_error": str(e)}
        if doc and doc.get("psid"):
            out.update(stored=True, psid=_mask(doc["psid"]), psidts=_mask(doc.get("psidts")),
                       has_psidts=bool(doc.get("psidts")), pasted_at=_iso(doc.get("pastedAt")),
                       refreshed_at=_iso(doc.get("refreshedAt")), refresh_count=doc.get("refreshCount", 0))
        try:
            r = requests.get(webai_url + "/v1/auth/status", timeout=3)
            j = r.json()
            out["webai"] = {"webapi": (j.get("gemini_webapi") or {}).get("status"),
                            "source": (j.get("gemini_webapi") or {}).get("auth_source")}
        except Exception:
            out["webai"] = None                                 # restarting / down
        return out

    @app.route(base, methods=["GET"], endpoint="webai_auth_page")
    def page():
        denied = guard()
        if denied:
            return denied
        return Response(PAGE_HTML.replace("__BASE__", base).replace("__UI__", prefix + "/ui"),
                        200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"})

    @app.route(base + "/cookies", methods=["GET", "POST", "DELETE"], endpoint="webai_auth_cookies")
    def cookies():
        denied = guard()
        if denied:
            return denied
        if request.method == "GET":
            return jsonify(status_payload())
        if not csrf_ok():
            return jsonify({"error": "missing X-Requested-With header"}), 403
        try:
            if request.method == "DELETE":
                removed = delete_doc()
                try:
                    write_config("", "")
                except OSError:
                    pass
                restarted = restart_webai()
                return jsonify({"ok": True, "removed": bool(removed), "restarted": restarted})
            raw = request.get_data(as_text=True)
            if len(raw) > 2_000_000:
                return jsonify({"error": "payload too large"}), 413
            try:
                psid, psidts = extract_cookies(raw)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            save_pasted(psid, psidts)
            try:
                write_config(psid, psidts)
            except OSError as e:
                print(f"[webai-cookies] config write failed: {e}", file=sys.stderr, flush=True)
            restarted = restart_webai()
            return jsonify({"ok": True, "psid": _mask(psid), "psidts": _mask(psidts),
                            "has_psidts": bool(psidts), "restarted": restarted})
        except Exception as e:
            return jsonify({"error": f"DB error: {e}"}), 500

    start_sync_thread()


PAGE_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gemini Web Cookies</title>
<style>
:root{--bg:#0f1115;--fg:#e8eaed;--mut:#9aa0a6;--card:#181b21;--bd:#2a2f38;--ac:#6ea8fe;--ok:#4ade80;--bad:#f87171}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--fg:#1d2127;--mut:#5f6770;--card:#fff;--bd:#dfe3e8;--ac:#1a56db;--ok:#15803d;--bad:#b91c1c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:20px 16px 48px}h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--mut);margin:0 0 16px}.sub a{color:var(--ac)}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px;margin-bottom:16px}
.row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px dashed var(--bd)}.row:last-child{border:0}
.row b{font-weight:500;color:var(--mut)}code{font-family:ui-monospace,monospace;font-size:13px;word-break:break-all}
textarea{width:100%;min-height:200px;background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:8px;padding:10px;font:12px/1.4 ui-monospace,monospace;resize:vertical}
button{background:var(--ac);color:#fff;border:0;border-radius:8px;padding:9px 16px;font:inherit;cursor:pointer}
button.d{background:transparent;color:var(--bad);border:1px solid var(--bad)}button:disabled{opacity:.5;cursor:wait}
.bar{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap}#msg{margin-top:10px;min-height:1.4em}
.ok{color:var(--ok)}.bad{color:var(--bad)}small{color:var(--mut)}
</style></head><body><main>
<h1>Gemini Web Cookies</h1>
<p class="sub">gemini.google.com la login karun cookies export kara (Cookie-Editor &rarr; Export &rarr; JSON) ani khali paste kara. <a href="__UI__">Dashboard</a></p>
<div class="card" id="st"><small>Loading…</small></div>
<div class="card">
  <textarea id="j" spellcheck="false" placeholder='[{"name":"__Secure-1PSID","value":"…","domain":".google.com", …}, …]'></textarea>
  <div class="bar"><button id="save">Save cookies</button><button id="del" class="d">Remove saved cookies</button></div>
  <div id="msg"></div>
  <p><small>Fakt <code>__Secure-1PSID</code> ani <code>__Secure-1PSIDTS</code> ghetle jatat; baki JSON ignore hote. Auto-refresh zalele values DB madhe apoap update hotat, restart nantar punha paste karaychi garaj nahi.
  Tip: cookies Incognito window madhun export kara ani to window band kara, mhanje browser ani server ekmekanchi cookie rotate karnar nahit.</small></p>
</div>
<script>
const B="__BASE__/cookies", H={"X-Requested-With":"webai-auth"};
const $=id=>document.getElementById(id), esc=s=>String(s??"—").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const when=s=>s?new Date(s).toLocaleString():"—";
function say(t,c){$("msg").className=c||"";$("msg").textContent=t}
async function load(){
  try{
    const r=await fetch(B,{headers:H});const s=await r.json();
    const w=s.webai?`${esc(s.webai.webapi)} <small>(${esc(s.webai.source)})</small>`:"<span class=bad>WebAI starting / unreachable</span>";
    $("st").innerHTML=(s.db_error?`<div class="row"><b>DB</b><span class="bad">${esc(s.db_error)}</span></div>`:"")+
      `<div class="row"><b>Saved in DB</b><span class="${s.stored?"ok":"bad"}">${s.stored?"yes":"no"}</span></div>`+
      (s.stored?`<div class="row"><b>__Secure-1PSID</b><code>${esc(s.psid)}</code></div>
      <div class="row"><b>__Secure-1PSIDTS</b><code>${esc(s.psidts)}</code></div>
      <div class="row"><b>Pasted</b><span>${when(s.pasted_at)}</span></div>
      <div class="row"><b>Last auto-refresh saved</b><span>${when(s.refreshed_at)} · ${s.refresh_count}×</span></div>`:"")+
      `<div class="row"><b>Gemini web auth</b><span>${w}</span></div>`;
    return s;
  }catch(e){$("st").textContent="Status load failed: "+e}
}
async function act(method,body,busy){
  $("save").disabled=$("del").disabled=true;say(busy);
  try{
    const r=await fetch(B,{method,headers:{...H,"Content-Type":"application/json"},body});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||r.status);
    say(j.restarted===false?"Saved. (WebAI restart karaila milala nahi - manually restart kara.)":"Done. WebAI restart hotay (~10s)…","ok");
    return true;
  }catch(e){say(String(e.message||e),"bad");return false}
  finally{$("save").disabled=$("del").disabled=false}
}
async function settle(){for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,2500));const s=await load();if(s&&s.webai)break}}
$("save").onclick=async()=>{const v=$("j").value.trim();if(!v)return say("JSON paste kara","bad");
  if(await act("POST",v,"Saving…")){$("j").value="";await load();await settle()}};
$("del").onclick=async()=>{if(!confirm("Saved cookies remove karaycha?"))return;
  if(await act("DELETE",null,"Removing…")){await load();await settle()}};
load();setInterval(load,30000);
</script></main></body></html>
"""


# ─── CLI ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if cmd in ("apply", "sync"):
            try:
                if sync_from_cache():
                    print("[webai-cookies] rotated cookies saved to DB", flush=True)
            except Exception as e:
                print(f"[webai-cookies] sync skipped: {e}", file=sys.stderr, flush=True)
        if cmd == "apply":
            print("[webai-cookies] cookies from DB written to config" if apply_to_config()
                  else "[webai-cookies] no cookies in DB - paste them at /api/web/v1/ui/auth", flush=True)
        elif cmd != "sync":
            print(__doc__)
            sys.exit(2)
    except Exception as e:  # never block WebAI startup because of the DB
        print(f"[webai-cookies] {cmd} failed: {e}", file=sys.stderr, flush=True)

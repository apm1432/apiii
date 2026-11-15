import os, json, time, threading, datetime

from collections import deque
import collections
from flask import Flask, request, jsonify, Response, render_template_string, g
from functools import wraps
import requests
from urllib.parse import quote
import base64, copy, hashlib, re, uuid
import concurrent.futures, itertools, gc
import deploy_badge

app = Flask(__name__)

# ─── Config from Environment ──────────────────────────────────────────────────
RAW_KEYS   = os.environ.get("GEMINI_API_KEYS", "").split(",")
RAW_MODELS = os.environ.get("GEMINI_MODELS", "gemini-3.1-flash-lite:15:500,gemini-3.5-flash-lite:15:500,gemini-3.5-flash:5:20,gemini-3.6-flash:5:20,gemini-3.7-flash:5:20,gemini-3.8-flash:5:20").split(",")

API_KEYS = list(dict.fromkeys([k.strip() for k in RAW_KEYS if k.strip()]))

MODELS = []
for m in RAW_MODELS:
    if not m.strip(): continue
    parts = m.split(":")
    name = parts[0].strip()
    rpm  = int(parts[1].strip()) if len(parts) > 1 and parts[1].strip() else 15
    # RPD is optional (your format is just "name:rpm") -> safe default when absent
    rpd  = int(parts[2].strip()) if len(parts) > 2 and parts[2].strip() else (1500 if "flash" in name else 50)
    MODELS.append({"name": name, "rpm": rpm, "rpd": rpd})

if not MODELS:
    MODELS = [{"name": "gemini-3.1-flash-lite", "rpm": 15, "rpd": 500}]

# Concurrency safety margin: reserve this many RPM slots as a buffer so that
# several requests admitted in the same instant (before their timestamps are
# recorded) can never push the key+model pair over its real RPM limit.
# Default 0 = the RPM you give with the model (GEMINI_MODELS "name:rpm:rpd" or /add) is followed EXACTLY.
# Slots are reserved atomically under state_lock, so parallel requests can no longer overshoot it.
RPM_SAFETY_MARGIN = int(os.environ.get("RPM_SAFETY_MARGIN", "0"))

# +1 second on EVERY wait: a cooldown of 20s ends at 21s, the 60s RPM window is 61s.
EXTRA_WAIT = float(os.environ.get("EXTRA_WAIT", "1"))
GEMINI_CONNECT_TIMEOUT = float(os.environ.get("GEMINI_CONNECT_TIMEOUT", "10"))
GEMINI_READ_TIMEOUT = float(os.environ.get("GEMINI_READ_TIMEOUT", "120"))
RPM_WINDOW_SECS = 60.0 + EXTRA_WAIT

def _effective_rpm(rpm_limit: int) -> int:
    return max(1, int(rpm_limit) - RPM_SAFETY_MARGIN)

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
# Google's free-tier DAILY quota resets at midnight Pacific Time (13:30 IST in winter, 12:30 IST in summer) - NOT at midnight IST.
try:
    from zoneinfo import ZoneInfo
    GOOGLE_TZ = ZoneInfo("America/Los_Angeles")
except Exception:                       # no tzdata in the image -> fixed PST (off by one hour in summer, still far better than IST midnight)
    GOOGLE_TZ = datetime.timezone(datetime.timedelta(hours=-8))

# ─── State ────────────────────────────────────────────────────────────────────
state_lock = threading.RLock()

# RPM window: (key, model_name) -> deque of monotonic timestamps
rpm_window: dict = {}

# RPD counts: (key, model_name) -> int
rpd_count: dict = {}

# RPM cooldown (429 penalty): (key, model_name) -> monotonic timestamp until blocked
rpm_cooldown: dict = {}

# RPD daily penalty: (key, model_name) -> UTC timestamp when it unlocks
# (midnight IST). Scoped per model, NOT per key -- a key that hits its daily
# quota on ONE model still works fine for every other model on that key.
# Google's free-tier RPD quota is actually per (project/key, model) anyway,
# so penalizing the whole key was both wrong and wasteful.
key_daily_penalty: dict = {}

# (key, model_name) pairs that returned a hard compatibility error (e.g.
# "This model only supports Interactions API", missing thought_signature)
# rather than a rate-limit error. These are not transient -- retrying won't
# help until the proxy code itself is changed to speak that model's newer
# API shape -- so they're excluded from routing entirely instead of being
# retried forever. Cleared on process restart.
PERMANENTLY_BROKEN_MODELS: set = set()

# ─── Manual model blocks (dashboard button / POST /model_block) ───────────────
# A model can be switched OFF for every key for a custom time (1h, 1d, 43d, 2h30m ... or forever).
# It is skipped by auto/pool routing, by sticky pins and by the web-search path. Blocks are saved in
# MongoDB (collection wapi_model_blocks, auto-deleted by a TTL index when they expire) with a JSON file as
# a fallback, so they survive restarts / redeploys. They are NOT touched by "Release daily locks".
# A client that explicitly asks for a blocked model is served by the other models (auto mode) unless
# BLOCKED_MODEL_FALLBACK_AUTO=0 -> it then gets a 429 "model_blocked" with Retry-After.
MODEL_BLOCKS: dict = {}     # model key (lower-case) -> {"model": name, "until": epoch, "since": epoch, "reason": str}
MAX_BLOCK_SECS = 3650 * 86400
BLOCKED_MODEL_FALLBACK_AUTO = os.environ.get("BLOCKED_MODEL_FALLBACK_AUTO", "1") != "0"
BLOCKS_COLLECTION = os.environ.get("MODEL_BLOCKS_COLLECTION", "wapi_model_blocks")
BLOCKS_FILE = os.environ.get("MODEL_BLOCKS_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "model_blocks.json"))
_GENERIC_MODEL_ALIASES = {"gemini-pro", "auto", "default", "round-robin", "gemini-working-model", "openrouter/auto", ""}
_DUR_UNITS = {"s": 1, "sec": 1, "secs": 1, "second": 1, "seconds": 1,
              "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60,
              "h": 3600, "hr": 3600, "hrs": 3600, "hour": 3600, "hours": 3600,
              "d": 86400, "day": 86400, "days": 86400,
              "w": 7 * 86400, "wk": 7 * 86400, "week": 7 * 86400, "weeks": 7 * 86400,
              "mo": 30 * 86400, "month": 30 * 86400, "months": 30 * 86400,
              "y": 365 * 86400, "yr": 365 * 86400, "year": 365 * 86400, "years": 365 * 86400}
_DUR_RE = re.compile(r"(\d+(?:\.\d+)?)\s*([a-z]+)")


def parse_duration(text):
    """'1h' '1d' '43d' '90m' '2h30m' '1.5d' '1 week' '3 months' -> seconds (capped at 10 years).
    A bare number means minutes. 'forever' / 'permanent' -> the cap. Returns None when it cannot be read."""
    s = str(text or "").strip().lower().replace(",", " ")
    if not s:
        return None
    if s in ("forever", "permanent", "permanently", "always", "inf", "infinite"):
        return MAX_BLOCK_SECS
    if re.fullmatch(r"\d+(?:\.\d+)?", s):
        total = float(s) * 60
    else:
        if _DUR_RE.sub("", s).strip():
            return None
        total = 0.0
        for num, unit in _DUR_RE.findall(s):
            mult = _DUR_UNITS.get(unit)
            if mult is None:
                return None
            total += float(num) * mult
    if total <= 0:
        return None
    return int(min(total, MAX_BLOCK_SECS))


def _bk(model_name) -> str:
    """Block-table key of a model name: 'models/Gemini-3.5-Flash' and 'gemini-3.5-flash' are the same model."""
    return str(model_name or "").strip().split("/")[-1].lower()


def _model_block_left(model_name) -> float:
    """Seconds left of a manual block on this model (0 = not blocked). Cheap, lock-free read (hot path)."""
    b = MODEL_BLOCKS.get(_bk(model_name))
    if not b:
        return 0.0
    left = b["until"] - time.time()
    if left <= 0:
        MODEL_BLOCKS.pop(_bk(model_name), None)      # expired -> unblocked (the Mongo TTL index removes the stored copy)
        return 0.0
    return left


def _is_model_blocked(model_name) -> bool:
    return _model_block_left(model_name) > 0


def _model_blocks_view():
    """List for the dashboard / API, soonest-ending first."""
    now = time.time()
    out = []
    for b in list(MODEL_BLOCKS.values()):
        left = b["until"] - now
        if left > 0:
            out.append({"model": b["model"], "seconds_left": int(left), "until": b["until"], "since": b.get("since"),
                        "until_ist": datetime.datetime.fromtimestamp(b["until"], IST).strftime("%Y-%m-%d %H:%M IST")
                                     if b["until"] < 4_000_000_000 else "forever",
                        "reason": b.get("reason", ""), "forever": left > MAX_BLOCK_SECS - 86400})
    out.sort(key=lambda x: x["seconds_left"])
    return out


_blk_coll_cache = None
_blk_coll_lock = threading.Lock()
_blk_io_lock = threading.Lock()


def _blocks_coll():
    """MongoDB collection for blocks (same database as Node, MONGO_URI). None when MONGO_URI is not set."""
    global _blk_coll_cache
    with _blk_coll_lock:
        if _blk_coll_cache is None:
            uri = os.environ.get("MONGO_URI", "")
            if not uri:
                return None
            from pymongo import MongoClient
            client = MongoClient(uri, serverSelectionTimeoutMS=5000, connectTimeoutMS=5000)
            coll = client.get_database(client.get_default_database(default="test").name)[BLOCKS_COLLECTION]
            try:
                coll.create_index("expireAt", expireAfterSeconds=0)     # Mongo deletes a block by itself when it ends
            except Exception as e:
                print(f"[MODEL BLOCK] TTL index failed: {e}")
            _blk_coll_cache = coll
        return _blk_coll_cache


def _blocks_save_file():
    try:
        with state_lock:
            snap = {k: dict(v) for k, v in MODEL_BLOCKS.items() if v["until"] > time.time()}
        tmp = BLOCKS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snap, f)
        os.replace(tmp, BLOCKS_FILE)
    except Exception as e:
        print(f"[MODEL BLOCK] file save failed: {e}")


def _blocks_persist(op, bk=None):
    """Background write of one change ('set' bk / 'del' bk / 'clear'). Never blocks or breaks a request."""
    def _run():
        with _blk_io_lock:
            _blocks_save_file()
            try:
                coll = _blocks_coll()
                if coll is None:
                    return
                if op == "set":
                    b = MODEL_BLOCKS.get(bk)
                    if b:
                        coll.replace_one({"_id": bk}, {"_id": bk, "model": b["model"], "until": b["until"], "since": b["since"],
                                                       "reason": b.get("reason", ""),
                                                       "expireAt": datetime.datetime.fromtimestamp(min(b["until"], 4_000_000_000), datetime.timezone.utc)},
                                         upsert=True)
                elif op == "del":
                    coll.delete_one({"_id": bk})
                elif op == "clear":
                    coll.delete_many({})
            except Exception as e:
                print(f"[MODEL BLOCK] MongoDB save failed (still kept in memory + file): {e}")
    threading.Thread(target=_run, daemon=True).start()


def _blocks_merge(rows):
    now = time.time()
    n = 0
    with state_lock:
        for r in rows:
            try:
                bk = _bk(r.get("model") or r.get("_id"))
                until = float(r["until"])
                if not bk or until <= now:
                    continue
                cur = MODEL_BLOCKS.get(bk)
                if cur is None or float(r.get("since") or 0) >= float(cur.get("since") or 0):
                    MODEL_BLOCKS[bk] = {"model": str(r.get("model") or bk), "until": until,
                                        "since": float(r.get("since") or now), "reason": str(r.get("reason") or "")}
                    n += 1
            except Exception:
                continue
    return n


def _blocks_load():
    """Startup: file first (fast, local), then MongoDB in the background (retries until it answers)."""
    try:
        with open(BLOCKS_FILE, encoding="utf-8") as f:
            _blocks_merge(list(json.load(f).values()))
    except (OSError, ValueError):
        pass
    if not os.environ.get("MONGO_URI"):
        return
    def _bg():
        for _ in range(20):
            try:
                coll = _blocks_coll()
                n = _blocks_merge(list(coll.find({"until": {"$gt": time.time()}})))
                print(f"[MODEL BLOCK] loaded {n} block(s) from MongoDB")
                return
            except Exception as e:
                print(f"[MODEL BLOCK] MongoDB load failed, retrying in 30s: {e}")
                time.sleep(30)
    threading.Thread(target=_bg, daemon=True).start()

# ─── Persistent model list (dashboard "➕ Add model", POST /model_config, POST /add) ──────────────────────
# Models added / edited on the dashboard are saved in MongoDB (collection wapi_custom_models) with a JSON file as
# a fallback, and are re-applied on every start, so they survive restarts / redeploys together with their RPM and RPD.
# A saved entry for a model that is also in GEMINI_MODELS overrides that model's limits; deleting the saved entry
# restores the GEMINI_MODELS values. Models that exist only in the saved list are removed from routing on delete.
ENV_MODELS = [dict(m) for m in MODELS]          # snapshot of GEMINI_MODELS (env), taken before any saved change
CUSTOM_MODELS_COLLECTION = os.environ.get("CUSTOM_MODELS_COLLECTION", "wapi_custom_models")
CUSTOM_MODELS_FILE = os.environ.get("CUSTOM_MODELS_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "custom_models.json"))
CUSTOM_CFG: dict = {}       # model key (lower-case) -> {"name", "rpm", "rpd", "added", "updated", "last_tier"(optional)}
# Persistent manual Last-Tier ("use last", like lite models) overrides:
#   _bk(model_name) -> True (always use in Last Tier) | False (always use in Primary Tier, even if 'lite' in name)
# Models not in LAST_TIER_OVERRIDES fall back to default LITE_LAST ('lite' in name).
LAST_TIER_OVERRIDES: dict = {}
LAST_TIER_UPDATED: float = 0.0
_LAST_TIER_DOC_ID = "__last_tier__"
_MODEL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/\-]{0,99}$")
_cfg_io_lock = threading.Lock()


def _cfg_clean_name(raw):
    """'models/gemini-x' -> 'gemini-x'. None when the name is not usable (spaces, ':', ',' ...)."""
    n = str(raw or "").strip()
    if n.lower().startswith("models/"):
        n = n[7:]
    if not _MODEL_NAME_RE.match(n) or _bk(n) in _GENERIC_MODEL_ALIASES or n == _LAST_TIER_DOC_ID:
        return None
    return n


def _cfg_int(v, lo, hi):
    try:
        f = float(str(v).strip())
    except (TypeError, ValueError):
        return None
    if f != int(f) or not (lo <= int(f) <= hi):
        return None
    return int(f)


def _cfg_apply(name, rpm, rpd):
    """Put the model in the routing list (or update its limits). Returns True when a new entry was created."""
    bk = _bk(name)
    with state_lock:
        ex = next((m for m in MODELS if _bk(m["name"]) == bk), None)
        if ex is not None:
            ex["rpm"], ex["rpd"] = int(rpm), int(rpd)
            return False
        MODELS.append({"name": name, "rpm": int(rpm), "rpd": int(rpd)})
        return True


def _cfg_remove(name):
    """Undo a saved entry: env models get their GEMINI_MODELS limits back, the others leave the routing list."""
    bk = _bk(name)
    with state_lock:
        env = next((m for m in ENV_MODELS if _bk(m["name"]) == bk), None)
        ex = next((m for m in MODELS if _bk(m["name"]) == bk), None)
        if env is not None:
            if ex is not None:
                ex["rpm"], ex["rpd"] = env["rpm"], env["rpd"]
            else:
                MODELS.append(dict(env))
            return "reset"
        if ex is not None and len(MODELS) > 1:
            MODELS.remove(ex)
            LAST_TIER_OVERRIDES.pop(bk, None)
            return "removed"
        return "kept"       # never remove the last model


def _cfg_save_file():
    try:
        with state_lock:
            snap = {k: dict(v) for k, v in CUSTOM_CFG.items()}
            snap[_LAST_TIER_DOC_ID] = {
                "_id": _LAST_TIER_DOC_ID,
                "overrides": dict(LAST_TIER_OVERRIDES),
                "updated": LAST_TIER_UPDATED,
            }
        tmp = CUSTOM_MODELS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snap, f)
        os.replace(tmp, CUSTOM_MODELS_FILE)
    except Exception as e:
        print(f"[MODEL CFG] file save failed: {e}")


def _cfg_coll():
    c = _blocks_coll()          # same MongoDB database as the blocks
    return None if c is None else c.database[CUSTOM_MODELS_COLLECTION]


def _cfg_persist(op, bk):
    """Background write of one change ('set' bk / 'del' bk). Never blocks or breaks a request."""
    def _run():
        with _cfg_io_lock:
            _cfg_save_file()
            try:
                coll = _cfg_coll()
                if coll is None:
                    return
                if bk == _LAST_TIER_DOC_ID:
                    with state_lock:
                        doc = {
                            "_id": _LAST_TIER_DOC_ID,
                            "overrides": dict(LAST_TIER_OVERRIDES),
                            "updated": LAST_TIER_UPDATED,
                        }
                    coll.replace_one({"_id": _LAST_TIER_DOC_ID}, doc, upsert=True)
                    return
                if op == "set":
                    r = CUSTOM_CFG.get(bk)
                    if r:
                        coll.replace_one({"_id": bk}, dict(r, _id=bk), upsert=True)
                elif op == "del":
                    coll.delete_one({"_id": bk})
            except Exception as e:
                print(f"[MODEL CFG] MongoDB save failed (still kept in memory + file): {e}")
    threading.Thread(target=_run, daemon=True).start()


def _cfg_merge(rows):
    global LAST_TIER_UPDATED
    n = 0
    for r in rows:
        try:
            if not isinstance(r, dict):
                continue
            if r.get("_id") == _LAST_TIER_DOC_ID or "overrides" in r:
                upd = float(r.get("updated") or 0)
                with state_lock:
                    if upd >= LAST_TIER_UPDATED:
                        LAST_TIER_UPDATED = upd
                        ov = r.get("overrides")
                        if isinstance(ov, dict):
                            LAST_TIER_OVERRIDES.clear()
                            for k, v in ov.items():
                                ck = _bk(k)
                                if ck and ck != _LAST_TIER_DOC_ID:
                                    LAST_TIER_OVERRIDES[ck] = bool(v)
                continue
            name = _cfg_clean_name(r.get("name") or r.get("_id"))
            rpm, rpd = _cfg_int(r.get("rpm"), 1, 1_000_000), _cfg_int(r.get("rpd"), 1, 100_000_000)
            if not name or rpm is None or rpd is None:
                continue
            bk = _bk(name)
            with state_lock:
                cur = CUSTOM_CFG.get(bk)
                if cur is not None and float(cur.get("updated") or 0) > float(r.get("updated") or 0):
                    continue
                entry = {"name": name, "rpm": rpm, "rpd": rpd,
                         "added": float(r.get("added") or time.time()),
                         "updated": float(r.get("updated") or time.time())}
                if "last_tier" in r and r["last_tier"] is not None:
                    entry["last_tier"] = bool(r["last_tier"])
                    if bk not in LAST_TIER_OVERRIDES:
                        LAST_TIER_OVERRIDES[bk] = bool(r["last_tier"])
                CUSTOM_CFG[bk] = entry
            _cfg_apply(name, rpm, rpd)
            n += 1
        except Exception:
            continue
    return n


def _cfg_load():
    """Startup: file first (fast, local), then MongoDB in the background (retries until it answers)."""
    try:
        with open(CUSTOM_MODELS_FILE, encoding="utf-8") as f:
            raw = json.load(f)
            if isinstance(raw, dict):
                _cfg_merge(list(raw.values()))
            elif isinstance(raw, list):
                _cfg_merge(raw)
    except (OSError, ValueError):
        pass
    if not os.environ.get("MONGO_URI"):
        return
    def _bg():
        for _ in range(20):
            try:
                n = _cfg_merge(list(_cfg_coll().find({})))
                print(f"[MODEL CFG] loaded {n} saved model(s) + last-tier config from MongoDB; routing list now has {len(MODELS)} model(s)")
                return
            except Exception as e:
                print(f"[MODEL CFG] MongoDB load failed, retrying in 30s: {e}")
                time.sleep(30)
    threading.Thread(target=_bg, daemon=True).start()


def _cfg_save(name, rpm, rpd, last_tier=None):
    """Apply + remember one model (used by the dashboard, /model_config and /add). Returns True when it was new."""
    global LAST_TIER_UPDATED
    bk, now = _bk(name), time.time()
    with state_lock:
        prev = CUSTOM_CFG.get(bk)
        entry = {"name": name, "rpm": int(rpm), "rpd": int(rpd),
                 "added": (prev or {}).get("added", now), "updated": now}
        if last_tier is not None:
            LAST_TIER_OVERRIDES[bk] = bool(last_tier)
            LAST_TIER_UPDATED = now
            entry["last_tier"] = bool(last_tier)
        elif prev and "last_tier" in prev:
            entry["last_tier"] = prev["last_tier"]
        CUSTOM_CFG[bk] = entry
    created = _cfg_apply(name, rpm, rpd)
    _cfg_persist("set", bk)
    if last_tier is not None:
        _cfg_persist("set", _LAST_TIER_DOC_ID)
    return created


def _last_tier_save():
    """Persist LAST_TIER_OVERRIDES to custom_models.json and MongoDB."""
    global LAST_TIER_UPDATED
    with state_lock:
        LAST_TIER_UPDATED = time.time()
        for bk, cfg in CUSTOM_CFG.items():
            if bk in LAST_TIER_OVERRIDES:
                cfg["last_tier"] = bool(LAST_TIER_OVERRIDES[bk])
            else:
                cfg.pop("last_tier", None)
    _cfg_persist("set", _LAST_TIER_DOC_ID)


def _cfg_view():
    with state_lock:
        env = {_bk(m["name"]) for m in ENV_MODELS}
        return [{"name": m["name"], "rpm": m["rpm"], "rpd": m["rpd"],
                 "saved": _bk(m["name"]) in CUSTOM_CFG,
                 "in_env": _bk(m["name"]) in env,
                 "last_tier": _is_lite(m["name"]),
                 "last_tier_manual": _bk(m["name"]) in LAST_TIER_OVERRIDES,
                 "default_lite": bool(LITE_LAST and "lite" in (m["name"] or "").lower())} for m in MODELS]


# ─── Conversation stickiness (fixes Gemini thought_signature 400s) ───────────
# Gemini 2.5/3 "thinking" models attach an encrypted thought_signature to
# function-call parts. That signature is only valid when it is echoed back
# to the SAME model (and same underlying key/project) that produced it. Our
# round-robin picks a fresh (key, model) on every incoming HTTP request --
# which is correct for independent, one-shot chats, but breaks any request
# that is a *continuation* of a tool-calling turn (an agent like Hermes
# sending the function result back): if that continuation lands on a
# different (key, model) than the one that emitted the function call, Gemini
# rejects it with "signature missing/mismatch" (400) and the agent's task
# stalls mid-execution.
#
# Fix: give each conversation a stable id and pin it to the (key, model)
# that handled its most recent successful turn, as long as that slot is
# still viable (not rate-limited / not broken). Independent conversations
# still spread freely across every key+model, so your overall quota usage
# is unaffected -- only steps *within* one tool-calling task stay glued to
# the same model.
CONV_STICKY_TTL = 3 * 60 * 60   # forget a caller's pin after 3h of no traffic
STICKY_MAX_WAIT = float(os.environ.get("STICKY_MAX_WAIT", "0"))  # short wait for RPM on the pinned model; after that we switch (signatures are re-injected)
conversation_sticky: dict = {}   # client_id -> (key, model_name, last_used_monotonic)

def _client_id_from_request(data: dict, remote_addr: str) -> str:
    """Identity used to pin a caller to one (key, model). Prefers an
    explicit id the client sends (session_id / user); otherwise falls back
    to the caller's IP. For a single-bot setup like Hermes → wapi, every
    call comes from the same IP anyway, so this behaves as one global pin --
    exactly what you want: whichever model is doing the current
    thinking/tool-call work stays fixed until its daily quota runs out."""
    explicit = data.get("_conv_hint")
    if explicit:
        return f"id:{explicit}"
    fp = ""
    try:   # first user message stays the same for every turn of one conversation
        first = next((m for m in (data.get("messages") or [])
                      if isinstance(m, dict) and m.get("role") == "user"), None)
        if first:
            c = first.get("content")
            if isinstance(c, list):
                c = " ".join(str(p.get("text", "")) for p in c if isinstance(p, dict))
            fp = hashlib.sha1(str(c or "")[:500].encode("utf-8", "replace")).hexdigest()[:12]
    except Exception:
        fp = ""
    return f"ip:{remote_addr or 'unknown'}" + (f":{fp}" if fp else "")

def _is_tool_continuation(messages: list) -> bool:
    """True if this request is continuing a function-calling turn (an
    assistant tool_calls message or a tool-result message is present) --
    i.e. it MUST stay on the (key, model) that started this turn, or Gemini
    will reject the thought_signature."""
    for m in messages:
        role = m.get("role")
        if role == "tool" or (role == "assistant" and m.get("tool_calls")):
            return True
    return False

def _prune_conv_sticky():
    cutoff = time.monotonic() - CONV_STICKY_TTL
    dead = [cid for cid, (_, _, ts) in conversation_sticky.items() if ts < cutoff]
    for cid in dead:
        conversation_sticky.pop(cid, None)

def _pin_hard_dead(key, model_name, model_dict) -> bool:
    """True only for failures that CANNOT be waited out: this (key, model)
    is permanently incompatible or its daily (RPD) quota is gone for today.
    RPM being momentarily full is NOT included here -- that's what we wait
    on instead of switching (see acquire_sticky_slot_wait)."""
    if (key, model_name) in PERMANENTLY_BROKEN_MODELS: return True
    if _is_model_blocked(model_name): return True           # manually blocked on the dashboard
    if _is_daily_penalized(key, model_name): return True
    if not _rpd_available(key, model_name, model_dict["rpd"]): return True
    return False

def acquire_sticky_slot_wait(client_id: str):
    """
    Resolve the pinned slot for this client, WAITING (not switching) while
    it's only RPM-limited, since RPM resets within ~60s and switching model
    mid-task would break the thought_signature.

    Returns one of:
      ("ok", key, model_dict)   -> reserved and ready to use
      ("exhausted", None, None) -> daily quota / permanent break: pin
                                    cleared, caller should surface an error
                                    to the user; their NEXT fresh message
                                    will get a brand-new pin
      ("busy", None, None)      -> still RPM-limited after STICKY_MAX_WAIT;
                                    pin is kept (not cleared) so the next
                                    retry can resume on it
      (None, None, None)        -> no pin exists yet for this client
    """
    deadline = time.monotonic() + STICKY_MAX_WAIT
    while True:
        with state_lock:
            _prune_conv_sticky()
            entry = conversation_sticky.get(client_id)
            if not entry:
                return (None, None, None)
            key, model_name, _ = entry
            model_dict = next((m for m in MODELS if m["name"] == model_name), None)

            if model_dict is None or _pin_hard_dead(key, model_name, model_dict):
                conversation_sticky.pop(client_id, None)
                return ("exhausted", None, None)

            if _is_rpm_cooldown(key, model_name) or not _rpm_available(key, model_name, model_dict["rpm"]):
                rpm_blocked = True
            else:
                rpm_blocked = False

            if not rpm_blocked:
                _record_request(key, model_name)
                conversation_sticky[client_id] = (key, model_name, time.monotonic())
                return ("ok", key, model_dict)

        # RPM-limited only -- wait it out instead of switching models.
        if time.monotonic() >= deadline:
            return ("busy", None, None)
        time.sleep(1.0)

CONV_STICKY_MAX = int(os.environ.get("CONV_STICKY_MAX", "2000"))

def remember_sticky_slot(client_id: str, key: str, model_name: str):
    with state_lock:
        rate_strikes.pop((key, model_name), None)
        conversation_sticky[client_id] = (key, model_name, time.monotonic())
        # MEMORY: this dict used to be pruned only when a tool-continuation arrived, so every plain chat request
        # (a new ip+first-message fingerprint each time) added an entry that was never removed.
        if len(conversation_sticky) > CONV_STICKY_MAX:
            _prune_conv_sticky()
            if len(conversation_sticky) > CONV_STICKY_MAX:      # still too many -> drop the oldest ones
                for cid, _ in sorted(conversation_sticky.items(), key=lambda kv: kv[1][2])[:len(conversation_sticky) - CONV_STICKY_MAX]:
                    conversation_sticky.pop(cid, None)


# ─── thought_signature cache + injection (enables key/model switching) ───────
# Clients like Hermes drop `extra_content.google.thought_signature` from the
# assistant tool_calls they echo back. We capture it from every Google
# response, cache it by tool_call id, and put it back into the history
# before forwarding -- so the next step may run on ANY key/model.
SIG_CACHE_TTL = int(os.environ.get("SIG_CACHE_TTL", str(6 * 3600)))
# Dummy signature Google documents for history that has none (Gemini 3 only).
# Set env SIG_FALLBACK="" to disable.
SIG_FALLBACK = os.environ.get("SIG_FALLBACK", "skip_thought_signature_validator")
SIG_CACHE_MAX = int(os.environ.get("SIG_CACHE_MAX", "1500"))
sig_cache: dict = {}            # key -> (signature, monotonic_ts)
sig_lock = threading.Lock()

def _tc_fp(tc: dict):
    fn = tc.get("function") or {}
    name, args = fn.get("name") or "", fn.get("arguments") or ""
    try: args = json.dumps(json.loads(args), sort_keys=True)
    except Exception: pass
    return "fp:" + hashlib.sha1(f"{name}|{args}".encode()).hexdigest()

def _extract_sig(tc: dict):
    return (((tc.get("extra_content") or {}).get("google") or {}).get("thought_signature"))

def _store_sig(tc: dict):
    sig = _extract_sig(tc)
    if not sig: return
    now = time.monotonic()
    with sig_lock:
        if len(sig_cache) > SIG_CACHE_MAX:
            cutoff = now - SIG_CACHE_TTL
            for k in [k for k, (_, ts) in sig_cache.items() if ts < cutoff]:
                sig_cache.pop(k, None)
            if len(sig_cache) > SIG_CACHE_MAX:             # all still fresh: evict the oldest (a signature is several KB)
                for k, _ in sorted(sig_cache.items(), key=lambda kv: kv[1][1])[:len(sig_cache) - SIG_CACHE_MAX + SIG_CACHE_MAX // 4]:
                    sig_cache.pop(k, None)
        if tc.get("id"): sig_cache[tc["id"]] = (sig, now)
        fn = tc.get("function") or {}
        if fn.get("name") and fn.get("arguments") is not None:
            sig_cache[_tc_fp(tc)] = (sig, now)

def _lookup_sig(tc: dict):
    with sig_lock:
        for k in (tc.get("id"), _tc_fp(tc)):
            if k and k in sig_cache and sig_cache[k][1] > time.monotonic() - SIG_CACHE_TTL:
                return sig_cache[k][0]
    return None

def capture_signatures(body: bytes):
    """Read a Google response (plain JSON or SSE) and cache tool-call signatures."""
    try:
        text = body.decode("utf-8", "replace")
        if text.lstrip().startswith("data:") or "\ndata:" in text:
            for line in text.splitlines():
                line = line.strip()
                if not line.startswith("data:") or line.endswith("[DONE]"): continue
                try: obj = json.loads(line[5:].strip())
                except Exception: continue
                for ch in obj.get("choices", []):
                    for tc in ((ch.get("delta") or {}).get("tool_calls") or []):
                        _store_sig(tc)
        else:
            obj = json.loads(text)
            for ch in obj.get("choices", []):
                for tc in ((ch.get("message") or {}).get("tool_calls") or []):
                    _store_sig(tc)
    except Exception as e:
        print(f"[SIG CAPTURE] {e}")

# ─── Responses-API / unknown-field normalization ──────────────────────────────
# Some clients (Hermes included) call POST /v1/responses instead of
# /v1/chat/completions once you pick a SPECIFIC model from the model list
# ("auto"/round-robin/reset stays on /v1/chat/completions -> that's why reset
# "worked"). The Responses API has a different shape: "input" instead of
# "messages", "instructions" instead of a system message, plus Responses-only
# fields like "include", "prompt_cache_key", "store", "previous_response_id",
# "text", "reasoning". Google's Gemini OpenAI-compat endpoint only implements
# classic Chat Completions and does strict schema validation -- any of those
# extra keys makes it reject the WHOLE request with 400 "Unknown name ...
# Cannot find field", even though model/messages were fine. Normalizing every
# incoming body into plain Chat Completions shape here fixes it permanently,
# no matter which endpoint/client/model sent the request.
CHAT_COMPLETIONS_ALLOWED_KEYS = {
    "model", "messages", "temperature", "top_p", "top_k", "max_tokens",
    "max_completion_tokens", "stream", "stream_options", "stop", "n",
    "presence_penalty", "frequency_penalty", "logit_bias", "seed",
    "tools", "tool_choice", "functions", "function_call",
    "response_format", "logprobs", "top_logprobs", "parallel_tool_calls",
    "_conv_hint",  # internal marker, stripped later in proxy_chat before forwarding
    "_wants_search",  # internal marker: the client asked for web search (see _extract_search_intent), stripped in proxy_chat
}

def _normalize_tools(tools):
    """Responses API sends function tools FLAT: {"type":"function","name":...,
    "description":...,"parameters":...,"strict":...} directly on the tool
    object. Chat Completions (what Gemini's compat layer expects) nests it:
    {"type":"function","function":{"name":...,"description":...,"parameters":...}}.
    Sending the flat shape is exactly what produced "Unknown name \"name\" at
    'tools[0]'" etc -- Gemini was looking for a "function" key that wasn't
    there. "strict" isn't forwarded at all; Gemini doesn't support it."""
    if not isinstance(tools, list):
        return tools
    fixed = []
    for t in tools:
        if not isinstance(t, dict):
            continue
        if t.get("type") == "function" and "function" not in t and "name" in t:
            fn = {"name": t.get("name"), "description": t.get("description", "")}
            if "parameters" in t:
                fn["parameters"] = t["parameters"]
            fixed.append({"type": "function", "function": fn})
        else:
            fixed.append(t)
    return fixed

def _normalize_tool_choice(tc):
    """Same flat-vs-nested mismatch as tools, for tool_choice: Responses API
    sends {"type":"function","name":"foo"}; Chat Completions wants
    {"type":"function","function":{"name":"foo"}}."""
    if isinstance(tc, dict) and tc.get("type") == "function" and "function" not in tc and "name" in tc:
        return {"type": "function", "function": {"name": tc["name"]}}
    return tc

# ─── Web search ───────────────────────────────────────────────────────────────
# Gemini's OpenAI-compatible endpoint does NOT know OpenAI-style search tools ({"type":"web_search"},
# web_search_options, enable_search, OpenRouter "plugins" ...): it answers 400 "invalid tool type: web_search",
# and the old loop then retried that request on EVERY key/model (dozens of wasted calls).
# Now: (1) every search hint is removed from the body so it can never reach Gemini's compat layer, and
#      (2) if the client asked for search, the request is answered through Gemini's NATIVE generateContent API
#          with the Google Search tool, and converted back to a normal Chat Completions / Responses answer
#          (citations are returned as "annotations" + "citations"). Set ROUTER_WEB_SEARCH=0 to turn this off.
ROUTER_WEB_SEARCH = os.environ.get("ROUTER_WEB_SEARCH", "1") != "0"
SEARCH_TOOL_TYPES = {"web_search", "web_search_preview", "web_search_preview_2025_03_11", "google_search",
                     "google_search_retrieval", "browser_search", "web"}

def _extract_search_intent(data: dict) -> bool:
    """Removes every web-search hint from `data` (in place) and tells whether the client wanted search."""
    wants = False
    tools = data.get("tools")
    if isinstance(tools, list):
        keep = []
        for t in tools:
            if isinstance(t, dict) and (str(t.get("type", "")).lower() in SEARCH_TOOL_TYPES
                                        or "google_search" in t or "google_search_retrieval" in t):
                wants = True
                continue
            keep.append(t)
        if keep:
            data["tools"] = keep
        else:
            data.pop("tools", None)
            data.pop("tool_choice", None)
    if "web_search_options" in data:
        data.pop("web_search_options", None)
        wants = True
    if data.get("enable_search"):
        wants = True
    plugins = data.get("plugins")
    if isinstance(plugins, list) and any(isinstance(x, dict) and x.get("id") == "web" for x in plugins):
        wants = True
    return wants

def _oa_messages_to_gemini(messages):
    """Chat Completions messages -> (systemInstruction parts, contents). None when a message cannot be converted
    (tool calls / tool results / remote image urls): then the normal path is used (answer without search)."""
    system, contents = [], []
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role in ("tool", "function") or m.get("tool_calls"):
            return None
        c = m.get("content")
        parts = []
        if isinstance(c, str):
            if c.strip():
                parts.append({"text": c})
        elif isinstance(c, list):
            for part in c:
                if not isinstance(part, dict):
                    continue
                t = part.get("type")
                if t in ("text", "input_text", "output_text") and part.get("text"):
                    parts.append({"text": part["text"]})
                elif t == "image_url":
                    u = part.get("image_url")
                    u = u.get("url") if isinstance(u, dict) else u
                    mm = re.match(r"data:([^;]+);base64,(.+)$", u or "", re.S)
                    if not mm:
                        return None
                    parts.append({"inlineData": {"mimeType": mm.group(1), "data": mm.group(2)}})
        if not parts:
            continue
        if role in ("system", "developer"):
            system.extend(parts)
        else:
            contents.append({"role": "model" if role == "assistant" else "user", "parts": parts})
    if not contents:
        return None
    return system, contents

def _native_to_chat_completion(gj: dict, model: str):
    cands = gj.get("candidates") or []
    if not cands:
        return None
    cand = cands[0] or {}
    parts = (cand.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought") and isinstance(p.get("text"), str)).strip()
    if not text:
        return None
    chunks = ((cand.get("groundingMetadata") or {}).get("groundingChunks")) or []
    annotations, citations, seen = [], [], set()
    for ch in chunks:
        web = (ch or {}).get("web") or {}
        uri = web.get("uri")
        if not uri or uri in seen:
            continue
        seen.add(uri)
        citations.append(uri)
        annotations.append({"type": "url_citation", "url_citation": {"url": uri, "title": web.get("title", "")}})
    um = gj.get("usageMetadata") or {}
    fr = str(cand.get("finishReason", "STOP")).upper()
    return {
        "id": "chatcmpl-" + uuid.uuid4().hex[:24],
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0,
                     "message": {"role": "assistant", "content": text, "annotations": annotations},
                     "finish_reason": "length" if fr == "MAX_TOKENS" else "stop"}],
        "citations": citations,
        "usage": {"prompt_tokens": um.get("promptTokenCount", 0),
                  "completion_tokens": um.get("candidatesTokenCount", 0),
                  "total_tokens": um.get("totalTokenCount", 0)},
    }

def search_via_native(data: dict, requested_model: str, is_responses_api: bool, client_stream_requested: bool):
    """Answers with Gemini's Google Search tool. Returns a Flask response, or None when the request cannot be answered
    this way (the caller then answers normally, without search). Never loops over the whole pool on a 400."""
    rf = data.get("response_format")
    if isinstance(rf, dict) and rf.get("type") in ("json_object", "json_schema"):
        return None   # JSON mode + Google Search are not allowed together on Gemini
    conv = _oa_messages_to_gemini(data.get("messages"))
    if conv is None:
        return None
    system, contents = conv
    gen = {}
    if data.get("temperature") is not None:
        gen["temperature"] = data["temperature"]
    if data.get("top_p") is not None:
        gen["topP"] = data["top_p"]
    mt = data.get("max_completion_tokens") or data.get("max_tokens")
    if mt:
        gen["maxOutputTokens"] = int(mt)
    payload = {"contents": contents, "tools": [{"google_search": {}}]}
    if system:
        payload["systemInstruction"] = {"parts": system}
    if gen:
        payload["generationConfig"] = gen

    tried = set()
    attempts = 0
    max_tries = min(8, max(2, len(API_KEYS) * max(1, len(MODELS))))
    while attempts < max_tries:
        slot = acquire_next_slot(requested_model, exclude=tried)
        if slot is None:
            return None
        _k_i, _m_i, key, model = slot
        actual_model = model["name"]
        tried.add((key, actual_model))
        attempts += 1
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{actual_model}:generateContent"
        try:
            resp = requests.post(url, json=payload, headers={"x-goog-api-key": key, "Content-Type": "application/json"}, timeout=120)
        except Exception as e:
            print(f"[SEARCH ERROR] key=…{key[-6:]} model={actual_model}: {e}")
            with state_lock:
                _apply_rpm_cooldown(key, actual_model, seconds=20)
            continue
        if resp.status_code == 200:
            try:
                chat = _native_to_chat_completion(resp.json(), actual_model)
            except Exception:
                chat = None
            if chat is None:      # blocked / empty answer: let another slot try
                continue
            if hasattr(g, "log_entry"):
                g.log_entry["status"] = f"200 Success ({actual_model}, web search)"
                g.log_entry["model"] = actual_model
                g.log_entry["route"] = "Gemini native search (Google Search tool) key …" + key[-4:] + " → " + actual_model
            with state_lock:
                metrics["successful_api_calls"] += 1
                _record_rpd_success(key, actual_model)
            if is_responses_api:
                rj = chat_completion_to_responses_json(chat, actual_model)
                if client_stream_requested:
                    return Response(responses_sse_stream(rj), mimetype="text/event-stream")
                return jsonify(rj)
            return jsonify(chat)
        err_text = ""
        try: err_text = resp.text.lower()
        except Exception: pass
        if resp.status_code in (429, 403):
            with state_lock:
                metrics["rate_limit_hits"] += 1
                kind = _handle_429(key, actual_model, err_text)
            print(f"[SEARCH 429] key=…{key[-6:]} model={actual_model} -> next slot ({kind})")
            continue
        if resp.status_code in (500, 503):
            with state_lock:
                _apply_rpm_cooldown(key, actual_model, seconds=20)
            continue
        # 400 / 404 / others: this model or request does not support Google Search -> answer WITHOUT search (one call wasted, not sixty)
        print(f"[SEARCH {resp.status_code}] model={actual_model} cannot use Google Search ({err_text[:120]}) -> answering without search")
        return None
    return None

def normalize_to_chat_completions(data: dict) -> dict:
    """Accepts either a normal Chat Completions body OR a Responses-API body
    and returns something Gemini's /v1beta/openai/chat/completions accepts."""
    data = dict(data)
    wants_search = _extract_search_intent(data)

    if "tools" in data:
        data["tools"] = _normalize_tools(data["tools"])
    if "tool_choice" in data:
        data["tool_choice"] = _normalize_tool_choice(data["tool_choice"])

    if "messages" not in data and "input" in data:
        raw_input = data.pop("input")
        if isinstance(raw_input, str):
            data["messages"] = [{"role": "user", "content": raw_input}]
        elif isinstance(raw_input, list):
            msgs = []
            for item in raw_input:
                if isinstance(item, dict) and "role" in item:
                    content = item.get("content")
                    if isinstance(content, list):  # Responses API content parts
                        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
                    msgs.append({"role": item["role"], "content": content})
            data["messages"] = msgs
        else:
            data["messages"] = []

    instructions = data.pop("instructions", None)
    if instructions:
        data["messages"] = [{"role": "system", "content": instructions}] + data.get("messages", [])

    out = {k: v for k, v in data.items() if k in CHAT_COMPLETIONS_ALLOWED_KEYS}
    if wants_search:
        out["_wants_search"] = True
    return out

# ─── Responses-API response reconstruction ────────────────────────────────────
# Fixing the REQUEST shape (above) was step 1. Step 2: when the caller hit
# /v1/responses, Gemini still answers in plain Chat-Completions JSON/SSE --
# a totally different event protocol than the Responses API stream a
# Responses-API client (Hermes/Codex) is parsing. Relaying Gemini's stream
# unchanged meant the client waited forever for a Responses-shaped terminal
# event ("response.completed") that would never arrive -> "Codex Responses
# stream did not emit a terminal response". Fix: for /v1/responses we always
# call Gemini with stream forced OFF (one complete JSON back, no partial-SSE
# translation needed), rebuild a real Responses-API object from it, and if
# the ORIGINAL caller wanted streaming we emit our own minimal-but-valid
# Responses SSE stream that is guaranteed to end with response.completed.
def _gemini_choice_to_responses_output(choice: dict) -> list:
    msg = (choice or {}).get("message") or {}
    items = []
    content_text = msg.get("content") or ""
    anns = []
    for a in (msg.get("annotations") or []):
        uc = (a or {}).get("url_citation") or {}
        if uc.get("url"):
            anns.append({"type": "url_citation", "url": uc["url"], "title": uc.get("title", "")})
    if anns:   # the answer was produced with web search
        items.append({"type": "web_search_call", "id": f"ws_{uuid.uuid4().hex[:24]}", "status": "completed"})
    if content_text:
        items.append({
            "type": "message",
            "id": f"msg_{uuid.uuid4().hex[:24]}",
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "output_text", "text": content_text, "annotations": anns}],
        })
    for tc in (msg.get("tool_calls") or []):
        fn = tc.get("function") or {}
        items.append({
            "type": "function_call",
            "id": f"fc_{uuid.uuid4().hex[:24]}",
            "call_id": tc.get("id") or f"call_{uuid.uuid4().hex[:24]}",
            "name": fn.get("name", ""),
            "arguments": fn.get("arguments", "{}"),
            "status": "completed",
        })
    return items

def chat_completion_to_responses_json(gemini_json: dict, model: str) -> dict:
    choices = gemini_json.get("choices") or [{}]
    output = _gemini_choice_to_responses_output(choices[0])
    text_parts = [it["content"][0]["text"] for it in output if it["type"] == "message"]
    return {
        "id": gemini_json.get("id") or f"resp_{uuid.uuid4().hex[:24]}",
        "object": "response",
        "created_at": gemini_json.get("created", int(time.time())),
        "status": "completed",
        "model": model,
        "output": output,
        "output_text": "".join(text_parts),
        "usage": gemini_json.get("usage", {}),
    }

def responses_sse_stream(resp_json: dict):
    """Minimal-but-valid Responses-API SSE stream. Always ends with the
    response.completed terminal event -- that guarantee is the actual fix."""
    yield f"event: response.created\ndata: {json.dumps({'type': 'response.created', 'response': resp_json})}\n\n"
    for item in resp_json["output"]:
        if item["type"] == "message":
            text = item["content"][0]["text"]
            yield (f"event: response.output_text.delta\ndata: "
                   f"{json.dumps({'type': 'response.output_text.delta', 'item_id': item['id'], 'delta': text})}\n\n")
    yield f"event: response.completed\ndata: {json.dumps({'type': 'response.completed', 'response': resp_json})}\n\n"
    yield "data: [DONE]\n\n"

class _GuardedIter:
    """Wraps a generator so `on_close` ALWAYS runs when the response is closed.
    MEMORY/SOCKET LEAK FIX: closing a generator that was never started does NOT run its `finally:` block, so when a
    client disconnected before the first chunk the upstream connection (and the WebAI account's in-flight slot)
    stayed open forever. Werkzeug calls .close() on the response iterable -> this object cleans up in every case."""
    def __init__(self, gen, on_close):
        self._gen, self._on_close, self._done = gen, on_close, False

    def __iter__(self):
        return self

    def __next__(self):
        try:
            return next(self._gen)
        except BaseException:
            self._finish()
            raise

    def close(self):
        try:
            close = getattr(self._gen, "close", None)
            if close:
                close()
        finally:
            self._finish()

    def _finish(self):
        if not self._done:
            self._done = True
            try:
                self._on_close()
            except Exception:
                pass


def _drain_close(resp):
    """A failed upstream answer (429/5xx/400...) is read completely and its connection returned/closed right away.
    Responses opened with stream=True that were only `continue`d past used to stay open until garbage collection."""
    try:
        resp.content          # read the (small) error body so .text / .content still work afterwards
    except Exception:
        pass
    try:
        resp.close()
    except Exception:
        pass


def _stream_gemini_sse(resp, log_entry=None, log_start=None):
    """Streams Gemini SSE chunks immediately to the client without buffering resp.content,
    while capturing tool_call thought_signatures on the fly as lines arrive."""
    sig_buf = b""
    try:
        for chunk in resp.iter_content(chunk_size=None):
            if not chunk:
                continue
            sig_buf += chunk
            if b"\n" in sig_buf:
                *lines, sig_buf = sig_buf.split(b"\n")
                for ln in lines:
                    if b"thought_signature" in ln or b"tool_calls" in ln:
                        capture_signatures(ln)
            yield chunk
        if sig_buf and (b"thought_signature" in sig_buf or b"tool_calls" in sig_buf):
            capture_signatures(sig_buf)
    finally:
        try:
            resp.close()
        except Exception:
            pass
        if log_entry is not None and log_start is not None:
            log_entry["response_ms"] = round((time.monotonic() - log_start) * 1000)

def _finalize_success_response(resp, is_responses_api: bool, actual_model: str, client_stream_requested: bool):
    """Build the Response for a 200 from Gemini. Plain /v1/chat/completions
    streaming calls are relayed chunk-by-chunk immediately (never buffered via resp.content).
    /v1/responses calls get converted into a real Responses-API object (see above)."""
    _trail(f"200 OK from {actual_model}")
    excluded = ['content-encoding', 'content-length', 'transfer-encoding', 'connection']
    if not is_responses_api:
        out_headers = [(n, v) for n, v in resp.raw.headers.items() if n.lower() not in excluded]
        ctype = (resp.headers.get("Content-Type") or "").lower()
        if client_stream_requested or "text/event-stream" in ctype:
            out_headers = [(n, v) for n, v in out_headers if n.lower() not in ('cache-control', 'x-accel-buffering')]
            out_headers.append(('Cache-Control', 'no-cache, no-store, no-transform'))
            out_headers.append(('X-Accel-Buffering', 'no'))
            log_entry = getattr(g, "log_entry", None)
            log_start = getattr(g, "_log_start", None)
            return Response(_GuardedIter(_stream_gemini_sse(resp, log_entry, log_start), resp.close), resp.status_code, out_headers)
        body = resp.content
        capture_signatures(body)
        return Response(body, resp.status_code, out_headers)
    body = resp.content
    capture_signatures(body)
    try:
        gemini_json = json.loads(body.decode("utf-8", "replace"))
    except Exception:
        out_headers = [(n, v) for n, v in resp.raw.headers.items() if n.lower() not in excluded]
        return Response(body, resp.status_code, out_headers)
    responses_json = chat_completion_to_responses_json(gemini_json, actual_model)
    if client_stream_requested:
        return Response(responses_sse_stream(responses_json), mimetype="text/event-stream")
    return jsonify(responses_json)

def prepare_payload(data: dict, model_name: str, force_dummy: bool = False) -> dict:
    """Copy of the request with signatures fixed up for the chosen model.
    - gemini-*  : restore the cached real signature; dummy if none cached
                  (dummy is only used for gemini-3*, where it is required).
    - others    : (gemma) REAL signatures are rejected (400) and none gives a
                  500, but the dummy is accepted -> always send the dummy.
    - force_dummy: used by the self-heal retry after a signature 400."""
    payload = dict(data)
    msgs = copy.deepcopy(data.get("messages") or [])
    is_gemini = model_name.startswith("gemini-")
    is_g3 = model_name.startswith("gemini-3")

    def put_dummy(tcs):
        for tc in tcs: tc.pop("extra_content", None)
        if SIG_FALLBACK:
            tcs[0]["extra_content"] = {"google": {"thought_signature": SIG_FALLBACK}}

    for m in msgs:
        tcs = m.get("tool_calls") if m.get("role") == "assistant" else None
        if not tcs: continue
        if force_dummy or not is_gemini:
            put_dummy(tcs)
            continue
        for tc in tcs:
            if not _extract_sig(tc):
                sig = _lookup_sig(tc)
                if sig:
                    tc.setdefault("extra_content", {}).setdefault("google", {})["thought_signature"] = sig
        if is_g3 and SIG_FALLBACK and not any(_extract_sig(tc) for tc in tcs):
            tcs[0].setdefault("extra_content", {}).setdefault("google", {})["thought_signature"] = SIG_FALLBACK
    payload["messages"] = msgs
    return payload

def _heal_signature(resp, url, headers, data, model_name):
    """If Google says the signature is missing/invalid, retry ONCE on the same
    key+model with the dummy signature instead of failing the user."""
    try:
        if resp.status_code == 400 and "thought_signature" in resp.text.lower():
            print(f"[SIG HEAL] {model_name}: signature 400 -> retrying with dummy signature")
            _drain_close(resp)
            return requests.post(url, json=prepare_payload(data, model_name, force_dummy=True),
                                 headers=headers, stream=True, timeout=(GEMINI_CONNECT_TIMEOUT, GEMINI_READ_TIMEOUT))
    except Exception as e:
        print(f"[SIG HEAL ERROR] {e}")
    return resp

# Last RPD reset date (IST)
_last_rpd_reset = datetime.datetime.now(IST).strftime("%Y-%m-%d")

def _today_ist():
    return datetime.datetime.now(IST).strftime("%Y-%m-%d")

def _maybe_reset_rpd():
    """Reset RPD counts at midnight IST. Call inside state_lock."""
    global _last_rpd_reset
    today = _today_ist()
    if today != _last_rpd_reset:
        print(f"[RPD RESET] Midnight IST - clearing all RPD counts (was {_last_rpd_reset})")
        rpd_count.clear()
        # Daily penalties are NOT cleared here any more: each one expires at the time Google said (see
        # _apply_daily_penalty), and Google's quota does not reset at midnight IST.
        _last_rpd_reset = today

# ─── Requests per day, per key and model (shown on /logs; only TODAY + YESTERDAY are kept) ───────────────────
# Counted at the same place as the RPD counter (_record_rpd_success = a confirmed 200 from Google), so the numbers
# match what is used against RPD. Saved in MongoDB (collection wapi_usage_daily, one document per IST day, API keys are
# stored only as a short hash) so a restart / redeploy does not lose today's count; documents older than yesterday are
# deleted. The day changes at midnight IST. After a restart today's saved count is also put back into the RPD counter.
USAGE_COLLECTION = os.environ.get("USAGE_COLLECTION", "wapi_usage_daily")
USAGE_FLUSH_SECS = float(os.environ.get("USAGE_FLUSH_SECS", "15"))
USAGE: dict = {}                    # "YYYY-MM-DD" -> {(key hash, model name): requests}
_usage_lock = threading.Lock()
_usage_dirty = False
_usage_loaded = threading.Event()


def _kid(key) -> str:
    return hashlib.sha256(str(key).encode()).hexdigest()[:12]


def _yesterday_ist():
    return (datetime.datetime.now(IST) - datetime.timedelta(days=1)).strftime("%Y-%m-%d")


def _usage_add(key, model_name):
    global _usage_dirty
    day = _today_ist()
    with _usage_lock:
        d = USAGE.setdefault(day, {})
        k = (_kid(key), str(model_name))
        d[k] = d.get(k, 0) + 1
        if len(USAGE) > 2:
            keep = _yesterday_ist()
            for old in [x for x in USAGE if x < keep]:
                USAGE.pop(old, None)
        _usage_dirty = True


def _usage_view():
    """{"today", "yesterday", "models": {model: {"today": n, "yesterday": n, "rows": [{key, today, yesterday}]}}}"""
    today, yday = _today_ist(), _yesterday_ist()
    with _usage_lock:
        t = {(kid, _bk(m)): n for (kid, m), n in USAGE.get(today, {}).items()}
        y = {(kid, _bk(m)): n for (kid, m), n in USAGE.get(yday, {}).items()}
    keys = [(_kid(k), "..." + k[-4:]) for k in list(API_KEYS)]
    out = {}
    for m in list(MODELS):
        bk, rows, tt, ty = _bk(m["name"]), [], 0, 0
        for kid, label in keys:
            a, b = t.get((kid, bk), 0), y.get((kid, bk), 0)
            rows.append({"key": label, "today": a, "yesterday": b})
            tt += a
            ty += b
        out[m["name"]] = {"today": tt, "yesterday": ty, "rows": rows}
    return {"today": today, "yesterday": yday, "models": out}


def _usage_coll():
    c = _blocks_coll()          # same MongoDB database as the blocks
    return None if c is None else c.database[USAGE_COLLECTION]


def _usage_flush():
    global _usage_dirty
    if not _usage_loaded.is_set():
        return                  # never overwrite the saved days before they were read back
    coll = _usage_coll()
    if coll is None:
        return
    keep = _yesterday_ist()
    with _usage_lock:
        snap = {day: [{"k": k, "m": m, "n": n} for (k, m), n in d.items()] for day, d in USAGE.items() if day >= keep}
        _usage_dirty = False
    try:
        for day, rows in snap.items():
            coll.replace_one({"_id": day}, {"_id": day, "rows": rows, "updated": time.time()}, upsert=True)
        coll.delete_many({"_id": {"$lt": keep}})
    except Exception as e:
        _usage_dirty = True
        print(f"[USAGE] MongoDB save failed, will retry: {e}")


def _usage_load():
    if not os.environ.get("MONGO_URI"):
        return
    def _bg():
        for _ in range(40):
            try:
                docs = list(_usage_coll().find({"_id": {"$gte": _yesterday_ist()}}))      # read first, apply once
                today, n = _today_ist(), 0
                with _usage_lock:
                    for doc in docs:
                        d = USAGE.setdefault(str(doc["_id"]), {})
                        for r in doc.get("rows", []):
                            kk = (str(r["k"]), str(r["m"]))
                            d[kk] = d.get(kk, 0) + int(r["n"])
                            n += 1
                    cur = dict(USAGE.get(today, {}))
                by_kid = {_kid(k): k for k in API_KEYS}
                with state_lock:
                    for (kid, m), c in cur.items():
                        if kid in by_kid:
                            rpd_count[(by_kid[kid], m)] = max(rpd_count.get((by_kid[kid], m), 0), c)
                _usage_loaded.set()
                print(f"[USAGE] loaded {n} saved row(s) from MongoDB (today + yesterday)")
                return
            except Exception as e:
                print(f"[USAGE] MongoDB load failed, retrying in 30s: {e}")
                time.sleep(30)
    threading.Thread(target=_bg, daemon=True, name="usage-load").start()

    def _loop():
        while True:
            time.sleep(USAGE_FLUSH_SECS)
            if _usage_dirty:
                _usage_flush()
    threading.Thread(target=_loop, daemon=True, name="usage-flush").start()
    import atexit
    atexit.register(_usage_flush)


def _get_key(key, model_name, d, default_factory):
    k = (key, model_name)
    if k not in d:
        d[k] = default_factory()
    return d[k]

def _prune_rpm(key, model_name):
    window = _get_key(key, model_name, rpm_window, deque)
    cutoff = time.monotonic() - RPM_WINDOW_SECS
    while window and window[0] < cutoff:
        window.popleft()
    return window

def _rpm_available(key, model_name, rpm_limit):
    window = _prune_rpm(key, model_name)

    # 60s sliding-window check — this is the ONLY guard needed.
    # The old code also added a per-request spacing rule
    # (e.g. 13 s between requests for a 5-RPM model). With 12 keys × 6
    # models the pool has 72 slots; spacing one slot out blocks ALL of them
    # simultaneously when requests arrive in a burst, making the router
    # return None and send a 429 to the user even though the aggregate
    # quota has barely been touched. Removing the spacing rule and relying
    # on the window count alone is correct: the 60-second window
    # automatically limits throughput to `effective_limit` RPM without
    # needlessly serialising bursts across unrelated (key, model) pairs.
    return len(window) < _effective_rpm(rpm_limit)

def _rpd_available(key, model_name, rpd_limit):
    used = _get_key(key, model_name, rpd_count, lambda: 0)
    if isinstance(used, deque):  # safety
        used = 0
    return used < rpd_limit

def _is_rpm_cooldown(key, model_name):
    until = rpm_cooldown.get((key, model_name), 0)
    return time.monotonic() < until

def _is_daily_penalized(key, model_name):
    until = key_daily_penalty.get((key, model_name), 0)
    return time.time() < until

def _record_request(key, model_name):
    """Call BEFORE sending API request — reserves the RPM slot only.

    IMPORTANT: this does NOT touch rpd_count anymore. It used to increment
    the daily counter right here, at *reservation* time, before we even
    knew whether the request would succeed. That meant every 503
    ("model overloaded"), every client-side read-timeout, and every 429
    silently consumed a slot of the daily budget even though Google never
    actually served the request -- so a key could get midnight-penalized
    (key_daily_penalty) after a run of transient failures while its real
    Gemini-side RPD quota was still almost untouched. RPD is now only
    counted by _record_rpd_success(), called after a confirmed 200."""
    _prune_rpm(key, model_name)
    rpm_window[(key, model_name)].append(time.monotonic())

def _record_rpd_success(key, model_name):
    """Call AFTER a confirmed 200 response. This is the only place
    rpd_count should be incremented, since it's the only case where a
    request actually consumed quota on Google's side."""
    k = (key, model_name)
    rpd_count[k] = rpd_count.get(k, 0) + 1
    try:
        _usage_add(key, model_name)
    except Exception as e:      # statistics must never break a request
        print(f"[USAGE] {e}")

def _apply_rpm_cooldown(key, model_name, seconds=62):
    """Apply 62s cooldown to this key+model pair after 429."""
    rpm_cooldown[(key, model_name)] = time.monotonic() + seconds + EXTRA_WAIT
    print(f"[COOLDOWN] key=…{key[-6:]} model={model_name} blocked for {seconds}s")

def _next_google_reset_ts():
    """Next midnight Pacific Time (+30 s) = when Google's free-tier daily quota really resets."""
    now = datetime.datetime.now(GOOGLE_TZ)
    nxt = (now + datetime.timedelta(days=1)).replace(hour=0, minute=0, second=30, microsecond=0)
    return nxt.timestamp()

def _apply_daily_penalty(key, model_name, retry_secs=None):
    """Block this (key, model) pair after its daily quota is hit. Only this model is blocked on this key --
    every other model on the same key keeps working normally.

    How long: exactly as long as Google itself says (retryDelay / "Please retry in 3h42m..."), because that is
    when the quota really comes back. It used to be 'until midnight IST', but Google resets at midnight
    PACIFIC (13:30 IST): a key whose quota returned at 13:30 stayed locked ~10 more hours.
    No wait time given -> until the next Google reset (midnight Pacific)."""
    now = time.time()
    if retry_secs and retry_secs > 300:
        unlock_ts = now + min(retry_secs + 30, 26 * 3600)
        why = f"Google said retry in {int(retry_secs)}s"
    else:
        unlock_ts = _next_google_reset_ts()
        why = "until Google's daily reset (midnight Pacific)"
    key_daily_penalty[(key, model_name)] = unlock_ts
    mins = round((unlock_ts - now) / 60)
    print(f"[DAILY LIMIT] key=…{key[-6:]} model={model_name} penalized ~{mins} mins ({why}) — other models on this key are unaffected")

def _clear_penalty(key, model_name):
    """A real 200 from Google proves this (key, model) works RIGHT NOW -> drop the daily penalty, RPM cooldown
    and strike counter that said otherwise. Call with state_lock held."""
    k = (key, model_name)
    was = key_daily_penalty.pop(k, None)
    rpm_cooldown.pop(k, None)
    rate_strikes.pop(k, None)
    if was and was > time.time():
        print(f"[PENALTY CLEARED] key=…{key[-6:]} model={model_name} answered 200 -> daily penalty removed")

# ─── Global Metrics ───────────────────────────────────────────────────────────
metrics = {
    "total_incoming_requests": 0,
    "successful_api_calls": 0,
    "rate_limit_hits": 0,
    "rpm_cooldowns_applied": 0,
    "daily_limits_hit": 0,
    "failed_requests": 0,
    "webai_fallback_calls": 0,
    "usage_by_key": {}
}


# ─── Smarter 429 classification ──────────────────────────────────────────────
# Google's "You exceeded your current quota" text is used for BOTH per-minute
# and per-day limits. The old code treated every message containing "quota" as
# a DAILY limit and locked the model until midnight even after a 1-minute hit.
# We now read the quotaId (…PerDay… / …PerMinute…) and the retryDelay.
rate_strikes: dict = {}   # (key, model) -> consecutive ambiguous 429 count
# An ambiguous 429 ("resource has been exhausted", no quotaId, no retryDelay) is an RPM-style 429. It used to be
# promoted to a midnight DAILY penalty after 5 in a row -> healthy keys were locked for a whole day. Now it is only
# a cooldown, unless you opt in with AMBIGUOUS_429_STRIKES=<n> (0 = never, the default).
AMBIGUOUS_429_STRIKES = int(os.environ.get("AMBIGUOUS_429_STRIKES", "0"))

def _parse_retry_secs(t: str):
    """Google's own wait time in seconds from a lower-cased 429 body, or None. Understands the JSON field
    ("retryDelay": "13372s") AND the message text ("Please retry in 3h42m52.9s" / "retry in 21.5s")."""
    m = re.search(r'retrydelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s', t)
    if m:
        return float(m.group(1))
    m = re.search(r'retry in\s+((?:\d+(?:\.\d+)?(?:h|m(?!s)|s)\s*)+)', t)
    if m:
        total = sum(float(n) * {"h": 3600, "m": 60, "s": 1}[u]
                    for n, u in re.findall(r'(\d+(?:\.\d+)?)(h|m(?!s)|s)', m.group(1)))
        if total > 0:
            return total
    return None

def _handle_429(key, model_name, err_text: str) -> str:
    """Classify a 429 and apply the right penalty. Call with state_lock held.
    Returns "daily" or "rpm".

    Google's free-tier Gemini 3.x models return a quotaId string containing
    "...PerDay...FreeTier" even for errors that come back with a short
    retryDelay (commonly 40-60s) and clear well within a minute -- so that
    label text alone is NOT a reliable signal for these models; trusting it
    blindly is what caused keys to get midnight-blocked while their real
    daily quota was still mostly unused. retryDelay -- Google's own stated
    wait time -- is checked FIRST and trusted over the label. A key/model is
    only ever pushed into a real midnight daily-block when either:
      (a) Google gives an explicitly long retryDelay (>300s), or a
          daily-looking label with no retryDelay at all -- i.e. Google
          itself is saying "there is no short wait that fixes this", or
      (b) the SAME (key, model) keeps coming back with an ambiguous quota
          error several times in a row, each one AFTER its own previous
          short cooldown has fully expired (acquire_next_slot only ever
          retries it once that cooldown is over) -- repeated failure that
          survives waiting is the real behavioural signature of a genuine
          daily block, since a per-minute limit would have cleared by then.
    """
    t = (err_text or "").lower()
    k = (key, model_name)

    _parsed = _parse_retry_secs(t)
    retry = _parsed + 2 if _parsed is not None else None

    # A per-minute window is only 60 s wide, so a wait longer than 5 minutes can ONLY be a daily quota - even when
    # the same error also lists a per-minute metric (models with limit 0 on the free tier list both).
    if retry is not None and retry > 300:
        _apply_daily_penalty(key, model_name, retry)
        rate_strikes.pop(k, None)
        return "daily"

    # ── Per-minute / RPM detection ────────────────────────────────────────────
    # Explicit label -> definitely RPM, short cooldown, reset strikes.
    if "perminute" in t or "per minute" in t or "per_minute" in t:
        rate_strikes.pop(k, None)
        _apply_rpm_cooldown(key, model_name, seconds=int(retry or 62))
        return "rpm"

    # Only an explicit per-day label counts. "free tier" / "free_tier_requests" is in EVERY free-tier quota error,
    # per-minute ones too, so it said nothing about the day - an RPM 429 without a parsable wait time used to be
    # locked for the whole day because of it.
    is_daily_label = (
        "perday" in t or "per day" in t or "per_day" in t or "daily" in t
    )

    # A short retryDelay is trusted over the label, whatever it says: it
    # clears fast, so it's treated as an RPM-style cooldown, not a daily one.
    if retry is not None and retry <= 120:
        _apply_rpm_cooldown(key, model_name, seconds=int(retry))
        return _escalate_or_stay_rpm(k, key, model_name)

    # No short retryDelay to trust: a long one (>300s), or a daily-looking
    # label with no retryDelay at all, really does mean "come back tomorrow".
    if is_daily_label and retry is None:
        _apply_daily_penalty(key, model_name)
        rate_strikes.pop(k, None)
        return "daily"

    # ── Ambiguous 429 ─────────────────────────────────────────────────────────
    # No reliable signal at all (bare 429, no retryDelay, no clear label) ->
    # a single flat ~62s cooldown every time (no escalating 5-minute jump),
    # since RPM windows are only 60s wide anyway. Only escalates to a real
    # daily block after this same combo fails the same ambiguous way
    # repeatedly (see _escalate_or_stay_rpm).
    _apply_rpm_cooldown(key, model_name, seconds=int(retry or 62))
    return _escalate_or_stay_rpm(k, key, model_name)

def _escalate_or_stay_rpm(k, key, model_name) -> str:
    """Consecutive-ambiguous-strike counter for the (key, model) pair `k`.
    Each strike here can only happen after the PREVIOUS short cooldown for
    this same combo has actually expired (acquire_next_slot won't re-pick a
    combo that's still under cooldown), so reaching the cap means the combo
    failed the same way several separate times, well spaced apart -- real
    confirmation of a genuine daily block, not just a noisy burst. Reset to
    0 on any success (see remember_sticky_slot)."""
    n = rate_strikes.get(k, 0) + 1
    rate_strikes[k] = n
    if AMBIGUOUS_429_STRIKES > 0 and n >= AMBIGUOUS_429_STRIKES:
        _apply_daily_penalty(key, model_name)
        rate_strikes.pop(k, None)
        return "daily"
    return "rpm"

# ─── Dynamic model list (refreshed daily from API) ────────────────────────────
dynamic_models_lock = threading.Lock()
DYNAMIC_MODELS = []
OPENAI_MODELS_LIST = []

def refresh_models_loop():
    global DYNAMIC_MODELS, OPENAI_MODELS_LIST
    while True:
        if API_KEYS:
            for key in API_KEYS:
                try:
                    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={key}"
                    resp = requests.get(url, timeout=10)
                    if resp.status_code == 200:
                        data = resp.json().get("models", [])
                        new_rr, new_openai = [], []
                        now = int(time.time())
                        for m in data:
                            name = m["name"].replace("models/", "")
                            new_openai.append({"id": name, "object": "model", "created": now, "owned_by": "google"})
                            methods = m.get("supportedGenerationMethods", [])
                            skip = any(x in name.lower() for x in ["embedding","tts","image","transcribe","robotics","aqa"])
                            if "generateContent" in methods and not skip:
                                rpm = 30 if "flash-lite" in name else (15 if "flash" in name else 2)
                                rpd = 1500 if "flash-lite" in name else (1500 if "flash" in name else 50)
                                new_rr.append({"name": name, "rpm": rpm, "rpd": rpd})
                        for extra in ["dall-e-3", "whisper-1", "auto", "tts-1"]:
                            if not any(x["id"] == extra for x in new_openai):
                                new_openai.append({"id": extra, "object": "model", "created": now, "owned_by": "google"})
                        with dynamic_models_lock:
                            if new_rr:
                                DYNAMIC_MODELS = new_rr
                                OPENAI_MODELS_LIST = new_openai
                        break
                except Exception as e:
                    print(f"[MODEL REFRESH ERROR] {e}")
        time.sleep(86400 if DYNAMIC_MODELS else 60)

threading.Thread(target=refresh_models_loop, daemon=True).start()

def get_active_models():
    # ALWAYS use the models you configured in GEMINI_MODELS for routing.
    # The dynamically-fetched list (DYNAMIC_MODELS) is informational only —
    # it used to silently replace your ENV pool in "auto" mode, which meant
    # auto-mode requests could be routed to models you never approved/rate-
    # limited in GEMINI_MODELS. That's fixed: MODELS (from env) is now the
    # single source of truth for routing.
    return MODELS

# ─── Core: Smart Combo Picker ─────────────────────────────────────────────────
current_combo_idx = 0

LITE_LAST = os.environ.get("LITE_LAST", "1") != "0"   # 0 = old behaviour (lite mixed with the others)

def _is_lite(model_name: str) -> bool:
    """True when `model_name` belongs to the LAST TIER (used only after all Primary-Tier models are busy/exhausted).
    Manual overrides from /wapi/logs (LAST_TIER_OVERRIDES, persisted across restarts) take priority over the default 'lite' name match."""
    bk = _bk(model_name)
    if bk in LAST_TIER_OVERRIDES:
        return bool(LAST_TIER_OVERRIDES[bk])
    return LITE_LAST and "lite" in (model_name or "").lower()

def _list_combos_in_order(requested_model: str):
    """
    Builds the ordered candidate list (key, model) for a request.
    Must be called while already holding state_lock.

    Two modes:
    1. POOL MODE ("auto"/empty/generic alias):
       - Uses ONLY the models configured in GEMINI_MODELS (env) — never the
         dynamically-fetched list — so auto mode always respects your RPM
         settings for gemini-3.1-flash-lite, gemini-3.5-flash, etc.
       - Tries all key × model combos, highest-RPM model first.
    2. SPECIFIC MODEL MODE (user sent a real model name):
       - Only that model is used, all keys are tried in rotation.
    """
    active_models = get_active_models()

    GENERIC_ALIASES = _GENERIC_MODEL_ALIASES
    is_pool_mode = requested_model.lower() in GENERIC_ALIASES
    if MODEL_BLOCKS:
        # manually blocked models are not even listed (all keys)
        active_models = [m for m in active_models if not _is_model_blocked(m["name"])]
        if not is_pool_mode and _is_model_blocked(requested_model):
            return []

    combos = []

    if is_pool_mode:
        # Sort models so that the ones with the most available keys come
        # first. A model where every key is daily-penalized or broken is
        # sorted to the bottom so the router doesn't waste time iterating
        # its K slots before reaching a fully-available model.
        # Within the same availability bucket, higher RPM wins (original
        # behaviour for healthy models).
        def _model_sort_key(m):
            penalized_keys = sum(
                1 for k in API_KEYS
                if _is_daily_penalized(k, m["name"])
                or (k, m["name"]) in PERMANENTLY_BROKEN_MODELS
            )
            # fewer penalized keys = better; higher rpm = better
            return (penalized_keys, -m["rpm"])

        K = len(API_KEYS)
        if not active_models or K == 0:
            return []

        # TWO TIERS: every non-lite model first, "lite" models only LAST.
        # Inside each tier the key x model combos are rotated round-robin
        # (so parallel requests spread over the whole tier). Because
        # acquire_next_slot() takes the first viable combo in this order,
        # a lite model is used only when no non-lite (key, model) is
        # usable for this request (RPM full / cooldown / daily-exhausted /
        # already failed in this request).
        non_lite = sorted([m for m in active_models if not _is_lite(m["name"])], key=_model_sort_key)
        lite = sorted([m for m in active_models if _is_lite(m["name"])], key=_model_sort_key)
        for tier in (non_lite, lite):
            M = len(tier)
            if M == 0:
                continue
            total = K * M
            for i in range(total):
                idx = (current_combo_idx + i) % total
                m_i = idx // K
                k_i = idx % K
                combos.append((k_i, m_i, API_KEYS[k_i], tier[m_i]))
    else:
        model_dict = next(
            (m for m in active_models if m["name"] == requested_model), None
        )
        if model_dict is None:
            is_flash = "flash" in requested_model.lower()
            model_dict = {
                "name": requested_model,
                "rpm": 15 if is_flash else 2,
                "rpd": 1500 if is_flash else 50,
            }
        K = len(API_KEYS)
        if K == 0:
            return []
        for i in range(K):
            k_i = (current_combo_idx + i) % K
            combos.append((k_i, -1, API_KEYS[k_i], model_dict))

    return combos


def acquire_next_slot(requested_model: str, exclude: set):
    """
    Atomically picks the next viable (key, model) combo AND reserves it
    (records the request timestamp) in one locked step.

    This is the fix for the multi-user race condition: previously,
    "find a viable combo" and "record that a request is using it" were two
    separate lock acquisitions, so two requests arriving at nearly the same
    moment could both pass the RPM check for the same key+model before
    either one recorded its usage — letting concurrent users occasionally
    slip past the RPM limit or collide on the same slot.

    Now the check-then-reserve happens under a single lock hold, so at most
    one caller can ever claim a given (key, model) slot for a given instant.
    Returns (k_i, m_i, key, model) or None if nothing is viable right now.
    """
    with state_lock:
        _maybe_reset_rpd()

        if not API_KEYS:
            return None

        combos = _list_combos_in_order(requested_model)

        for (k_i, m_i, key, model) in combos:
            if (key, model["name"]) in exclude:
                continue
            if _is_model_blocked(model["name"]):
                continue
            if (key, model["name"]) in PERMANENTLY_BROKEN_MODELS:
                continue
            if _is_daily_penalized(key, model["name"]):
                continue
            if _is_rpm_cooldown(key, model["name"]):
                continue
            if not _rpd_available(key, model["name"], model["rpd"]):
                continue
            if not _rpm_available(key, model["name"], model["rpm"]):
                continue

            # Reserve immediately, still inside the lock, before returning —
            # this is what closes the race window.
            _record_request(key, model["name"])
            
            global current_combo_idx
            # Advance by 1 across the total pool of K*M combinations
            # If we are in specific model mode, we still just advance by 1
            # so it moves to the next key.
            # unbounded counter: each tier takes it modulo its own size
            current_combo_idx += 1
                
            return (k_i, m_i, key, model)

        return None


def get_best_combo(requested_model: str):
    """
    Kept for compatibility with /status and any external callers — returns
    the full viable list WITHOUT reserving anything. The actual proxy path
    uses acquire_next_slot() instead, which is race-free.
    """
    with state_lock:
        _maybe_reset_rpd()
        if not API_KEYS:
            return []
        combos = _list_combos_in_order(requested_model)
        viable = []
        for (k_i, m_i, key, model) in combos:
            if _is_model_blocked(model["name"]):
                continue
            if (key, model["name"]) in PERMANENTLY_BROKEN_MODELS:
                continue
            if _is_daily_penalized(key, model["name"]):
                continue
            if _is_rpm_cooldown(key, model["name"]):
                continue
            if not _rpd_available(key, model["name"], model["rpd"]):
                continue
            if not _rpm_available(key, model["name"], model["rpm"]):
                continue
            viable.append((k_i, m_i, key, model))
        return viable


# ─── Request logs ─────────────────────────────────────────────────────────────
class _LogDeque(deque):
    """Every log entry gets a unique, increasing id (used by the dashboard to load details on demand)."""
    _seq = itertools.count(1)
    def appendleft(self, entry):
        entry.setdefault("id", next(_LogDeque._seq))
        super().appendleft(entry)

request_logs = _LogDeque(maxlen=50)
# Failed requests are ALSO kept here (last 100), so under heavy traffic the 50 newest successes can never push an
# error off the dashboard before you saw it.
failed_logs = deque(maxlen=100)


def _clip(v, n):
    v = "" if v is None else (v if isinstance(v, str) else str(v))
    return v if len(v) <= n else v[:n] + "…"


def _log_kind(e):
    """ok | warn (200 but a fallback/problem happened) | fail | pending"""
    st = str(e.get("status") or "")
    if st.startswith("Pending"):
        return "pending"
    if st[:1] == "2" and "fail" not in st.lower():
        return "warn" if (e.get("error_detail") or "web fallback" in st.lower()) else "ok"
    return "fail"


def _resp_preview_from_entry(e):
    """Readable response preview for the dashboard logs list."""
    r_txt = str(e.get("response") or "").strip()
    tcs = e.get("tool_calls") or []
    if not r_txt and isinstance(e.get("resp_obj"), dict):
        ro = e["resp_obj"]
        r_txt = str(ro.get("text") or "").strip()
        if not tcs:
            tcs = ro.get("tool_calls") or []
    if r_txt:
        return r_txt
    if tcs:
        parts = []
        for tc in tcs[:4]:
            if isinstance(tc, dict):
                parts.append(f"🔧 {tc.get('name') or 'tool'}({str(tc.get('arguments') or '')[:120]})")
        if parts:
            return " | ".join(parts)
    return ""


def _slim_log(e):
    """Compact version of a log entry for the dashboard list, including both prompt and response previews."""
    err = e.get("error_detail")
    resp_prev = _resp_preview_from_entry(e)
    return {"id": e.get("id"), "time": e.get("time"), "ip": _clip(e.get("ip"), 60), "status": _clip(e.get("status"), 80),
            "kind": _log_kind(e), "model": _clip(e.get("model"), 80), "route": _clip(e.get("route"), 200),
            "response_ms": e.get("response_ms"), "message": _clip(e.get("message"), 500),
            "response": _clip(resp_prev, 600),
            "is_correct": bool(e.get("is_correct")), "password_used": _clip(e.get("password_used"), 40),
            "error": _clip(err, 600), "n_attempts": len(e.get("attempts") or []),
            "has_detail": True}


KEEP_SUCCESS_DETAIL = os.environ.get("LOG_KEEP_SUCCESS_DETAIL", "1") != "0"


def _scrub_success(e):
    """Keep bounded request & response text on the last 50 in-memory log entries so /wapi/logs always displays
    every incoming response and prompt properly (even without browser IndexedDB or after 5+ minutes)."""
    if e.get("scrubbed"):
        return
    if e.get("request"):
        e["request"] = _clip(e.get("request"), 8000)
    if e.get("response"):
        e["response"] = _clip(e.get("response"), 20000)
    if e.get("message"):
        e["message"] = _clip(e.get("message"), 1000)
    e["scrubbed"] = True


_trim_timer = None


def _trim_memory_soon():
    """After a big upload (images) give the freed memory back to the OS: python/glibc otherwise keeps it."""
    global _trim_timer
    if _trim_timer is not None:
        return
    def _do():
        global _trim_timer
        _trim_timer = None
        try:
            gc.collect()
            import ctypes
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except Exception:
            pass
    _trim_timer = threading.Timer(3.0, _do)
    _trim_timer.daemon = True
    _trim_timer.start()


def _log_preview(msg):
    """Short text for a message that may be a multimodal list (text + base64 images). Never str() the raw list."""
    if isinstance(msg, str):
        return msg
    if isinstance(msg, list):
        texts, files = [], 0
        for x in msg:
            if isinstance(x, dict) and x.get("type") in ("text", "input_text"):
                texts.append(str(x.get("text") or ""))
            elif isinstance(x, dict):
                files += 1
            elif isinstance(x, str):
                texts.append(x)
        t = " ".join(texts).strip()
        return (t[:300] + ("…" if len(t) > 300 else "")) + (f" [+{files} image/file]" if files else "")
    return _clip(msg, 300)

# ─── Shared question pool (used by test_all_keys AND auto-test on /add) ───────
# Questions are assigned by model-index so each model always gets a distinct
# prompt.  The list is intentionally longer than the number of models so new
# models added via /add also get a unique question automatically.
MODEL_QUESTIONS = [
    "What is your name? Answer in one sentence.",
    "What is 5 + 3? Just give the number.",
    "What is 10 - 7? Just give the number.",
    "What is 4 × 6? Just give the number.",
    "How old are you? Answer in one sentence.",
    "What color is the sky? One word answer.",
    "What is 2 + 2? Just give the number.",
    "What is the capital of France? One word.",
    "What is 3 × 3? Just give the number.",
    "What is the opposite of hot? One word.",
    "How many days are in a week? Just the number.",
    "What is 100 ÷ 4? Just give the number.",
]

def _question_for_model_idx(m_idx: int) -> str:
    """Return a deterministic question for a model by its index in MODELS."""
    return MODEL_QUESTIONS[m_idx % len(MODEL_QUESTIONS)]

def _test_single_combo(key: str, model_name: str, question: str, timeout: int = 15) -> dict:
    """
    Fire one test call for (key, model_name) and return a result dict.
    Does NOT touch RPM state — purely diagnostic. It DOES count a genuine
    200 towards rpd_count, though: this call is a REAL request against
    Google, so it really does consume a slice of that key+model's daily
    quota whether the router's internal counter knows about it or not.
    Not recording it here used to let "Test All Keys" silently burn real
    RPD headroom that the router still believed was fully available,
    causing later production requests on that key+model to fail with a
    real Google 429 that looked unexplained. Only successes are counted,
    for the same reason _record_rpd_success() only fires on 200 in the
    main proxy path — a 429/503/timeout here didn't consume any quota.
    """
    url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    payload = {"model": model_name, "messages": [{"role": "user", "content": question}], "max_tokens": 60}
    start = time.time()
    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
        elapsed = round((time.time() - start) * 1000)
        if resp.status_code == 200:
            try:
                text = resp.json()["choices"][0]["message"]["content"].strip()
            except Exception:
                text = resp.text
            with state_lock:
                _maybe_reset_rpd()
                _record_rpd_success(key, model_name)
                _clear_penalty(key, model_name)       # it answered -> it is NOT daily-penalized / cooling down
            return {"key": f"...{key[-4:]}", "model": model_name, "question": question,
                    "status": 200, "ok": True, "response": text, "ms": elapsed}
        else:
            try:
                err_msg = json.dumps(resp.json(), indent=2)
            except Exception:
                err_msg = resp.text
            return {"key": f"...{key[-4:]}", "model": model_name, "question": question,
                    "status": resp.status_code, "ok": False, "response": err_msg, "ms": elapsed}
    except Exception as e:
        return {"key": f"...{key[-4:]}", "model": model_name, "question": question,
                "status": 0, "ok": False,
                "response": f"Exception: {str(e)}",
                "ms": round((time.time() - start) * 1000)}

# ─── Test All Keys Route ───────────────────────────────────────────────────────
@app.route('/test_keys', methods=['GET'])
def test_all_keys():
    """
    Test every (key, model) combo with a simple 'What is your name?' message.
    Returns JSON with results for each combo — used by the dashboard Test button.
    These are REAL calls to Google, made directly (bypassing the router's
    combo-picking logic) — but a successful one now still counts against
    that key+model's tracked RPD, since it really did use up real quota.
    Auth: Bearer password required.
    """
    expected_pass = os.environ.get("PASSWORD", "")
    auth_header   = request.headers.get("Authorization", "")
    bearer_ok = (auth_header == f"Bearer {expected_pass}")
    basic_ok  = False
    if auth_header.startswith("Basic "):
        try:
            decoded = base64.b64decode(auth_header[6:]).decode("utf-8")
            _, pwd = decoded.split(":", 1)
            basic_ok = (pwd == expected_pass)
        except Exception:
            pass
    if not bearer_ok and not basic_ok:
        return Response("Unauthorized", 401, {"WWW-Authenticate": 'Basic realm="WAPI Test"'})

    # Questions are assigned by model-index using the shared MODEL_QUESTIONS pool
    # defined near /add — so newly added models automatically get a unique question
    # without any code change here.
    results = []

    # Optional filters (combine freely):
    #   ?key=<last chars of a key>  -> that ONE key on every model
    #   ?model=<model name>         -> that ONE model on every key
    #   ?key=..&model=..            -> a single (key, model) pair
    target_key_preview = request.args.get("key")
    target_model = (request.args.get("model") or "").strip().split("/")[-1]

    # Concurrency: firing all 72 combos at once (32 workers, near-simultaneous
    # TLS connections to the SAME Google host from this ONE server IP) reads
    # to Google's edge like a connection-flood, not 72 independent users --
    # it can trigger raw connection resets (SSLEOFError, SSLZeroReturnError,
    # "Remote end closed connection") on a big chunk of the batch that have
    # nothing to do with any key's real quota/health. A lower worker count
    # plus a small stagger between submissions keeps this a genuine health
    # check instead of a self-inflicted burst that makes healthy keys look
    # broken.
    tasks = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        for key in API_KEYS:
            if target_key_preview:
                clean_preview = target_key_preview.replace("...", "").strip()
                if not key.endswith(clean_preview):
                    continue
            model_list = [(i, m["name"]) for i, m in enumerate(MODELS)
                          if not target_model or m["name"].lower() == target_model.lower()]
            if target_model and not model_list:       # a model that is not in GEMINI_MODELS: test it as typed
                model_list = [(0, target_model)]
            for m_idx, model_name in model_list:
                question   = _question_for_model_idx(m_idx)
                tasks.append(executor.submit(_test_single_combo, key, model_name, question))
                time.sleep(0.12)  # stagger submissions so connections open gradually

    results = [t.result() for t in tasks]
    for r in results:                       # tests run even for blocked models (diagnostic) - just tell the page
        r["blocked_left"] = int(_model_block_left(r["model"]))

    total = len(results)
    ok_count = sum(1 for r in results if r["ok"])
    return jsonify({
        "total": total,
        "ok": ok_count,
        "failed": total - ok_count,
        "results": results
    })

# ─── Auth ─────────────────────────────────────────────────────────────────────
def check_browser_auth(username, password):
    return password == os.environ.get("PASSWORD", "")

def request_browser_login():
    return Response('Login Required', 401,
        {'WWW-Authenticate': 'Basic realm="Admin (password field = your API PASSWORD)"'})

def requires_browser_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.authorization
        if not auth or not check_browser_auth(auth.username, auth.password):
            return request_browser_login()
        return f(*args, **kwargs)
    return decorated

# ─── LIVE CAPTURE (RAM only, short-lived) ─────────────────────────────────────
# Full request (messages, tool calls, tools) + full response (text, tool calls) + the route trail of every
# /v1/chat/completions|responses request. NOTHING is written to disk or MongoDB. The record lives in RAM for
# LIVE_TTL seconds after the request ended; the /logs page in YOUR browser pulls it and keeps it in the browser's
# IndexedDB, so the server never has to hold history. Pending requests are visible while they run.
LIVE_TTL = float(os.environ.get("LIVE_TTL", "1800"))
LIVE_MAX = int(os.environ.get("LIVE_MAX", "200"))
BOOT_ID = str(int(time.time()))
live_full = collections.OrderedDict()   # log id -> record
live_lock = threading.Lock()


def _live_prune():
    now = time.time()
    for k in list(live_full):
        r = live_full[k]
        age = now - (r.get("t1") or r["t0"])
        if (r["done"] and age > LIVE_TTL) or age > 900:
            live_full.pop(k, None)
    while len(live_full) > LIVE_MAX:
        live_full.popitem(last=False)


def _lc(v, n):
    v = "" if v is None else (v if isinstance(v, str) else str(v))
    return v if len(v) <= n else v[:n] + "…[+" + str(len(v) - n) + " chars]"


def _live_content(c, n):
    if isinstance(c, str):
        return _lc(c, n)
    if isinstance(c, list):
        out = []
        for x in c:
            if isinstance(x, dict):
                t = x.get("type")
                if t in (None, "text", "input_text", "output_text"):
                    out.append(_lc(x.get("text"), n))
                else:
                    u = x.get("image_url")
                    size = len((u.get("url") if isinstance(u, dict) else u) or x.get("file_data") or x.get("data") or "")
                    out.append(f"[{t or 'file'} ~{size // 1024} KB]")
            else:
                out.append(_lc(x, n))
        return "\n".join(out)
    return _lc(c, n)


def _live_tcs(tcs):
    out = []
    for tc in (tcs or []):
        if isinstance(tc, dict):
            fn = tc.get("function") or tc
            out.append({"id": tc.get("id") or tc.get("call_id"), "name": fn.get("name"),
                        "arguments": _lc(fn.get("arguments") if not isinstance(fn.get("arguments"), (dict, list)) else json.dumps(fn.get("arguments"), ensure_ascii=False), 4000)})
    return out


def _live_msg(m):
    if not isinstance(m, dict):
        return {"role": "?", "content": _lc(m, 2000)}
    role = m.get("role") or m.get("type") or "?"
    d = {"role": role}
    if m.get("name"):
        d["name"] = m["name"]
    if m.get("tool_call_id") or m.get("call_id"):
        d["tool_call_id"] = m.get("tool_call_id") or m.get("call_id")
    if "content" in m:
        d["content"] = _live_content(m.get("content"), 2500 if role in ("system", "developer") else 4000)
    elif "output" in m:                      # Responses API function_call_output
        d["content"] = _live_content(m.get("output"), 4000)
    elif "text" in m:
        d["content"] = _lc(m.get("text"), 4000)
    if m.get("tool_calls"):
        d["tool_calls"] = _live_tcs(m["tool_calls"])
    if role == "function_call":              # Responses API function_call item
        d["tool_calls"] = _live_tcs([m])
    return d


def _live_req(raw, path):
    msgs = raw.get("messages")
    if msgs is None:
        inp = raw.get("input")
        msgs = [{"role": "user", "content": inp}] if isinstance(inp, str) else list(inp or [])
        if raw.get("instructions"):
            msgs = [{"role": "system", "content": raw["instructions"]}] + msgs
    msgs = [m for m in (msgs or [])]
    tools = []
    for t in (raw.get("tools") or []):
        if isinstance(t, dict):
            fn = t.get("function") or t
            try:
                ps = json.dumps(fn.get("parameters") or {}, ensure_ascii=False)
            except Exception:
                ps = ""
            tools.append({"name": str(fn.get("name") or t.get("type") or "?"), "description": _lc(fn.get("description"), 300), "parameters": _lc(ps, 1200)})
    params = {k: raw[k] for k in ("model", "stream", "temperature", "top_p", "max_tokens", "max_completion_tokens",
                                  "tool_choice", "reasoning_effort", "response_format") if k in raw}
    return {"path": path, "params": params, "n_messages": len(msgs),
            "messages": [_live_msg(m) for m in msgs[-30:]], "messages_cut": max(0, len(msgs) - 30), "tools": tools[:60]}


def _live_begin(log_entry, raw, path):
    try:
        req_obj = _live_req(raw, path)
        log_entry["req_obj"] = req_obj
        log_entry.setdefault("trail", [])
        rec = {"id": log_entry["id"], "boot": BOOT_ID, "t0": time.time(), "t1": None, "done": False,
               "req": req_obj, "resp": None, "trail": log_entry["trail"], "attempts": [], "log": log_entry}
        with live_lock:
            live_full[rec["id"]] = rec
            _live_prune()
        g.live = rec
    except Exception as e:
        print(f"[LIVE] begin failed: {e}")


def _live_attach(attempt_errors):
    rec = getattr(g, "live", None)
    if rec is not None:
        rec["attempts"] = attempt_errors      # same list object -> always current


def _trail(text):
    try:
        rec = getattr(g, "live", None)
        if rec is not None and len(rec["trail"]) < 80:
            rec["trail"].append(f"+{int((time.time() - rec['t0']) * 1000)}ms {text}")
    except Exception:
        pass


def _extract_msg_content_str(c) -> str:
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts = []
        for p in c:
            if isinstance(p, dict):
                if p.get("text"):
                    parts.append(str(p.get("text")))
                elif p.get("content"):
                    parts.append(str(p.get("content")))
            elif isinstance(p, str):
                parts.append(p)
        return "".join(parts)
    return "" if c is None else str(c)


def _live_resp_from_json(j):
    out = {}
    if not isinstance(j, dict):
        return out
    if "choices" in j and isinstance(j.get("choices"), list):
        ch = (j.get("choices") or [{}])[0] or {}
        m = ch.get("message") or ch.get("delta") or {}
        txt = _extract_msg_content_str(m.get("content"))
        rc = m.get("reasoning_content") or m.get("reasoning") or m.get("thought")
        if rc and isinstance(rc, str):
            txt = (f"[Thinking]\n{rc.strip()}\n\n{txt}" if txt else f"[Thinking]\n{rc.strip()}")
        out["text"] = _lc(txt, 20000)
        tcs = m.get("tool_calls") or ([m.get("function_call")] if m.get("function_call") else [])
        out["tool_calls"] = _live_tcs(tcs)
        out["finish_reason"] = ch.get("finish_reason")
    elif isinstance(j.get("output"), list) or "output_text" in j:
        texts, tcs = [], []
        for it in (j.get("output") or []):
            if not isinstance(it, dict):
                continue
            if it.get("type") == "message":
                for c in (it.get("content") or []):
                    if isinstance(c, dict) and (c.get("text") or c.get("output_text")):
                        texts.append(str(c.get("text") or c.get("output_text")))
            elif it.get("type") in ("function_call", "custom_tool_call"):
                tcs.append(it)
        if not texts and j.get("output_text"):
            texts.append(str(j.get("output_text")))
        out["text"] = _lc("".join(texts), 20000)
        out["tool_calls"] = _live_tcs(tcs)
        out["finish_reason"] = j.get("status")
    elif "candidates" in j and isinstance(j.get("candidates"), list):
        cand = (j.get("candidates") or [{}])[0] or {}
        parts = ((cand.get("content") or {}).get("parts")) or []
        texts, tcs = [], []
        for p in parts:
            if isinstance(p, dict):
                if p.get("text"):
                    texts.append(str(p.get("text")))
                if p.get("functionCall"):
                    fc = p["functionCall"]
                    tcs.append({"name": fc.get("name"), "arguments": json.dumps(fc.get("args") or {}, ensure_ascii=False)})
        out["text"] = _lc("".join(texts), 20000)
        out["tool_calls"] = _live_tcs(tcs)
        out["finish_reason"] = cand.get("finishReason")
    elif isinstance(j.get("text"), str):
        out["text"] = _lc(j["text"], 20000)
    if j.get("error"):
        try:
            out["error"] = _lc(json.dumps(j["error"], ensure_ascii=False) if isinstance(j["error"], (dict, list)) else str(j["error"]), 3000)
        except Exception:
            out["error"] = _lc(j["error"], 3000)
    if isinstance(j.get("usage"), dict):
        out["usage"] = j["usage"]
    return out


def _sync_resp_to_log_entry(log_entry, resp_obj):
    if not isinstance(log_entry, dict) or not isinstance(resp_obj, dict):
        return
    log_entry["resp_obj"] = resp_obj
    if resp_obj.get("text"):
        log_entry["response"] = _lc(resp_obj["text"], 20000)
    elif resp_obj.get("error") and not log_entry.get("response"):
        log_entry["response"] = _lc(resp_obj["error"], 4000)
    if resp_obj.get("tool_calls"):
        log_entry["tool_calls"] = resp_obj["tool_calls"]
    if resp_obj.get("finish_reason"):
        log_entry["finish_reason"] = resp_obj["finish_reason"]
    if resp_obj.get("usage"):
        log_entry["usage"] = resp_obj["usage"]


class _LiveAcc:
    """Collects the answer of an SSE stream (chat deltas + tool-call deltas + Responses 'completed') while it is relayed."""
    def __init__(self, rec=None, log_entry=None):
        self.buf = b""
        self.text = []
        self.n = 0
        self.tcs = {}
        self.finish = None
        self.usage = None
        self.final = None
        self.rec = rec
        self.log_entry = log_entry

    def _process_line(self, ln: bytes):
        ln = ln.strip()
        if not ln.startswith(b"data:") or ln.endswith(b"[DONE]"):
            return
        try:
            o = json.loads(ln[5:].strip())
        except Exception:
            return
        if not isinstance(o, dict):
            return
        if o.get("type") == "response.completed" and isinstance(o.get("response"), dict):
            self.final = o.get("response")
            return
        if o.get("type") == "response.output_text.delta" and o.get("delta") and self.n < 20000:
            s_delta = str(o.get("delta"))
            self.text.append(s_delta)
            self.n += len(s_delta)
            return
        if isinstance(o.get("usage"), dict):
            self.usage = o["usage"]
        for ch in (o.get("choices") or []):
            if not isinstance(ch, dict):
                continue
            d = ch.get("delta") or ch.get("message") or {}
            c = _extract_msg_content_str(d.get("content"))
            rc = d.get("reasoning_content") or d.get("reasoning")
            if rc and isinstance(rc, str) and not c:
                c = rc
            if c and self.n < 20000:
                self.text.append(c)
                self.n += len(c)
            for tc in (d.get("tool_calls") or []):
                if not isinstance(tc, dict):
                    continue
                cur = self.tcs.setdefault(tc.get("index", 0), {"id": None, "name": "", "arguments": ""})
                if tc.get("id"):
                    cur["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    cur["name"] += fn["name"]
                if fn.get("arguments") and len(cur["arguments"]) < 4000:
                    cur["arguments"] += fn["arguments"]
            if ch.get("finish_reason"):
                self.finish = ch["finish_reason"]

    def feed(self, chunk):
        self.buf += chunk
        if b"\n" not in self.buf:
            if len(self.buf) > 262144:      # one giant line / binary download: never keep it all in RAM
                self.buf = b""
            return
        *lines, self.buf = self.buf.split(b"\n")
        for ln in lines:
            self._process_line(ln)
        # Live update preview while streaming
        if self.text and self.log_entry is not None:
            cur_txt = _lc("".join(self.text), 20000)
            self.log_entry["response"] = cur_txt
            if self.rec is not None:
                self.rec["resp"] = {"text": cur_txt, "tool_calls": list(self.tcs.values()), "finish_reason": self.finish, "status_code": 200}

    def result(self):
        if self.buf.strip():
            try:
                for ln in self.buf.split(b"\n"):
                    self._process_line(ln)
            except Exception:
                pass
            self.buf = b""
        if self.final:
            return _live_resp_from_json(self.final)
        out = {"text": _lc("".join(self.text), 20000), "tool_calls": list(self.tcs.values()), "finish_reason": self.finish}
        if self.usage:
            out["usage"] = self.usage
        return out


def _live_finish(rec, resp_obj, status_code, log_entry=None):
    ro = dict(resp_obj or {}, status_code=status_code)
    if rec is not None:
        rec["resp"] = ro
        rec["t1"] = time.time()
        rec["done"] = True
        if log_entry is None:
            log_entry = rec.get("log")
    if log_entry is not None:
        _sync_resp_to_log_entry(log_entry, ro)


def _live_wrap_stream(it, rec, status_code, log_entry=None):
    if log_entry is None and rec is not None:
        log_entry = rec.get("log")
    acc = _LiveAcc(rec=rec, log_entry=log_entry)
    def gen():
        for chunk in it:
            try:
                acc.feed(chunk if isinstance(chunk, bytes) else str(chunk).encode("utf-8", "replace"))
            except Exception:
                pass
            yield chunk
    def _done():
        try:
            if rec is None or not rec.get("done"):
                _live_finish(rec, acc.result(), status_code, log_entry=log_entry)
        finally:
            close = getattr(it, "close", None)
            if close:
                try: close()
                except Exception: pass
    return _GuardedIter(gen(), _done)


def _live_after(response):
    rec = getattr(g, "live", None)
    log_entry = getattr(g, "log_entry", None)
    if rec is None and log_entry is None:
        return
    if rec is not None and rec.get("done"):
        if log_entry is not None and rec.get("resp"):
            _sync_resp_to_log_entry(log_entry, rec["resp"])
        return
    if response.is_streamed:
        response.response = _live_wrap_stream(response.response, rec, response.status_code, log_entry=log_entry)
        return
    if response.direct_passthrough:
        _live_finish(rec, {}, response.status_code, log_entry=log_entry)
        return
    body = response.get_data()
    obj = {}
    if len(body) < 4_000_000:
        mime = (response.mimetype or "").lower()
        if "json" in mime:
            try:
                obj = _live_resp_from_json(json.loads(body.decode("utf-8", "replace")))
            except Exception:
                obj = {"text": _lc(body.decode("utf-8", "replace"), 4000)}
        elif "text/" in mime and "html" not in mime:
            obj = {"text": _lc(body.decode("utf-8", "replace"), 4000)}
    _live_finish(rec, obj, response.status_code, log_entry=log_entry)


def _live_public(r):
    return {"id": r["id"], "boot": r["boot"], "t0": r["t0"], "t1": r["t1"], "done": r["done"], "req": r["req"],
            "resp": r["resp"], "trail": list(r["trail"]), "attempts": [_lc(a, 700) for a in list(r["attempts"])[-25:]],
            "slim": _slim_log(r["log"])}


def _live_view(since, boot, pending):
    if boot != BOOT_ID:
        since, pending = 0, set()
    with live_lock:
        _live_prune()
        recs = [r for r in live_full.values() if r["id"] > since or r["id"] in pending]
    return jsonify({"boot": BOOT_ID, "recs": [_live_public(r) for r in recs[:60]]})


@app.before_request
def strict_password_and_log():
    if request.method == 'OPTIONS':
        return
    if request.path in ['/ping', '/healthz', '/logs', '/dashboard_data', '/status', '/test_keys', '/release_daily', '/router/release_daily',
                        '/model_block', '/router/model_block', '/model_config', '/router/model_config', '/model_available', '/router/model_available', '/model_test', '/router/model_test']:
        return
    if request.path == WEBAPI_PREFIX or request.path.startswith(WEBAPI_PREFIX + '/'):
        return  # /api/web/v1 -> own auth inside webapi_proxy() (Bearer OR browser Basic)
    g._log_start = time.monotonic()  # for response_ms in after_request, not stored in log_entry itself
    expected_pass = os.environ.get("PASSWORD", "")
    auth_header   = request.headers.get("Authorization", "")
    is_correct    = (auth_header == f"Bearer {expected_pass}")

    msg = ""
    if request.is_json:
        try:
            body = request.get_json(silent=True) or {}
            msgs = body.get("messages")
            if msgs is None and "input" in body:
                inp = body.get("input")
                msgs = [{"role": "user", "content": inp}] if isinstance(inp, str) else (inp if isinstance(inp, list) else [])
            if isinstance(msgs, list) and msgs:
                user_msgs = [m for m in msgs if isinstance(m, dict) and m.get("role") == "user"]
                target_m = user_msgs[-1] if user_msgs else (msgs[-1] if isinstance(msgs[-1], dict) else {})
                msg = target_m.get("content", "") if isinstance(target_m, dict) else str(target_m)
        except Exception:
            pass

    _files_note = ""
    if isinstance(msg, list):                      # multimodal: text parts + images/files (never str() the raw list)
        _n = sum(1 for x in msg if isinstance(x, dict) and x.get("type") not in ("text", "input_text", "output_text"))
        _files_note = f" [+{_n} image/file]" if _n else ""
        msg = " ".join(str(x.get("text") or "") for x in msg if isinstance(x, dict) and x.get("type") in ("text", "input_text", "output_text")).strip()
    msg = _log_preview(msg)
    formatted_msg = (str(msg).strip() if msg else "") + _files_note

    log_entry = {
        "time": datetime.datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
        "ip": request.headers.get("Cf-Connecting-Ip",
              request.headers.get("X-Forwarded-For", request.remote_addr)),
        "path": request.path,
        "password_used": "*** HIDDEN (CORRECT) ***" if is_correct else auth_header,
        "is_correct": is_correct,
        "message": formatted_msg,
        "model": None,           # filled in on a successful 200 (which key/model served it)
        "response_ms": None,     # filled in in after_request below
        "error_detail": None,    # filled in on failure -- WHY it failed, not just the status code
        "status": "Pending..."
    }
    # Request details for EVERY logged request (proxy_chat replaces this with a richer summary).
    # Bodies are only read for JSON (already parsed above) - never for uploads, so multipart parsing stays intact.
    _body_note = "(no body)"
    if request.is_json:
        try:
            _braw = request.get_data()
            _bt = _braw[:500].decode("utf-8", "replace")
            _body_note = f"body ({len(_braw) // 1024} KB):\n" + _bt + ("…" if len(_braw) > 500 else "")
        except Exception:
            _body_note = "(unreadable body)"
    elif request.content_length:
        _body_note = f"body: {request.content_length} bytes ({request.mimetype})"
    log_entry["request"] = f"{request.method} {request.full_path.rstrip('?')}\n{_body_note}\nheaders:\n{_safe_headers(request.headers)}"
    log_entry["route"] = None
    g.log_entry = log_entry
    request_logs.appendleft(log_entry)

    if not is_correct:
        log_entry["status"] = "401 Blocked"
        return jsonify({"error": "Unauthorized Access. Invalid Password."}), 401

@app.after_request
def update_log_status(response):
    if hasattr(g, 'log_entry'):
        if g.log_entry["status"] == "Pending...":
            g.log_entry["status"] = f"{response.status_code} {'Success' if response.status_code == 200 else 'Failed'}"
        if request.url_rule is None and response.status_code in (404, 405) and not g.log_entry.get("error_detail"):
            # Flask itself answered (no route matched) -> nothing was forwarded to Gemini / WebAI.
            if response.status_code == 405:
                g.log_entry["error_detail"] = (f"405: route {request.path} exists but method {request.method} is not allowed "
                                               f"(allowed: {response.headers.get('Allow', '?')})")
            else:
                _valid = sorted({r.rule for r in app.url_map.iter_rules() if r.endpoint != "static"})
                g.log_entry["error_detail"] = (f"404: wapi router has NO route '{request.path}' (nothing was forwarded to Gemini/WebAI). "
                                               f"Wrong URL from the client? Via nginx use /wapi/<route>. Valid routes: {', '.join(_valid)}")
            g.log_entry["route"] = "No route matched (not forwarded anywhere)"
        if response.status_code >= 400 and not g.log_entry.get("error_detail") and not response.is_streamed:
            try:
                g.log_entry["error_detail"] = _short_err(response.get_data(as_text=True), 400)
            except Exception:
                pass
        if g.log_entry.get("response_ms") is None and hasattr(g, "_log_start"):
            g.log_entry["response_ms"] = round((time.monotonic() - g._log_start) * 1000)
        try:                       # logging bookkeeping must never be able to change or break a response
            if _log_kind(g.log_entry) == "fail" and not g.log_entry.get("_in_failed"):
                g.log_entry["_in_failed"] = True
                failed_logs.appendleft(g.log_entry)
            _scrub_success(g.log_entry)
        except Exception:
            pass
    try:
        _live_after(response)
    except Exception as _e:
        print(f"[LIVE] after failed: {_e}")
    try:
        if (request.content_length or 0) > 1_000_000:
            _trim_memory_soon()
    except Exception:
        pass
    return response

# ─── Dashboard ────────────────────────────────────────────────────────────────
@app.route('/dashboard_data', methods=['GET'])
@requires_browser_auth
def api_dashboard_data():
    if request.args.get("detail") is not None:
        return _log_detail(request.args.get("detail"))
    if request.args.get("live_since") is not None:
        try:
            _since = int(request.args.get("live_since") or 0)
        except ValueError:
            _since = 0
        _pend = {int(x) for x in (request.args.get("pending") or "").split(",") if x.strip().isdigit()}
        return _live_view(_since, request.args.get("boot", ""), _pend)
    now = time.time()
    now_mono = time.monotonic()
    with state_lock:
        _maybe_reset_rpd()
        now_ist = datetime.datetime.now(IST)
        next_midnight = (now_ist + datetime.timedelta(days=1)).replace(hour=0, minute=0, second=5, microsecond=0)
        mins_to_midnight = max(1.0, round((next_midnight.astimezone(datetime.timezone.utc).timestamp() - now) / 60, 1))
        active_models_snap = get_active_models()

        penalized = {}
        for (k, m), ts in key_daily_penalty.items():
            if ts > now:
                penalized[f"{k[:5]}...{k[-5:]}|{m}"] = round((ts - now) / 60, 1)
        for k in API_KEYS:
            for m_obj in active_models_snap:
                mn = m_obj["name"]
                label = f"{k[:5]}...{k[-5:]}|{mn}"
                if label not in penalized:
                    if (k, mn) in PERMANENTLY_BROKEN_MODELS:
                        penalized[label] = mins_to_midnight
                    elif not _rpd_available(k, mn, m_obj["rpd"]):
                        penalized[label] = mins_to_midnight

        cooldowns = {
            f"{k[:5]}...{k[-5:]}|{m}": round(ts - now_mono, 1)
            for (k, m), ts in rpm_cooldown.items() if ts > now_mono
        }
        key_list = [f"...{k[-4:]}" for k in API_KEYS]
        # Per-model: count of available keys and list of penalized key last-5 digits
        model_key_info = {}
        for m in active_models_snap:
            mn = m["name"]
            pen_keys = []
            available = 0
            for k in API_KEYS:
                if _is_daily_penalized(k, mn) or (k, mn) in PERMANENTLY_BROKEN_MODELS or not _rpd_available(k, mn, m["rpd"]):
                    pen_keys.append(k[-5:])
                else:
                    available += 1
            model_key_info[mn] = {"available": available, "penalized_last5": pen_keys,
                                  "blocked_left": int(_model_block_left(mn))}
    cfg_list = _cfg_view()
    return jsonify({
        "metrics": metrics,
        "active_keys": len(API_KEYS),
        "key_list": key_list,
        "penalized_keys": penalized,
        "rpm_cooldowns": cooldowns,
        "models": active_models_snap,
        "model_key_info": model_key_info,
        "model_blocks": _model_blocks_view(),
        "usage": _usage_view(),
        "model_cfg": {m["name"]: {"saved": m["saved"], "in_env": m["in_env"],
                                  "last_tier": m["last_tier"], "last_tier_manual": m["last_tier_manual"],
                                  "default_lite": m["default_lite"]} for m in cfg_list},
        "last_tier_models": [m["name"] for m in cfg_list if m["last_tier"]],
        "primary_tier_models": [m["name"] for m in cfg_list if not m["last_tier"]],
        **_dash_logs(request.args.get("slim") == "1"),
    })


def _dash_logs(slim):
    recent = list(request_logs)
    if not slim:      # old format (kept for any other client); only the huge message text is clipped
        return {"logs": [dict(e, message=_clip(e.get("message"), 2000), response=_clip(_resp_preview_from_entry(e), 4000)) for e in recent]}
    ids = {e.get("id") for e in recent}
    older = [e for e in list(failed_logs) if e.get("id") not in ids]
    return {"logs": [_slim_log(e) for e in recent], "older_errors": [_slim_log(e) for e in older]}


def _log_detail(raw_id):
    """Full details of ONE log entry (response, tool calls, request messages, route trail, attempts, full error)."""
    try:
        want = int(raw_id)
    except (TypeError, ValueError):
        return jsonify({"error": "bad id"}), 400
    with live_lock:
        live_rec = live_full.get(want)
    e = next((x for x in list(request_logs) + list(failed_logs) if x.get("id") == want), None)
    if e is None and live_rec is not None:
        e = live_rec.get("log")
    if e is None:
        return jsonify({"error": "log entry is gone (only the newest requests are kept)"}), 404
    req, err = str(e.get("request") or ""), str(e.get("error_detail") or "")
    resp_txt = str(e.get("response") or "")
    resp_obj = e.get("resp_obj")
    req_obj = e.get("req_obj")
    trail = list(e.get("trail") or [])
    if live_rec is not None:
        if not resp_obj and live_rec.get("resp"):
            resp_obj = live_rec["resp"]
        if not req_obj and live_rec.get("req"):
            req_obj = live_rec["req"]
        if not trail and live_rec.get("trail"):
            trail = list(live_rec["trail"])
        if not resp_txt and isinstance(resp_obj, dict) and resp_obj.get("text"):
            resp_txt = str(resp_obj["text"])
    att = [_clip(a, 700) for a in (e.get("attempts") or (live_rec.get("attempts") if live_rec else []) or [])[-25:]]
    return jsonify({
        "id": want,
        "status": e.get("status"),
        "model": e.get("model"),
        "route": e.get("route"),
        "response_ms": e.get("response_ms"),
        "message": _clip(e.get("message") or "", 4000),
        "response": _clip(resp_txt, 20000),
        "response_truncated": len(resp_txt) > 20000,
        "tool_calls": e.get("tool_calls") or (resp_obj.get("tool_calls") if isinstance(resp_obj, dict) else []) or [],
        "finish_reason": e.get("finish_reason") or (resp_obj.get("finish_reason") if isinstance(resp_obj, dict) else None),
        "usage": e.get("usage") or (resp_obj.get("usage") if isinstance(resp_obj, dict) else None),
        "req": req_obj,
        "resp": resp_obj or ({"text": _clip(resp_txt, 20000), "tool_calls": e.get("tool_calls") or [], "status_code": 200 if str(e.get("status") or "").startswith("200") else 0} if (resp_txt or e.get("tool_calls")) else None),
        "trail": trail,
        "request": _clip(req, 8000),
        "request_truncated": len(req) > 8000,
        "error_detail": _clip(err, 8000),
        "error_truncated": len(err) > 8000,
        "attempts": att,
    })

def _admin_ok() -> bool:
    """Bearer <PASSWORD> (scripts / curl) OR browser Basic auth (dashboard). Refuses everything when PASSWORD is unset."""
    import hmac
    expected = os.environ.get("PASSWORD", "")
    if not expected:
        return False
    h = request.headers.get("Authorization", "")
    if h.startswith("Bearer ") and hmac.compare_digest(h[7:], expected):
        return True
    a = request.authorization
    return bool(a and a.password is not None and hmac.compare_digest(str(a.password), expected))


@app.route('/model_block', methods=['GET', 'POST', 'DELETE', 'OPTIONS'])
@app.route('/router/model_block', methods=['GET', 'POST', 'DELETE', 'OPTIONS'])
def model_block_api():
    """Block a model on ALL keys for a custom time, list the blocks, or lift them.
      GET                                    -> {"blocks": [...]}
      POST {"model": "gemini-3.5-flash", "duration": "43d"}            (1h, 6h, 1d, 43d, 90m, 2h30m, 1w, 3mo, forever)
      POST {"model": "...", "seconds"|"minutes"|"hours"|"days": N}     numeric alternatives
      POST {"model": "...", "until": "2026-12-31T23:59" | <epoch>}     absolute end (IST when no zone is given)
           optional "reason": "why"
      POST {"action": "unblock", "model": "..."}  or  DELETE ?model=...  -> lift one block
      POST {"action": "unblock_all"}              or  DELETE            -> lift every block
    Auth: Authorization: Bearer <PASSWORD> (or the dashboard's browser login)."""
    if request.method == 'OPTIONS':
        return Response(status=200)
    if not _admin_ok():
        return Response("Unauthorized", 401, {"WWW-Authenticate": 'Basic realm="Admin (password field = your API PASSWORD)"'})
    body = request.get_json(silent=True) or {}
    if request.method == 'GET':
        return jsonify({"blocks": _model_blocks_view()})

    action = str(body.get("action") or ("unblock" if request.method == 'DELETE' else "block")).lower()
    model = str(body.get("model") or request.args.get("model") or "").strip()

    if action in ("unblock_all", "clear") or (action == "unblock" and model in ("*", "all")) \
            or (request.method == 'DELETE' and not model):
        with state_lock:
            n = len(MODEL_BLOCKS)
            MODEL_BLOCKS.clear()
        _blocks_persist("clear")
        print(f"[MODEL BLOCK] all blocks lifted ({n})")
        return jsonify({"unblocked": n, "blocks": []})

    if not model or _bk(model) in _GENERIC_MODEL_ALIASES:
        return jsonify({"error": "model is required (a real model name, not auto/default)"}), 400
    bk = _bk(model)

    if action == "unblock":
        with state_lock:
            was = MODEL_BLOCKS.pop(bk, None)
        _blocks_persist("del", bk)
        print(f"[MODEL BLOCK] {model} unblocked")
        return jsonify({"unblocked": 1 if was else 0, "model": model, "blocks": _model_blocks_view()})

    if action != "block":
        return jsonify({"error": f"unknown action '{action}' (block | unblock | unblock_all)"}), 400

    now = time.time()
    secs = None
    if body.get("duration") not in (None, ""):
        secs = parse_duration(body.get("duration"))
        if secs is None:
            return jsonify({"error": f"cannot read duration '{body.get('duration')}' - use e.g. 1h, 1d, 43d, 90m, 2h30m, 1w, forever"}), 400
    else:
        for field, mult in (("seconds", 1), ("minutes", 60), ("hours", 3600), ("days", 86400)):
            if body.get(field) not in (None, ""):
                try:
                    secs = float(body[field]) * mult
                except (TypeError, ValueError):
                    return jsonify({"error": f"'{field}' must be a number"}), 400
                break
        if secs is None and body.get("until") not in (None, ""):
            u = body["until"]
            try:
                if isinstance(u, (int, float)) or re.fullmatch(r"\d+(\.\d+)?", str(u).strip()):
                    end = float(u)
                else:
                    dt = datetime.datetime.fromisoformat(str(u).strip().replace("Z", "+00:00"))
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=IST)
                    end = dt.timestamp()
            except ValueError:
                return jsonify({"error": f"cannot read until '{u}' - use e.g. 2026-12-31T23:59 (IST) or an epoch"}), 400
            secs = end - now
    if secs is None:
        return jsonify({"error": "give a duration (e.g. \"duration\": \"43d\") or seconds/minutes/hours/days or until"}), 400
    if secs <= 0:
        return jsonify({"error": "the block time must be in the future"}), 400
    secs = min(secs, MAX_BLOCK_SECS)
    display = next((m["name"] for m in MODELS if _bk(m["name"]) == bk), model.split("/")[-1])
    with state_lock:
        MODEL_BLOCKS[bk] = {"model": display, "until": now + secs, "since": now,
                            "reason": str(body.get("reason") or "")[:200]}
    _blocks_persist("set", bk)
    print(f"[MODEL BLOCK] {display} blocked on all keys for {int(secs)}s")
    return jsonify({"blocked": display, "seconds": int(secs), "known_model": any(_bk(m["name"]) == bk for m in MODELS),
                    "blocks": _model_blocks_view()})


def _parse_model_names_input(raw_models):
    """Accepts a list of strings or a comma/newline/space-separated string of model names."""
    if isinstance(raw_models, str):
        items = re.split(r"[,\s\n;]+", raw_models)
    elif isinstance(raw_models, (list, tuple, set)):
        items = []
        for x in raw_models:
            if isinstance(x, str):
                items.extend(re.split(r"[,\s\n;]+", x))
    else:
        items = []
    cleaned, seen = [], set()
    for it in items:
        if not it or not str(it).strip():
            continue
        cn = _cfg_clean_name(it)
        if cn and _bk(cn) not in seen:
            seen.add(_bk(cn))
            cleaned.append(cn)
    return cleaned


@app.route('/model_config', methods=['GET', 'POST', 'DELETE', 'OPTIONS'])
@app.route('/router/model_config', methods=['GET', 'POST', 'DELETE', 'OPTIONS'])
def model_config_api():
    """Add a model with its RPM / RPD limits (saved: survives restarts), change its limits, remove it,
    or manage the persistent Last-Tier ('use last', like lite models) model list.
      GET  -> {"models": [{name, rpm, rpd, saved, in_env, last_tier, last_tier_manual}, ...], "last_tier_models": [...]}
      POST {"model": "gemini-3.9-flash", "rpm": 10, "rpd": 250, "last_tier": true}
      POST {"action": "set_last_tier", "mode": "add"|"remove"|"replace"|"toggle"|"reset", "models": ["m1", "m2"]}
      POST {"action": "delete", "model": "..."}  or  DELETE ?model=...
    Auth: Authorization: Bearer <PASSWORD> (or the dashboard's browser login)."""
    if request.method == 'OPTIONS':
        return Response(status=200)
    if not _admin_ok():
        return Response("Unauthorized", 401, {"WWW-Authenticate": 'Basic realm="Admin (password field = your API PASSWORD)"'})
    if request.method == 'GET':
        view = _cfg_view()
        return jsonify({
            "models": view,
            "last_tier_models": [m["name"] for m in view if m["last_tier"]],
            "primary_tier_models": [m["name"] for m in view if not m["last_tier"]],
        })
    body = request.get_json(silent=True) or {}
    action = str(body.get("action") or ("delete" if request.method == 'DELETE' else "set")).lower()

    if action in ("last_tier", "set_last_tier", "update_last_tier"):
        mode = str(body.get("mode") or ("Add" if body.get("last_tier", True) else "remove")).strip().lower()
        raw_list = body.get("models") if "models" in body else (body.get("model") or body.get("names") or "")
        names = _parse_model_names_input(raw_list)
        def_rpm = _cfg_int(body.get("rpm"), 1, 1_000_000)
        def_rpd = _cfg_int(body.get("rpd"), 1, 100_000_000)
        added_new = []
        with state_lock:
            if mode in ("reset", "reset_default", "default"):
                LAST_TIER_OVERRIDES.clear()
            elif mode == "replace":
                target_bks = {_bk(n) for n in names}
                # Ensure any newly typed models are also added to MODELS & CUSTOM_CFG so they participate in routing
                for n in names:
                    bk = _bk(n)
                    if not any(_bk(m["name"]) == bk for m in MODELS):
                        s_rpm, s_rpd, _ = _suggest_limits(n)
                        _cfg_save(n, def_rpm or s_rpm, def_rpd or s_rpd, last_tier=True)
                        added_new.append(n)
                for m in MODELS:
                    mbk = _bk(m["name"])
                    LAST_TIER_OVERRIDES[mbk] = (mbk in target_bks)
            elif mode in ("add", "true", "1", "set"):
                if not names:
                    return jsonify({"error": "Provide at least one valid model name to add to Last-Tier"}), 400
                for n in names:
                    bk = _bk(n)
                    if not any(_bk(m["name"]) == bk for m in MODELS):
                        s_rpm, s_rpd, _ = _suggest_limits(n)
                        _cfg_save(n, def_rpm or s_rpm, def_rpd or s_rpd, last_tier=True)
                        added_new.append(n)
                    else:
                        LAST_TIER_OVERRIDES[bk] = True
            elif mode in ("remove", "false", "0", "primary", "unset"):
                if not names:
                    return jsonify({"error": "Provide at least one valid model name to move to Primary Tier"}), 400
                for n in names:
                    LAST_TIER_OVERRIDES[_bk(n)] = False
            elif mode == "toggle":
                if not names:
                    return jsonify({"error": "Provide at least one model name to toggle"}), 400
                for n in names:
                    bk = _bk(n)
                    LAST_TIER_OVERRIDES[bk] = not _is_lite(n)
            else:
                return jsonify({"error": f"Unknown mode '{mode}' (add | remove | replace | toggle | reset)"}), 400
        _last_tier_save()
        view = _cfg_view()
        lt_list = [m["name"] for m in view if m["last_tier"]]
        print(f"[LAST TIER] mode={mode} names={names} added_new={added_new} -> last_tier={lt_list}")
        return jsonify({
            "ok": True,
            "mode": mode,
            "updated_models": names,
            "added_new": added_new,
            "last_tier_models": lt_list,
            "primary_tier_models": [m["name"] for m in view if not m["last_tier"]],
            "models": view,
        })

    raw = body.get("model") or body.get("name") or request.args.get("model")
    name = _cfg_clean_name(raw)
    if name is None:
        return jsonify({"error": "model name is required: letters, digits, . _ - / only (no spaces), e.g. gemini-3.9-flash"}), 400
    bk = _bk(name)

    if action == "delete":
        with state_lock:
            had = CUSTOM_CFG.pop(bk, None)
            had_lt = LAST_TIER_OVERRIDES.pop(bk, None)
        if had is not None:
            _cfg_persist("del", bk)
        if had_lt is not None:
            _last_tier_save()
        if had is None and had_lt is None and not any(_bk(m["name"]) == bk for m in ENV_MODELS):
            return jsonify({"error": f"'{name}' is not a saved model (models from GEMINI_MODELS are changed by saving new limits)"}), 404
        res = _cfg_remove(name) if had is not None else "reset"
        print(f"[MODEL CFG] {name} deleted from the saved list -> {res}")
        view = _cfg_view()
        return jsonify({"result": res, "model": name, "models": view, "last_tier_models": [m["name"] for m in view if m["last_tier"]]})

    if action not in ("set", "add", "update"):
        return jsonify({"error": f"unknown action '{action}' (set | delete | set_last_tier)"}), 400
    rpm = _cfg_int(body.get("rpm"), 1, 1_000_000)
    rpd = _cfg_int(body.get("rpd"), 1, 100_000_000)
    if rpm is None or rpd is None:
        return jsonify({"error": "rpm and rpd are required whole numbers >= 1"}), 400
    lt_val = body.get("last_tier") if "last_tier" in body else None
    if lt_val is not None:
        lt_val = bool(lt_val) if not isinstance(lt_val, str) else (lt_val.strip().lower() in ("1", "true", "yes", "on"))
    created = _cfg_save(name, rpm, rpd, last_tier=lt_val)
    view = _cfg_view()
    print(f"[MODEL CFG] {name} {'added' if created else 'updated'}: rpm={rpm} rpd={rpd} last_tier={_is_lite(name)} (saved)")
    return jsonify({"model": name, "rpm": rpm, "rpd": rpd, "last_tier": _is_lite(name), "created": created,
                    "models": view, "last_tier_models": [m["name"] for m in view if m["last_tier"]]})


_avail_cache = {"t": 0.0, "models": None}
_avail_lock = threading.Lock()
_AVAIL_SKIP = ("embedding", "tts", "image", "transcribe", "robotics", "aqa", "imagen", "veo", "live", "audio")


def _google_models(force=False):
    """The model list of your Google account (models.list, all pages), cached for 5 min. Tries the keys one by one."""
    with _avail_lock:
        if not force and _avail_cache["models"] is not None and time.time() - _avail_cache["t"] < 300:
            return _avail_cache["models"]
    if not API_KEYS:
        raise RuntimeError("no API keys configured")
    last = "unknown error"
    for key in list(API_KEYS):
        try:
            out, token = [], None
            for _ in range(10):
                params = {"pageSize": 1000}
                if token:
                    params["pageToken"] = token
                r = requests.get("https://generativelanguage.googleapis.com/v1beta/models", params=params,
                                 headers={"x-goog-api-key": key}, timeout=(5, 20))
                if r.status_code != 200:
                    raise RuntimeError(f"Google answered HTTP {r.status_code}")
                j = r.json()
                out += j.get("models", [])
                token = j.get("nextPageToken")
                if not token:
                    break
            with _avail_lock:
                _avail_cache.update(t=time.time(), models=out)
            return out
        except Exception as e:
            last = str(e).replace(key, "…")
    raise RuntimeError(last)


def _suggest_limits(name):
    """Google's API does not publish RPM / RPD, so copy them from the newest model of the same family you already
    have (flash-lite / flash / pro); otherwise the cautious default 5 / 20. The dashboard lets you change them."""
    n = name.lower()
    fam = "flash-lite" if "flash-lite" in n else ("flash" if "flash" in n else ("pro" if "pro" in n else None))
    def same(m):
        mn = m["name"].lower()
        if fam == "flash-lite":
            return "flash-lite" in mn
        if fam == "flash":
            return "flash" in mn and "lite" not in mn
        return fam == "pro" and "pro" in mn
    pool = [m for m in MODELS if fam and same(m)]
    if pool:
        return pool[-1]["rpm"], pool[-1]["rpd"], f"copied from {pool[-1]['name']}"
    return 5, 20, "cautious default"


@app.route('/model_available', methods=['GET', 'OPTIONS'])
@app.route('/router/model_available', methods=['GET', 'OPTIONS'])
def model_available_api():
    """Live model list from Google for the dashboard's "➕ Add model" drop-down (so a name is never typed wrong).
      GET [?refresh=1] [&all=1]   all=1 also lists embedding / image / audio ... models
    Auth: Authorization: Bearer <PASSWORD> (or the dashboard's browser login)."""
    if request.method == 'OPTIONS':
        return Response(status=200)
    if not _admin_ok():
        return Response("Unauthorized", 401, {"WWW-Authenticate": 'Basic realm="Admin (password field = your API PASSWORD)"'})
    show_all = request.args.get("all") == "1"
    try:
        raw = _google_models(force=request.args.get("refresh") == "1")
    except Exception as e:
        return jsonify({"error": f"could not fetch the model list from Google: {e}"}), 502
    have = {_bk(m["name"]) for m in MODELS}
    out = []
    for m in raw:
        name = str(m.get("name", "")).replace("models/", "")
        methods = m.get("supportedGenerationMethods", [])
        if not name or "generateContent" not in methods:
            continue
        if not show_all and any(x in name.lower() for x in _AVAIL_SKIP):
            continue
        rpm, rpd, src = _suggest_limits(name)
        out.append({"name": name, "display": m.get("displayName", ""), "description": str(m.get("description", ""))[:200],
                    "input_tokens": m.get("inputTokenLimit"), "output_tokens": m.get("outputTokenLimit"),
                    "added": _bk(name) in have, "rpm": rpm, "rpd": rpd, "limits_from": src})
    out.sort(key=lambda x: (x["added"], [-ord(c) for c in x["name"]]))      # not added first, then Z -> A (newest versions on top)
    return jsonify({"models": out, "count": len(out), "new": sum(1 for x in out if not x["added"])})



# ─── Model probe: which models WORK and what TYPE they are (dashboard: Test selected / Test all models / Add model) ──
# One real call per model, on ONE key that is free right now (not RPM-busy, not cooling, not daily-locked). If that key
# answers 429/5xx the next free key is tried (PROBE_MAX_KEYS). The call is a normal request: it uses an RPM slot and, on
# a 200, one RPD of the key it used (only for models that are in the router pool).
PROBE_TIMEOUT = float(os.environ.get("PROBE_TIMEOUT", "60"))
PROBE_MAX_KEYS = int(os.environ.get("PROBE_MAX_KEYS", "3"))
PROBE_MAX_MODELS = 40
_probe_rr = 0
_KIND_LABEL = {
    "text-out": "text out", "image-out": "image out (+text)", "audio-out": "audio out (TTS)",
    "embedding": "embedding (vector out)", "live": "live / realtime (audio+text)",
    "image-video-out": "image / video out (Imagen, Veo)", "aqa": "AQA (grounded answer)",
}


def _model_kind(name, methods):
    """text-out / image-out / audio-out / embedding / live ... from Google's supportedGenerationMethods (+ the name)."""
    n = (name or "").lower()
    m = set(methods or [])
    if m and "generateContent" not in m:
        if m & {"embedContent", "embedText", "batchEmbedContents", "batchEmbedText"}:
            return "embedding"
        if m & {"predict", "predictLongRunning"}:
            return "image-video-out"
        if "bidiGenerateContent" in m:
            return "live"
        if "generateAnswer" in m:
            return "aqa"
    if "embedding" in n:
        return "embedding"
    if "tts" in n:
        return "audio-out"
    if "native-audio" in n or "-live" in n or n.startswith("live-"):
        return "live"
    if "imagen" in n or "veo" in n:
        return "image-video-out"
    if "image" in n:
        return "image-out"
    return "text-out"


def _probe_pick_key(name, skip_keys):
    """Pick a free key for `name` and reserve its RPM slot (models outside the pool have no limits to respect)."""
    global _probe_rr
    with state_lock:
        _maybe_reset_rpd()
        md = next((m for m in MODELS if _bk(m["name"]) == _bk(name)), None)
        pname = md["name"] if md else name
        n = len(API_KEYS)
        if not n:
            return None, md
        start = _probe_rr % n
        _probe_rr += 1
        for i in range(n):
            key = API_KEYS[(start + i) % n]
            if key in skip_keys or (key, pname) in PERMANENTLY_BROKEN_MODELS:
                continue
            if _is_daily_penalized(key, pname) or _is_rpm_cooldown(key, pname):
                continue
            if md:
                if not _rpd_available(key, pname, md["rpd"]) or not _rpm_available(key, pname, md["rpm"]):
                    continue
                _record_request(key, pname)
            return key, md
    return None, md


def _probe_call(key, name, kind):
    base = "https://generativelanguage.googleapis.com"
    t = (GEMINI_CONNECT_TIMEOUT, PROBE_TIMEOUT)
    nat = {"x-goog-api-key": key, "Content-Type": "application/json"}
    if kind == "text-out":
        return requests.post(base + "/v1beta/openai/chat/completions",
                             headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
                             json={"model": name, "max_tokens": 200,
                                   "messages": [{"role": "user", "content": "What is 2 + 2? Answer in one short sentence."}]},
                             timeout=t)
    if kind == "image-out":
        return requests.post(f"{base}/v1beta/models/{name}:generateContent", headers=nat, timeout=t,
                             json={"contents": [{"parts": [{"text": "Draw a small red circle on a white background."}]}],
                                   "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]}})
    if kind == "audio-out":
        return requests.post(f"{base}/v1beta/models/{name}:generateContent", headers=nat, timeout=t,
                             json={"contents": [{"parts": [{"text": "Say: hello"}]}],
                                   "generationConfig": {"responseModalities": ["AUDIO"],
                                                        "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Kore"}}}}})
    if kind == "embedding":
        return requests.post(f"{base}/v1beta/models/{name}:embedContent", headers=nat, timeout=t,
                             json={"content": {"parts": [{"text": "hello world"}]}})
    return None


def _probe_parse(kind, j):
    """-> (outputs list, short preview text)"""
    if kind == "text-out":
        ch = (j.get("choices") or [{}])[0]
        txt = str((ch.get("message") or {}).get("content") or "").strip()
        return ["text"], (txt or "(answered, but the text is empty - the model used its token budget for thinking)")
    if kind == "embedding":
        vals = (j.get("embedding") or {}).get("values") or []
        return ["vector"], f"{len(vals)} dimensions"
    outs, txt = [], ""
    for p in (((j.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []):
        if p.get("text"):
            txt += p["text"]
            if "text" not in outs:
                outs.append("text")
        inl = p.get("inlineData") or p.get("inline_data")
        if inl:
            mt = str(inl.get("mimeType") or inl.get("mime_type") or "")
            o = mt.split("/")[0] or "binary"
            if o not in outs:
                outs.append(o)
            txt += f" [{mt}, {len(str(inl.get('data') or ''))//1365} KB]"
    return outs, (txt.strip() or "(no content returned)")


def _probe_err(r):
    try:
        e = r.json().get("error") or {}
        return str(e.get("message") or r.text)[:260]
    except Exception:
        return (r.text or "")[:260]


def _probe_model(name, meta):
    methods = (meta or {}).get("supportedGenerationMethods", []) or []
    kind = _model_kind(name, methods)
    in_pool = any(_bk(m["name"]) == _bk(name) for m in MODELS)
    res = {"model": name, "kind": kind, "type": _KIND_LABEL.get(kind, kind), "ok": False, "tested": True, "status": 0,
           "ms": 0, "key": "", "outputs": [], "response": "", "in_pool": in_pool,
           "blocked_left": int(_model_block_left(name)), "display": (meta or {}).get("displayName", ""),
           "input_tokens": (meta or {}).get("inputTokenLimit"), "output_tokens": (meta or {}).get("outputTokenLimit"),
           "methods": methods, "exists": bool(meta) if meta is not None else None}
    if kind in ("image-video-out", "live", "aqa"):
        res.update(tested=False, ok=None, response="Not tested here: this model type does not use the normal chat / generateContent call. "
                                                   "It exists in your Google account, so it can be used by the right client.")
        return res
    skip, last_err = set(), None
    for _ in range(max(1, PROBE_MAX_KEYS)):
        key, md = _probe_pick_key(name, skip)
        if key is None:
            if last_err is None:
                res.update(status=0, response="No key is free for this model right now (every key is RPM-busy, cooling down or daily-locked). Try again in a minute.")
            break
        skip.add(key)
        t0 = time.time()
        try:
            r = _probe_call(key, name, kind)
            ms = round((time.time() - t0) * 1000)
            res.update(key="…" + key[-4:], ms=ms, status=r.status_code)
            if r.status_code == 200:
                outs, txt = _probe_parse(kind, r.json())
                res.update(ok=True, outputs=outs, response=txt[:400])
                if md:
                    with state_lock:
                        _record_rpd_success(key, md["name"])
                        _clear_penalty(key, md["name"])       # it answered -> it is NOT daily-penalized / cooling down
                return res
            err = _probe_err(r)
            last_err = err
            res["response"] = err
            if r.status_code in (429, 403) and md:
                with state_lock:
                    _handle_429(key, md["name"], (r.text or "").lower())
            if r.status_code in (400, 404):
                break                                    # the MODEL is the problem, other keys will say the same
        except Exception as e:
            last_err = str(e)[:200]
            res.update(key="…" + key[-4:], ms=round((time.time() - t0) * 1000), status=0, response="Exception: " + last_err)
    if res["status"] in (429, 403):
        res["response"] = "Rate-limited right now (" + res["response"][:160] + ") - the model exists, try again later."
    return res


@app.route('/model_test', methods=['GET', 'POST', 'OPTIONS'])
@app.route('/router/model_test', methods=['GET', 'POST', 'OPTIONS'])
def model_test_api():
    """Dashboard: test one / several / all models and report whether each works + its type.
      POST {"models": ["a","b"]} | {"all": true}      or      GET ?models=a,b | ?all=1
    Auth: Bearer <PASSWORD> or the dashboard's browser login."""
    if request.method == 'OPTIONS':
        return Response(status=200)
    if not _admin_ok():
        return Response("Unauthorized", 401, {"WWW-Authenticate": 'Basic realm="Admin (password field = your API PASSWORD)"'})
    if request.method == "POST":
        body = request.get_json(silent=True) or {}
    else:
        body = {"models": [x for x in (request.args.get("models") or "").split(",") if x.strip()],
                "all": request.args.get("all") == "1"}
    raw = [m["name"] for m in MODELS] if body.get("all") else (body.get("models") or [])
    names, seen = [], set()
    for x in raw:
        n = _cfg_clean_name(x)
        if n and _bk(n) not in seen:
            seen.add(_bk(n))
            names.append(n)
    if not names:
        return jsonify({"error": "no valid model name given"}), 400
    names = names[:PROBE_MAX_MODELS]
    try:
        meta_map = {str(m.get("name", "")).replace("models/", "").lower(): m for m in _google_models()}
    except Exception:
        meta_map = None                      # Google list unavailable: probe by name only
    jobs = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        for n in names:
            meta = (meta_map.get(_bk(n)) or {}) if meta_map is not None else None
            jobs.append(ex.submit(_probe_model, n, meta))
            time.sleep(0.15)
    results = [j.result() for j in jobs]
    for r in results:
        if r.get("exists") is False:
            r["response"] = "This model name is not in your Google account's model list. " + (r["response"] or "")
    ok = sum(1 for r in results if r["ok"] is True)
    return jsonify({"total": len(results), "ok": ok, "failed": sum(1 for r in results if r["ok"] is False),
                    "untested": sum(1 for r in results if r["ok"] is None), "results": results})


@app.route('/release_daily', methods=['POST'])
@app.route('/router/release_daily', methods=['POST'])
@requires_browser_auth
def release_daily():
    """Dashboard button: lift daily (RPD) penalties, RPD exhaustion, cooldowns, and broken-model locks NOW
    instead of waiting for midnight IST or restarting the server.
    Body (all optional): {"key": "<last chars of key>", "model": "<model name>"}.
    No body = release everything."""
    body = request.get_json(silent=True) or {}
    key_sfx = str(body.get("key") or "").replace("...", "").strip()
    if "|" in key_sfx and not body.get("model"):
        parts = key_sfx.split("|", 1)
        key_sfx = parts[0].replace("...", "").strip()[-5:]
        model = parts[1].strip()
    else:
        if len(key_sfx) > 5:
            key_sfx = key_sfx[-5:]
        model = str(body.get("model") or "").strip()

    released_set = set()
    with state_lock:
        all_pairs = (
            set(key_daily_penalty.keys())
            | set(rpd_count.keys())
            | set(PERMANENTLY_BROKEN_MODELS)
            | set(rate_strikes.keys())
            | set(rpm_cooldown.keys())
        )
        for (k, m) in list(all_pairs):
            if key_sfx and not k.endswith(key_sfx):
                continue
            if model and m != model:
                continue
            was_locked = (
                (k, m) in key_daily_penalty
                or (k, m) in PERMANENTLY_BROKEN_MODELS
                or (k, m) in rpm_cooldown
                or rpd_count.get((k, m), 0) > 0
            )
            key_daily_penalty.pop((k, m), None)
            PERMANENTLY_BROKEN_MODELS.discard((k, m))
            rate_strikes.pop((k, m), None)
            rpd_count.pop((k, m), None)
            rpm_cooldown.pop((k, m), None)
            if was_locked:
                released_set.add(f"...{k[-5:]}|{m}")
        if not key_sfx and not model:
            conversation_sticky.clear()
    released = sorted(released_set)
    print(f"[RELEASE DAILY] released {len(released)} lock(s): {released}")
    return jsonify({"released": len(released), "items": released})


@app.route('/logs', methods=['GET'])
@requires_browser_auth
def view_logs():
    html = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>WAPI Live Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
<style>
:root {
  --bg: #0f1117;
  --card: #171923;
  --card-alt: #1e2230;
  --border: #2b3040;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --accent: #6366f1;
  --green: #4ade80;
  --amber: #fbbf24;
  --red: #f87171;
  --blue: #60a5fa;
  --purple: #c084fc;
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  margin: 0;
  padding: 10px;
  background: var(--bg);
  color: var(--text);
  font-size: 13.5px;
  line-height: 1.4;
}
.container { max-width: 1440px; margin: 0 auto; }

/* Explicit text selection support everywhere */
.selectable, .msg, .resp-box, .det, .err, td, pre, code, .log-card-body {
  -webkit-user-select: text !important;
  -moz-user-select: text !important;
  -ms-user-select: text !important;
  user-select: text !important;
  cursor: text;
}

/* Compact Top Header */
.topbar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 12px;
  margin-bottom: 10px;
}
.topbar-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1.08em;
  font-weight: 700;
  color: #fff;
}
.topbar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

/* Buttons & Chips */
.btn {
  background: #3b82f6;
  color: #fff;
  border: none;
  padding: 6px 11px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  font-size: .82em;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: opacity .15s, background .15s;
  white-space: nowrap;
}
.btn:hover { background: #2563eb; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn-s {
  background: #232736;
  color: #e2e8f0;
  border: 1px solid #3b4256;
  border-radius: 5px;
  padding: 3px 8px;
  cursor: pointer;
  font-size: .76em;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}
.btn-s:hover { background: #32384e; }
.btn-copy {
  background: rgba(99,102,241,.16);
  color: #a5b4fc;
  border: 1px solid rgba(99,102,241,.38);
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
  font-size: .72em;
  font-weight: 600;
  white-space: nowrap;
}
.btn-copy:hover { background: rgba(99,102,241,.3); }
.chip {
  background: #1e2230;
  color: #cbd5e1;
  border: 1px solid #333a4d;
  border-radius: 999px;
  padding: 3px 10px;
  cursor: pointer;
  font-size: .78em;
  font-weight: 600;
  white-space: nowrap;
}
.chip.on { background: #3b82f6; color: #fff; border-color: #3b82f6; }

/* Compact KPI Strip */
.kpi-strip {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 7px;
  margin-bottom: 10px;
}
.kpi {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 10px;
  min-width: 0;
}
.kpi-lbl { font-size: .7em; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kpi-val { font-size: 1.25em; font-weight: 700; color: #fff; margin-top: 1px; }
.kpi-sub { font-size: .72em; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Dashboard Grid Panels */
.status-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}
.panel-row {
  display: grid;
  grid-template-columns: 1fr 1.6fr;
  gap: 10px;
}
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 10px 12px;
  min-width: 0;
}
.card h3 {
  margin: 0 0 8px;
  font-size: .82em;
  color: #cbd5e1;
  text-transform: uppercase;
  letter-spacing: .5px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.sub { font-size: .78em; color: var(--muted); }
.tag {
  background: #232736;
  padding: 2px 7px;
  border-radius: 5px;
  font-size: .76em;
  color: #e2e8f0;
  border: 1px solid #363c52;
}

/* Last-Tier (Use Last) Banner */
.lt-box {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
}
.lt-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 5px;
}
.lt-title {
  font-size: .8em;
  font-weight: 700;
  color: #fbbf24;
  display: flex;
  align-items: center;
  gap: 5px;
}
.lt-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  align-items: center;
}
.lt-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: rgba(251, 191, 36, 0.16);
  color: #fde68a;
  border: 1px solid rgba(251, 191, 36, 0.45);
  border-radius: 999px;
  padding: 2px 8px;
  font-size: .75em;
  font-family: monospace;
}
.lt-chip button {
  background: none;
  border: none;
  color: #fca5a5;
  cursor: pointer;
  padding: 0 2px;
  font-size: 1em;
  line-height: 1;
  font-weight: bold;
}

/* Compact Model Rows */
.models-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 340px;
  overflow-y: auto;
  padding-right: 2px;
}
.m-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  background: #131620;
  border: 1px solid #2d3348;
  border-radius: 6px;
  padding: 5px 8px;
  font-size: .8em;
}
.m-row.is-lt {
  border-color: rgba(251, 191, 36, 0.45);
  background: rgba(251, 191, 36, 0.05);
}
.m-row.is-blk {
  border-color: #991b1b;
  background: rgba(153, 27, 27, 0.1);
}
.m-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
.m-name {
  font-family: monospace;
  font-weight: 600;
  color: #e2e8f0;
  word-break: break-all;
}
.m-actions {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
  align-items: center;
}
.tier-badge {
  font-size: .68em;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 4px;
  text-transform: uppercase;
}
.tier-1st { background: rgba(59, 130, 246, 0.18); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.35); }
.tier-last { background: rgba(251, 191, 36, 0.2); color: #fcd34d; border: 1px solid rgba(251, 191, 36, 0.45); }

/* Badges */
.badge { padding: 2px 7px; border-radius: 4px; font-size: .75em; font-weight: 700; white-space: nowrap; }
.bg-green { background: rgba(74,222,128,.16); color: #4ade80; border: 1px solid rgba(74,222,128,.3); }
.bg-red { background: rgba(248,113,113,.16); color: #f87171; border: 1px solid rgba(248,113,113,.3); }
.bg-amber { background: rgba(251,191,36,.16); color: #fbbf24; border: 1px solid rgba(251,191,36,.3); }
.bg-blue { background: rgba(96,165,250,.16); color: #60a5fa; border: 1px solid rgba(96,165,250,.3); }

/* Logs Toolbar */
.logs-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  justify-content: space-between;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
}
.search-inp {
  background: #11131a;
  color: #fff;
  border: 1px solid #333a4d;
  border-radius: 6px;
  padding: 5px 9px;
  font-size: .8em;
  min-width: 190px;
  flex: 1;
  max-width: 320px;
}

/* Desktop Table & Boxes */
.table-wrapper {
  background: var(--card);
  border-radius: 8px;
  overflow-x: auto;
  border: 1px solid var(--border);
  margin-bottom: 20px;
}
table.logs-tbl { width: 100%; border-collapse: collapse; min-width: 860px; }
table.logs-tbl th, table.logs-tbl td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid #242938;
  vertical-align: top;
}
table.logs-tbl th {
  background: #1d2130;
  color: #cbd5e1;
  font-weight: 600;
  font-size: .76em;
  text-transform: uppercase;
  letter-spacing: .4px;
  position: sticky;
  top: 0;
}
table.logs-tbl tr:hover { background: rgba(255,255,255,.02); }

.msg, .resp-box {
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  font-size: .8em;
  padding: 6px 8px;
  border-radius: 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  max-height: 110px;
  overflow-y: auto;
  line-height: 1.35;
}
.msg {
  color: #fdba74;
  background: #12141c;
  border: 1px solid #262b3d;
}
.resp-box {
  color: #a7f3d0;
  background: #0f1917;
  border: 1px solid rgba(74,222,128,.25);
}
.resp-box.empty {
  color: #64748b;
  background: #12141c;
  border-color: #222634;
  font-style: italic;
}
.err {
  color: #fca5a5;
  font-weight: 600;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  font-size: .78em;
  max-height: 95px;
  overflow-y: auto;
}
.err.warn { color: #fcd34d; }
.det {
  background: #10121a;
  border: 1px solid #262b3d;
  border-radius: 6px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .8em;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow: auto;
  color: #93c5fd;
  line-height: 1.4;
}
.det-sec-hdr {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  margin-bottom: 4px;
  font-size: .8em;
  font-weight: 700;
}
.pwd-wrong { font-family: monospace; color: #fca5a5; background: #451a1a; padding: 1px 5px; border-radius: 3px; font-size: .78em; }
.ip { font-family: monospace; color: #93c5fd; font-size: .78em; }

/* Mobile Cards View for Logs */
.logs-cards { display: none; flex-direction: column; gap: 8px; margin-bottom: 20px; }
.log-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.log-card.k-fail { border-left: 3px solid #f87171; background: rgba(248,113,113,.05); }
.log-card.k-warn { border-left: 3px solid #fbbf24; background: rgba(251,191,36,.04); }
.log-card.k-pending { border-left: 3px solid #60a5fa; }
.log-card.k-ok { border-left: 3px solid #4ade80; }
.lc-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.lc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-size: .75em;
  color: var(--muted);
}
.lc-route {
  font-size: .74em;
  color: #93c5fd;
  word-break: break-word;
}
.lc-box-lbl {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: .72em;
  color: var(--muted);
  font-weight: 600;
  margin-bottom: 2px;
}

/* View mode classes */
body.view-cards .table-wrapper { display: none !important; }
body.view-cards .logs-cards { display: flex !important; }
body.view-table .table-wrapper { display: block !important; }
body.view-table .logs-cards { display: none !important; }

/* Selection Lock Toast */
#sel-banner {
  display: none;
  position: fixed;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(15, 23, 42, 0.95);
  border: 1px solid #6366f1;
  color: #e0e7ff;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: .78em;
  font-weight: 600;
  z-index: 9998;
  box-shadow: 0 4px 14px rgba(0,0,0,.5);
  align-items: center;
  gap: 8px;
}

/* Modals */
.modal-backdrop {
  display: none;
  position: fixed;
  top: 0; left: 0; width: 100%; height: 100%;
  background: rgba(0,0,0,.82);
  z-index: 10000;
  align-items: center;
  justify-content: center;
  padding: 12px;
  overflow-y: auto;
}
.modal-box {
  width: 100%;
  max-width: 520px;
  background: #171923;
  border-radius: 11px;
  border: 1px solid #4c1d95;
  padding: 16px;
  max-height: 92vh;
  overflow-y: auto;
}

/* Responsive Media Queries */
@media (max-width: 960px) {
  .kpi-strip { grid-template-columns: repeat(3, 1fr); }
  .panel-row { grid-template-columns: 1fr; }
}
@media (max-width: 780px) {
  body { padding: 7px; font-size: 13px; }
  .kpi-strip { grid-template-columns: repeat(2, 1fr); gap: 6px; }
  .kpi { padding: 6px 8px; }
  .kpi-val { font-size: 1.12em; }
  .table-wrapper { display: none; }
  .logs-cards { display: flex; }
  .search-inp { max-width: 100%; width: 100%; }
  .m-row { padding: 6px 7px; }
}
</style>
</head>
<body>
<div class="container">

  <!-- Top Header -->
  <div class="topbar">
    <div class="topbar-title">
      <span>🚀 WAPI Live Dashboard</span>
      <span id="live-dot" style="font-size:.72em;font-weight:600;color:#4ade80;background:rgba(74,222,128,.12);padding:2px 7px;border-radius:999px;">● Live</span>
    </div>
    <div class="topbar-actions">
      <button class="btn" onclick="fetchData(true)" id="refresh-btn">🔄 Refresh</button>
      <button class="btn" onclick="openLastTierModal()" style="background:#d97706;">⚡/🔚 Model Priority (Last-Tier)</button>
      <button class="btn" onclick="openModelForm()" style="background:#6d28d9;">➕ Add Model</button>
      <button class="btn" onclick="testAllKeys()" id="test-btn" style="background:#4f46e5;">🧪 Test Keys</button>
    </div>
  </div>

  <div id="error-msg" style="color:#fca5a5;background:#451a1a;padding:8px 10px;border-radius:6px;text-align:center;display:none;margin-bottom:10px;font-size:.82em;"></div>

  <!-- Selection Active Floating Pill -->
  <div id="sel-banner">
    <span>🔒 Text selected — auto-refresh paused so you can copy</span>
    <button class="btn-copy" onclick="copyCurrentSelection()">📋 Copy Selected</button>
    <button class="btn-s" onclick="clearUserSelection()" style="padding:1px 6px;">✕</button>
  </div>

  <!-- Status & Models Panel -->
  <div class="status-panel" id="status-panel">
    <div class="card" style="text-align:center;padding:20px;">Loading dashboard...</div>
  </div>

  <!-- Logs Section Header & Toolbar -->
  <div class="logs-toolbar">
    <div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center;" id="log-chips"></div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;flex:1;justify-content:flex-end;">
      <input type="search" id="log-search" class="search-inp" placeholder="🔍 Search prompt, response, model, error..." oninput="onSearchInput(this.value)">
      <button class="btn-s" id="view-toggle-btn" onclick="cycleViewMode()" title="Switch between Card View and Table View">📱/💻 View: Auto</button>
      <button class="btn-s" id="pause-btn" onclick="togglePause()">⏸ Pause</button>
      <button class="btn-s" onclick="clearSaved()" title="Clear browser IndexedDB logs">🗑 Clear Saved</button>
      <button class="btn-s" id="skip-btn" onclick="skipLoad()" style="display:none;background:#7f1d1d;border-color:#b91c1c;">⏭ Skip</button>
    </div>
  </div>
  <div id="log-note" style="color:#94a3b8;font-size:.78em;margin-bottom:6px;min-height:1px;"></div>

  <!-- Desktop Compact Table View -->
  <div class="table-wrapper">
    <table class="logs-tbl">
      <thead>
        <tr>
          <th style="width:125px;">Time / IP</th>
          <th style="width:110px;">Status / ms</th>
          <th style="width:155px;">Model / Route</th>
          <th style="width:24%;">Prompt / Message</th>
          <th style="width:30%;">Incoming Response</th>
          <th style="width:16%;">Error / Why</th>
          <th style="width:68px;"></th>
        </tr>
      </thead>
      <tbody id="logs-body">
        <tr><td colspan="7" style="text-align:center;color:#666;padding:24px;">Loading logs...</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Mobile & Compact Card View -->
  <div class="logs-cards" id="logs-cards">
    <div class="card" style="text-align:center;color:#666;padding:20px;">Loading logs...</div>
  </div>

</div>

<!-- Modal: Test All Keys -->
<div id="test-modal" class="modal-backdrop">
  <div class="modal-box" style="max-width:960px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <h2 id="test-title" style="margin:0;color:#a78bfa;font-size:1.05em;">🧪 Key & Model Test</h2>
      <button onclick="document.getElementById('test-modal').style.display='none'" class="btn-s" style="padding:5px 12px;">✕ Close</button>
    </div>
    <div id="test-summary" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;"></div>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;min-width:540px;font-size:.82em;">
        <thead><tr style="background:#2d1b69;">
          <th style="padding:8px;text-align:left;color:#c4b5fd;">Key</th>
          <th style="padding:8px;text-align:left;color:#c4b5fd;">Model</th>
          <th style="padding:8px;text-align:left;color:#c4b5fd;">Question</th>
          <th style="padding:8px;text-align:center;color:#c4b5fd;">Status</th>
          <th style="padding:8px;text-align:left;color:#c4b5fd;">Response</th>
          <th style="padding:8px;text-align:right;color:#c4b5fd;">ms</th>
        </tr></thead>
        <tbody id="test-tbody"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- Modal: Block Model -->
<div id="block-modal" class="modal-backdrop">
  <div class="modal-box" style="max-width:440px;border-color:#991b1b;">
    <h2 style="margin:0 0 4px;color:#fca5a5;font-size:1.05em;">⛔ Block model on all keys</h2>
    <div style="color:#e5e7eb;font-family:monospace;margin-bottom:10px;font-size:.9em;" id="blk-model"></div>
    <div style="color:#9ca3af;font-size:.8em;margin-bottom:6px;">Duration (pick or type):</div>
    <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;">
      <button class="chip" onclick="pickDur('30m')">30m</button><button class="chip" onclick="pickDur('1h')">1h</button>
      <button class="chip" onclick="pickDur('6h')">6h</button><button class="chip" onclick="pickDur('1d')">1d</button>
      <button class="chip" onclick="pickDur('7d')">7d</button><button class="chip" onclick="pickDur('30d')">30d</button>
      <button class="chip" onclick="pickDur('43d')">43d</button><button class="chip" onclick="pickDur('forever')">forever</button>
    </div>
    <input id="blk-dur" placeholder="e.g. 1h, 1d, 43d, 90m, 2h30m, forever" style="width:100%;padding:8px;border-radius:6px;border:1px solid #4b5563;background:#111827;color:#fff;margin-bottom:7px;">
    <input id="blk-reason" placeholder="reason (optional)" style="width:100%;padding:8px;border-radius:6px;border:1px solid #4b5563;background:#111827;color:#fff;margin-bottom:7px;">
    <div id="blk-err" style="color:#f87171;font-size:.8em;min-height:1.1em;margin-bottom:6px;"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn-s" onclick="closeBlock()" style="padding:6px 14px;">Cancel</button>
      <button class="btn" onclick="confirmBlock()" style="background:#dc2626;">⛔ Block</button>
    </div>
  </div>
</div>

<!-- Modal: Add / Edit Model -->
<div id="model-modal" class="modal-backdrop">
  <div class="modal-box" style="max-width:450px;">
    <h2 style="margin:0 0 10px;color:#c4b5fd;font-size:1.05em;" id="mdl-title">➕ Add model</h2>
    <div id="mdl-pick-row" style="margin-bottom:8px;">
      <div style="color:#9ca3af;font-size:.8em;margin-bottom:4px;">Pick from Google (live account list)</div>
      <div style="display:flex;gap:6px;">
        <select id="mdl-pick" onchange="pickModel()" style="flex:1;min-width:0;padding:8px;border-radius:6px;border:1px solid #4b5563;background:#111827;color:#fff;"><option value="">Loading...</option></select>
        <button class="btn-s" onclick="loadAvailable(true)" style="padding:6px 10px;" title="Re-fetch from Google">🔄</button>
      </div>
      <div id="mdl-pick-note" style="color:#9ca3af;font-size:.75em;margin-top:4px;min-height:1em;"></div>
    </div>
    <div style="color:#9ca3af;font-size:.8em;margin-bottom:3px;">Model name</div>
    <input id="mdl-name" placeholder="e.g. gemini-3.9-flash" style="width:100%;padding:8px;border-radius:6px;border:1px solid #4b5563;background:#111827;color:#fff;margin-bottom:8px;">
    <div style="display:flex;gap:8px;">
      <div style="flex:1;"><div style="color:#9ca3af;font-size:.8em;margin-bottom:3px;">RPM (per min/key)</div>
      <input id="mdl-rpm" type="number" min="1" placeholder="10" style="width:100%;padding:8px;border-radius:6px;border:1px solid #4b5563;background:#111827;color:#fff;margin-bottom:8px;"></div>
      <div style="flex:1;"><div style="color:#9ca3af;font-size:.8em;margin-bottom:3px;">RPD (per day/key)</div>
      <input id="mdl-rpd" type="number" min="1" placeholder="250" style="width:100%;padding:8px;border-radius:6px;border:1px solid #4b5563;background:#111827;color:#fff;margin-bottom:8px;"></div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.35);padding:7px 9px;border-radius:6px;margin-bottom:8px;cursor:pointer;font-size:.82em;color:#fde68a;">
      <input type="checkbox" id="mdl-last-tier">
      <span>🔚 <b>Use in Last-Tier (Fallback)</b> — use only after all Primary-Tier models are busy/exhausted (survives restarts)</span>
    </label>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
      <button class="btn-s" id="mdl-test-btn" onclick="mdlTest()" style="background:#2d1b69;border-color:#4c1d95;padding:5px 10px;">🧪 Test this model</button>
      <span style="color:#6b7280;font-size:.75em;">verifies it works before saving</span>
    </div>
    <div id="mdl-test-out" style="font-size:.8em;min-height:1em;margin-bottom:8px;word-break:break-word;"></div>
    <div id="mdl-err" style="color:#f87171;font-size:.8em;min-height:1.1em;margin-bottom:6px;"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn-s" id="mdl-del" onclick="deleteModelCfg()" style="padding:6px 12px;display:none;background:#7f1d1d;border-color:#f87171;color:#fee2e2;">🗑 Delete</button>
      <button class="btn-s" onclick="closeModelForm()" style="padding:6px 12px;">Cancel</button>
      <button class="btn" onclick="saveModelCfg()" style="background:#6d28d9;">💾 Save</button>
    </div>
  </div>
</div>

<!-- Modal: Manage Multiple Last-Tier (Use Last) Models -->
<div id="lt-modal" class="modal-backdrop">
  <div class="modal-box" style="max-width:540px;border-color:#d97706;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <h2 style="margin:0;color:#fbbf24;font-size:1.05em;">🔚 Last-Tier (Use Last) Models</h2>
      <button class="btn-s" onclick="closeLastTierModal()">✕ Close</button>
    </div>
    <div style="color:#94a3b8;font-size:.78em;margin-bottom:10px;">
      Models in the <b>Last-Tier</b> list are used <b>LAST</b> (only when every Primary-Tier model is RPM-busy, cooling down, or daily-exhausted). Saved in MongoDB + disk so they survive restarts.
    </div>

    <!-- Section 1: Tick/Untick from existing models pool -->
    <div style="background:#11131c;border:1px solid #2b3040;border-radius:8px;padding:10px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:6px;">
        <span style="font-size:.82em;font-weight:700;color:#e2e8f0;">1. Select Models from Pool (Tick = Use Last):</span>
        <span style="display:inline-flex;gap:4px;">
          <button class="btn-s" onclick="ltCheckPreset('all')">☑ All</button>
          <button class="btn-s" onclick="ltCheckPreset('lite')">⚡ Only *lite*</button>
          <button class="btn-s" onclick="ltCheckPreset('none')">☐ None</button>
        </span>
      </div>
      <div id="lt-pool-list" style="display:flex;flex-direction:column;gap:5px;max-height:200px;overflow-y:auto;margin-bottom:8px;"></div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
        <button class="btn-s" onclick="resetLastTierDefault()" title="Clear manual overrides and revert to default *lite* models only">↩ Reset to Default (*lite*)</button>
        <button class="btn" onclick="saveLastTierChecklist()" style="background:#d97706;">💾 Save Checked as Last-Tier</button>
      </div>
    </div>

    <!-- Section 2: Manually add/type multiple models at once -->
    <div style="background:#11131c;border:1px solid #2b3040;border-radius:8px;padding:10px;">
      <div style="font-size:.82em;font-weight:700;color:#e2e8f0;margin-bottom:4px;">2. Manually Add Multiple Models to Last-Tier:</div>
      <div style="color:#94a3b8;font-size:.75em;margin-bottom:6px;">
        Type or paste one or more model names (comma, space, or newline separated), or pick from Google below. If a model is not in the router pool yet, it is automatically added and saved!
      </div>
      <div style="display:flex;gap:6px;margin-bottom:6px;">
        <select id="lt-google-pick" onchange="ltAppendFromGoogle()" style="flex:1;min-width:0;padding:6px 8px;border-radius:6px;border:1px solid #3b4256;background:#171923;color:#fff;font-size:.8em;">
          <option value="">+ Pick from Google account model list...</option>
        </select>
        <button class="btn-s" onclick="loadLtGoogleModels(true)" title="Refresh Google model list">🔄</button>
      </div>
      <textarea id="lt-manual-input" rows="3" placeholder="e.g. gemini-3.1-flash-lite, gemini-3.5-flash-lite, gemini-3.5-flash" style="width:100%;padding:8px;border-radius:6px;border:1px solid #3b4256;background:#0b0d13;color:#fff;font-family:monospace;font-size:.82em;resize:vertical;margin-bottom:6px;"></textarea>
      <div id="lt-err" style="color:#f87171;font-size:.78em;min-height:1.1em;margin-bottom:6px;"></div>
      <div style="display:flex;justify-content:flex-end;gap:6px;">
        <button class="btn" onclick="addManualLastTierModels('add')" style="background:#059669;">➕ Add to Last-Tier List</button>
      </div>
    </div>
  </div>
</div>

<!-- Modal: Model Probe Test -->
<div id="mt-modal" class="modal-backdrop">
  <div class="modal-box" style="max-width:1000px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <h2 id="mt-title" style="margin:0;color:#a78bfa;font-size:1.05em;">🧪 Model Test</h2>
      <button onclick="mtClose()" class="btn-s" style="padding:5px 12px;">✕ Close</button>
    </div>
    <div id="mt-summary" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;"></div>
    <div id="mt-bytype" style="color:#9ca3af;font-size:.82em;margin-bottom:10px;"></div>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;min-width:680px;font-size:.82em;">
        <thead><tr style="background:#2d1b69;color:#c4b5fd;text-align:left;">
          <th style="padding:8px;">Model</th><th style="padding:8px;">Works?</th><th style="padding:8px;">Type</th><th style="padding:8px;">Output</th><th style="padding:8px;">Key</th><th style="padding:8px;text-align:right;">ms</th><th style="padding:8px;">Answer / Error</th>
        </tr></thead>
        <tbody id="mt-tbody"></tbody>
      </table>
    </div>
  </div>
</div>

<script>
// ===== Selection Guard & Copy Helper (Prevents auto-refresh from wiping text selection) =====
let isSelecting = false;
let selectionHoldUntil = 0;

function checkSelectionState() {
  const s = window.getSelection ? window.getSelection() : null;
  const txt = s ? s.toString().trim() : '';
  isSelecting = txt.length > 0;
  if (isSelecting) {
    selectionHoldUntil = Date.now() + 2500;
  }
  const banner = document.getElementById('sel-banner');
  if (banner) banner.style.display = isSelecting ? 'inline-flex' : 'none';
}

document.addEventListener('selectionchange', checkSelectionState);
document.addEventListener('touchend', () => { setTimeout(checkSelectionState, 80); }, {passive: true});
document.addEventListener('mouseup', () => { setTimeout(checkSelectionState, 50); }, {passive: true});

function isUserBusySelecting() {
  if (isSelecting) return true;
  const s = window.getSelection ? window.getSelection() : null;
  if (s && s.toString().trim().length > 0) return true;
  return Date.now() < selectionHoldUntil;
}

function clearUserSelection() {
  if (window.getSelection) window.getSelection().removeAllRanges();
  isSelecting = false;
  selectionHoldUntil = 0;
  const banner = document.getElementById('sel-banner');
  if (banner) banner.style.display = 'none';
  if (window._last) { updateUI(window._last); }
}

async function copyTextRaw(text, btnEl) {
  const str = String(text || '');
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(str);
      ok = true;
    }
  } catch (e) {}
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {}
  }
  if (btnEl) {
    const orig = btnEl.getAttribute('data-orig') || btnEl.innerHTML;
    if (!btnEl.getAttribute('data-orig')) btnEl.setAttribute('data-orig', orig);
    btnEl.innerHTML = ok ? '✅ Copied' : '⚠️ Failed';
    setTimeout(() => { btnEl.innerHTML = orig; }, 1400);
  }
  return ok;
}

function copyByElemId(elemId, btnEl) {
  const el = document.getElementById(elemId);
  if (!el) return;
  copyTextRaw(el.innerText || el.textContent || '', btnEl);
}

function selectElemText(elemId) {
  const el = document.getElementById(elemId);
  if (!el || !window.getSelection) return;
  selectionHoldUntil = Date.now() + 8000;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  checkSelectionState();
}

function copyCurrentSelection() {
  const s = window.getSelection ? window.getSelection().toString() : '';
  if (s) copyTextRaw(s, null);
}

// ===== View Mode (Auto / Cards / Table) =====
let viewMode = localStorage.getItem('wapi_view_mode') || 'auto';
function applyViewMode() {
  document.body.classList.remove('view-cards', 'view-table');
  if (viewMode === 'cards') document.body.classList.add('view-cards');
  else if (viewMode === 'table') document.body.classList.add('view-table');
  const btn = document.getElementById('view-toggle-btn');
  if (btn) {
    btn.textContent = viewMode === 'cards' ? '📱 View: Cards' : (viewMode === 'table' ? '💻 View: Table' : '📱/💻 View: Auto');
  }
}
function cycleViewMode() {
  viewMode = viewMode === 'auto' ? 'cards' : (viewMode === 'cards' ? 'table' : 'auto');
  try { localStorage.setItem('wapi_view_mode', viewMode); } catch (e) {}
  applyViewMode();
}
applyViewMode();

// ===== Search & Filter State =====
let searchQuery = '';
function onSearchInput(val) {
  searchQuery = (val || '').trim().toLowerCase();
  lastSig = '';
  if (window._last) renderLogs(window._last);
}

// ===== Key & Model Testing =====
async function testAllKeys(targetKey = '', targetModel = '') {
  const btn = document.getElementById('test-btn');
  if (!window._wapiPwd) {
    const pwd = prompt('Enter your WAPI password to run key tests:');
    if (!pwd) return;
    window._wapiPwd = pwd;
  }
  btn.innerText = '⏳ Testing...'; btn.disabled = true;
  document.getElementById('test-modal').style.display = 'flex';
  const msg = (targetKey && targetModel) ? `⏳ Testing ${esc(targetModel)} on key ${esc(targetKey)}...`
    : targetKey ? `⏳ Running tests on every model for key ${esc(targetKey)}...`
    : targetModel ? `⏳ Testing model ${esc(targetModel)} on ALL keys...`
    : '⏳ Running tests on all keys × models...';
  document.getElementById('test-title').textContent = '🧪 ' + (targetModel ? 'Model ' + targetModel : 'Key & Model') + (targetKey ? ' · key ' + targetKey : (targetModel ? ' · all keys' : ' · all keys × models')) + ' Test';
  document.getElementById('test-tbody').innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:#a78bfa;">${msg}</td></tr>`;
  document.getElementById('test-summary').innerHTML = '';
  try {
    const qs = [];
    if (targetKey) qs.push('key=' + encodeURIComponent(targetKey));
    if (targetModel) qs.push('model=' + encodeURIComponent(targetModel));
    let url = '/router/test_keys' + (qs.length ? '?' + qs.join('&') : '');
    let r = await fetch(url, {headers: {Authorization: 'Bearer ' + window._wapiPwd}});
    if (r.status === 404) {
      r = await fetch('test_keys' + (qs.length ? '?' + qs.join('&') : ''), {headers: {Authorization: 'Bearer ' + window._wapiPwd}});
    }
    if (r.status === 401) {
      window._wapiPwd = null;
      throw new Error('Wrong password (401). Click Test again to re-enter.');
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    renderTestResults(await r.json());
  } catch (e) {
    document.getElementById('test-tbody').innerHTML = `<tr><td colspan="6" style="text-align:center;padding:18px;color:#f87171;">❌ Error: ${esc(e.message)}</td></tr>`;
  }
  btn.innerText = '🧪 Test Keys'; btn.disabled = false;
}

function renderTestResults(data) {
  const ok = data.ok || 0, total = data.total || 0, failed = data.failed || 0;
  document.getElementById('test-summary').innerHTML = `
    <span class="badge bg-green">✅ Working: ${ok}</span>
    <span class="badge bg-red">❌ Failed: ${failed}</span>
    <span class="badge bg-blue">📊 Total: ${total}</span>`;
  let html = '';
  (data.results || []).forEach(r => {
    const bg = r.ok ? 'rgba(74,222,128,.05)' : 'rgba(248,113,113,.05)';
    const statusColor = r.ok ? '#4ade80' : (r.status === 429 ? '#fbbf24' : '#f87171');
    const statusLabel = r.ok ? '✅ 200' : (r.status === 429 ? '⚠️ 429' : ('❌ ' + r.status));
    html += `<tr style="background:${bg};border-bottom:1px solid #2d2d2d;">
      <td style="padding:7px;font-family:monospace;color:#93c5fd;">${esc(r.key)}</td>
      <td style="padding:7px;color:#c4b5fd;">${esc(r.model)}${r.blocked_left > 0 ? ' <span style="color:#f87171;font-weight:bold;">⛔</span>' : ''}</td>
      <td style="padding:7px;color:#fbbf24;font-style:italic;">${esc(r.question || '')}</td>
      <td style="padding:7px;text-align:center;font-weight:bold;color:${statusColor};">${statusLabel}</td>
      <td class="selectable" style="padding:7px;max-width:280px;word-break:break-word;">${esc(r.response)}</td>
      <td style="padding:7px;text-align:right;color:#9ca3af;">${r.ms}ms</td>
    </tr>`;
  });
  document.getElementById('test-tbody').innerHTML = html || '<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:18px;">No results</td></tr>';
}

// ===== Live Polling & Data Fetching =====
let ctl = null, loading = false, paused = false, filter = 'all', lastSig = '', lastStatusSig = '', lastMs = 0, timer = null;
const expanded = {};

function setBusy(b) {
  loading = b;
  document.getElementById('skip-btn').style.display = b ? 'inline-flex' : 'none';
  document.getElementById('refresh-btn').textContent = b ? '⏳...' : '🔄 Refresh';
}
function skipLoad() { if (ctl) ctl.abort(); }
function togglePause() {
  paused = !paused;
  document.getElementById('pause-btn').textContent = paused ? '▶ Resume' : '⏸ Pause';
  document.getElementById('live-dot').textContent = paused ? '⏸ Paused' : '● Live';
  document.getElementById('live-dot').style.color = paused ? '#fbbf24' : '#4ade80';
}

async function fetchData(manual) {
  if (manual !== true && (loading || document.hidden || isUserBusySelecting())) return;
  if (ctl) ctl.abort();
  const my = new AbortController(); ctl = my;
  const to = setTimeout(() => my.abort(), 12000);
  const t0 = Date.now();
  setBusy(true);
  try {
    let r = await fetch('/router/dashboard_data?slim=1', {credentials: 'same-origin', signal: my.signal});
    if (r.status === 404) {
      r = await fetch('dashboard_data?slim=1', {credentials: 'same-origin', signal: my.signal});
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (my !== ctl) return;
    document.getElementById('error-msg').style.display = 'none';
    window._last = data;
    if (manual === true || !isUserBusySelecting()) {
      updateUI(data, manual === true);
    }
    syncLive();
  } catch (e) {
    if (my !== ctl) return;
    const el = document.getElementById('error-msg');
    el.style.display = 'block';
    el.textContent = (e.name === 'AbortError') ? '⏭ Slow load skipped — retrying automatically.' : '⚠️ Could not load data: ' + e.message;
  }
  clearTimeout(to);
  if (my === ctl) { lastMs = Date.now() - t0; setBusy(false); }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!paused && !isUserBusySelecting()) await fetchData(false);
    schedule();
  }, Math.min(18000, Math.max(4500, lastMs * 3)));
}

async function setFilter(f) {
  filter = f;
  lastSig = '';
  if (f === 'saved') await loadSaved();
  if (window._last) renderLogs(window._last, true);
}

// ===== Log Details Expansion (Works from Both Live IndexedDB and Server _log_detail) =====
async function toggleDetail(id) {
  if (expanded[id]) {
    if (expanded[id].ctl) expanded[id].ctl.abort();
    delete expanded[id];
    lastSig = '';
    if (window._last) renderLogs(window._last, true);
    return;
  }
  const _rec = await idbGet(filter === 'saved' ? ((savedRows.find(r => r.id === id) || {}).k) : (liveMeta.boot + ':' + id));
  if (_rec && _rec.resp && (_rec.resp.text || (_rec.resp.tool_calls && _rec.resp.tool_calls.length) || _rec.done)) {
    expanded[id] = {state: 'ok', live: _rec};
    lastSig = '';
    if (window._last) renderLogs(window._last, true);
    return;
  }
  const c = new AbortController();
  expanded[id] = {state: 'loading', ctl: c};
  lastSig = '';
  if (window._last) renderLogs(window._last, true);
  try {
    let r = await fetch('/router/dashboard_data?detail=' + id, {credentials: 'same-origin', signal: c.signal});
    if (r.status === 404) {
      r = await fetch('dashboard_data?detail=' + id, {credentials: 'same-origin', signal: c.signal});
    }
    const d = await r.json();
    if (!expanded[id] || expanded[id].ctl !== c) return;
    if (r.ok) {
      expanded[id] = {state: 'ok', d: d, live: _rec || null};
    } else if (_rec) {
      expanded[id] = {state: 'ok', live: _rec};
    } else {
      expanded[id] = {state: 'err', msg: d.error || ('HTTP ' + r.status)};
    }
  } catch (e) {
    if (!expanded[id] || expanded[id].ctl !== c) return;
    if (_rec) expanded[id] = {state: 'ok', live: _rec};
    else expanded[id] = {state: 'err', msg: e.message};
  }
  lastSig = '';
  if (window._last) renderLogs(window._last, true);
}

function buildDetailContent(id) {
  const x = expanded[id];
  if (!x) return '';
  if (x.state === 'loading') {
    return '<div style="padding:8px;">⏳ Loading full response & details... <button class="btn-s" onclick="toggleDetail(' + id + ')">⏭ Cancel</button></div>';
  }
  if (x.state === 'err') {
    return '<div style="padding:8px;"><span style="color:#f87171">' + esc(x.msg) + '</span> <button class="btn-s" onclick="toggleDetail(' + id + ')">Close</button></div>';
  }
  const nl = String.fromCharCode(10);
  const d = x.d || {};
  const rec = x.live || {};
  const q = d.req || rec.req || {};
  const p = d.resp || rec.resp || (d.response ? {text: d.response, tool_calls: d.tool_calls || [], finish_reason: d.finish_reason, usage: d.usage, status_code: 200} : null);
  const trail = (d.trail && d.trail.length) ? d.trail : (rec.trail || []);
  const attempts = (d.attempts && d.attempts.length) ? d.attempts : (rec.attempts || []);
  const errDetail = d.error_detail || (p && p.error) || '';

  let o = '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:6px;">'
    + '<span style="font-weight:700;color:#c4b5fd;font-size:.82em;">🔎 Full Log Details #' + id + '</span>'
    + '<button class="btn-s" onclick="toggleDetail(' + id + ')">✕ Close details</button></div>';

  // 1. Incoming Response Section (Featured First!)
  const respBoxId = 'det-resp-' + id;
  if (p || d.response) {
    const rText = (p && p.text) ? p.text : (d.response || '');
    const tcs = (p && p.tool_calls && p.tool_calls.length) ? p.tool_calls : (d.tool_calls || []);
    const metaParts = [];
    if (p && p.status_code) metaParts.push('HTTP ' + p.status_code);
    if ((p && p.finish_reason) || d.finish_reason) metaParts.push('finish: ' + ((p && p.finish_reason) || d.finish_reason));
    if ((p && p.usage) || d.usage) metaParts.push('usage: ' + JSON.stringify((p && p.usage) || d.usage));
    o += '<div class="det-sec-hdr" style="color:#4ade80;">'
      + '<span>✅ Incoming Response ' + (metaParts.length ? '<span style="color:#94a3b8;font-weight:normal;font-size:.9em;">(' + esc(metaParts.join(' · ')) + ')</span>' : '') + '</span>'
      + '<span style="display:inline-flex;gap:5px;">'
      + '<button class="btn-copy" onclick="copyByElemId(\'' + respBoxId + '\', this)">📋 Copy Response</button>'
      + '<button class="btn-copy" onclick="selectElemText(\'' + respBoxId + '\')">🔍 Select</button>'
      + '</span></div>';
    if (rText) {
      o += '<div id="' + respBoxId + '" class="det selectable" style="color:#d1fae5;border-color:rgba(74,222,128,.35);background:#0b1714;">' + esc(rText) + '</div>';
    } else if (!tcs.length) {
      o += '<div id="' + respBoxId + '" class="det selectable" style="color:#9ca3af;">(empty response text)</div>';
    }
    if (tcs.length) {
      const tcBoxId = 'det-tc-' + id;
      const tcText = tcs.map(c => '🔧 ' + (c.name || 'tool') + nl + pj(c.arguments) + (c.id ? nl + 'id=' + c.id : '')).join(nl + nl);
      o += '<div class="det-sec-hdr" style="color:#fcd34d;"><span>🔧 Tool Calls (' + tcs.length + ')</span>'
        + '<button class="btn-copy" onclick="copyByElemId(\'' + tcBoxId + '\', this)">📋 Copy Tool Calls</button></div>'
        + '<div id="' + tcBoxId + '" class="det selectable" style="color:#fde68a;">' + esc(tcText) + '</div>';
    }
  } else if (rec && rec.done === false) {
    o += '<div class="det-sec-hdr" style="color:#60a5fa;">⏳ Response is still streaming / running...</div>';
  }

  // 2. Error / Fallback Reason
  if (errDetail) {
    const errBoxId = 'det-err-' + id;
    o += '<div class="det-sec-hdr" style="color:#f87171;"><span>⚠️ Error / Fallback Details</span>'
      + '<button class="btn-copy" onclick="copyByElemId(\'' + errBoxId + '\', this)">📋 Copy Error</button></div>'
      + '<div id="' + errBoxId + '" class="det selectable" style="color:#fca5a5;border-color:rgba(248,113,113,.35);">' + esc(errDetail) + '</div>';
  }

  // 3. Route Trail & Attempts
  if (trail.length) {
    const trBoxId = 'det-tr-' + id;
    o += '<div class="det-sec-hdr" style="color:#fbbf24;"><span>🛣️ Route Trail (' + trail.length + ')</span>'
      + '<button class="btn-copy" onclick="copyByElemId(\'' + trBoxId + '\', this)">📋 Copy</button></div>'
      + '<div id="' + trBoxId + '" class="det selectable" style="color:#fcd34d;max-height:160px;">' + esc(trail.join(nl)) + '</div>';
  }
  if (attempts.length) {
    const attBoxId = 'det-att-' + id;
    o += '<div class="det-sec-hdr" style="color:#f87171;"><span>🔄 Attempts (' + attempts.length + ')</span>'
      + '<button class="btn-copy" onclick="copyByElemId(\'' + attBoxId + '\', this)">📋 Copy</button></div>'
      + '<div id="' + attBoxId + '" class="det selectable" style="color:#fca5a5;max-height:160px;">' + esc(attempts.join(nl)) + '</div>';
  }

  // 4. Request Messages / Raw Request Summary
  if (q && q.messages && q.messages.length) {
    const reqMsgsId = 'det-reqm-' + id;
    o += '<div class="det-sec-hdr" style="color:#93c5fd;">'
      + '<span>💬 Request Messages (' + (q.n_messages || q.messages.length) + ') · ' + esc(JSON.stringify(q.params || {})) + '</span>'
      + '<span style="display:inline-flex;gap:5px;">'
      + '<button class="btn-copy" onclick="copyByElemId(\'' + reqMsgsId + '\', this)">📋 Copy All Messages</button>'
      + '<button class="btn-copy" onclick="selectElemText(\'' + reqMsgsId + '\')">🔍 Select</button>'
      + '</span></div>';
    if (q.tools && q.tools.length) {
      o += '<div class="det selectable" style="color:#c4b5fd;max-height:110px;margin-bottom:4px;">Tools (' + q.tools.length + '): ' + esc(q.tools.map(t => t.name).join(', ')) + '</div>';
    }
    let mHtml = '';
    q.messages.forEach(m => { mHtml += liveMsgBlock(m); });
    o += '<div id="' + reqMsgsId + '">' + mHtml + '</div>';
  } else if (d.request) {
    const reqBoxId = 'det-req-' + id;
    o += '<div class="det-sec-hdr" style="color:#93c5fd;"><span>📨 Request Summary</span>'
      + '<span style="display:inline-flex;gap:5px;">'
      + '<button class="btn-copy" onclick="copyByElemId(\'' + reqBoxId + '\', this)">📋 Copy Request</button>'
      + '<button class="btn-copy" onclick="selectElemText(\'' + reqBoxId + '\')">🔍 Select</button>'
      + '</span></div>'
      + '<div id="' + reqBoxId + '" class="det selectable">' + esc(d.request) + '</div>';
  }
  return o;
}

function renderLogs(data, forceRender) {
  if (!forceRender && isUserBusySelecting()) return;
  window._last = data;
  const recent = data.logs || [], old = data.older_errors || [];
  const cnt = {ok: 0, warn: 0, fail: 0, pending: 0};
  recent.forEach(l => { cnt[l.kind] = (cnt[l.kind] || 0) + 1; });
  const nFail = cnt.fail + old.length;
  const chips = [
    ['all', 'All (' + recent.length + ')'],
    ['fail', '❌ Errors (' + nFail + ')'],
    ['warn', '⚠️ Fallback (' + cnt.warn + ')'],
    ['pending', '⏳ Pending (' + cnt.pending + ')'],
    ['ok', '✅ OK (' + cnt.ok + ')'],
    ['saved', '💾 Browser (' + savedCount + ')']
  ];
  document.getElementById('log-chips').innerHTML = chips.map(c =>
    '<span class="chip' + (filter === c[0] ? ' on' : '') + '" onclick="setFilter(\'' + c[0] + '\')">' + c[1] + '</span>'
  ).join('');

  let rows;
  if (filter === 'all') rows = recent;
  else if (filter === 'fail') rows = recent.filter(l => l.kind === 'fail').concat(old);
  else if (filter === 'saved') rows = savedRows.map(r => {
    const s = Object.assign({}, r.slim || {});
    if (!s.response && r.resp && r.resp.text) s.response = r.resp.text.slice(0, 500);
    return s;
  });
  else rows = recent.filter(l => l.kind === filter);

  // Merge live response preview from browser store if present
  rows = rows.map(l => {
    const copy = Object.assign({}, l);
    const liveRec = liveById[copy.id];
    if (!copy.response && liveRec && liveRec.resp) {
      if (liveRec.resp.text) copy.response = liveRec.resp.text.slice(0, 500);
      else if (liveRec.resp.tool_calls && liveRec.resp.tool_calls.length) {
        copy.response = '🔧 ' + liveRec.resp.tool_calls.map(t => t.name + '(' + (t.arguments || '').slice(0, 80) + ')').join(' | ');
      }
    }
    return copy;
  });

  if (searchQuery) {
    rows = rows.filter(l => {
      const hay = ((l.model || '') + ' ' + (l.status || '') + ' ' + (l.message || '') + ' ' + (l.response || '') + ' ' + (l.error || '') + ' ' + (l.route || '') + ' ' + (l.ip || '')).toLowerCase();
      return hay.includes(searchQuery);
    });
  }

  rows = rows.slice().sort((a, b) => b.id - a.id);
  if (!paused) {
    document.getElementById('log-note').textContent = (filter === 'all' && old.length)
      ? (old.length + ' older error(s) kept in ❌ Errors tab')
      : '';
  }

  const sig = filter + '|' + searchQuery + '|' + rows.map(l => l.id + ':' + l.status + ':' + l.response_ms + ':' + (l.response || '').length).join(',') + '|' + Object.keys(expanded).map(k => k + ':' + expanded[k].state).join(',');
  if (!forceRender && sig === lastSig) return;
  lastSig = sig;

  const tbody = document.getElementById('logs-body');
  const cardsEl = document.getElementById('logs-cards');
  if (!rows.length) {
    const emptyMsg = filter === 'all' && !searchQuery ? 'No logs yet.' : 'No matching logs.';
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#666;padding:24px;">' + emptyMsg + '</td></tr>';
    cardsEl.innerHTML = '<div class="card" style="text-align:center;color:#666;padding:20px;">' + emptyMsg + '</div>';
    return;
  }

  let tblHtml = '';
  let cardHtml = '';

  rows.forEach(l => {
    const k = l.kind;
    const bar = k === 'fail' ? 'background:rgba(248,113,113,.07);border-left:3px solid #f87171;'
      : k === 'warn' ? 'background:rgba(251,191,36,.06);border-left:3px solid #fbbf24;'
      : k === 'pending' ? 'border-left:3px solid #60a5fa;' : '';
    const bc = k === 'fail' ? 'bg-red' : k === 'warn' ? 'bg-amber' : k === 'pending' ? 'bg-blue' : 'bg-green';
    const pwd = l.is_correct ? '🛡️' : '<span class="pwd-wrong">' + esc(l.password_used || 'NONE') + '</span>';
    const ms = (l.response_ms !== null && l.response_ms !== undefined) ? l.response_ms + 'ms' : '—';
    const promptId = 'p-txt-' + l.id;
    const respId = 'r-txt-' + l.id;
    const mPromptId = 'mp-txt-' + l.id;
    const mRespId = 'mr-txt-' + l.id;
    const promptTxt = l.message || '(empty)';
    const hasResp = !!(l.response && l.response.trim());
    const respTxt = hasResp ? l.response : (k === 'pending' ? '⏳ Generating response...' : (l.error ? '⚠️ See error' : '—'));
    const errHtml = l.error ? '<div class="err selectable' + (k === 'warn' ? ' warn' : '') + '">' + esc(l.error) + '</div>' : '<span style="color:#4ade80;font-size:.78em;">—</span>';
    const isExp = !!expanded[l.id];
    const detBtn = '<button class="btn-s" onclick="toggleDetail(' + l.id + ')">' + (isExp ? '✕ Close' : 'Details ▾') + '</button>';

    // Desktop Table Row
    tblHtml += '<tr style="' + bar + '">'
      + '<td style="white-space:nowrap;font-size:.78em;"><div style="color:#94a3b8;">' + esc(l.time || '') + '</div><div class="ip">' + esc(l.ip || '') + ' ' + pwd + '</div></td>'
      + '<td><span class="badge ' + bc + '">' + esc(l.status || '') + '</span><div style="color:#94a3b8;font-size:.75em;margin-top:3px;">⏱ ' + ms + '</div></td>'
      + '<td><div style="color:#c4b5fd;font-weight:600;font-size:.8em;font-family:monospace;word-break:break-all;">' + (l.model ? esc(l.model) : '—') + '</div><div style="color:#93c5fd;font-size:.73em;margin-top:2px;word-break:break-word;">' + esc(l.route || '—') + '</div></td>'
      + '<td><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;"><span style="font-size:.7em;color:#94a3b8;">Prompt</span><button class="btn-copy" onclick="copyByElemId(\'' + promptId + '\', this)">📋</button></div><div id="' + promptId + '" class="msg selectable">' + esc(promptTxt) + '</div></td>'
      + '<td><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;"><span style="font-size:.7em;color:#4ade80;">Response</span>' + (hasResp ? '<button class="btn-copy" onclick="copyByElemId(\'' + respId + '\', this)">📋</button>' : '') + '</div><div id="' + respId + '" class="resp-box selectable' + (hasResp ? '' : ' empty') + '">' + esc(respTxt) + '</div></td>'
      + '<td>' + errHtml + '</td>'
      + '<td style="text-align:right;">' + detBtn + '</td>'
      + '</tr>';
    if (isExp) {
      tblHtml += '<tr><td colspan="7" style="background:#11131c;padding:10px 14px;">' + buildDetailContent(l.id) + '</td></tr>';
    }

    // Mobile Compact Card
    cardHtml += '<div class="log-card k-' + k + '">'
      + '<div class="lc-top">'
      +   '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">'
      +     '<span class="badge ' + bc + '">' + esc(l.status || '') + '</span>'
      +     '<span style="color:#c4b5fd;font-family:monospace;font-weight:700;font-size:.82em;">' + (l.model ? esc(l.model) : '—') + '</span>'
      +     '<span style="color:#94a3b8;font-size:.76em;">⏱ ' + ms + '</span>'
      +   '</div>'
      +   detBtn
      + '</div>'
      + '<div class="lc-meta"><span>🕒 ' + esc(l.time || '') + '</span><span>·</span><span class="ip">' + esc(l.ip || '') + ' ' + pwd + '</span></div>'
      + (l.route ? '<div class="lc-route">🛣️ ' + esc(l.route) + '</div>' : '')
      + '<div>'
      +   '<div class="lc-box-lbl"><span>💬 Prompt</span><span style="display:inline-flex;gap:4px;"><button class="btn-copy" onclick="copyByElemId(\'' + mPromptId + '\', this)">📋 Copy</button><button class="btn-copy" onclick="selectElemText(\'' + mPromptId + '\')">🔍 Select</button></span></div>'
      +   '<div id="' + mPromptId + '" class="msg selectable">' + esc(promptTxt) + '</div>'
      + '</div>'
      + '<div>'
      +   '<div class="lc-box-lbl"><span style="color:#4ade80;">✅ Response</span>' + (hasResp ? '<span style="display:inline-flex;gap:4px;"><button class="btn-copy" onclick="copyByElemId(\'' + mRespId + '\', this)">📋 Copy</button><button class="btn-copy" onclick="selectElemText(\'' + mRespId + '\')">🔍 Select</button></span>' : '') + '</div>'
      +   '<div id="' + mRespId + '" class="resp-box selectable' + (hasResp ? '' : ' empty') + '">' + esc(respTxt) + '</div>'
      + '</div>'
      + (l.error ? '<div><div class="lc-box-lbl"><span style="color:#f87171;">⚠️ Error / Fallback</span></div>' + errHtml + '</div>' : '')
      + (isExp ? '<div style="background:#11131c;border:1px solid #2b3040;border-radius:6px;padding:8px;margin-top:4px;">' + buildDetailContent(l.id) + '</div>' : '')
      + '</div>';
  });

  tbody.innerHTML = tblHtml;
  cardsEl.innerHTML = cardHtml;
}

// ===== Browser-side Log Store (IndexedDB) + In-Memory Map =====
const IDB_NAME = 'wapi_logs', IDB_STORE = 'recs', IDB_MAX = 300;
let idb = null, liveBusy = false, savedRows = [], savedCount = 0;
const liveById = {};
const liveMeta = {boot: '', maxId: 0, pending: new Set()};

function idbOpen() {
  return new Promise(res => {
    if (!window.indexedDB) { res(null); return; }
    const rq = indexedDB.open(IDB_NAME, 1);
    rq.onupgradeneeded = () => { const s = rq.result.createObjectStore(IDB_STORE, {keyPath: 'k'}); s.createIndex('t0', 't0'); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => res(null);
  });
}
function idbStore(mode) { return idb.transaction(IDB_STORE, mode).objectStore(IDB_STORE); }
function idbReq(rq) { return new Promise(res => { rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); }); }
async function idbPut(rec) {
  liveById[rec.id] = rec;
  if (!idb) return;
  rec.k = rec.boot + ':' + rec.id;
  await idbReq(idbStore('readwrite').put(rec));
}
async function idbGet(k) {
  if (k) {
    const parts = String(k).split(':');
    const numId = Number(parts[parts.length - 1]);
    if (liveById[numId]) return liveById[numId];
  }
  if (!idb || !k) return null;
  return await idbReq(idbStore('readonly').get(k));
}
async function idbAll() { if (!idb) return []; return (await idbReq(idbStore('readonly').getAll())) || []; }
async function idbTrim() {
  if (!idb) return;
  const n = (await idbReq(idbStore('readonly').count())) || 0;
  savedCount = n;
  if (n <= IDB_MAX) return;
  const keys = (await idbReq(idbStore('readonly').index('t0').getAllKeys())) || [];
  for (let i = 0; i < n - IDB_MAX; i++) await idbReq(idbStore('readwrite').delete(keys[i]));
  savedCount = IDB_MAX;
}
async function loadSaved() { savedRows = (await idbAll()).sort((a, b) => b.t0 - a.t0); savedCount = savedRows.length; }
async function clearSaved() {
  if (!confirm('Delete all logs saved in this browser?')) return;
  if (idb) await idbReq(idbStore('readwrite').clear());
  savedRows = []; savedCount = 0; liveMeta.maxId = 0; liveMeta.pending.clear();
  Object.keys(liveById).forEach(k => delete liveById[k]);
  lastSig = ''; if (window._last) renderLogs(window._last, true);
}
async function syncLive() {
  if (liveBusy) return;
  liveBusy = true;
  try {
    let url = '/router/dashboard_data?live_since=' + liveMeta.maxId + '&boot=' + encodeURIComponent(liveMeta.boot) + '&pending=' + Array.from(liveMeta.pending).join(',');
    let r = await fetch(url, {credentials: 'same-origin'});
    if (r.status === 404) {
      r = await fetch('dashboard_data?live_since=' + liveMeta.maxId + '&boot=' + encodeURIComponent(liveMeta.boot) + '&pending=' + Array.from(liveMeta.pending).join(','), {credentials: 'same-origin'});
    }
    if (!r.ok) { liveBusy = false; return; }
    const d = await r.json();
    if (d.boot !== liveMeta.boot) { liveMeta.boot = d.boot; liveMeta.maxId = 0; liveMeta.pending.clear(); }
    const recs = d.recs || [];
    for (const rec of recs) {
      await idbPut(rec);
      liveMeta.maxId = Math.max(liveMeta.maxId, rec.id);
      if (rec.done) liveMeta.pending.delete(rec.id); else liveMeta.pending.add(rec.id);
      const x = expanded[rec.id]; if (x) x.live = rec;
    }
    if (recs.length) {
      await idbTrim();
      if (filter === 'saved') await loadSaved();
      if (!isUserBusySelecting()) {
        lastSig = '';
        if (window._last) renderLogs(window._last, false);
      }
    }
  } catch (e) {}
  liveBusy = false;
}
(async function liveInit() {
  idb = await idbOpen();
  if (idb) {
    const all = (await idbAll()).sort((a, b) => a.t0 - b.t0);
    savedCount = all.length;
    const last = all[all.length - 1];
    if (last) {
      liveMeta.boot = last.boot;
      all.forEach(r => {
        liveById[r.id] = r;
        if (r.boot === last.boot) {
          liveMeta.maxId = Math.max(liveMeta.maxId, r.id);
          if (!r.done) liveMeta.pending.add(r.id);
        }
      });
    }
  }
  syncLive();
})();
setInterval(() => { if (!paused && !document.hidden && !isUserBusySelecting() && liveMeta.pending.size) syncLive(); }, 2000);

function pj(a) { try { return JSON.stringify(JSON.parse(a), null, 2); } catch (e) { return a || ''; } }
function liveMsgBlock(m) {
  const nl = String.fromCharCode(10);
  const col = {system: '#a1a1aa', developer: '#a1a1aa', user: '#93c5fd', assistant: '#86efac', tool: '#fcd34d'}[m.role] || '#d4d4d8';
  let t = '[' + m.role + (m.name ? ' ' + m.name : '') + (m.tool_call_id ? ' #' + m.tool_call_id : '') + ']' + nl + (m.content || '');
  (m.tool_calls || []).forEach(c => { t += nl + '🔧 ' + c.name + '(' + pj(c.arguments) + ')' + (c.id ? '  id=' + c.id : ''); });
  return '<div class="det selectable" style="color:' + col + ';margin-top:4px;max-height:220px">' + esc(t) + '</div>';
}

// ===== Block Model Controls =====
function fmtLeft(sec) {
  sec = Math.max(0, Math.floor(sec));
  if (sec >= 86400 * 3649) return 'forever';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm';
  return sec + 's';
}
let blockTarget = '';
function openBlock(name) {
  blockTarget = name;
  document.getElementById('blk-model').textContent = name;
  document.getElementById('blk-dur').value = '1d';
  document.getElementById('blk-reason').value = '';
  document.getElementById('blk-err').textContent = '';
  document.getElementById('block-modal').style.display = 'flex';
  document.getElementById('blk-dur').focus();
}
function closeBlock() { document.getElementById('block-modal').style.display = 'none'; }
function pickDur(v) { document.getElementById('blk-dur').value = v; }
async function confirmBlock() {
  const dur = document.getElementById('blk-dur').value.trim();
  if (!dur) { document.getElementById('blk-err').textContent = 'Enter a duration, e.g. 1h, 1d, 43d'; return; }
  const d = await modelBlockCall({action: 'block', model: blockTarget, duration: dur, reason: document.getElementById('blk-reason').value.trim()});
  if (d) closeBlock();
}
async function unblockModel(name) {
  if (name === '*' && !confirm('Unblock ALL blocked models?')) return;
  await modelBlockCall(name === '*' ? {action: 'unblock_all'} : {action: 'unblock', model: name});
}
async function modelBlockCall(payload) {
  const opts = {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)};
  const noteEl = document.getElementById('log-note');
  try {
    let r = await fetch('/router/model_block', opts);
    if (r.status === 404) r = await fetch('model_block', opts);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = d.error || ('HTTP ' + r.status);
      if (payload.action === 'block') document.getElementById('blk-err').textContent = m; else alert(m);
      return null;
    }
    if (noteEl) noteEl.textContent = payload.action === 'block' ? ('⛔ ' + d.blocked + ' blocked for ' + fmtLeft(d.seconds)) : '✅ Unblocked';
    lastSig = ''; lastStatusSig = ''; await fetchData(true);
    return d;
  } catch (e) {
    if (payload.action === 'block') document.getElementById('blk-err').textContent = e.message; else alert('Failed: ' + e.message);
    return null;
  }
}

// ===== Add / Edit Model + Persistent Multi-Model Last-Tier Controls =====
let mdlEditing = false, mdlSavedFlag = false, mdlInEnv = false;
let availModels = [], usageOpen = {}, panelsOpen = {usage: false};

async function loadAvailable(force) {
  const sel = document.getElementById('mdl-pick'), note = document.getElementById('mdl-pick-note');
  sel.innerHTML = '<option value="">Loading from Google...</option>'; note.textContent = '';
  const q = force ? '?refresh=1' : '';
  try {
    let r = await fetch('/router/model_available' + q, {credentials: 'same-origin'});
    if (r.status === 404) r = await fetch('model_available' + q, {credentials: 'same-origin'});
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    availModels = d.models || [];
    const fresh = availModels.filter(m => !m.added), have = availModels.filter(m => m.added);
    let h = '<option value="">' + (fresh.length ? ('Choose a model (' + fresh.length + ' new)') : 'All Google models added') + '</option>';
    if (fresh.length) h += '<optgroup label="Not added yet">' + fresh.map(m => '<option value="' + esc(m.name) + '">' + esc(m.name) + '</option>').join('') + '</optgroup>';
    if (have.length) h += '<optgroup label="Already in pool">' + have.map(m => '<option value="' + esc(m.name) + '">' + esc(m.name) + ' (in pool)</option>').join('') + '</optgroup>';
    sel.innerHTML = h;
  } catch (e) {
    sel.innerHTML = '<option value="">Could not load list — type name below</option>';
    note.textContent = '⚠️ ' + e.message;
  }
}

function pickModel() {
  const name = document.getElementById('mdl-pick').value;
  const m = availModels.find(x => x.name === name), note = document.getElementById('mdl-pick-note');
  if (!m) { note.textContent = ''; return; }
  document.getElementById('mdl-name').value = m.name;
  document.getElementById('mdl-rpm').value = m.rpm;
  document.getElementById('mdl-rpd').value = m.rpd;
  document.getElementById('mdl-last-tier').checked = m.name.toLowerCase().includes('lite');
  const tok = m.input_tokens ? (' · ' + Number(m.input_tokens).toLocaleString() + ' in tokens') : '';
  note.textContent = 'Suggested (' + m.limits_from + ')' + tok;
}

function openModelForm(name, rpm, rpd, saved, inEnv, isLastTier) {
  mdlEditing = !!name; mdlSavedFlag = !!saved; mdlInEnv = !!inEnv;
  document.getElementById('mdl-title').textContent = name ? '✏️ Edit model & tier' : '➕ Add model';
  const n = document.getElementById('mdl-name');
  n.value = name || ''; n.readOnly = mdlEditing; n.style.opacity = mdlEditing ? '.65' : '1';
  document.getElementById('mdl-rpm').value = rpm || '';
  document.getElementById('mdl-rpd').value = rpd || '';
  document.getElementById('mdl-last-tier').checked = isLastTier !== undefined ? !!isLastTier : ((name || '').toLowerCase().includes('lite'));
  document.getElementById('mdl-err').textContent = '';
  document.getElementById('mdl-test-out').innerHTML = '';
  const del = document.getElementById('mdl-del');
  del.style.display = (mdlEditing && mdlSavedFlag) ? 'inline-flex' : 'none';
  del.textContent = mdlInEnv ? '↩ Reset to env' : '🗑 Delete';
  document.getElementById('mdl-pick-row').style.display = mdlEditing ? 'none' : 'block';
  if (!mdlEditing) loadAvailable(false);
  document.getElementById('model-modal').style.display = 'flex';
  (mdlEditing ? document.getElementById('mdl-rpm') : n).focus();
}
function closeModelForm() { document.getElementById('model-modal').style.display = 'none'; }

async function modelCfgCall(payload, customErrId) {
  const opts = {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)};
  const errEl = document.getElementById(customErrId || 'mdl-err');
  try {
    let r = await fetch('/router/model_config', opts);
    if (r.status === 404) r = await fetch('model_config', opts);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (errEl) errEl.textContent = d.error || ('HTTP ' + r.status);
      else alert(d.error || ('HTTP ' + r.status));
      return null;
    }
    lastSig = ''; lastStatusSig = ''; await fetchData(true);
    return d;
  } catch (e) {
    if (errEl) errEl.textContent = 'Failed: ' + e.message;
    else alert('Failed: ' + e.message);
    return null;
  }
}

async function saveModelCfg() {
  const name = document.getElementById('mdl-name').value.trim();
  const rpm = document.getElementById('mdl-rpm').value.trim();
  const rpd = document.getElementById('mdl-rpd').value.trim();
  const lastTier = document.getElementById('mdl-last-tier').checked;
  const errEl = document.getElementById('mdl-err');
  if (!name) { errEl.textContent = 'Enter the model name'; return; }
  if (!rpm || !rpd) { errEl.textContent = 'Enter both RPM and RPD'; return; }
  const d = await modelCfgCall({action: 'set', model: name, rpm: rpm, rpd: rpd, last_tier: lastTier});
  if (d) {
    closeModelForm();
    const noteEl = document.getElementById('log-note');
    if (noteEl) noteEl.textContent = (d.created ? '✅ Added ' : '✅ Updated ') + d.model + ' (RPM ' + d.rpm + ', RPD ' + d.rpd + ', ' + (d.last_tier ? '🔚 Last-Tier' : '⚡ Primary') + ') — saved';
  }
}

async function deleteModelCfg() {
  const name = document.getElementById('mdl-name').value.trim();
  const msg = mdlInEnv ? ('Reset ' + name + ' to GEMINI_MODELS env limits?') : ('Delete model ' + name + ' from the router?');
  if (!confirm(msg)) return;
  const d = await modelCfgCall({action: 'delete', model: name});
  if (d) closeModelForm();
}

// ===== Last-Tier (Use Last) Multi-Model Manager =====
async function toggleSingleLastTier(modelName, makeLastTier) {
  const mode = makeLastTier ? 'add' : 'remove';
  const d = await modelCfgCall({action: 'set_last_tier', mode: mode, models: [modelName]});
  if (d) {
    const noteEl = document.getElementById('log-note');
    if (noteEl) noteEl.textContent = (makeLastTier ? '🔚 Moved to Last-Tier: ' : '⬆️ Moved to Primary Tier: ') + modelName + ' (saved)';
  }
}

async function batchSelectedLastTier(makeLastTier) {
  const chosen = mtChosen();
  if (!chosen.length) { alert('Tick one or more models first.'); return; }
  const d = await modelCfgCall({action: 'set_last_tier', mode: makeLastTier ? 'add' : 'remove', models: chosen});
  if (d) {
    const noteEl = document.getElementById('log-note');
    if (noteEl) noteEl.textContent = (makeLastTier ? '🔚 Added ' : '⬆️ Moved ') + chosen.length + ' model(s) to ' + (makeLastTier ? 'Last-Tier' : 'Primary Tier') + ' (saved)';
  }
}

function openLastTierModal() {
  document.getElementById('lt-err').textContent = '';
  document.getElementById('lt-manual-input').value = '';
  renderLastTierModalPool();
  loadLtGoogleModels(false);
  document.getElementById('lt-modal').style.display = 'flex';
}
function closeLastTierModal() { document.getElementById('lt-modal').style.display = 'none'; }

function renderLastTierModalPool() {
  const data = window._last || {};
  const models = data.models || [];
  const cfg = data.model_cfg || {};
  const box = document.getElementById('lt-pool-list');
  if (!models.length) {
    box.innerHTML = '<div style="color:#6b7280;padding:8px;">No models loaded yet.</div>';
    return;
  }
  box.innerHTML = models.map(m => {
    const c = cfg[m.name] || {};
    const isLt = !!c.last_tier;
    return `<label style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;background:${isLt ? 'rgba(251,191,36,.1)' : '#171923'};border:1px solid ${isLt ? 'rgba(251,191,36,.4)' : '#2b3040'};cursor:pointer;font-size:.82em;">
      <span style="display:flex;align-items:center;gap:7px;">
        <input type="checkbox" class="lt-pool-chk" data-m="${esc(m.name)}" ${isLt ? 'checked' : ''}>
        <span style="font-family:monospace;color:#e2e8f0;font-weight:600;">${esc(m.name)}</span>
      </span>
      <span style="font-size:.75em;color:${isLt ? '#fbbf24' : '#93c5fd'};">${isLt ? '🔚 Last-Tier' : '⚡ Primary'} · RPM ${m.rpm} · RPD ${m.rpd}</span>
    </label>`;
  }).join('');
}

function ltCheckPreset(preset) {
  document.querySelectorAll('.lt-pool-chk').forEach(chk => {
    const m = (chk.dataset.m || '').toLowerCase();
    if (preset === 'all') chk.checked = true;
    else if (preset === 'none') chk.checked = false;
    else if (preset === 'lite') chk.checked = m.includes('lite');
  });
}

async function saveLastTierChecklist() {
  const checked = [];
  document.querySelectorAll('.lt-pool-chk').forEach(chk => {
    if (chk.checked && chk.dataset.m) checked.push(chk.dataset.m);
  });
  const d = await modelCfgCall({action: 'set_last_tier', mode: 'replace', models: checked}, 'lt-err');
  if (d) {
    renderLastTierModalPool();
    const noteEl = document.getElementById('log-note');
    if (noteEl) noteEl.textContent = '🔚 Saved Last-Tier list (' + (d.last_tier_models || []).length + ' model(s)) — survives restarts';
    closeLastTierModal();
  }
}

async function addManualLastTierModels(mode) {
  const raw = document.getElementById('lt-manual-input').value.trim();
  if (!raw) {
    document.getElementById('lt-err').textContent = 'Type or pick at least one model name above';
    return;
  }
  const d = await modelCfgCall({action: 'set_last_tier', mode: mode || 'add', models: raw}, 'lt-err');
  if (d) {
    document.getElementById('lt-manual-input').value = '';
    renderLastTierModalPool();
    const noteEl = document.getElementById('log-note');
    if (noteEl) noteEl.textContent = '🔚 Added to Last-Tier list! Active Last-Tier models: ' + (d.last_tier_models || []).join(', ');
    closeLastTierModal();
  }
}

async function resetLastTierDefault() {
  if (!confirm('Reset Last-Tier list to default (only models with "lite" in their name)?')) return;
  const d = await modelCfgCall({action: 'set_last_tier', mode: 'reset'}, 'lt-err');
  if (d) {
    renderLastTierModalPool();
    const noteEl = document.getElementById('log-note');
    if (noteEl) noteEl.textContent = '↩ Reset Last-Tier list to default (*lite* models)';
    closeLastTierModal();
  }
}

async function loadLtGoogleModels(force) {
  const sel = document.getElementById('lt-google-pick');
  if (!sel) return;
  if (!force && availModels && availModels.length) {
    populateLtGoogleSelect(availModels);
    return;
  }
  sel.innerHTML = '<option value="">Loading Google models...</option>';
  try {
    let r = await fetch('/router/model_available' + (force ? '?refresh=1' : ''), {credentials: 'same-origin'});
    if (r.status === 404) r = await fetch('model_available' + (force ? '?refresh=1' : ''), {credentials: 'same-origin'});
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.models) {
      availModels = d.models;
      populateLtGoogleSelect(availModels);
      return;
    }
  } catch (e) {}
  sel.innerHTML = '<option value="">Could not fetch Google list — type model names below</option>';
}

function populateLtGoogleSelect(list) {
  const sel = document.getElementById('lt-google-pick');
  if (!sel) return;
  let h = '<option value="">+ Pick from Google account models (' + list.length + ')...</option>';
  list.forEach(m => {
    h += '<option value="' + esc(m.name) + '">' + esc(m.name) + (m.added ? ' (in pool)' : ' (new)') + '</option>';
  });
  sel.innerHTML = h;
}

function ltAppendFromGoogle() {
  const sel = document.getElementById('lt-google-pick');
  const val = sel.value;
  if (!val) return;
  const ta = document.getElementById('lt-manual-input');
  const cur = ta.value.trim();
  const parts = cur ? cur.split(/[,\s\n]+/).filter(Boolean) : [];
  if (!parts.includes(val)) parts.push(val);
  ta.value = parts.join(', ');
  sel.value = '';
}

// ===== Model Probe Testing =====
let mtSel = {};
function mtCount() { return Object.keys(mtSel).filter(k => mtSel[k]).length; }
function mtChosen() { return Object.keys(mtSel).filter(k => mtSel[k]); }
function mtRefreshBtn() {
  const n = mtCount();
  const b = document.getElementById('mt-sel-btn');
  if (b) { b.textContent = '🧪 Test (' + n + ')'; b.disabled = n === 0; b.style.opacity = n ? '1' : '.45'; }
  const bLt = document.getElementById('mt-lt-btn');
  if (bLt) { bLt.textContent = '🔚 → Last (' + n + ')'; bLt.disabled = n === 0; bLt.style.opacity = n ? '1' : '.45'; }
  const bPr = document.getElementById('mt-pr-btn');
  if (bPr) { bPr.textContent = '⬆️ → 1st (' + n + ')'; bPr.disabled = n === 0; bPr.style.opacity = n ? '1' : '.45'; }
}
function mtToggle(name, on) { mtSel[name] = !!on; mtRefreshBtn(); }
function mtSelectAll(on) {
  (window._mtNames || []).forEach(n => { mtSel[n] = on; });
  document.querySelectorAll('.mt-chk').forEach(c => { c.checked = on; });
  mtRefreshBtn();
}
function mtClose() { document.getElementById('mt-modal').style.display = 'none'; }
async function mtCall(names, all) {
  const opts = {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(all ? {all: true} : {models: names})};
  let r = await fetch('/router/model_test', opts);
  if (r.status === 404) r = await fetch('model_test', opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}
function mtKindColor(k) { return {'text-out': '#60a5fa', 'image-out': '#f472b6', 'audio-out': '#fbbf24', 'embedding': '#2dd4bf', 'live': '#c084fc'}[k] || '#9ca3af'; }
async function mtRun(names, all) {
  if (!all && !names.length) return;
  document.getElementById('mt-modal').style.display = 'flex';
  document.getElementById('mt-title').textContent = '🧪 Model Test — ' + (all ? 'all models' : names.length + ' selected');
  document.getElementById('mt-summary').innerHTML = '';
  document.getElementById('mt-bytype').textContent = '';
  document.getElementById('mt-tbody').innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:#a78bfa;">⏳ Testing one real request per model...</td></tr>';
  try {
    const d = await mtCall(names, all);
    mtRender(d);
  } catch (e) {
    document.getElementById('mt-tbody').innerHTML = '<tr><td colspan="7" style="text-align:center;padding:18px;color:#f87171;">❌ ' + esc(e.message) + '</td></tr>';
  }
}
function mtRender(d) {
  const rs = d.results || [];
  document.getElementById('mt-summary').innerHTML =
    '<span class="badge bg-green">✅ Working: ' + (d.ok || 0) + '</span>' +
    '<span class="badge bg-red">❌ Not working: ' + (d.failed || 0) + '</span>' +
    (d.untested ? '<span class="badge bg-amber">➖ Untested: ' + d.untested + '</span>' : '') +
    '<span class="badge bg-blue">📊 Total: ' + (d.total || 0) + '</span>';
  const by = {};
  rs.filter(r => r.ok === true).forEach(r => { (by[r.type] = by[r.type] || []).push(r.model); });
  document.getElementById('mt-bytype').innerHTML = Object.keys(by).length ? ('Working by type: ' + Object.keys(by).map(t => '<b>' + esc(t) + '</b> (' + by[t].length + ')').join(' · ')) : '';
  let h = '';
  rs.forEach(r => {
    const st = r.ok === true ? ['✅ works', '#4ade80', 'rgba(74,222,128,.05)'] : (r.ok === null ? ['➖ untested', '#9ca3af', 'rgba(156,163,175,.05)'] : ((r.status === 429 || r.status === 403) ? ['⚠️ ' + r.status + ' limit', '#fbbf24', 'rgba(251,191,36,.05)'] : ['❌ ' + (r.status || 'err'), '#f87171', 'rgba(248,113,113,.05)']));
    const tags = (r.in_pool ? '' : ' <span style="color:#fbbf24;font-size:.75em;">not in pool</span>') + (r.blocked_left > 0 ? ' <span style="color:#f87171;font-size:.75em;">⛔ blocked</span>' : '');
    h += '<tr style="background:' + st[2] + ';border-bottom:1px solid #2d2d2d;">' +
      '<td style="padding:7px;font-family:monospace;color:#c4b5fd;">' + esc(r.model) + tags + '</td>' +
      '<td style="padding:7px;font-weight:bold;color:' + st[1] + ';white-space:nowrap;">' + st[0] + '</td>' +
      '<td style="padding:7px;color:' + mtKindColor(r.kind) + ';">' + esc(r.type || '') + '</td>' +
      '<td style="padding:7px;color:#e5e7eb;">' + esc((r.outputs || []).join(' + ') || '-') + '</td>' +
      '<td style="padding:7px;font-family:monospace;color:#93c5fd;">' + esc(r.key || '') + '</td>' +
      '<td style="padding:7px;text-align:right;color:#9ca3af;">' + (r.ms || '') + '</td>' +
      '<td class="selectable" style="padding:7px;max-width:320px;word-break:break-word;color:' + (r.ok === true ? '#e5e7eb' : '#fca5a5') + ';">' + esc(r.response || '') + '</td></tr>';
  });
  document.getElementById('mt-tbody').innerHTML = h || '<tr><td colspan="7" style="text-align:center;color:#6b7280;padding:18px;">No results</td></tr>';
}

async function mdlTest() {
  const name = document.getElementById('mdl-name').value.trim();
  const out = document.getElementById('mdl-test-out'), btn = document.getElementById('mdl-test-btn');
  if (!name) { out.innerHTML = '<span style="color:#f87171;">Pick or type a model name first</span>'; return; }
  out.innerHTML = '<span style="color:#a78bfa;">⏳ Testing ' + esc(name) + '...</span>'; btn.disabled = true;
  try {
    const d = await mtCall([name], false);
    const r = (d.results || [])[0];
    if (!r) out.textContent = 'No result';
    else {
      const c = r.ok === true ? '#4ade80' : (r.ok === null ? '#9ca3af' : '#f87171');
      out.innerHTML = '<b style="color:' + c + ';">' + (r.ok === true ? '✅ Works' : (r.ok === null ? '➖ Not testable' : '❌ Failed (' + (r.status || 'error') + ')')) + '</b>' +
        ' · <b style="color:' + mtKindColor(r.kind) + ';">' + esc(r.type) + '</b>' + (r.ms ? ' · ' + r.ms + 'ms' : '') +
        '<div class="selectable" style="color:#9ca3af;margin-top:3px;">' + esc(r.response || '') + '</div>';
    }
  } catch (e) { out.innerHTML = '<span style="color:#f87171;">❌ ' + esc(e.message) + '</span>'; }
  btn.disabled = false;
}

async function releaseDaily(keyFilter = '', modelFilter = '') {
  const payload = {};
  if (keyFilter) payload.key = keyFilter;
  if (modelFilter) payload.model = modelFilter;
  const noteEl = document.getElementById('log-note');
  if (noteEl) noteEl.textContent = '⏳ Releasing lock...';
  try {
    let r = await fetch('/router/release_daily', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
    if (r.status === 404) {
      r = await fetch('release_daily', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (noteEl) noteEl.textContent = '🔓 Released ' + d.released + ' lock' + (d.released === 1 ? '' : 's');
    lastSig = ''; lastStatusSig = ''; await fetchData(true);
  } catch (e) { alert('Release failed: ' + e.message); }
}

// ===== Render Top Dashboard Panels =====
function updateUI(data, force) {
  if (!force && isUserBusySelecting()) return;
  const m = data.metrics || {};
  window._mtNames = (data.models || []).map(x => x.name);

  // Build Penalized Keys HTML
  let penHtml = '';
  const penData = data.penalized_keys || {};
  const penEntries = Object.entries(penData);
  if (penEntries.length > 0) {
    penHtml += `<button class="btn-s" style="background:#dc2626;border-color:#ef4444;color:#fff;" onclick="releaseDaily('','')">🔓 Release All (${penEntries.length})</button>`;
    for (const [kv, mins] of penEntries) {
      const pipe = kv.lastIndexOf('|');
      const keyPart = pipe >= 0 ? kv.slice(0, pipe) : kv;
      const modelPart = pipe >= 0 ? kv.slice(pipe + 1) : '';
      const last5 = keyPart.slice(-5);
      penHtml += `<span class="tag" style="display:inline-flex;align-items:center;gap:4px;background:rgba(248,113,113,.15);color:#fca5a5;border-color:#f87171;">...${esc(last5)}|${esc(modelPart)} (${mins}m) <button class="btn-s" style="background:#b91c1c;color:#fff;padding:0 5px;font-size:.7em;" onclick="releaseDaily('${esc(last5)}','${esc(modelPart)}')">🔓</button></span>`;
    }
  } else {
    penHtml = `<span style="color:#4ade80;font-size:.8em;">All Clear ✅</span> <button class="btn-s" style="padding:1px 6px;font-size:.72em;" onclick="releaseDaily('','')">🔓 Reset Counters</button>`;
  }

  // Cooldowns HTML
  let cdHtml = '';
  const cdEntries = Object.entries(data.rpm_cooldowns || {});
  if (cdEntries.length > 0) {
    for (const [k, v] of cdEntries) {
      cdHtml += `<span class="tag" style="background:rgba(251,191,36,.16);color:#fbbf24;border-color:#fbbf24;">${esc(k)} (${v}s)</span>`;
    }
    cdHtml += ` <button class="btn-s" style="background:#78350f;border-color:#fbbf24;color:#fde68a;padding:1px 6px;" onclick="releaseDaily('','')">🔓 Clear</button>`;
  } else {
    cdHtml = '<span style="color:#4ade80;font-size:.8em;">None</span>';
  }

  // Keys Chips
  let keysHtml = '';
  (data.key_list || []).forEach(k => {
    keysHtml += `<span class="tag" style="background:#231c4c;border-color:#4c1d95;cursor:pointer;" onclick="testAllKeys('${esc(k)}')" title="Tap to test all models on key ${esc(k)}">${esc(k)} 🧪</span>`;
  });

  // Models & Last-Tier HTML
  const mki = data.model_key_info || {};
  const cfgMap = data.model_cfg || {};
  const ltModels = [];
  const prModels = [];
  (data.models || []).forEach(mod => {
    const c = cfgMap[mod.name] || {};
    const isLt = c.last_tier !== undefined ? !!c.last_tier : mod.name.toLowerCase().includes('lite');
    if (isLt) ltModels.push(mod.name);
    else prModels.push(mod.name);
  });

  let ltChipsHtml = '';
  if (ltModels.length) {
    ltChipsHtml = ltModels.map(mn =>
      `<span class="lt-chip" title="Used LAST (only after Primary models). Click ✕ to move to Primary Tier.">🔚 ${esc(mn)} <button data-m="${esc(mn)}" onclick="toggleSingleLastTier(this.dataset.m, false)" title="Move ${esc(mn)} to Primary Tier">✕</button></span>`
    ).join('');
  } else {
    ltChipsHtml = '<span style="color:#94a3b8;font-size:.76em;">None — all models are in Primary Tier</span>';
  }

  // Sort display: Primary models first, Last-Tier models at the bottom (matching router execution order!)
  const sortedModels = (data.models || []).slice().sort((a, b) => {
    const la = !!((cfgMap[a.name] || {}).last_tier);
    const lb = !!((cfgMap[b.name] || {}).last_tier);
    return (la === lb) ? 0 : (la ? 1 : -1);
  });

  let modelsHtml = '';
  sortedModels.forEach(model => {
    const mn = model.name;
    const info = mki[mn] || {available: '?', penalized_last5: [], blocked_left: 0};
    const total = data.active_keys || 0;
    const penCount = (info.penalized_last5 || []).length;
    const avail = info.available;
    const blockedLeft = info.blocked_left || 0;
    const countColor = blockedLeft > 0 ? '#f87171' : (penCount > 0 ? '#fbbf24' : '#4ade80');
    const penTip = penCount > 0 ? info.penalized_last5.map(k => '...' + k).join(', ') : 'none';
    const em = esc(mn);
    const cfgInfo = cfgMap[mn] || {saved: false, in_env: false, last_tier: false};
    const isLt = !!cfgInfo.last_tier;
    const todayCnt = (((data.usage || {}).models || {})[mn] || {}).today || 0;

    const tierBadge = isLt
      ? `<span class="tier-badge tier-last" title="Last-Tier: used only when all Primary models are unavailable">🔚 LAST</span>`
      : `<span class="tier-badge tier-1st" title="Primary Tier: used first">⚡ 1ST</span>`;

    const tierToggleBtn = isLt
      ? `<button class="btn-s" style="background:rgba(59,130,246,.18);border-color:#3b82f6;color:#93c5fd;" data-m="${em}" onclick="event.stopPropagation();toggleSingleLastTier(this.dataset.m,false)" title="Move ${em} to Primary Tier (use first)">⬆️ 1st</button>`
      : `<button class="btn-s" style="background:rgba(245,158,11,.18);border-color:#d97706;color:#fde68a;" data-m="${em}" onclick="event.stopPropagation();toggleSingleLastTier(this.dataset.m,true)" title="Put ${em} in Last-Tier list (use last, like lite)">🔚 Last</button>`;

    const editBtn = `<button class="btn-s" style="background:#1e3a5f;border-color:#3b82f6;" data-m="${em}" data-rpm="${model.rpm}" data-rpd="${model.rpd}" data-s="${cfgInfo.saved ? 1 : 0}" data-e="${cfgInfo.in_env ? 1 : 0}" data-lt="${isLt ? 1 : 0}" onclick="event.stopPropagation();openModelForm(this.dataset.m,this.dataset.rpm,this.dataset.rpd,this.dataset.s==='1',this.dataset.e==='1',this.dataset.lt==='1')" title="Edit RPM / RPD / Tier">✏️</button>`;
    const testBtn = `<button class="btn-s" style="background:#2d1b69;border-color:#4c1d95;" data-m="${em}" onclick="event.stopPropagation();testAllKeys('',this.dataset.m)" title="Test ${em} on all keys">🧪</button>`;
    const blockBtn = blockedLeft > 0
      ? `<button class="btn-s" style="background:#14532d;border-color:#4ade80;color:#dcfce7;" data-m="${em}" onclick="event.stopPropagation();unblockModel(this.dataset.m)">✅ Unblock</button>`
      : `<button class="btn-s" style="background:#7f1d1d;border-color:#f87171;color:#fee2e2;" data-m="${em}" onclick="event.stopPropagation();openBlock(this.dataset.m)" title="Block ${em}">⛔</button>`;
    const relBtn = penCount > 0
      ? `<button class="btn-s" style="background:#b91c1c;color:#fff;" data-m="${em}" onclick="event.stopPropagation();releaseDaily('',this.dataset.m)" title="Release ${penCount} locked key(s)">🔓${penCount}</button>`
      : '';

    modelsHtml += `<div class="m-row ${isLt ? 'is-lt' : ''} ${blockedLeft > 0 ? 'is-blk' : ''}">
      <div class="m-left">
        <input type="checkbox" class="mt-chk" data-m="${em}" ${mtSel[mn] ? 'checked' : ''} onclick="event.stopPropagation()" onchange="mtToggle(this.dataset.m,this.checked)">
        ${tierBadge}
        <span class="m-name" ${penCount > 0 ? `style="cursor:pointer" data-m="${em}" data-pen="${esc(penTip)}" onclick="alert('Penalized keys for '+this.dataset.m+': '+this.dataset.pen)"` : ''}>${em}</span>
        <span style="color:${countColor};font-weight:700;">${avail}/${total}</span>
        <span style="color:#94a3b8;font-size:.9em;">RPM ${model.rpm} · RPD ${model.rpd}</span>
        <span style="color:#60a5fa;font-size:.9em;">today ${todayCnt}</span>
        ${cfgInfo.saved ? '<span style="color:#a78bfa;font-size:.82em;" title="Saved in DB/file">💾</span>' : ''}
        ${blockedLeft > 0 ? `<span style="color:#f87171;font-weight:700;font-size:.85em;">⛔ ${fmtLeft(blockedLeft)}</span>` : ''}
      </div>
      <div class="m-actions">${tierToggleBtn}${editBtn}${testBtn}${blockBtn}${relBtn}</div>
    </div>`;
  });

  // Blocked Models
  let blkHtml = '';
  (data.model_blocks || []).forEach(b => {
    blkHtml += `<span class="tag" style="display:inline-flex;align-items:center;gap:5px;background:rgba(248,113,113,.15);color:#fca5a5;border-color:#f87171;">⛔ ${esc(b.model)} (${fmtLeft(b.seconds_left)}) <button class="btn-s" style="background:#14532d;color:#dcfce7;padding:0 5px;" data-m="${esc(b.model)}" onclick="unblockModel(this.dataset.m)">✅</button></span>`;
  });
  blkHtml = blkHtml ? (blkHtml + ` <button class="btn-s" onclick="unblockModel('*')">Unblock all</button>`) : '<span style="color:#4ade80;font-size:.8em;">None</span>';

  // Daily Usage per Key (Collapsible)
  let usageHtml = '';
  const um = (data.usage || {}).models || {};
  (data.models || []).forEach(model => {
    const u = um[model.name]; if (!u) return;
    const rpd = model.rpd || 1;
    const rowsH = u.rows.map(r => {
      const pct = Math.min(100, Math.round(r.today * 100 / rpd));
      const col = r.today >= rpd ? '#f87171' : (r.today >= rpd * 0.7 ? '#fbbf24' : '#4ade80');
      return `<tr><td style="padding:2px 6px;font-family:monospace;color:#93c5fd;">${esc(r.key)}</td>
        <td style="padding:2px 6px;min-width:140px;"><div style="display:flex;align-items:center;gap:6px;"><b style="color:${r.today ? col : '#6b7280'};min-width:26px;">${r.today}</b><div style="flex:1;height:5px;background:#27272a;border-radius:3px;"><div style="width:${pct}%;height:5px;background:${col};border-radius:3px;"></div></div><span style="color:#6b7280;font-size:.75em;">/${rpd}</span></div></td>
        <td style="padding:2px 6px;color:${r.yesterday ? '#e5e7eb' : '#6b7280'};">${r.yesterday}</td></tr>`;
    }).join('');
    usageHtml += `<details data-m="${esc(model.name)}" ${usageOpen[model.name] ? 'open' : ''} ontoggle="usageOpen[this.dataset.m]=this.open" style="background:#131620;border:1px solid #2d3348;border-radius:6px;padding:5px 8px;margin-bottom:4px;font-size:.8em;">
      <summary style="cursor:pointer;display:flex;gap:10px;flex-wrap:wrap;align-items:center;"><span style="font-family:monospace;color:#c4b5fd;">${esc(model.name)}</span>
        <span>today <b style="color:#60a5fa;">${u.today}</b></span><span style="color:#9ca3af;">yday ${u.yesterday}</span><span style="color:#6b7280;font-size:.85em;">(${rpd}/key)</span></summary>
      <div style="overflow-x:auto;margin-top:4px;"><table style="border-collapse:collapse;font-size:.9em;width:100%;"><thead><tr style="color:#9ca3af;text-align:left;"><th style="padding:2px 6px;">Key</th><th style="padding:2px 6px;">Today</th><th style="padding:2px 6px;">Yday</th></tr></thead><tbody>${rowsH}</tbody></table></div>
    </details>`;
  });

  const nSel = mtCount();
  document.getElementById('status-panel').innerHTML = `
    <div class="kpi-strip">
      <div class="kpi"><div class="kpi-lbl">Active Keys</div><div class="kpi-val" style="color:#60a5fa;">${data.active_keys || 0}</div><div class="kpi-sub">${(data.models || []).length} models (${ltModels.length} last-tier)</div></div>
      <div class="kpi"><div class="kpi-lbl">Total Traffic</div><div class="kpi-val">${m.total_incoming_requests || 0}</div><div class="kpi-sub">incoming requests</div></div>
      <div class="kpi"><div class="kpi-lbl">Google 200 OK</div><div class="kpi-val" style="color:#4ade80;">${m.successful_api_calls || 0}</div><div class="kpi-sub">direct key answers</div></div>
      <div class="kpi"><div class="kpi-lbl">RPM Cooldowns</div><div class="kpi-val" style="color:#fbbf24;">${m.rpm_cooldowns_applied || 0}</div><div class="kpi-sub">rate Hits: ${m.rate_limit_hits || 0}</div></div>
      <div class="kpi"><div class="kpi-lbl">Daily Hits</div><div class="kpi-val" style="color:#f87171;">${m.daily_limits_hit || 0}</div><div class="kpi-sub">penalized: ${penEntries.length}</div></div>
      <div class="kpi"><div class="kpi-lbl">Fallback / Fail</div><div class="kpi-val" style="color:#c084fc;">${m.webai_fallback_calls || 0} <span style="color:#64748b;font-size:.75em;">/</span> <span style="color:#f87171;">${m.failed_requests || 0}</span></div><div class="kpi-sub">web fallback / failed</div></div>
    </div>

    <div class="panel-row">
      <div class="card">
        <h3><span>🔑 Keys (${data.active_keys || 0}) & Locks</span></h3>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">${keysHtml || '<span class="sub">No keys</span>'}</div>
        <div class="sub" style="margin-bottom:6px;"><b style="color:#cbd5e1;">Daily Penalized:</b> <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;">${penHtml}</div></div>
        <div class="sub" style="margin-bottom:6px;"><b style="color:#cbd5e1;">RPM Cooldowns:</b> <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;">${cdHtml}</div></div>
        <div class="sub"><b style="color:#cbd5e1;">Blocked Models:</b> <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;">${blkHtml}</div></div>
      </div>

      <div class="card">
        <h3>
          <span>🤖 Models (${prModels.length} Primary · ${ltModels.length} Last-Tier)</span>
          <span style="display:inline-flex;gap:4px;flex-wrap:wrap;">
            <button class="btn-s" onclick="mtSelectAll(true)">☑ All</button>
            <button class="btn-s" onclick="mtSelectAll(false)">☐ None</button>
            <button class="btn-s" id="mt-lt-btn" style="background:rgba(245,158,11,.2);border-color:#d97706;color:#fde68a;opacity:${nSel ? 1 : .45};" ${nSel ? '' : 'disabled'} onclick="batchSelectedLastTier(true)" title="Put ticked models in Last-Tier list">🔚 → Last (${nSel})</button>
            <button class="btn-s" id="mt-pr-btn" style="background:rgba(59,130,246,.2);border-color:#3b82f6;color:#93c5fd;opacity:${nSel ? 1 : .45};" ${nSel ? '' : 'disabled'} onclick="batchSelectedLastTier(false)" title="Move ticked models to Primary Tier">⬆️ → 1st (${nSel})</button>
            <button class="btn-s" id="mt-sel-btn" style="background:#2d1b69;border-color:#4c1d95;opacity:${nSel ? 1 : .45};" ${nSel ? '' : 'disabled'} onclick="mtRun(mtChosen(),false)">🧪 Test (${nSel})</button>
            <button class="btn-s" style="background:#7c3aed;border-color:#a78bfa;color:#fff;" onclick="mtRun([],true)">🧪 All</button>
          </span>
        </h3>

        <!-- Persistent Last-Tier Models Banner -->
        <div class="lt-box">
          <div class="lt-head">
            <span class="lt-title">⚡/🔚 Model Priority: Last-Tier (Use Last) List — ${ltModels.length} model(s)</span>
            <button class="btn-s" style="background:#d97706;border-color:#fbbf24;color:#fff;padding:4px 10px;font-size:.8em;" onclick="openLastTierModal()">⚙️ Set Priority / Add Last-Tier Models</button>
          </div>
          <div class="lt-chips">${ltChipsHtml}</div>
        </div>

        <div class="models-list">${modelsHtml}</div>
      </div>
    </div>

    <details ${panelsOpen.usage ? 'open' : ''} ontoggle="panelsOpen.usage=this.open" class="card" style="padding:8px 12px;">
      <summary style="cursor:pointer;font-weight:700;font-size:.82em;color:#cbd5e1;text-transform:uppercase;letter-spacing:.4px;">
        📊 Requests Per Day Per Key — Today (${esc((data.usage || {}).today || '')}) & Yesterday (${esc((data.usage || {}).yesterday || '')})
      </summary>
      <div style="margin-top:8px;">${usageHtml || '<span class="sub">No usage data</span>'}</div>
    </details>
  `;

  renderLogs(data, force);
}

function esc(s) {
  return (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

fetchData(true).then(schedule);
</script>
</body>
</html>"""
    return Response(deploy_badge.inject(html), mimetype="text/html; charset=utf-8")

# ─── Request snapshot + readable error reasons (shown on the dashboard) ──────
def _msg_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for p in content:
            if not isinstance(p, dict):
                continue
            t = p.get("type")
            if t in ("text", "input_text", "output_text"):
                out.append(str(p.get("text", "")))
            elif t in ("image_url", "input_image", "file"):
                out.append("[image/file omitted]")
        return " ".join(out)
    return "" if content is None else str(content)

def _req_snapshot(raw: dict, path: str) -> str:
    """Human-readable summary of an incoming request for the dashboard log.
    Image/file data is never stored (only counted). API keys are never in the body."""
    try:
        msgs = raw.get("messages")
        if msgs is None and "input" in raw:
            inp = raw.get("input")
            msgs = [{"role": "user", "content": inp}] if isinstance(inp, str) else [m for m in (inp or []) if isinstance(m, dict)]
        msgs = [m for m in (msgs or []) if isinstance(m, dict)]
        tools = raw.get("tools") if isinstance(raw.get("tools"), list) else []
        names = []
        for t in tools[:8]:
            if isinstance(t, dict):
                names.append(str((t.get("function") or {}).get("name") or t.get("name") or t.get("type") or "?"))
        n_files = 0
        for m in msgs:
            c = m.get("content")
            if isinstance(c, list):
                n_files += sum(1 for x in c if isinstance(x, dict) and x.get("type") in ("image_url", "input_image", "file"))
        last_user = next((m for m in reversed(msgs) if m.get("role") == "user"), None)
        last_txt = _msg_text(last_user.get("content")) if last_user else ""
        roles = ",".join(str(m.get("role")) for m in msgs[-6:])
        head = (f"{path} | model={raw.get('model') or '-'} | stream={bool(raw.get('stream'))} | msgs={len(msgs)} "
                f"(last roles: {roles or '-'}) | tools={len(tools)}{(' [' + ', '.join(names) + ']') if names else ''} | images/files={n_files}")
        return head + "\nlast user message:\n" + last_txt[:1500] + ("…" if len(last_txt) > 1500 else "")
    except Exception as e:
        return f"(could not summarize request: {e})"

_SECRET_HDR = re.compile(r"authorization|cookie|token|secret|api[-_]?key|password", re.I)

def _safe_headers(h) -> str:
    """Request headers for the dashboard; secrets (Authorization, Cookie, keys…) are masked."""
    out = []
    for k, v in h.items():
        if _SECRET_HDR.search(k):
            scheme = v.split(" ", 1)[0] + " " if k.lower() == "authorization" and " " in v else ""
            out.append(f"{k}: {scheme}***")
        else:
            out.append(f"{k}: {str(v)[:150]}")
    return "\n".join(out)

def _short_err(text: str, limit: int = 300) -> str:
    """Pull the human message out of a Google / OpenAI style JSON error body."""
    t = (text or "").strip()
    try:
        j = json.loads(t)
        if isinstance(j, list) and j:
            j = j[0]
        e = j.get("error", j) if isinstance(j, dict) else {}
        if isinstance(e, dict) and e.get("message"):
            t = f"{e.get('status') or e.get('code') or ''} {e['message']}".strip()
        elif isinstance(j, dict) and j.get("detail"):
            t = str(j["detail"])
    except Exception:
        pass
    return re.sub(r"\s+", " ", t)[:limit]

def _why(status: int, err_text: str, model: str = "") -> str:
    """Plain-language reason for an upstream HTTP status."""
    e = (err_text or "").lower()
    if status == 404:
        if "no longer available" in e or "not found" in e:
            return f"404: model '{model}' does not exist / was retired / wrong model name (or not available to this key)"
        return "404: endpoint or model not found"
    if status == 429:
        return "429: quota / rate limit (per-minute RPM or per-day RPD)"
    if status == 400:
        return "400: Google rejected the request body (bad/unsupported field, bad message shape, or content blocked)"
    if status == 401:
        return "401: API key invalid or missing"
    if status == 403:
        return "403: key has no permission for this model, is revoked, or is quota-blocked"
    if status == 413:
        return "413: request too large"
    if status in (500, 503):
        return f"{status}: Google server overloaded / temporary error"
    return f"{status}: unexpected upstream status"

# ─── WebAI fallback (cookie based /api/web/v1) — LAST RESORT only ────────────
# Every request always tries the Gemini key pool FIRST. Only when the pool
# cannot serve it (all keys cooling down for longer than FALLBACK_MAX_WAIT,
# daily-exhausted, or every attempt failed) is the request answered by
# WebAI-to-API. No state is kept: the very next request starts with the keys
# again, so as soon as a key wakes up it is used first.
# Model: always a "lite" model when WebAI offers one (auto-detected from
# WebAI's /v1/models), otherwise WEBAI_FALLBACK_MODEL, otherwise WebAI's first.
# WEBAI_ENABLED=0 (or false / no / off) -> WebAI is OFF completely: start.sh starts no WebAI process, the
# /api/web/v1 URLs do not exist (plain 404), the cookie page is not registered and there is no WebAI fallback.
# Default (not set) = enabled.
WEBAI_ENABLED = os.environ.get("WEBAI_ENABLED", "1").strip().lower() not in ("0", "false", "no", "off")
WEBAI_FALLBACK = WEBAI_ENABLED and os.environ.get("WEBAI_FALLBACK", "1") != "0"

def _webai_route(*args, **kwargs):
    """Same as @app.route, but registers NOTHING when WebAI is disabled (the URL then simply does not exist)."""
    if WEBAI_ENABLED:
        return app.route(*args, **kwargs)
    return lambda f: f
WEBAI_FALLBACK_MODEL = os.environ.get("WEBAI_FALLBACK_MODEL", "").strip()
FALLBACK_MAX_WAIT = float(os.environ.get("FALLBACK_MAX_WAIT", "3"))
# Without the WebAI fallback (tool calls / continuations) wait at most this long for a free (key, model) slot.
POOL_MAX_WAIT = float(os.environ.get("POOL_MAX_WAIT", "5"))   # (no longer used: requests now wait until every key is daily-dead)
# A request keeps retrying (waiting out RPM cooldowns, switching key/model) until EVERY key x model is daily-locked.
# Safety net so a client that already hung up does not hold a worker thread forever: give up after this many seconds
# (0 = never give up, only stop when all keys are daily-penalized).
REQUEST_MAX_SECS = float(os.environ.get("REQUEST_MAX_SECS", "900"))
# A request for ONE specific model (not auto) tries every key at most ONCE (hammering a model that fails on all keys
# could get the keys banned by Google). It only waits up to this many seconds for a key that is cooling down; after that,
# or when every key has been tried, the last Google error is returned to the client as it is.
SPECIFIC_MAX_WAIT = float(os.environ.get("SPECIFIC_MAX_WAIT", "20"))
# One WebAI process per Gemini account (wapi/webai_supervisor.py); webai_pool spreads the load over them.
import webai_pool
import webapi_model_fix
_webai_model_cache = {"model": None, "ts": 0.0, "file_model": None, "file_ts": 0.0}

def _has_file_parts(data: dict) -> bool:
    """True when any message carries image / file / audio parts (not plain text)."""
    for m in (data.get("messages") or []):
        c = m.get("content") if isinstance(m, dict) else None
        if isinstance(c, list):
            for part in c:
                if isinstance(part, dict) and part.get("type") not in (None, "text"):
                    return True
    return False

def _webai_list_models():
    try:
        r = requests.get(webai_pool.get_pool().any_url() + "/v1/models", timeout=8)
        if r.status_code == 200:
            return [m.get("id") for m in (r.json().get("data") or []) if isinstance(m, dict) and m.get("id")]
    except Exception as e:
        print(f"[WEBAI FALLBACK] model list failed: {e}")
    return []

def _webai_pick_model(need_files: bool = False):
    """need_files=True -> never a `playwright/*` model: that backend rejects image/file parts with
    HTTP 400 'File content parts are only supported on the Gemini WebAPI backend'. Returns None if no
    WebAPI-backend model exists (caller then skips the fallback instead of sending a doomed request)."""
    now = time.time()
    mk, tk = ("file_model", "file_ts") if need_files else ("model", "ts")
    if _webai_model_cache[mk] and now - _webai_model_cache[tk] < 600:
        return _webai_model_cache[mk]
    ids = _webai_list_models()
    if need_files:
        ids = [i for i in ids if "playwright" not in i.lower()]
    model = None
    lite = [i for i in ids if "lite" in i.lower()]
    if lite:
        model = next((i for i in lite if "flash" in i.lower()), lite[0])
    elif ids:
        model = WEBAI_FALLBACK_MODEL if WEBAI_FALLBACK_MODEL in ids else ids[0]
    if not model and not need_files:
        model = WEBAI_FALLBACK_MODEL or None
    if model:
        _webai_model_cache.update({mk: model, tk: now})
    return model

def _webai_fix_links(raw: bytes, acc_id: str = "") -> bytes:
    proto = request.headers.get("X-Forwarded-Proto", "https").split(",")[0].strip() or "https"
    base = f"{proto}://{request.host}{WEBAPI_PREFIX}"
    acc = ("a=" + quote(acc_id, safe="") + "&") if acc_id else ""     # artifact must be fetched by the account that made it
    return (raw.replace(b'"/v1/artifacts/fetch?', ('"' + base + '/artifacts/fetch?' + acc).encode())
               .replace(b'](/v1/artifacts/fetch?', ('](' + base + '/artifacts/fetch?' + acc).encode()))

def chat_completion_sse(cj: dict):
    ch = (cj.get("choices") or [{}])[0]
    msg = ch.get("message") or {}
    base = {"id": cj.get("id"), "object": "chat.completion.chunk", "created": cj.get("created"), "model": cj.get("model")}
    yield "data: " + json.dumps({**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": msg.get("content") or ""}, "finish_reason": None}]}) + "\n\n"
    yield "data: " + json.dumps({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": ch.get("finish_reason") or "stop"}]}) + "\n\n"
    yield "data: [DONE]\n\n"

def webai_fallback(data: dict, is_responses_api: bool, client_stream_requested: bool):
    """Returns (flask_response_or_None, info). info = model name on success, else the reason it was not used.
    The request goes to the least-busy logged-in WebAI account; if that account fails it is retried on the next one."""
    if not WEBAI_FALLBACK:
        return None, "web fallback is OFF (" + ("WEBAI_ENABLED=0" if not WEBAI_ENABLED else "WEBAI_FALLBACK=0") + ")"
    if data.get("tools") or _is_tool_continuation(data.get("messages") or []):
        return None, "web fallback skipped: tool-calling request (WebAI has no tool support)"
    need_files = _has_file_parts(data)
    model = _webai_pick_model(need_files)
    if need_files and not model:
        return None, "web fallback skipped: request has image/file but WebAI has no WebAPI-backend model (only playwright/*)"
    msgs = []
    for m in data.get("messages") or []:
        if not isinstance(m, dict):
            continue
        role = "system" if m.get("role") == "developer" else m.get("role")
        c = m.get("content")
        msgs.append({"role": role, "content": "" if c is None else c})
    body = {"messages": msgs, "stream": False}
    if isinstance(data.get("response_format"), dict):
        body["response_format"] = data["response_format"]      # dropped by _webapi_request, replaced by a prompt instruction + reply cleaning
    if model:
        body["model"] = model
    raw = _webapi_fix_body(json.dumps(body, ensure_ascii=False).encode("utf-8"))
    pool = webai_pool.get_pool()
    tried = set()
    reason = "no WebAI account is running (add cookies at /api/web/v1/ui/auth)"
    for _ in range(pool.count()):
        slot = pool.acquire(exclude=tried, wait=30)
        if slot is None:
            break
        tried.add(slot.id)
        try:
            up = _webapi_request("POST", slot.url + "/v1/chat/completions", None, raw,
                                 {"Content-Type": "application/json"}, slot, True, stream=False)
        except Exception as e:
            pool.release(slot, error=True)
            reason = f"web fallback failed: WebAI '{slot.label}' unreachable at {slot.url} ({str(e)[:150]}) - not running or cookies missing?"
            continue
        pool.release(slot, status=up.status_code)
        if up.status_code != 200:
            reason = f"web fallback failed: WebAI '{slot.label}' HTTP {up.status_code} (model={model}): {_short_err(up.text, 250)}"
            if up.status_code in webai_pool.RETRY_STATUS:
                continue            # this account has a problem -> next account
            break                   # request itself was rejected (400/422...) -> another account would say the same
        try:
            cj = json.loads(_webai_fix_links(up.content, slot.id).decode("utf-8", "replace"))
        except Exception:
            reason = f"web fallback failed: WebAI '{slot.label}' returned a non-JSON answer"
            continue
        if getattr(up, "want_json", False):
            webapi_param_fix.clean_json_reply(cj)
        msg = ((cj.get("choices") or [{}])[0].get("message")) or {}
        if not (msg.get("content") or msg.get("tool_calls")):
            reason = f"web fallback failed: WebAI '{slot.label}' returned an empty answer (model={model})"
            continue
        actual = cj.get("model") or model or "webai"
        g.webai_account = slot.label + (" [NOT LOGGED IN - anonymous]" if slot.auth is False else "")
        if is_responses_api:
            rj = chat_completion_to_responses_json(cj, actual)
            resp = Response(responses_sse_stream(rj), mimetype="text/event-stream") if client_stream_requested else jsonify(rj)
        elif client_stream_requested:
            resp = Response(chat_completion_sse(cj), mimetype="text/event-stream")
        else:
            resp = jsonify(cj)
        return resp, actual
    return None, reason

# ─── Main Proxy ───────────────────────────────────────────────────────────────
@app.route('/v1/chat/completions', methods=['POST', 'OPTIONS'])
@app.route('/v1/chat/completions/', methods=['POST', 'OPTIONS'])
@app.route('/v1/responses', methods=['POST', 'OPTIONS'])
def proxy_chat():
    if request.method == 'OPTIONS':
        return Response(status=200)

    with state_lock:
        metrics["total_incoming_requests"] += 1

    data = request.json or {}
    if hasattr(g, "log_entry"):
        _live_begin(g.log_entry, data, request.path)
        g.log_entry["request"] = _req_snapshot(data, request.path) + "\nheaders:\n" + _safe_headers(request.headers)
        g.log_entry["route"] = f"Gemini key pool ({request.path})"
    # Capture a conversation id BEFORE popping these -- session_id/user are
    # the clearest hints a client can give us; we fall back to the caller's
    # IP otherwise (see _client_id_from_request).
    conv_hint = data.get('session_id') or data.get('user')
    if conv_hint:
        data['_conv_hint'] = conv_hint
    data.pop('session_id', None)
    data.pop('user', None)
    data = normalize_to_chat_completions(data)  # <-- strips Responses-API/unknown fields that caused the 400s
    wants_search = bool(data.pop('_wants_search', False)) and ROUTER_WEB_SEARCH
    is_responses_api = request.path.startswith('/v1/responses')
    client_stream_requested = bool(data.get("stream"))
    if is_responses_api:
        data["stream"] = False  # always get one complete JSON back from Gemini; we rebuild the Responses stream ourselves
    requested_model = data.get("model", "")
    if "/" in requested_model:
        requested_model = requested_model.split("/")[-1]
    _blk_left = _model_block_left(requested_model) if requested_model else 0
    if _blk_left > 0:
        # the client asked for a model that is blocked on the dashboard
        if BLOCKED_MODEL_FALLBACK_AUTO:
            _trail(f"model '{requested_model}' is blocked ({int(_blk_left)}s left) -> served by the other models (auto)")
            if hasattr(g, "log_entry"):
                g.log_entry["error_detail"] = f"requested model '{requested_model}' is blocked for {int(_blk_left)}s more -> answered by the other models"
            requested_model = "auto"
        else:
            if hasattr(g, "log_entry"):
                g.log_entry["error_detail"] = f"model '{requested_model}' is blocked for {int(_blk_left)}s more (BLOCKED_MODEL_FALLBACK_AUTO=0)"
                g.log_entry["route"] = "Blocked model (not forwarded anywhere)"
            return Response(json.dumps({"error": {"message": f"Model '{requested_model}' is temporarily blocked by the admin ({int(_blk_left)}s left).",
                                                   "type": "model_blocked", "code": "model_blocked"}}),
                            429, {"Content-Type": "application/json", "Retry-After": str(int(_blk_left) + 1)})
    messages = data.get("messages", []) or []
    remote_addr = request.headers.get("X-Real-IP") or \
                  (request.headers.get("X-Forwarded-For", "").split(",")[0].strip()) or \
                  request.remote_addr
    client_id = _client_id_from_request(data, remote_addr)
    data.pop('_conv_hint', None)
    is_continuation = _is_tool_continuation(messages)

    # The client asked for web search: answer through Gemini's native Google Search tool (see search_via_native).
    # Returns None when that is not possible -> the normal path below answers without search.
    if wants_search and not is_continuation and not data.get("tools") and (is_responses_api or not client_stream_requested):
        try:
            _search_out = search_via_native(data, requested_model, is_responses_api, client_stream_requested)
        except Exception as _e:
            print(f"[SEARCH FAILED] {_e} -> answering without search")
            _search_out = None
        if _search_out is not None:
            return _search_out

    last_resp = None
    attempt_errors = []      # short "{status} {model} (…key): reason" strings for
                              # every failed attempt this request made, so that if
                              # the request ultimately fails, the dashboard log can
                              # show WHY (not just a bare status code) -- see
                              # g.log_entry["error_detail"] set right before we
                              # return to the client below.
    _live_attach(attempt_errors)
    tried = set()            # (key, model_name) permanently excluded this request
                              # (daily-penalized, permanently broken, or attempt-cap reached)
    attempt_counts = {}      # (key, model_name) -> attempts made this request, for
                              # transient failures (503/500/timeout) only. A combo
                              # that fails this way isn't given up on after just one
                              # try -- Google's "high demand" 503s are usually brief,
                              # so each combo gets up to MAX_ATTEMPTS_PER_COMBO tries,
                              # cycling through every other key/model in between
                              # (never hammered 3x back-to-back), before it's finally
                              # excluded for the rest of this request.
    MAX_ATTEMPTS_PER_COMBO = 3
    bad_400 = {}             # error text -> how often Google answered exactly that 400 (a bad REQUEST is not a bad key)

    if is_continuation:
        # PREFER the (key, model) that produced the tool call (its signature
        # is guaranteed valid), but never fail because of it: if it is
        # rate-limited / exhausted / erroring we fall through to normal
        # routing, and prepare_payload() re-injects the cached signature.
        outcome, key, model = acquire_sticky_slot_wait(client_id)
        if outcome == "ok":
            actual_model = model["name"]
            print(f"[STICKY] {client_id} → preferring key=…{key[-6:]} model={actual_model}")
            _trail(f"sticky slot {actual_model} (key …{key[-4:]}) is free")
            tried.add((key, actual_model))
            data["model"] = actual_model
            headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
            url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
            try:
                resp = requests.post(url, json=prepare_payload(data, actual_model), headers=headers, stream=True, timeout=(GEMINI_CONNECT_TIMEOUT, GEMINI_READ_TIMEOUT))
                resp = _heal_signature(resp, url, headers, data, actual_model)
                if resp.status_code != 200:
                    _drain_close(resp)
                if resp.status_code == 200:
                    remember_sticky_slot(client_id, key, actual_model)
                    if hasattr(g, "log_entry"):
                        g.log_entry["status"] = f"200 Success ({actual_model})"
                        g.log_entry["model"] = actual_model
                        g.log_entry["route"] = "Gemini key …" + key[-4:] + " (sticky tool-continuation)" + " → " + actual_model
                    with state_lock:
                        metrics["successful_api_calls"] += 1
                        _record_rpd_success(key, actual_model)
                    return _finalize_success_response(resp, is_responses_api, actual_model, client_stream_requested)
                if resp.status_code in (429, 403):
                    err = resp.text.lower()
                    with state_lock:
                        _handle_429(key, actual_model, err)
                print(f"[STICKY] pinned slot returned {resp.status_code} → switching slot")
                last_resp = resp
            except Exception as e:
                print(f"[STICKY ERROR] {e} → switching slot")
        # exhausted / busy / no pin / pinned failed -> normal routing below

    # ── Keep trying until EVERY (key, model) is dead for today ────────────────────────────────────────
    # A request now only ends when
    #   (a) one slot answers 200, or
    #   (b) every key x model is daily-penalized / RPD-exhausted / permanently broken / manually blocked, or
    #   (c) REQUEST_MAX_SECS passed (safety net, default 15 min).
    # RPM 429s are NOT failures: that (key, model) gets a cooldown until its RPM window is over, nothing else is sent
    # to it meanwhile, and the request just goes on with the other slots (or sleeps until the soonest one frees up).
    deadline = (time.monotonic() + REQUEST_MAX_SECS) if REQUEST_MAX_SECS > 0 else None
    exit_reason = "all_daily"
    _wait_note_ts = 0.0
    _is_pool_req = (requested_model or "").lower() in _GENERIC_MODEL_ALIASES

    while True:
        if deadline is not None and time.monotonic() >= deadline:
            exit_reason = "deadline"
            attempt_errors.append(f"gave up after {int(REQUEST_MAX_SECS)}s of waiting for a free key")
            break

        # Atomic: pick a viable (key, model) AND reserve its RPM slot in one lock hold.
        slot = acquire_next_slot(requested_model, exclude=tried)

        if slot is None:
            # Nothing usable right now. Is anything merely waiting (RPM window / cooldown) or is all of it dead for today?
            with state_lock:
                now_mono = time.monotonic()
                waits = []
                any_waitable = False
                cand_models = get_active_models()
                if not _is_pool_req:      # a specific model was requested: only that one is ever picked
                    cand_models = [m for m in cand_models if m["name"] == requested_model] or \
                                  [{"name": requested_model, "rpm": 15 if "flash" in requested_model.lower() else 2,
                                    "rpd": 1500 if "flash" in requested_model.lower() else 50}]
                for m_dict in cand_models:
                    m_name = m_dict["name"]
                    if _is_model_blocked(m_name):
                        continue                      # manually blocked: never wait for it
                    eff = _effective_rpm(m_dict["rpm"])
                    for k in API_KEYS:
                        if (k, m_name) in tried:
                            continue
                        if (k, m_name) in PERMANENTLY_BROKEN_MODELS:
                            continue
                        if _is_daily_penalized(k, m_name):
                            continue
                        if not _rpd_available(k, m_name, m_dict["rpd"]):
                            continue
                        any_waitable = True
                        # free only when BOTH the 429 cooldown and the RPM window allow it -> take the later one.
                        free_in = 0.0
                        cd = rpm_cooldown.get((k, m_name), 0)
                        if cd > now_mono:
                            free_in = cd - now_mono
                        window = _prune_rpm(k, m_name)          # prune FIRST (a stale window made this loop spin every 0.2 s)
                        if len(window) >= eff:
                            free_in = max(free_in, window[len(window) - eff] + RPM_WINDOW_SECS - now_mono)
                        waits.append(max(0.0, free_in))

            if not any_waitable:
                print("[EXHAUSTED] All key×model combos are daily-exhausted, blocked or broken.")
                attempt_errors.append("pool: every key×model is daily-exhausted / broken for today (resets midnight IST)")
                exit_reason = "all_daily"
                break

            soonest = min(waits) if waits else 2.0
            if not _is_pool_req and soonest > SPECIFIC_MAX_WAIT:
                exit_reason = "specific"
                attempt_errors.append(f"specific model: remaining keys cooling down for {soonest:.0f}s -> not waiting")
                break
            wait_secs = min(soonest + 0.2, 5.0)          # re-check at least every 5 s (a lock may have been released)
            if deadline is not None:
                wait_secs = max(0.05, min(wait_secs, deadline - time.monotonic()))
            _now_ts = time.monotonic()
            if _now_ts - _wait_note_ts >= 10.0:          # one trail line per ~10 s, not hundreds
                _trail(f"all slots busy (RPM cooldown) -> waiting, soonest free in ~{soonest:.0f}s")
                _wait_note_ts = _now_ts
            time.sleep(wait_secs)
            continue

        k_idx, m_idx, key, model = slot
        actual_model = model["name"]
        if not _is_pool_req:
            tried.add((key, actual_model))      # specific model: one attempt per key, never a second one
        data["model"] = actual_model
        _trail(f"sent to {actual_model} (key …{key[-4:]})")

        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json"
        }
        url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"

        try:
            resp = requests.post(url, json=prepare_payload(data, actual_model), headers=headers, stream=True, timeout=(GEMINI_CONNECT_TIMEOUT, GEMINI_READ_TIMEOUT))
            resp = _heal_signature(resp, url, headers, data, actual_model)
            if resp.status_code != 200:
                _drain_close(resp)        # error answers are small: read + close now (stream=True otherwise keeps the socket open)
            last_resp = resp

            if resp.status_code == 200:

                # Pin this conversation to this exact (key, model) so that
                # if the assistant's reply contains a tool call, the NEXT
                # request (the tool result) lands back on the same slot and
                # its thought_signature still validates.
                remember_sticky_slot(client_id, key, actual_model)
                if hasattr(g, "log_entry"):
                    g.log_entry["status"] = f"200 Success ({actual_model})"
                    g.log_entry["model"] = actual_model
                    g.log_entry["route"] = "Gemini key …" + key[-4:] + " (round-robin pool)" + " → " + actual_model
                with state_lock:
                    metrics["successful_api_calls"] += 1
                    _record_rpd_success(key, actual_model)
                    safe_key = key[:5] + "..." + key[-5:]
                    metrics["usage_by_key"].setdefault(safe_key, {})
                    metrics["usage_by_key"][safe_key][actual_model] = \
                        metrics["usage_by_key"][safe_key].get(actual_model, 0) + 1

                return _finalize_success_response(resp, is_responses_api, actual_model, client_stream_requested)

            elif resp.status_code in [429, 403]:
                err_text = ""
                try: err_text = resp.text.lower()
                except: pass

                with state_lock:
                    metrics["rate_limit_hits"] += 1
                    kind = _handle_429(key, actual_model, err_text)
                    if kind == "daily":
                        metrics["daily_limits_hit"] = metrics.get("daily_limits_hit", 0) + 1
                        # A confirmed daily/quota block is the ONLY reason a
                        # combo is permanently excluded for this request --
                        # every other failure kind below gets more chances.
                        tried.add((key, actual_model))
                    else:
                        metrics["rpm_cooldowns_applied"] = metrics.get("rpm_cooldowns_applied", 0) + 1
                        # RPM-style cooldown only: NOT excluded. Its own
                        # cooldown timer keeps acquire_next_slot from
                        # re-picking it until the cooldown actually clears,
                        # after which it's fair game again on a later pass.

                if resp.status_code == 403 and kind != "daily" and not any(w in err_text for w in ("quota", "exhaust", "rate", "limit")):
                    # a real 403 (invalid / leaked / not allowed key) is not a rate limit: do not retry this combo in this request
                    tried.add((key, actual_model))
                print(f"[429] key=…{key[-6:]} model={actual_model} → instantly switching to next key/model")
                _trail(f"429 {actual_model} (key …{key[-4:]}) {kind}-limit -> next slot")
                attempt_errors.append(f"429 {actual_model} (…{key[-4:]}): {kind}-limit | {_short_err(err_text, 220)}")
                continue  # instantly retry with the next best slot

            elif resp.status_code in [500, 503]:
                # Google's own transient overload ("model currently
                # experiencing high demand") -- NOT a quota problem, so this
                # must never trigger a daily block. Give this exact combo a
                # short breather (so it isn't hammered again on the very
                # next iteration) and let round-robin move on to other
                # combos; it becomes eligible again once the breather ends,
                # up to MAX_ATTEMPTS_PER_COMBO total tries for this request.
                with state_lock:
                    n = attempt_counts.get((key, actual_model), 0) + 1
                    attempt_counts[(key, actual_model)] = n
                    _apply_rpm_cooldown(key, actual_model, seconds=min(20 * n, 120))
                    print(f"[{resp.status_code}] model={actual_model} key=…{key[-6:]} "
                          f"server error #{n} -> cooldown {min(20 * n, 120)}s, trying other combos first")
                attempt_errors.append(f"{resp.status_code} {actual_model} (…{key[-4:]}): server overloaded/unavailable")
                continue

            elif resp.status_code in [400, 404]:
                err_text = ""
                try: err_text = resp.text.lower()
                except: pass

                # Two different kinds of 400 need different handling:
                #
                # 1. Payload/compatibility errors ("Interactions API" only,
                #    missing thought_signature, etc.) mean THIS MODEL cannot
                #    be used through this chat/completions-style proxy at
                #    all -- retrying it will just fail again, forever, and
                #    without this fix it silently got re-picked every time
                #    because the old code only ever removed models from the
                #    unused DYNAMIC_MODELS list, never from MODELS (the env
                #    pool that auto mode actually uses).
                #
                # 2. Genuine bad-request errors caused by the request body
                #    itself (bad JSON, unsupported field, etc.) would repeat
                #    on every model/key too, but are not model-specific --
                #    those should not silently disable a model, so we only
                #    hard-disable the model on the known compatibility
                #    signatures below and otherwise just move on and let the
                #    request fail after trying a couple of other slots.
                if resp.status_code == 404 and ("no longer available" in err_text
                                                or "is not found" in err_text
                                                or "not found for api version" in err_text):
                    with state_lock:
                        for _k in API_KEYS:
                            PERMANENTLY_BROKEN_MODELS.add((_k, actual_model))
                    print(f"[404 RETIRED] {actual_model} no longer exists -> removed from pool for all keys "
                          f"(remove it from GEMINI_MODELS env)")
                    attempt_errors.append(f"404 {actual_model} (…{key[-4:]}): model no longer exists on Google's side "
                                           f"-> permanently removed from the pool")
                    continue

                model_is_incompatible = any(sig in err_text for sig in [
                    "interactions api",   # genuinely model-level. NOT thought_signature /
                                          # unsupported: those are per-request problems and
                                          # used to permanently ban healthy models.
                ])

                if model_is_incompatible:
                    with state_lock:
                        # Disable this model for THIS key permanently for the
                        # rest of the process lifetime (until restart/redeploy)
                        # -- it will never succeed on this key, so don't waste
                        # future requests retrying it. midnight-IST-style
                        # cooldown doesn't apply here since the problem isn't
                        # rate limiting, it's a hard incompatibility.
                        PERMANENTLY_BROKEN_MODELS.add((key, actual_model))
                        metrics["failed_requests"] += 1
                    print(f"[400 INCOMPATIBLE] key=…{key[-6:]} model={actual_model} "
                          f"does not work via this proxy shape → disabled for this key, switching instantly")
                    attempt_errors.append(f"400 {actual_model} (…{key[-4:]}): incompatible with this proxy shape "
                                           f"-> permanently disabled for this key")
                else:
                    tried.add((key, actual_model))
                    print(f"[{resp.status_code}] model={actual_model} bad request, trying next combo...")
                    attempt_errors.append(f"{resp.status_code} {actual_model} (…{key[-4:]}): {_why(resp.status_code, err_text, actual_model)} | {_short_err(err_text, 220)}")
                    # The same 400 on two different slots means the REQUEST itself is wrong, not the key/model:
                    # return it to the client now instead of trying every key x model x 3 passes (that used to be ~60 calls).
                    if resp.status_code == 400:
                        sig = re.sub(r"\d+", "#", err_text)[:160]
                        bad_400[sig] = bad_400.get(sig, 0) + 1
                        if bad_400[sig] >= 2:
                            if hasattr(g, "log_entry"):
                                g.log_entry["error_detail"] = f"bad request (same 400 on {bad_400[sig]} slots, stopped early): {' || '.join(attempt_errors[-2:])}"
                            excluded = ['content-encoding','content-length','transfer-encoding','connection']
                            out_headers = [(n, v) for n, v in resp.raw.headers.items() if n.lower() not in excluded]
                            return Response(resp.content, 400, out_headers)
                continue  # instantly try the next key/model regardless

            else:
                with state_lock:
                    metrics["failed_requests"] += 1
                err_text = ""
                try: err_text = resp.text[:200]
                except: pass
                if hasattr(g, "log_entry"):
                    g.log_entry["error_detail"] = (
                        f"{resp.status_code} {actual_model} (…{key[-4:]}): {_why(resp.status_code, err_text, actual_model)} | {_short_err(err_text, 300)}"
                        + (f" | earlier attempts: {' || '.join(attempt_errors[-4:])}" if attempt_errors else "")
                    )
                excluded = ['content-encoding','content-length','transfer-encoding','connection']
                out_headers = [(n, v) for n, v in resp.raw.headers.items() if n.lower() not in excluded]
                return Response(resp.content, resp.status_code, out_headers)

        except Exception as e:
            print(f"[ERROR] key=…{key[-6:]} model={actual_model}: {e}")
            # Network-level failure (e.g. read timeout) -- same treatment as
            # a 503: transient, not quota-related, never a daily block.
            attempt_errors.append(f"EXC {actual_model} (…{key[-4:]}): {str(e)[:150]}")
            with state_lock:
                n = attempt_counts.get((key, actual_model), 0) + 1
                attempt_counts[(key, actual_model)] = n
                _apply_rpm_cooldown(key, actual_model, seconds=min(20 * n, 120))
            continue

    # Every key×model combo was tried (or the pool is genuinely exhausted / cooling down).
    # LAST RESORT: answer through WebAI (cookies). Keys were tried first, always.
    keys_report = " || ".join(attempt_errors[-6:]) if attempt_errors else "no key/model combo was usable (pool empty?)"
    _trail("Gemini keys could not serve this -> trying WebAI fallback")
    fb_resp, fb_info = webai_fallback(data, is_responses_api, client_stream_requested)
    if fb_resp is not None:
        with state_lock:
            metrics["webai_fallback_calls"] = metrics.get("webai_fallback_calls", 0) + 1
        if hasattr(g, "log_entry"):
            g.log_entry["status"] = f"200 Success (web fallback: {fb_info})"
            g.log_entry["model"] = f"web:{fb_info}"
            g.log_entry["route"] = f"Gemini keys FAILED → WebAI fallback (account '{getattr(g, 'webai_account', '?')}', model {fb_info})"
            g.log_entry["error_detail"] = f"Gemini keys could not serve this -> answered by WebAI ({fb_info}). Why keys failed: {keys_report}"
            g.log_entry["attempts"] = attempt_errors[-20:]
        print(f"[WEBAI FALLBACK] served by {fb_info}")
        return fb_resp

    with state_lock:
        metrics["failed_requests"] += 1

    error_summary = keys_report
    if hasattr(g, "log_entry"):
        g.log_entry["error_detail"] = f"exhausted after {len(attempt_errors)} attempt(s): {error_summary} || {fb_info}"
        g.log_entry["attempts"] = attempt_errors[-20:] + [fb_info]
        g.log_entry["route"] = "Gemini key pool → all failed; WebAI fallback NOT used"

    if not _is_pool_req and last_resp is not None:
        # specific model, every key tried once: hand the client the real (last) Google error
        excluded = ['content-encoding', 'content-length', 'transfer-encoding', 'connection']
        out_headers = [(n, v) for n, v in last_resp.raw.headers.items() if n.lower() not in excluded]
        return Response(last_resp.content, last_resp.status_code, out_headers)

    if exit_reason == "deadline":
        msg = (f"No key answered within {int(REQUEST_MAX_SECS)}s (all keys were RPM-busy / cooling down). "
               "Please retry in a minute.")
        code, retry_after = "keys_busy_timeout", 30
    else:
        msg = ("All API keys are daily-limited for every model (RPD exhausted / blocked). "
               "Daily limits reset at midnight IST.")
        code, retry_after = "all_keys_daily_exhausted", 600
    return Response(json.dumps({
        "error": {
            "message": msg,
            "type": "rate_limit_error",
            "code": code,
            "details": attempt_errors[-6:] + [fb_info]
        }
    }), 429, {"Content-Type": "application/json", "Retry-After": str(retry_after)})

# ─── Audio Transcription ──────────────────────────────────────────────────────
@app.route('/v1/audio/transcriptions', methods=['POST', 'OPTIONS'])
def proxy_transcriptions():
    if request.method == 'OPTIONS':
        return Response(status=200)
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files['file']
    b64_audio = base64.b64encode(file.read()).decode('utf-8')
    mime_type = file.content_type or "audio/wav"

    payload = {
        "contents": [{"parts": [
            {"inlineData": {"mimeType": mime_type, "data": b64_audio}},
            {"text": "Transcribe the following audio accurately."}
        ]}],
        "generationConfig": {"temperature": 0.0}
    }

    TRANSCRIBE_MODEL = os.environ.get("TRANSCRIBE_MODEL", "gemini-3.5-flash")
    if _is_model_blocked(TRANSCRIBE_MODEL):
        return jsonify({"error": {"message": f"Transcription model '{TRANSCRIBE_MODEL}' is temporarily blocked by the admin.",
                                  "type": "model_blocked"}}), 429
    for key in API_KEYS:
        if _is_daily_penalized(key, TRANSCRIBE_MODEL):
            continue
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{TRANSCRIBE_MODEL}:generateContent?key={key}"
            resp = requests.post(url, json=payload, timeout=60)
            if resp.status_code == 200:
                with state_lock:
                    metrics["successful_api_calls"] += 1
                result = resp.json()
                try:
                    text = result['candidates'][0]['content']['parts'][0]['text']
                    if hasattr(g, "log_entry"):
                        g.log_entry["model"] = TRANSCRIBE_MODEL
                        g.log_entry["response"] = text.strip()
                        g.log_entry["status"] = f"200 Success ({TRANSCRIBE_MODEL})"
                    return jsonify({"text": text.strip()})
                except KeyError:
                    return jsonify({"error": "Failed to parse transcription"}), 500
            elif resp.status_code in [429, 403]:
                with state_lock:
                    metrics["rate_limit_hits"] += 1
                continue
        except Exception as e:
            print(f"[TRANSCRIPTION ERROR] {e}")
            continue

    return jsonify({"error": {"message": "All keys exhausted for transcription.", "type": "rate_limit"}}), 429

# ─── Context length (answers client probes, so clients need no manual setting) ─
# Agents like Hermes ask the server for the model's context window: first the
# Ollama-style POST /api/show (+ GET /api/tags), and they also read
# context_length from /v1/models. Without an answer they fall back to a guess.
# Set env CONTEXT_LENGTH to change the advertised value (default 250000).
CONTEXT_LENGTH = int(os.environ.get("CONTEXT_LENGTH", "250000"))

def _with_ctx(items):
    return [{**m, "context_length": CONTEXT_LENGTH, "context_window": CONTEXT_LENGTH,
             "max_model_len": CONTEXT_LENGTH} for m in items]

@app.route('/api/show', methods=['GET', 'POST', 'OPTIONS'])
def ollama_show():
    if request.method == 'OPTIONS':
        return Response(status=200)
    body = request.get_json(silent=True) or {}
    name = body.get("model") or body.get("name") or request.args.get("model") or "auto"
    if hasattr(g, "log_entry"):
        g.log_entry["route"] = f"Ollama-style probe answered by router (context_length={CONTEXT_LENGTH}, model={name})"
        g.log_entry["model"] = name
    return jsonify({
        "license": "", "modelfile": "", "template": "",
        "parameters": f"num_ctx {CONTEXT_LENGTH}",
        "details": {"parent_model": "", "format": "api", "family": "gemini", "families": ["gemini"],
                    "parameter_size": "", "quantization_level": ""},
        "model_info": {"general.architecture": "gemini", "general.basename": name,
                       "gemini.context_length": CONTEXT_LENGTH},
        "capabilities": ["completion", "tools", "vision"],
    })

@app.route('/api/tags', methods=['GET', 'OPTIONS'])
def ollama_tags():
    if request.method == 'OPTIONS':
        return Response(status=200)
    if hasattr(g, "log_entry"):
        g.log_entry["route"] = "Ollama-style probe answered by router (model list)"
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    names = ["auto"] + [m["name"] for m in get_active_models()]
    return jsonify({"models": [{
        "name": n, "model": n, "modified_at": now, "size": 0, "digest": "",
        "details": {"parent_model": "", "format": "api", "family": "gemini", "families": ["gemini"],
                    "parameter_size": "", "quantization_level": ""}} for n in names]})

# ─── Models List ──────────────────────────────────────────────────────────────
@app.route('/v1/models', methods=['GET', 'OPTIONS'])
def proxy_models():
    if request.method == 'OPTIONS':
        return Response(status=200)
    with dynamic_models_lock:
        if OPENAI_MODELS_LIST:
            return jsonify({"object": "list", "data": _with_ctx(OPENAI_MODELS_LIST)})
    now = int(time.time())
    data = [{"id": m["name"], "object": "model", "created": now, "owned_by": "google"}
            for m in get_active_models()]
    return jsonify({"object": "list", "data": _with_ctx(data)})

# ─── Add key/model dynamically ────────────────────────────────────────────────
@app.route('/add', methods=['POST'])
def add_key_model():
    if request.headers.get("Authorization") != f"Bearer {os.environ.get('PASSWORD','')}":
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    new_key_added   = False
    new_model_added = False
    added_key       = None
    added_model     = None

    with state_lock:
        if "key" in data and data["key"] not in API_KEYS:
            API_KEYS.append(data["key"])
            new_key_added = True
            added_key = data["key"]
        if "model" in data and "rpm" in data:
            _ex = next((m for m in MODELS if _bk(m["name"]) == _bk(data["model"])), None)
            _rpd_new = int(data["rpd"]) if "rpd" in data else (_ex["rpd"] if _ex else 500)
            new_model_added = _cfg_save(_ex["name"] if _ex else _cfg_clean_name(data["model"]) or data["model"],
                                        int(data["rpm"]), _rpd_new)      # saved -> survives restarts
            added_model = data["model"]

    test_results = []

    # ── Auto-test: new KEY → test it against every current model ──────────────
    if new_key_added:
        print(f"[ADD KEY] New key added (…{added_key[-6:]}), auto-testing against all {len(MODELS)} models...")
        for m_idx, model in enumerate(MODELS):
            question = _question_for_model_idx(m_idx)
            result = _test_single_combo(added_key, model["name"], question)
            test_results.append(result)
            status_str = "✅ OK" if result["ok"] else f"❌ {result['status']}"
            print(f"  [ADD KEY TEST] key=…{added_key[-6:]} model={model['name']} → {status_str} ({result['ms']}ms)")

    # ── Auto-test: new MODEL → test every existing key against it ─────────────
    if new_model_added:
        # find the index of the newly added model for question assignment
        new_m_idx = next((i for i, m in enumerate(MODELS) if m["name"] == added_model), len(MODELS) - 1)
        question  = _question_for_model_idx(new_m_idx)
        print(f"[ADD MODEL] New model '{added_model}' added, auto-testing against all {len(API_KEYS)} keys...")
        for key in API_KEYS:
            # skip the key that was just added to avoid double-testing the
            # (new_key, new_model) combo — it was already covered above
            if new_key_added and key == added_key:
                continue
            result = _test_single_combo(key, added_model, question)
            test_results.append(result)
            status_str = "✅ OK" if result["ok"] else f"❌ {result['status']}"
            print(f"  [ADD MODEL TEST] key=…{key[-6:]} model={added_model} → {status_str} ({result['ms']}ms)")

    ok_count = sum(1 for r in test_results if r["ok"])
    return jsonify({
        "status": "success",
        "keys_count": len(API_KEYS),
        "models": MODELS,
        "new_key_added": new_key_added,
        "new_model_added": new_model_added,
        "auto_test": {
            "total": len(test_results),
            "ok": ok_count,
            "failed": len(test_results) - ok_count,
            "results": test_results,
        }
    })

@app.route('/status', methods=['GET'])
@requires_browser_auth
def get_status():
    now = time.time()
    now_mono = time.monotonic()
    with state_lock:
        penalized = {f"{k[:5]}...{k[-5:]}|{m}": round((ts-now)/60,1)
                     for (k,m),ts in key_daily_penalty.items() if ts > now}
        cooldowns = {f"{k[:5]}...{k[-5:]}|{m}": round(ts-now_mono,1)
                     for (k,m),ts in rpm_cooldown.items() if ts > now_mono}
        broken = [f"{k[:5]}...{k[-5:]}|{m}" for (k,m) in PERMANENTLY_BROKEN_MODELS]
    return jsonify({
        "metrics": metrics,
        "active_keys": len(API_KEYS),
        "daily_penalized_keys_minutes_left": penalized,
        "rpm_cooldowns_seconds_left": cooldowns,
        "permanently_broken_key_model_pairs": broken,
        "model_blocks": _model_blocks_view(),
        "models": get_active_models()
    })

@app.route('/ping')
@app.route('/healthz')
def ping():
    return "OK", 200

# ─── /api/web/v1 : ONLY WebAI-to-API (separate from the Gemini key router) ────
# Mapping (so it works as an OpenAI base_url):
#   /api/web/v1/chat/completions  -> /v1/chat/completions of the least-busy WebAI account (one process per Gemini account, see webai_pool.py)
#   /api/web/v1/models            -> /v1/models of one logged-in account
#   /api/web/v1/ui/...            -> /ui/... of one account   (cookie page: /api/web/v1/ui/auth = add / remove accounts)
#   /api/web/v1/docs|redoc|openapi.json|health|ready|translate -> same path upstream
# Auth: "Authorization: Bearer <PASSWORD>" (API clients) OR browser Basic auth
# (password field = PASSWORD) so the dashboard opens in a browser.
# WebAI-to-API itself has no caller auth, so keep it bound to localhost.
WEBAPI_PREFIX = "/api/web/v1"
WEBAI_URL = os.environ.get("WEBAI_URL", "http://127.0.0.1:6969").rstrip("/")
_WEBAPI_ROOT_PATHS = ("ui", "docs", "redoc", "openapi.json", "health", "ready",
                      "translate", "favicon.ico")
_WEBAPI_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
               "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
               "content-encoding", "authorization", "accept-encoding"}
_WEBAPI_REWRITE_RE = re.compile(
    r"(?P<pre>[\"'(=\s])/(?P<seg>ui|v1|docs|redoc|openapi\.json|health|ready|translate|favicon\.ico)"
    r"(?=[/\"')?#\s]|$)")

def _webapi_authorized() -> bool:
    expected = os.environ.get("PASSWORD", "")
    if not expected:
        return False
    if request.headers.get("Authorization", "") == f"Bearer {expected}":
        return True
    auth = request.authorization
    return bool(auth and auth.password == expected)

def _webapi_rewrite_text(text: str) -> str:
    # dashboard pages use absolute paths (/ui/..., /v1/...) -> keep them under the prefix
    def _sub(m):
        seg = m.group("seg")
        return f'{m.group("pre")}{WEBAPI_PREFIX}' + ("" if seg == "v1" else f"/{seg}")
    return _WEBAPI_REWRITE_RE.sub(_sub, text)

def _webapi_rewrite_location(loc: str) -> str:
    return _webapi_rewrite_text(" " + loc)[1:] if loc.startswith("/") else loc

# /api/web/v1/ui/auth : paste-cookies page (cookies kept in MongoDB, auto-refreshed values synced back).
# Registered BEFORE the catch-all proxy below; exact routes win over <path:sub>.
try:
    if not WEBAI_ENABLED:
        raise RuntimeError("WEBAI_ENABLED=0")
    import webai_cookies
    webai_cookies.register(app, _webapi_authorized, WEBAPI_PREFIX, WEBAI_URL)
except Exception as _e:  # pymongo missing etc. -> proxy still works, only the paste page is lost
    print(f"[webai-cookies] disabled: {_e}", flush=True)


def _webapi_fix_body(raw: bytes) -> bytes:
    """WebAI-to-API accepts only {"type":"text"} and {"type":"file","file":{filename,file_data}} content parts.
    OpenAI clients (the exam-fix job) send {"type":"image_url"} -> 422 "Input should be a valid string".
    Convert image_url -> file part (data URL), so the paper image reaches Gemini. Anything else is left untouched."""
    try:
        body = json.loads(raw.decode("utf-8"))
        changed = False
        n = 0
        for m in (body.get("messages") or []):
            c = m.get("content")
            if not isinstance(c, list):
                continue
            new = []
            for part in c:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    u = part.get("image_url")
                    u = u.get("url") if isinstance(u, dict) else u
                    if isinstance(u, str) and u.startswith("data:"):
                        mime = u[5:].split(";", 1)[0] or "image/jpeg"
                        ext = {"image/png": "png", "image/webp": "webp", "image/gif": "gif"}.get(mime, "jpg")
                        n += 1
                        new.append({"type": "file", "file": {"filename": f"image_{n}.{ext}", "file_data": u}})
                        changed = True
                        continue
                    changed = True          # remote url cannot be used by WebAI -> drop it
                    continue
                if isinstance(part, dict) and part.get("type") in ("input_text", "output_text"):
                    part = {"type": "text", "text": part.get("text", "")}
                    changed = True
                new.append(part)
            m["content"] = new
        return json.dumps(body, ensure_ascii=False).encode("utf-8") if changed else raw
    except Exception:
        return raw

import webapi_param_fix

WEBAI_REQUIRE_AUTH = os.environ.get("WEBAI_REQUIRE_AUTH", "0") == "1"   # 1 = never answer from a logged-out (anonymous) WebAI instance
ANON_TAG = "NOT LOGGED IN - answered anonymously, NOT saved in the Gemini account (cookies expired? re-paste at /api/web/v1/ui/auth)"
WEBAPI_READ_TIMEOUT = float(os.environ.get("WEBAPI_READ_TIMEOUT", "600"))   # seconds WebAI may take to answer (lower = hung accounts are given up sooner)


def _webapi_request(method, url, params, body, headers, slot, is_chat, stream=True, log=None):
    """One request to a WebAI account with two self-healing steps for chat requests:
      * unknown model  -> retried with a model the account really has (webapi_model_fix)
      * unsupported parameter (422/400 naming a field) -> the field is removed and the request is retried at once;
        once that works the field is remembered and skipped up front on every later request (webapi_param_fix)
    Returns the final upstream response (may still be an error that is not fixable by us)."""
    send = body
    removed_known = []
    pending = []
    if is_chat:
        send, removed_known = webapi_param_fix.strip_known(send)
        send = webapi_param_fix.emulate(body, send)
        send, _req_m, _used_m = webapi_model_fix.preflight(slot.id, send)
        if _used_m and log is not None:
            log["model"] = f"{_req_m} -> {_used_m}"

    def _do(b):
        return requests.request(method, url, params=params, data=b, headers=headers,
                                stream=stream, timeout=(10, WEBAPI_READ_TIMEOUT), allow_redirects=False)

    up = _do(send)
    _want_json = is_chat and webapi_param_fix.wants_json(body)
    up.want_json = False
    if not is_chat:
        return up
    bad_models = {webapi_model_fix.get_model(send)}
    first_model = webapi_model_fix.get_model(body)
    for _ in range(8):
        if up.status_code not in (400, 404, 422):
            break
        txt = up.content.decode("utf-8", "replace")
        if webapi_model_fix.is_unknown_model_error(up.status_code, txt):
            avail = webapi_model_fix.parse_available(txt) or webapi_model_fix.fetch_models(requests, slot.url)
            webapi_model_fix.remember(slot.id, avail)
            alt = webapi_model_fix.pick(avail, exclude=bad_models)
            if not alt:
                break
            print(f"[WEBAPI MODEL FALLBACK] '{webapi_model_fix.get_model(send)}' unknown on '{slot.label}' -> '{alt}'", flush=True)
            if log is not None:
                log["model"] = f"{first_model} -> {alt}"
            up.close()
            bad_models.add(alt)
            send = webapi_model_fix.set_model(send, alt)     # keeps the parameter fixes made so far
            up = _do(send)
            continue
        cands = webapi_param_fix.candidates(up.status_code, txt, send)
        new_send, done = webapi_param_fix.remove_paths(send, cands) if cands else (send, [])
        if not done:
            break
        print(f"[WEBAPI PARAM FALLBACK] '{slot.label}' rejected {done} -> retrying without them", flush=True)
        if log is not None:
            log["model"] = (log.get("model") or first_model or "") + f"  (skipped params: {', '.join(done)})"
        up.close()
        pending += done
        send = webapi_param_fix.emulate(body, new_send)
        up = _do(send)
    up.want_json = bool(_want_json and not webapi_param_fix.wants_json(send))
    if up.status_code < 400:
        if pending:
            webapi_param_fix.learn(pending, "upstream 4xx, ok without them")
        if removed_known:
            webapi_param_fix.note_skipped(removed_known)
            if log is not None and not pending:
                log["model"] = (log.get("model") or first_model or "") + f"  (auto-skipped: {', '.join(removed_known)})"
    elif removed_known and not pending and up.status_code in (400, 422):
        # we already removed learned fields and it STILL fails: not our fields' fault, nothing to change
        pass
    return up


_RESPONSES_ONLY_KEYS = ("input", "instructions", "text", "reasoning", "store", "previous_response_id", "truncation",
                        "include", "max_output_tokens", "parallel_tool_calls", "metadata", "user", "service_tier",
                        "prompt_cache_key", "background")


def _webapi_responses_to_chat(raw: bytes):
    """WebAI-to-API has no /v1/responses (404). Turn a Responses-API body into a chat/completions body.
    Returns (chat_body_bytes, client_wanted_stream). Images (input_image) become image_url parts."""
    d = json.loads(raw.decode("utf-8"))
    stream = bool(d.get("stream"))
    msgs = []
    if d.get("instructions"):
        msgs.append({"role": "system", "content": d["instructions"]})
    inp = d.get("input")
    if "messages" in d and isinstance(d["messages"], list):
        msgs.extend(d["messages"])
    elif isinstance(inp, str):
        msgs.append({"role": "user", "content": inp})
    elif isinstance(inp, list):
        for item in inp:
            if not isinstance(item, dict) or "role" not in item:
                continue
            c = item.get("content")
            if isinstance(c, list):
                parts = []
                for p in c:
                    if not isinstance(p, dict):
                        continue
                    t = p.get("type")
                    if t in ("input_text", "output_text", "text"):
                        parts.append({"type": "text", "text": p.get("text", "")})
                    elif t == "input_image":
                        u = p.get("image_url")
                        u = u.get("url") if isinstance(u, dict) else u
                        if u:
                            parts.append({"type": "image_url", "image_url": {"url": u}})
                    else:
                        parts.append(p)
                c = parts
            role = "system" if item["role"] == "developer" else item["role"]
            msgs.append({"role": role, "content": "" if c is None else c})
    out = {k: v for k, v in d.items() if k not in _RESPONSES_ONLY_KEYS and k != "messages"}
    _fmt = (d.get("text") or {}).get("format") if isinstance(d.get("text"), dict) else None
    if isinstance(_fmt, dict) and _fmt.get("type") in ("json_object", "json_schema") and "response_format" not in out:
        out["response_format"] = ({"type": "json_object"} if _fmt["type"] == "json_object" else
                                  {"type": "json_schema", "json_schema": {"name": _fmt.get("name", "output"), "schema": _fmt.get("schema") or {}}})
    out["messages"] = msgs
    out["stream"] = False
    out.pop("tools", None)
    out.pop("tool_choice", None)
    return json.dumps(out, ensure_ascii=False).encode("utf-8"), stream


@_webai_route(WEBAPI_PREFIX + "/webai-log", methods=["GET"])
def webapi_webai_log():
    """Last lines printed by the WebAI-to-API processes (what they do while a request is 'Pending')."""
    if not _webapi_authorized():
        return Response("Login Required", 401, {"WWW-Authenticate": 'Basic realm="password field = your API PASSWORD"'})
    try:
        n = max(10, min(600, int(request.args.get("n", "150"))))
    except ValueError:
        n = 150
    try:
        with open(os.path.join(os.environ.get("WEBAI_POOL_DIR", "/tmp/webai-pool"), "webai.log"), encoding="utf-8") as f:
            lines = f.read().splitlines()[-n:]
    except OSError:
        lines = ["(no WebAI log yet)"]
    return Response("\n".join(lines) + "\n", mimetype="text/plain; charset=utf-8")


@_webai_route(WEBAPI_PREFIX + "/param-fix", methods=["GET", "DELETE"])
def webapi_param_fix_view():
    """GET  -> parameters WebAI rejected and that are now skipped automatically.
    DELETE (optional ?path=temperature) -> forget one / all of them."""
    if not _webapi_authorized():
        return jsonify({"error": "Unauthorized Access. Invalid Password."}), 401
    if request.method == "DELETE":
        webapi_param_fix.reset(request.args.get("path"))
    return jsonify({"enabled": webapi_param_fix.ENABLED, "skipped_params": webapi_param_fix.snapshot()})


@_webai_route(WEBAPI_PREFIX, defaults={'sub': ''}, methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
@_webai_route(WEBAPI_PREFIX + '/<path:sub>', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
def webapi_proxy(sub):
    cors = {"Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS"}
    if request.method == 'OPTIONS':
        return Response(status=200, headers=cors)

    sub = sub.strip("/")
    if sub == "":
        sub = "ui"
    _resp_mode = request.method == "POST" and sub == "responses"     # no /v1/responses in WebAI -> answered via chat/completions
    if _resp_mode:
        sub = "chat/completions"
    first = sub.split("/", 1)[0]
    upstream_path = "/" + sub if first in _WEBAPI_ROOT_PATHS else "/v1/" + sub
    url = WEBAI_URL + upstream_path     # replaced by the chosen account's URL below
    _is_chat = request.method == "POST" and sub.endswith("chat/completions")
    # Dashboard pages/assets (GET ui/*) are not logged (they poll constantly); every API route is.
    _log_it = not (request.method == "GET" and first in ("ui", "favicon.ico"))

    def _start_log(authorized: bool):
        raw_bytes = request.get_data()
        g._log_start = time.monotonic()
        model = None
        raw_json = {}
        if _is_chat:
            raw_json = request.get_json(silent=True) or {}
            model = raw_json.get("model")
            snap = _req_snapshot(raw_json, request.path)
            last = snap.split("last user message:\n", 1)[-1].strip()
            msg = _clip(last, 500)
        else:
            if first == "ui":
                snap = "body: (hidden - dashboard / cookie page)"
            elif raw_bytes:
                txt = raw_bytes[:800].decode("utf-8", "replace")
                snap = "body:\n" + txt + ("…" if len(raw_bytes) > 800 else "")
            else:
                snap = "body: (empty)"
            msg = f"{request.method} /{sub}"
        qs = request.full_path.rstrip("?")
        entry = {
            "time": datetime.datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
            "ip": request.headers.get("Cf-Connecting-Ip", request.headers.get("X-Forwarded-For", request.remote_addr)),
            "path": request.path,
            "password_used": "*** HIDDEN (CORRECT) ***" if authorized else request.headers.get("Authorization", ""),
            "is_correct": authorized, "message": msg, "model": model, "response_ms": None,
            "error_detail": None, "status": "Pending...",
            "route": f"WebAI direct ({request.method} {qs} → {url})",
            "request": f"{request.method} {qs} -> upstream {url}\n{snap}\nheaders:\n{_safe_headers(request.headers)}",
        }
        g.log_entry = entry
        request_logs.appendleft(entry)
        if _is_chat and authorized:
            _live_begin(entry, raw_json, request.path)

    if not _webapi_authorized():
        if _log_it and request.headers.get("Authorization"):   # browser's first no-credentials probe is not logged
            _start_log(False)
            g.log_entry["status"] = "401 Blocked"
            g.log_entry["error_detail"] = "Invalid password for /api/web/v1"
            g.log_entry["route"] = "Blocked at /api/web/v1 (wrong password)"
        if "text/html" in request.headers.get("Accept", ""):
            return Response('Login Required', 401,
                {'WWW-Authenticate': 'Basic realm="Web API (password field = your API PASSWORD)"'})
        return jsonify({"error": "Unauthorized Access. Invalid Password."}), 401

    if _log_it:
        _start_log(True)

    fwd_headers = {k: v for k, v in request.headers
                   if k.lower() not in _WEBAPI_HOP and k.lower() != "cookie"}
    fwd_headers["Accept-Encoding"] = "identity"
    _body = request.get_data()
    _resp_stream = False
    if _resp_mode:
        try:
            _body, _resp_stream = _webapi_responses_to_chat(_body)
        except Exception as _e:
            return jsonify({"error": {"message": f"invalid /responses body: {_e}", "type": "invalid_request_error"}}), 400
    if request.method == "POST" and sub.endswith("chat/completions") and "json" in request.headers.get("Content-Type", "").lower():
        _body = _webapi_fix_body(_body)
        fwd_headers = {k: v for k, v in fwd_headers.items() if k.lower() != "content-length"}
    # ── pick the WebAI account (one WebAI process per Gemini account) ──────────
    pool = webai_pool.get_pool()
    _acc = request.args.get("a") if first == "artifacts" else None       # artifact links carry the account that made them
    _params = [(k, v) for k, v in request.args.items(multi=True) if not (_acc is not None and k == "a")]
    _balanced = request.method == "POST" and first != "ui"                # generation requests: load-balanced + failover
    _conv = None
    if _is_chat:
        _j = request.get_json(silent=True)
        _conv = _j.get("conversation_id") if isinstance(_j, dict) else None
    _pref = pool.conv_account(_conv)
    max_tries = pool.count() if _balanced else 1
    tried, up, slot, last_exc, _anon_blocked = set(), None, None, None, None
    for _try in range(max(1, max_tries)):
        if _balanced:
            slot = pool.acquire(exclude=tried, prefer=_pref)
        else:
            slot = pool.slot_for(_acc) if _acc else pool.peek()
        if slot is None:
            break
        tried.add(slot.id)
        if _balanced and WEBAI_REQUIRE_AUTH and slot.auth is False and not slot.guest:
            pool.release(slot)                       # logged out -> do not use it, try the next account
            _anon_blocked = slot.label
            continue
        url = slot.url + upstream_path
        try:
            if _is_chat and hasattr(g, "log_entry"):      # shown in the 'Error / Why' column while the row is Pending
                g.log_entry["error_detail"] = (f"⏳ sent to WebAI '{slot.label}' at {datetime.datetime.now(IST).strftime('%H:%M:%S')} "
                                               f"({len(_body) // 1024} KB, logged_in={slot.auth}) - waiting for its answer. "
                                               f"WebAI log: {WEBAPI_PREFIX}/webai-log")
            up = _webapi_request(request.method, url, _params, _body, fwd_headers, slot, _is_chat, stream=True,
                                 log=getattr(g, "log_entry", None))
            if hasattr(g, "log_entry") and up.status_code < 400 and str(g.log_entry.get("error_detail") or "").startswith("⏳"):
                g.log_entry["error_detail"] = None
        except Exception as e:
            last_exc, up = e, None
            if _balanced:
                pool.release(slot, error=True)
            if _balanced and _try + 1 < max_tries:
                continue
            break
        if _balanced and up.status_code in webai_pool.RETRY_STATUS and _try + 1 < max_tries and pool.has_candidate(tried):
            pool.release(slot, status=up.status_code)     # this account has a problem -> next account
            up.close()
            up = None
            continue
        break
    if up is None:
        if _anon_blocked and last_exc is None:
            msg = f"WebAI account '{_anon_blocked}' is logged out (Gemini rejected the cookies) - paste fresh cookies at /api/web/v1/ui/auth"
        elif slot is None and last_exc is None:
            msg = "no WebAI account is running (add cookies at /api/web/v1/ui/auth)"
        elif isinstance(last_exc, requests.exceptions.ReadTimeout):
            msg = (f"WebAI account did not answer within {int(WEBAPI_READ_TIMEOUT)}s (Gemini web hung / overloaded - "
                   f"process is running). Try again or lower WEBAPI_READ_TIMEOUT.")
        else:
            msg = f"WebAI-to-API unreachable: {last_exc}"
        if hasattr(g, "log_entry"):
            g.log_entry["error_detail"] = f"{msg} (WebAI not running / not installed / crashed?)"
        return jsonify({"error": {"message": msg, "type": "upstream_unavailable"}}), 424
    if hasattr(g, "log_entry"):
        g.log_entry["route"] = (("⚠ " + ANON_TAG + " | ") if slot.auth is False else "") + \
            f"WebAI account '{slot.label}' ({request.method} {request.full_path.rstrip('?')} → {url})"

    _rel = {"done": not _balanced}
    def _release(error=False):
        if not _rel["done"]:
            _rel["done"] = True
            pool.release(slot, status=up.status_code, error=error)
    if _conv and up.status_code < 400:
        pool.remember_conv(_conv, slot.id)

    out_headers = {}
    for k, v in up.headers.items():
        kl = k.lower()
        if kl in _WEBAPI_HOP or kl == "set-cookie":
            continue
        if kl in ("location", "hx-redirect", "hx-location", "hx-push-url", "hx-replace-url"):
            v = _webapi_rewrite_location(v)
        out_headers[k] = v
    out_headers.update(cors)
    if slot.auth is False:
        out_headers["X-WebAI-Auth"] = "anonymous"

    # Koyeb replaces app-sent 502/503/504 with its own generic "no healthy service"
    # page, hiding the real reason -> report WebAI problems as 424 instead.
    status = 424 if up.status_code in (502, 503, 504) else up.status_code
    if status != up.status_code:
        out_headers["X-Upstream-Status"] = str(up.status_code)

    ctype = up.headers.get("Content-Type", "").lower()
    if hasattr(g, "log_entry") and status >= 400 and "event-stream" not in ctype:
        try:
            _eb = _short_err(up.content.decode("utf-8", "replace"), 400)
        except Exception:
            _eb = "(unreadable body)"
        _hint = ""
        if up.status_code == 404:
            _hint = f" -> route '{upstream_path}' does not exist in WebAI (valid: chat/completions, models, ui, docs, health, translate ...)"
        elif up.status_code == 422:
            _hint = " -> WebAI rejected the request body shape (see message)"
        elif up.status_code in (502, 503, 504):
            _hint = " -> WebAI process is down or restarting"
        elif up.status_code in (401, 403):
            _hint = " -> Gemini web cookies expired / invalid (paste fresh cookies at /api/web/v1/ui/auth)"
        g.log_entry["error_detail"] = f"WebAI HTTP {up.status_code} on {upstream_path}: {_eb}{_hint}"
    # artifact links (/v1/artifacts/fetch?...) -> absolute, working URLs under /api/web/v1
    _proto = request.headers.get("X-Forwarded-Proto", "https").split(",")[0].strip() or "https"
    _art_old = b'"/v1/artifacts/fetch?'
    _acc_q = 'a=' + quote(slot.id, safe='') + '&'
    _art_new = ('"' + _proto + '://' + request.host + WEBAPI_PREFIX + '/artifacts/fetch?' + _acc_q).encode()
    _md_old = b'](/v1/artifacts/fetch?'
    _md_new = ('](' + _proto + '://' + request.host + WEBAPI_PREFIX + '/artifacts/fetch?' + _acc_q).encode()
    if "application/json" in ctype:
        body = up.content.replace(_art_old, _art_new).replace(_md_old, _md_new)
        up.close()
        _release()
        if getattr(up, "want_json", False) and status < 400:
            try:
                _cj0 = json.loads(body.decode("utf-8", "replace"))
                _chg, _note = webapi_param_fix.clean_json_reply(_cj0)
                if _chg:
                    body = json.dumps(_cj0, ensure_ascii=False).encode("utf-8")
                if hasattr(g, "log_entry"):
                    if _chg:
                        g.log_entry["model"] = (g.log_entry.get("model") or "") + "  (JSON cleaned)"
                    elif _note.startswith("reply is not JSON"):
                        g.log_entry["error_detail"] = "⚠ " + _note
            except Exception as _e:
                print(f"[WEBAPI] json clean failed: {_e}", flush=True)
        if _resp_mode and status < 400:
            try:
                _cj = json.loads(body.decode("utf-8", "replace"))
                _rj = chat_completion_to_responses_json(_cj, _cj.get("model") or "webai")
                if _resp_stream:
                    return Response(responses_sse_stream(_rj), mimetype="text/event-stream", headers=cors)
                return Response(json.dumps(_rj, ensure_ascii=False), 200, {**cors, "Content-Type": "application/json"})
            except Exception as _e:
                print(f"[WEBAPI] responses conversion failed: {_e}", flush=True)
        return Response(body, status, out_headers)
    if "text/event-stream" in ctype:
        def _sse():
            buf = b""
            try:
                for chunk in up.iter_content(chunk_size=None):
                    if not chunk:
                        continue
                    buf += chunk
                    *lines, buf = buf.split(b"\n")      # whole lines only: a link is never cut in half
                    if lines:
                        yield b"\n".join(lines).replace(_art_old, _art_new).replace(_md_old, _md_new) + b"\n"
                if buf:
                    yield buf.replace(_art_old, _art_new).replace(_md_old, _md_new)
            except Exception:
                _release(error=True)
                raise
            finally:
                up.close()
                _release()
        return Response(_GuardedIter(_sse(), lambda: (up.close(), _release())), status, out_headers)
    if any(t in ctype for t in ("text/html", "text/css", "javascript")):
        body = _webapi_rewrite_text(up.content.decode(up.encoding or "utf-8", errors="replace"))
        if first == "ui" and "text/html" in ctype:
            body = deploy_badge.inject(body)
        up.close()
        _release()
        return Response(body.encode("utf-8"), status, out_headers)

    def _gen():
        try:
            for chunk in up.iter_content(chunk_size=None):
                if chunk:
                    yield chunk
        finally:
            up.close()
            _release()
    return Response(_GuardedIter(_gen(), lambda: (up.close(), _release())), status, out_headers)

# --- ANTI_504_HEARTBEAT_PATCH ---
import io as _hb_io
import json as _hb_json
import queue as _hb_queue
import time as _hb_time
import threading as _hb_threading

class _Anti504HeartbeatMiddleware:
    """Prevents Koyeb Edge / Cloudflare 100s Gateway Timeout (error code: 504)
    on BOTH streaming (stream=true) and non-streaming (stream=false) POST requests
    to /v1/chat/completions, /v1/responses, and /api/web/v1/chat/completions:
    - For stream=true: flushes HTTP 200 OK (text/event-stream) + a 2KB SSE comment
      (: keep-alive ...) after 8s if upstream is still thinking/retrying, followed by
      ': keep-alive\n\n' every 10s whenever upstream is silent (before first token
      or between tokens), and streams real SSE chunks immediately without buffering.
    - For stream=false: flushes HTTP 200 OK (application/json) + 4KB whitespace after
      10s, followed by 1KB whitespace every 10s until JSON body arrives."""

    def __init__(self, wsgi_app, first_byte_delay=8.0, heartbeat_interval=10.0):
        self.wsgi_app = wsgi_app
        self.first_byte_delay = first_byte_delay
        self.heartbeat_interval = heartbeat_interval

    def _is_target_request(self, environ):
        if environ.get("REQUEST_METHOD") != "POST":
            return False
        path = (environ.get("PATH_INFO") or "").rstrip("/")
        return path.endswith("/chat/completions") or path.endswith("/responses")

    def __call__(self, environ, start_response):
        if not self._is_target_request(environ):
            return self.wsgi_app(environ, start_response)

        try:
            content_length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            content_length = 0

        body_bytes = b""
        if content_length > 0 and environ.get("wsgi.input") is not None:
            body_bytes = environ["wsgi.input"].read(content_length)
            environ["wsgi.input"] = _hb_io.BytesIO(body_bytes)

        try:
            payload = _hb_json.loads(body_bytes.decode("utf-8", "replace")) if body_bytes else {}
        except Exception:
            payload = {}

        is_stream = isinstance(payload, dict) and bool(payload.get("stream"))

        if is_stream:
            return self._handle_streaming(environ, start_response)
        return self._handle_non_streaming(environ, start_response)

    def _handle_streaming(self, environ, start_response):
        q = _hb_queue.Queue()
        stop = _hb_threading.Event()      # set when the client is gone -> the worker stops reading upstream and fills no more RAM
        captured = {"status": "200 OK", "headers": [], "got_headers": False}

        def _capture_start_response(status, headers, exc_info=None):
            captured["status"] = status
            captured["headers"] = list(headers or [])
            captured["got_headers"] = True
            q.put(("headers", None))
            return lambda chunk: q.put(("chunk", chunk)) if chunk else None

        def _worker():
            try:
                app_iter = self.wsgi_app(environ, _capture_start_response)
                try:
                    for chunk in app_iter:
                        if stop.is_set():
                            break
                        if chunk:
                            q.put(("chunk", chunk))
                finally:
                    if hasattr(app_iter, "close"):
                        app_iter.close()
            except Exception as e:
                if not stop.is_set():
                    q.put(("exc", e))
            finally:
                q.put(("eof", None))

        t = _hb_threading.Thread(target=_worker, daemon=True)
        t.start()

        deadline = _hb_time.monotonic() + self.first_byte_delay
        buffered = []
        first_chunk_seen = False
        finished_fast = False

        while True:
            rem = deadline - _hb_time.monotonic()
            if rem <= 0:
                break
            try:
                ev_type, ev_val = q.get(timeout=rem)
            except _hb_queue.Empty:
                break
            if ev_type == "headers":
                continue
            buffered.append((ev_type, ev_val))
            if ev_type == "chunk":
                first_chunk_seen = True
                if captured["status"].startswith("200"):
                    break
            elif ev_type in ("eof", "exc"):
                finished_fast = True
                break

        # Fast error or empty response within 8s: preserve native status code (401/400/429/etc.)
        if finished_fast and not captured["status"].startswith("200"):
            for ev_type, ev_val in buffered:
                if ev_type == "exc":
                    raise ev_val
            start_response(captured["status"], captured["headers"])
            return [ev_val for ev_type, ev_val in buffered if ev_type == "chunk"]

        sse_headers = [
            ("Content-Type", "text/event-stream; charset=utf-8"),
            ("Cache-Control", "no-cache, no-store, no-transform"),
            ("Connection", "keep-alive"),
            ("X-Accel-Buffering", "no"),
        ]
        for hk, hv in captured.get("headers") or []:
            if hk.lower() in ("access-control-allow-origin", "access-control-allow-headers",
                              "access-control-allow-methods", "x-webai-auth", "x-upstream-status"):
                sse_headers.append((hk, hv))
        start_response("200 OK", sse_headers)

        def _sse_gen():
            try:
                yield from _sse_gen_inner()
            finally:
                stop.set()
                buffered.clear()
                try:
                    while True:               # drop whatever is still queued
                        q.get_nowait()
                except _hb_queue.Empty:
                    pass

        def _sse_gen_inner():
            if not first_chunk_seen:
                # Immediate 2KB SSE comment padding so Nginx / Koyeb Edge / Cloudflare flush 200 OK headers right away
                yield b": keep-alive " + (b"." * 2048) + b"\n\n"

            non_sse_buf = []

            def _is_non_sse_response():
                if not captured["got_headers"]:
                    return False
                if not captured["status"].startswith("200"):
                    return True
                ctype = ""
                for hk, hv in captured["headers"]:
                    if hk.lower() == "content-type":
                        ctype = hv.lower()
                        break
                return "application/json" in ctype and "event-stream" not in ctype

            for ev_type, ev_val in buffered:
                if ev_type == "chunk":
                    if _is_non_sse_response():
                        non_sse_buf.append(ev_val)
                    else:
                        yield ev_val
                elif ev_type == "exc":
                    err_payload = _hb_json.dumps({"error": {"message": str(ev_val), "type": "server_error", "code": 500}})
                    yield f"data: {err_payload}\n\ndata: [DONE]\n\n".encode("utf-8")
                    return
                elif ev_type == "eof":
                    if non_sse_buf:
                        for out_c in self._convert_json_buf_to_sse(b"".join(non_sse_buf), captured["status"]):
                            yield out_c
                    return

            while True:
                try:
                    ev_type, ev_val = q.get(timeout=self.heartbeat_interval)
                except _hb_queue.Empty:
                    yield b": keep-alive\n\n"
                    continue
                if ev_type == "headers":
                    continue
                if ev_type == "chunk":
                    if _is_non_sse_response():
                        non_sse_buf.append(ev_val)
                    else:
                        yield ev_val
                elif ev_type == "exc":
                    err_payload = _hb_json.dumps({"error": {"message": str(ev_val), "type": "server_error", "code": 500}})
                    yield f"data: {err_payload}\n\ndata: [DONE]\n\n".encode("utf-8")
                    return
                elif ev_type == "eof":
                    if non_sse_buf:
                        for out_c in self._convert_json_buf_to_sse(b"".join(non_sse_buf), captured["status"]):
                            yield out_c
                    return

        return _GuardedIter(_sse_gen(), stop.set)

    def _convert_json_buf_to_sse(self, raw_bytes, status_str):
        try:
            obj = _hb_json.loads(raw_bytes.decode("utf-8", "replace"))
            if status_str.startswith("200") and isinstance(obj, dict) and "choices" in obj:
                for line in chat_completion_sse(obj):
                    yield line.encode("utf-8") if isinstance(line, str) else line
                return
        except Exception:
            pass
        err_text = raw_bytes.decode("utf-8", "replace")
        try:
            err_obj = _hb_json.loads(err_text)
            if isinstance(err_obj, dict) and "error" in err_obj:
                yield f"data: {_hb_json.dumps(err_obj)}\n\ndata: [DONE]\n\n".encode("utf-8")
                return
        except Exception:
            pass
        code = int(status_str.split()[0]) if status_str and status_str.split()[0].isdigit() else 500
        err_payload = _hb_json.dumps({"error": {"message": err_text[:500], "type": "upstream_error", "code": code}})
        yield f"data: {err_payload}\n\ndata: [DONE]\n\n".encode("utf-8")

    def _handle_non_streaming(self, environ, start_response):
        done_evt = _hb_threading.Event()
        captured = {"status": "200 OK", "headers": [], "body_chunks": [], "exc": None}

        def _capture_start_response(status, headers, exc_info=None):
            captured["status"] = status
            captured["headers"] = list(headers or [])
            return lambda chunk: captured["body_chunks"].append(chunk)

        def _worker():
            try:
                app_iter = self.wsgi_app(environ, _capture_start_response)
                try:
                    for chunk in app_iter:
                        if chunk:
                            captured["body_chunks"].append(chunk)
                finally:
                    if hasattr(app_iter, "close"):
                        app_iter.close()
            except Exception as e:
                captured["exc"] = e
            finally:
                done_evt.set()

        t = _hb_threading.Thread(target=_worker, daemon=True)
        t.start()

        if done_evt.wait(timeout=self.first_byte_delay):
            if captured["exc"] is not None:
                raise captured["exc"]
            start_response(captured["status"], captured["headers"])
            return captured["body_chunks"]

        stream_headers = [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Cache-Control", "no-cache, no-store, no-transform"),
            ("X-Accel-Buffering", "no"),
        ]
        start_response("200 OK", stream_headers)

        def _heartbeat_stream():
            yield (b" " * 4096) + b"\n"
            while not done_evt.wait(timeout=self.heartbeat_interval):
                yield (b" " * 1024) + b"\n"
            if captured["exc"] is not None:
                err_json = _hb_json.dumps({
                    "error": {"message": str(captured["exc"]), "type": "server_error", "code": 500}
                }).encode("utf-8")
                yield err_json
            else:
                for chunk in captured["body_chunks"]:
                    if chunk:
                        yield chunk

        return _heartbeat_stream()

app.wsgi_app = _Anti504HeartbeatMiddleware(app.wsgi_app)

# ─── Memory janitor ───────────────────────────────────────────────────────────
# Everything above that grows with traffic is bounded where it is written, but several of those tables were only
# ever cleaned while NEW requests of the same kind arrived (a quiet period kept every old entry in RAM, and an
# unusual one - random model names, one-off conversations - kept adding). This thread sweeps them regularly.
JANITOR_SECS = float(os.environ.get("JANITOR_SECS", "60"))
JANITOR_MAX_PAIRS = int(os.environ.get("JANITOR_MAX_PAIRS", "2000"))


def _janitor_once(trim: bool = False):
    now_mono, now = time.monotonic(), time.time()
    known = {m["name"] for m in MODELS}
    with state_lock:
        for k in list(rpm_window):                              # sliding windows: drop old stamps, then empty deques
            dq = rpm_window[k]
            cutoff = now_mono - RPM_WINDOW_SECS
            while dq and dq[0] < cutoff:
                dq.popleft()
            if not dq:
                rpm_window.pop(k, None)
        for k in [k for k, ts in rpm_cooldown.items() if ts <= now_mono]:
            rpm_cooldown.pop(k, None)
        for k in [k for k, ts in key_daily_penalty.items() if ts <= now]:
            key_daily_penalty.pop(k, None)
        for k in [k for k, v in rpd_count.items() if not v]:
            rpd_count.pop(k, None)
        # pairs for model names that are NOT in GEMINI_MODELS (a client may send any name) must not pile up forever
        for table in (rpd_count, rate_strikes, rpm_cooldown, key_daily_penalty, rpm_window):
            if len(table) > JANITOR_MAX_PAIRS:
                for k in [k for k in table if k[1] not in known]:
                    table.pop(k, None)
        if len(PERMANENTLY_BROKEN_MODELS) > JANITOR_MAX_PAIRS:
            for k in [k for k in PERMANENTLY_BROKEN_MODELS if k[1] not in known]:
                PERMANENTLY_BROKEN_MODELS.discard(k)
        _prune_conv_sticky()
        for bk in [bk for bk, b in MODEL_BLOCKS.items() if b["until"] <= now]:
            MODEL_BLOCKS.pop(bk, None)
    with sig_lock:
        cutoff = now_mono - SIG_CACHE_TTL
        for k in [k for k, (_, ts) in sig_cache.items() if ts < cutoff]:
            sig_cache.pop(k, None)
    with live_lock:
        _live_prune()
    if WEBAI_ENABLED:
        try:
            webai_pool.get_pool().trim()
        except Exception:
            pass
    if trim:
        try:
            gc.collect()
            import ctypes
            ctypes.CDLL("libc.so.6").malloc_trim(0)           # give freed memory back to the OS (glibc keeps it otherwise)
        except Exception:
            pass


def _janitor_loop():
    n = 0
    while True:
        time.sleep(JANITOR_SECS)
        n += 1
        try:
            _janitor_once(trim=(n % 5 == 0))
        except Exception as e:
            print(f"[JANITOR] {e}")


threading.Thread(target=_janitor_loop, daemon=True, name="wapi-janitor").start()
_blocks_load()
_cfg_load()
_usage_load()


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=8085, threaded=True)
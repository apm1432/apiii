"""
Unsupported-parameter auto-skip for /api/web/v1 (WebAI-to-API).

Problem: WebAI-to-API validates the request body strictly. A client that sends a field it does not know
(temperature, max_tokens, response_format, reasoning_effort, a message "name", ...) gets
    422 {"detail": [{"type": "extra_forbidden", "loc": ["body", "temperature"], "msg": "Extra inputs are not permitted"}]}
or a text error like "Unsupported parameter: 'x'" and the whole request fails - again and again.

Fix (same idea as webapi_model_fix.py for unknown models):
  1. The request goes out. If upstream answers 400/422 and the error names a field we can drop,
  2. the field is removed from the body and the SAME request is retried right away  -> the client never sees the error.
  3. When the retry succeeds the field is remembered ("learned", saved to a small json file).
  4. Every later request has that field removed BEFORE it is sent -> no failed round trip at all.

Safety:
  * a field is only learned after the retry WITHOUT it succeeded (a wrong guess is never remembered)
  * structural fields are never removed (messages, model, role, content, text, type, stream, file ...)
  * only fields that really exist in the body are touched
  * WEBAPI_PARAM_FIX=0 turns the whole thing off; blocked list is visible with snapshot() / reset() is available
Paths use "*" for list indexes: "temperature", "messages.*.name", "messages.*.content.*.detail".
"""
import json, os, re, threading, time

ENABLED = os.environ.get("WEBAPI_PARAM_FIX", "1") != "0"
_FILE = os.environ.get("WEBAPI_PARAM_FILE", os.path.join(os.environ.get("WEBAI_POOL_DIR", "/tmp/webai-pool"),
                                                       "blocked_params.json"))
_LOCK = threading.Lock()
_BLOCKED = {}            # path -> {"since": ts, "hits": n, "reason": str}
_LOADED = False

# never removed - the request is meaningless without them / the proxy depends on them
_PROTECTED = {"messages", "model", "role", "content", "text", "type", "stream", "file", "file_data", "filename",
              "image_url", "url", "conversation_id", "input", "body", "query", "str", "list", "dict"}

_QUOTED_RE = re.compile(r"[`'\"]([A-Za-z_][A-Za-z0-9_.\-]{0,63})[`'\"]")
_PARAM_ERR_RE = re.compile(
    r"(unsupported|unknown|unrecognized|unexpected|extra inputs|extra fields?|not permitted|not supported|"
    r"not allowed|invalid parameter|additional properties|unsupported parameter|forbidden)", re.I)
_UNQUOTED_RE = re.compile(
    r"(?:unsupported|unknown|unrecognized|unexpected|invalid|extra)\s+(?:request\s+)?(?:parameter|param|field|argument|property|key)s?"
    r"\s*[:=]?\s*[`'\"]?([A-Za-z_][A-Za-z0-9_.\-]{0,63})", re.I)
_BAD_TYPES = {"extra_forbidden", "unexpected_keyword_argument", "value_error.extra", "unsupported", "unknown_parameter"}


# ── persistence ──────────────────────────────────────────────────────────────
def _load():
    global _LOADED
    if _LOADED:
        return
    _LOADED = True
    try:
        with open(_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for k, v in data.items():
                if isinstance(k, str) and isinstance(v, dict):
                    _BLOCKED[k] = v
    except (OSError, ValueError):
        pass


def _save():
    try:
        os.makedirs(os.path.dirname(_FILE), exist_ok=True)
        tmp = _FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_BLOCKED, f, ensure_ascii=False)
        os.replace(tmp, _FILE)
    except OSError:
        pass


def snapshot():
    with _LOCK:
        _load()
        return {k: dict(v) for k, v in _BLOCKED.items()}


def reset(path=None):
    with _LOCK:
        _load()
        if path:
            _BLOCKED.pop(path, None)
        else:
            _BLOCKED.clear()
        _save()


# ── body helpers ─────────────────────────────────────────────────────────────
def _parse(body):
    try:
        j = json.loads(body.decode("utf-8") if isinstance(body, (bytes, bytearray)) else body)
        return j if isinstance(j, dict) else None
    except Exception:
        return None


def _dump(j):
    return json.dumps(j, ensure_ascii=False).encode("utf-8")


def _remove(node, segs):
    """Delete the path `segs` below `node`. '*' walks every list item. Returns how many values were removed."""
    if not segs:
        return 0
    head, rest = segs[0], segs[1:]
    if head == "*":
        if not isinstance(node, list):
            return 0
        return sum(_remove(item, rest) for item in node)
    if not isinstance(node, dict) or head not in node:
        return 0
    if not rest:
        del node[head]
        return 1
    return _remove(node[head], rest)


def _protected(path):
    last = path.split(".")[-1]
    return last == "*" or last in _PROTECTED or not path


def remove_paths(body, paths):
    """-> (new_body, [paths that really existed and were removed])"""
    j = _parse(body)
    if j is None:
        return body, []
    done = []
    for p in paths:
        if _protected(p):
            continue
        if _remove(j, p.split(".")) > 0:
            done.append(p)
    return (_dump(j), done) if done else (body, [])


def strip_known(body):
    """Before sending: remove every field upstream is already known to reject. -> (body, [removed paths])"""
    if not ENABLED:
        return body, []
    with _LOCK:
        _load()
        paths = list(_BLOCKED)
    if not paths:
        return body, []
    return remove_paths(body, paths)


# ── reading the upstream error ───────────────────────────────────────────────
def _loc_to_path(loc):
    """['body','messages',0,'name'] -> 'messages.*.name'   (None when it is not a plain field path)"""
    if not isinstance(loc, (list, tuple)):
        return None
    parts = list(loc)
    if parts and parts[0] in ("body", "json"):
        parts = parts[1:]
    out = []
    for p in parts:
        if isinstance(p, int):
            out.append("*")
        elif isinstance(p, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_\-]*", p):
            out.append(p)
        else:
            return None
    return ".".join(out) if out else None


def _walk_detail(detail, found):
    if isinstance(detail, list):
        for d in detail:
            if isinstance(d, dict):
                typ = str(d.get("type") or "")
                msg = str(d.get("msg") or d.get("message") or "")
                if typ == "missing":
                    continue                                   # a REQUIRED field is missing - removing makes it worse
                p = _loc_to_path(d.get("loc"))
                if p:
                    found.append((p, typ or msg[:60]))
            elif isinstance(d, str):
                _walk_detail(d, found)
    elif isinstance(detail, dict):
        if isinstance(detail.get("param"), str) and detail["param"]:
            found.append((detail["param"], str(detail.get("code") or "param")))
        _walk_detail(detail.get("detail") or detail.get("errors") or detail.get("error") or detail.get("message"), found)
        if "loc" in detail:
            _walk_detail([detail], found)
    elif isinstance(detail, str) and _PARAM_ERR_RE.search(detail):
        names = _UNQUOTED_RE.findall(detail) or _QUOTED_RE.findall(detail)
        for name in names:
            found.append((name, "text"))


def candidates(status, text, body):
    """Which fields does this 400/422 error complain about, restricted to fields that exist in `body`?
    Returns a list of paths (may be empty - then the error is not about a removable parameter)."""
    if not ENABLED or status not in (400, 422):
        return []
    found = []
    try:
        j = json.loads(text)
    except Exception:
        j = None
    if j is not None:
        _walk_detail(j, found)
    if not found and isinstance(text, str):
        _walk_detail(text, found)
    j_body = _parse(body)
    if j_body is None:
        return []
    out = []
    for p, why in found:
        if p in out or _protected(p):
            continue
        if "." not in p and p not in j_body:
            # text errors may name a nested field only by its last name: look for it in messages
            found_nested = _find_nested(j_body, p)
            if found_nested:
                for q in found_nested:
                    if q not in out:
                        out.append(q)
            continue
        if _remove(json.loads(json.dumps(j_body)), p.split(".")) > 0:
            out.append(p)
    return out


def _find_nested(j, name):
    """name -> 'messages.*.name' style paths where `name` occurs as a key one or two levels inside messages."""
    hits = []
    msgs = j.get("messages")
    if isinstance(msgs, list):
        if any(isinstance(m, dict) and name in m for m in msgs):
            hits.append(f"messages.*.{name}")
        for m in msgs:
            c = m.get("content") if isinstance(m, dict) else None
            if isinstance(c, list) and any(isinstance(x, dict) and name in x for x in c):
                hits.append(f"messages.*.content.*.{name}")
                break
    return [h for h in hits if not _protected(h)]


# ── learning ─────────────────────────────────────────────────────────────────
def learn(paths, reason=""):
    """Call ONLY after the request without these fields succeeded."""
    if not ENABLED or not paths:
        return
    with _LOCK:
        _load()
        for p in paths:
            e = _BLOCKED.setdefault(p, {"since": int(time.time()), "hits": 0, "reason": reason[:200]})
            e["hits"] = int(e.get("hits", 0)) + 1
        _save()
    print(f"[WEBAPI PARAM FIX] learned: upstream does not accept {paths} -> will be skipped automatically", flush=True)


def note_skipped(paths):
    """Count how often a learned field was skipped up front (for the dashboard / debugging)."""
    if not paths:
        return
    with _LOCK:
        for p in paths:
            if p in _BLOCKED:
                _BLOCKED[p]["skipped"] = int(_BLOCKED[p].get("skipped", 0)) + 1


def unlearn(paths):
    """A field we skipped was NOT the problem / upstream now accepts it again."""
    with _LOCK:
        _load()
        for p in paths:
            _BLOCKED.pop(p, None)
        _save()


# ── keep the MEANING of a removed parameter ──────────────────────────────────
JSON_MARK = "[OUTPUT FORMAT]"


def emulate(orig_body, new_body):
    """`response_format` (json_object / json_schema) is removed because WebAI rejects it, but the caller relies on it
    to get pure JSON back. Without it Gemini answers in prose and the caller's parser breaks (before the fix the 400 made
    the caller add this instruction itself). So when response_format was dropped, ask for JSON in the prompt instead
    (same wording the caller uses). Applied once only."""
    o, n = _parse(orig_body), _parse(new_body)
    if o is None or n is None or "response_format" in n:
        return new_body
    rf = o.get("response_format")
    if not isinstance(rf, dict) or rf.get("type") not in ("json_object", "json_schema"):
        return new_body
    msgs = n.get("messages")
    if not isinstance(msgs, list):
        return new_body
    txt = f"\n\n{JSON_MARK}: Reply with ONLY the valid JSON, nothing before or after it, no markdown code fence."
    if rf.get("type") == "json_schema":
        try:
            sch = (rf.get("json_schema") or {}).get("schema")
            if sch:
                txt = f"\n\n{JSON_MARK}: Reply with ONLY valid JSON that matches this JSON schema, nothing before or after it, " \
                      f"no markdown code fence.\nSchema: {json.dumps(sch, ensure_ascii=False)}"
        except Exception:
            pass
    for m in reversed(msgs):
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, str):
            if JSON_MARK in c:
                return new_body
            m["content"] = c + txt
        elif isinstance(c, list):
            if any(isinstance(x, dict) and JSON_MARK in str(x.get("text", "")) for x in c):
                return new_body
            m["content"] = c + [{"type": "text", "text": txt.strip()}]
        else:
            return new_body
        return _dump(n)
    return new_body

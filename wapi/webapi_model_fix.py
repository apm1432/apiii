"""
Model auto-fallback for /api/web/v1 (WebAI-to-API).

Problem: WebAI-to-API only knows the models registered in its own config (often just `gemini-auto`). A client that
sends any other name (gemini-flash-lite, gpt-4o, ...) gets
    400 {"detail": "Unknown model name: 'x'. Available registered models: gemini-auto"}
and the whole request fails.

Fix: the router never lets that error reach the client. When the model is unknown we
  1. read the list of available models from the upstream error text (or from its /v1/models),
  2. rewrite the request body with a working model,
  3. retry the same request.
The list is remembered per WebAI account, so the next request with an unknown name is rewritten up front
(no wasted round trip).
"""
import json, re, time, threading

_LOCK = threading.Lock()
_AVAILABLE = {}          # account id -> (timestamp, [model ids])
_TTL = 300.0             # seconds an account's model list is trusted

_UNKNOWN_RE = re.compile(r"unknown model", re.I)
_AVAIL_RE = re.compile(r"available[^:]*models?\s*:\s*(.+)", re.I | re.S)

# Preference when several models are available (first match wins, else the first in the list).
_PREFER = ("gemini-auto", "auto", "flash", "lite", "pro")


def is_unknown_model_error(status, body_text):
    return status in (400, 404, 422) and bool(_UNKNOWN_RE.search(body_text or ""))


def parse_available(body_text):
    """'Unknown model name: 'x'. Available registered models: a, b' -> ['a', 'b']"""
    text = body_text or ""
    try:                                     # {"detail": "..."} / {"error": {"message": "..."}}
        j = json.loads(text)
        if isinstance(j, dict):
            d = j.get("detail") or j.get("error") or j.get("message")
            if isinstance(d, dict):
                d = d.get("message")
            if isinstance(d, str):
                text = d
    except Exception:
        pass
    m = _AVAIL_RE.search(text)
    if not m:
        return []
    tail = m.group(1).strip().strip('"}').strip()
    ids = [s.strip().strip("'\"`[]. ") for s in re.split(r"[,\n]", tail)]
    return [i for i in ids if i and " " not in i]


def pick(available, exclude=()):
    cands = [m for m in available if m not in exclude]
    if not cands:
        return None
    for p in _PREFER:
        for m in cands:
            if p in m.lower():
                return m
    return cands[0]


def remember(account_id, models):
    if models:
        with _LOCK:
            _AVAILABLE[account_id] = (time.monotonic(), list(models))


def known(account_id):
    with _LOCK:
        t, ms = _AVAILABLE.get(account_id, (0.0, []))
    return ms if ms and time.monotonic() - t < _TTL else []


def fetch_models(requests_mod, base_url, headers=None):
    """GET /v1/models of one WebAI instance -> [ids]  (used when the error text has no list)."""
    try:
        r = requests_mod.get(base_url + "/v1/models", headers=headers or {}, timeout=8)
        if r.status_code == 200:
            return [m.get("id") for m in (r.json().get("data") or []) if isinstance(m, dict) and m.get("id")]
    except Exception:
        pass
    return []


def get_model(body):
    try:
        return json.loads(body.decode("utf-8")).get("model")
    except Exception:
        return None


def set_model(body, model):
    """Return the request body with `model` replaced (unchanged on any problem)."""
    try:
        j = json.loads(body.decode("utf-8"))
        j["model"] = model
        return json.dumps(j, ensure_ascii=False).encode("utf-8")
    except Exception:
        return body


def preflight(account_id, body):
    """Before sending: if we already know this account's models and the requested one is not among them,
    swap it. Returns (body, requested, used) - requested/used are None when nothing changed."""
    ms = known(account_id)
    req = get_model(body)
    if ms and req and req not in ms:
        alt = pick(ms)
        if alt:
            return set_model(body, alt), req, alt
    return body, None, None

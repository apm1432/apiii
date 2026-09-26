import os, json, time, threading, datetime

from collections import deque
from flask import Flask, request, jsonify, Response, render_template_string, g
from functools import wraps
import requests
import base64, copy, hashlib, re, uuid
import concurrent.futures

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
    MODELS = [{"name": "gemini-2.0-flash-lite", "rpm": 30, "rpd": 1500}]

# Concurrency safety margin: reserve this many RPM slots as a buffer so that
# several requests admitted in the same instant (before their timestamps are
# recorded) can never push the key+model pair over its real RPM limit.
RPM_SAFETY_MARGIN = int(os.environ.get("RPM_SAFETY_MARGIN", "2"))

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))

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
STICKY_MAX_WAIT = float(os.environ.get("STICKY_MAX_WAIT", "15"))  # short wait for RPM on the pinned model; after that we switch (signatures are re-injected)
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
    return f"ip:{remote_addr or 'unknown'}"

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

def remember_sticky_slot(client_id: str, key: str, model_name: str):
    with state_lock:
        rate_strikes.pop((key, model_name), None)
        conversation_sticky[client_id] = (key, model_name, time.monotonic())


# ─── thought_signature cache + injection (enables key/model switching) ───────
# Clients like Hermes drop `extra_content.google.thought_signature` from the
# assistant tool_calls they echo back. We capture it from every Google
# response, cache it by tool_call id, and put it back into the history
# before forwarding -- so the next step may run on ANY key/model.
SIG_CACHE_TTL = int(os.environ.get("SIG_CACHE_TTL", str(6 * 3600)))
# Dummy signature Google documents for history that has none (Gemini 3 only).
# Set env SIG_FALLBACK="" to disable.
SIG_FALLBACK = os.environ.get("SIG_FALLBACK", "skip_thought_signature_validator")
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
        if len(sig_cache) > 5000:
            cutoff = now - SIG_CACHE_TTL
            for k in [k for k, (_, ts) in sig_cache.items() if ts < cutoff]:
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

def normalize_to_chat_completions(data: dict) -> dict:
    """Accepts either a normal Chat Completions body OR a Responses-API body
    and returns something Gemini's /v1beta/openai/chat/completions accepts."""
    data = dict(data)

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

    return {k: v for k, v in data.items() if k in CHAT_COMPLETIONS_ALLOWED_KEYS}

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
    if content_text:
        items.append({
            "type": "message",
            "id": f"msg_{uuid.uuid4().hex[:24]}",
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "output_text", "text": content_text, "annotations": []}],
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

def _finalize_success_response(resp, is_responses_api: bool, actual_model: str, client_stream_requested: bool):
    """Build the Response for a 200 from Gemini. Plain /v1/chat/completions
    calls are relayed unchanged (existing behaviour). /v1/responses calls
    get converted into a real Responses-API object (see above)."""
    excluded = ['content-encoding', 'content-length', 'transfer-encoding', 'connection']
    if not is_responses_api:
        out_headers = [(n, v) for n, v in resp.raw.headers.items() if n.lower() not in excluded]
        return Response(resp.content, resp.status_code, out_headers)
    try:
        gemini_json = resp.json()
    except Exception:
        out_headers = [(n, v) for n, v in resp.raw.headers.items() if n.lower() not in excluded]
        return Response(resp.content, resp.status_code, out_headers)
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
            return requests.post(url, json=prepare_payload(data, model_name, force_dummy=True),
                                 headers=headers, stream=True,timeout=600)
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
        # Also clear daily penalties since a new day started
        key_daily_penalty.clear()
        _last_rpd_reset = today

def _get_key(key, model_name, d, default_factory):
    k = (key, model_name)
    if k not in d:
        d[k] = default_factory()
    return d[k]

def _prune_rpm(key, model_name):
    window = _get_key(key, model_name, rpm_window, deque)
    cutoff = time.monotonic() - 60.0
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
    effective_limit = max(1, rpm_limit - RPM_SAFETY_MARGIN)
    return len(window) < effective_limit

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

def _apply_rpm_cooldown(key, model_name, seconds=62):
    """Apply 62s cooldown to this key+model pair after 429."""
    rpm_cooldown[(key, model_name)] = time.monotonic() + seconds
    print(f"[COOLDOWN] key=…{key[-6:]} model={model_name} blocked for {seconds}s")

def _apply_daily_penalty(key, model_name):
    """Block this (key, model) pair until midnight IST after its RPD limit
    is hit. Only this model is blocked on this key -- every other model on
    the same key keeps working normally."""
    now_ist = datetime.datetime.now(IST)
    next_midnight = (now_ist + datetime.timedelta(days=1)).replace(
        hour=0, minute=0, second=5, microsecond=0)
    unlock_ts = next_midnight.astimezone(datetime.timezone.utc).timestamp()
    key_daily_penalty[(key, model_name)] = unlock_ts
    mins = round((unlock_ts - time.time()) / 60)
    print(f"[DAILY LIMIT] key=…{key[-6:]} model={model_name} penalized until midnight IST (~{mins} mins) — other models on this key are unaffected")

# ─── Global Metrics ───────────────────────────────────────────────────────────
metrics = {
    "total_incoming_requests": 0,
    "successful_api_calls": 0,
    "rate_limit_hits": 0,
    "rpm_cooldowns_applied": 0,
    "daily_limits_hit": 0,
    "failed_requests": 0,
    "usage_by_key": {}
}


# ─── Smarter 429 classification ──────────────────────────────────────────────
# Google's "You exceeded your current quota" text is used for BOTH per-minute
# and per-day limits. The old code treated every message containing "quota" as
# a DAILY limit and locked the model until midnight even after a 1-minute hit.
# We now read the quotaId (…PerDay… / …PerMinute…) and the retryDelay.
rate_strikes: dict = {}   # (key, model) -> consecutive ambiguous 429 count

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

    m = re.search(r'retrydelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s', t)
    retry = float(m.group(1)) + 2 if m else None

    # ── Per-minute / RPM detection ────────────────────────────────────────────
    # Explicit label -> definitely RPM, short cooldown, reset strikes.
    if "perminute" in t or "per minute" in t or "per_minute" in t:
        rate_strikes.pop(k, None)
        _apply_rpm_cooldown(key, model_name, seconds=int(retry or 62))
        return "rpm"

    is_daily_label = (
        "perday" in t or "per day" in t or "per_day" in t or "daily" in t
        or "freetier" in t or "free_tier" in t or "free tier" in t
        or "generatecontentfreetier" in t
    )

    # A short retryDelay is trusted over the label, whatever it says: it
    # clears fast, so it's treated as an RPM-style cooldown, not a daily one.
    if retry is not None and retry <= 120:
        _apply_rpm_cooldown(key, model_name, seconds=int(retry))
        return _escalate_or_stay_rpm(k, key, model_name)

    # No short retryDelay to trust: a long one (>300s), or a daily-looking
    # label with no retryDelay at all, really does mean "come back tomorrow".
    if (retry and retry > 300) or (is_daily_label and retry is None):
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
    if n >= 5:
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

    GENERIC_ALIASES = {"gemini-pro", "auto", "default", "round-robin",
                        "gemini-working-model", "openrouter/auto", ""}
    is_pool_mode = requested_model.lower() in GENERIC_ALIASES

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

        sorted_models = sorted(active_models, key=_model_sort_key)
        K, M = len(API_KEYS), len(sorted_models)
        if M == 0 or K == 0:
            return []

        # Flat round-robin across all K*M combinations.
        for i in range(K * M):
            idx = (current_combo_idx + i) % (K * M)
            m_i = idx // K
            k_i = idx % K
            combos.append((k_i, m_i, API_KEYS[k_i], sorted_models[m_i]))
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
            current_combo_idx = (current_combo_idx + 1) % (len(API_KEYS) * max(1, len(MODELS)))
                
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
request_logs = deque(maxlen=50)

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

    # Read optional target_key from query params
    target_key_preview = request.args.get("key")

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
            for m_idx, model in enumerate(MODELS):
                model_name = model["name"]
                question   = _question_for_model_idx(m_idx)
                tasks.append(executor.submit(_test_single_combo, key, model_name, question))
                time.sleep(0.12)  # stagger submissions so connections open gradually

    results = [t.result() for t in tasks]

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

@app.before_request
def strict_password_and_log():
    if request.method == 'OPTIONS':
        return
    if request.path in ['/ping', '/healthz', '/logs', '/dashboard_data', '/status', '/test_keys']:
        return
    g._log_start = time.monotonic()  # for response_ms in after_request, not stored in log_entry itself
    expected_pass = os.environ.get("PASSWORD", "")
    auth_header   = request.headers.get("Authorization", "")
    is_correct    = (auth_header == f"Bearer {expected_pass}")

    msg = ""
    if request.is_json:
        try:
            body = request.get_json(silent=True) or {}
            msgs = body.get("messages", [])
            if msgs:
                msg = msgs[-1].get("content", "")
        except Exception:
            pass

    if isinstance(msg, str) and len(msg) > 1:
        formatted_msg = f"{msg[0]}...{msg[-1]}"
    else:
        formatted_msg = str(msg) if msg else ""

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
        if g.log_entry.get("response_ms") is None and hasattr(g, "_log_start"):
            g.log_entry["response_ms"] = round((time.monotonic() - g._log_start) * 1000)
    return response

# ─── Dashboard ────────────────────────────────────────────────────────────────
@app.route('/dashboard_data', methods=['GET'])
@requires_browser_auth
def api_dashboard_data():
    now = time.time()
    now_mono = time.monotonic()
    with state_lock:
        _maybe_reset_rpd()
        # key_daily_penalty is now keyed by (key, model) — display it the
        # same way rpm_cooldowns is displayed, so the dashboard shows which
        # specific model on which key is daily-exhausted, not the whole key.
        penalized = {
            f"{k[:5]}...{k[-5:]}|{m}": round((ts - now)/60, 1)
            for (k, m), ts in key_daily_penalty.items() if ts > now
        }
        cooldowns = {
            f"{k[:5]}...{k[-5:]}|{m}": round(ts - now_mono, 1)
            for (k, m), ts in rpm_cooldown.items() if ts > now_mono
        }
        key_list = [f"...{k[-4:]}" for k in API_KEYS]
    return jsonify({
        "metrics": metrics,
        "active_keys": len(API_KEYS),
        "key_list": key_list,
        "penalized_keys": penalized,
        "rpm_cooldowns": cooldowns,
        "models": get_active_models(),
        "logs": list(request_logs)
    })

@app.route('/logs', methods=['GET'])
@requires_browser_auth
def view_logs():
    # Same dashboard HTML as original — kept intact
    html = """<!DOCTYPE html><html><head><title>WAPI Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body{font-family:'Segoe UI',sans-serif;margin:0;padding:20px;background:#121212;color:#e0e0e0}
.container{max-width:1400px;margin:0 auto}
h1{color:#fff;text-align:center;margin-bottom:20px;display:flex;justify-content:center;align-items:center;gap:15px}
.status-panel{display:flex;flex-wrap:wrap;gap:15px;margin-bottom:25px}
.card{background:#1e1e1e;border-radius:8px;padding:15px;flex:1;min-width:200px;border:1px solid #333;box-shadow:0 4px 10px rgba(0,0,0,.3)}
.card h3{margin:0 0 10px;font-size:.9em;color:#888;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #333;padding-bottom:5px}
.card .val{font-size:1.8em;font-weight:bold;color:#fff;margin-bottom:5px}
.card .sub{font-size:.8em;color:#a1a1aa}
.table-wrapper{background:#1e1e1e;border-radius:8px;box-shadow:0 4px 15px rgba(0,0,0,.5);overflow-x:auto;border:1px solid #333;margin-bottom:30px}
table{width:100%;border-collapse:collapse;min-width:900px}
th,td{padding:12px 15px;text-align:left;border-bottom:1px solid #333}
th{background:#2c2c2c;color:#fff;font-weight:600;font-size:.95em;text-transform:uppercase;letter-spacing:.5px}
tr:hover{background:#252525}
.msg{max-width:400px;white-space:pre-wrap;word-break:break-word;font-size:.9em;color:#ce9178;background:#18181b;padding:8px;border-radius:4px;font-family:monospace}
.pwd-wrong{font-family:monospace;color:#fca5a5;background:#451a1a;padding:3px 6px;border-radius:3px;font-size:.9em}
.pwd-correct{font-family:monospace;color:#4ade80;font-style:italic;font-size:.9em;font-weight:bold}
.ip{font-family:monospace;color:#93c5fd}
.badge{padding:4px 8px;border-radius:4px;font-size:.85em;font-weight:bold}
.bg-green{background:rgba(74,222,128,.2);color:#4ade80}
.bg-red{background:rgba(248,113,113,.2);color:#f87171}
.flex-col{display:flex;flex-direction:column;gap:5px}
.tag{background:#333;padding:2px 6px;border-radius:4px;font-size:.8em;color:#ccc;border:1px solid #444}
.btn{background:#3b82f6;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:.9em;transition:.2s}
.btn:hover{background:#2563eb}
</style></head><body><div class="container">
<h1>🚀 WAPI Live Dashboard
<div style="display:flex;gap:8px;align-items:center;">
<button class="btn" onclick="fetchData()" id="refresh-btn">🔄 Refresh</button>
<button class="btn" onclick="testAllKeys()" id="test-btn" style="background:#7c3aed;">🧪 Test All Keys</button>
</div></h1>
<div id="error-msg" style="color:#fca5a5;background:#451a1a;padding:10px;border-radius:5px;text-align:center;display:none;margin-bottom:15px;"></div>
<div id="test-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.85);z-index:9999;overflow-y:auto;padding:20px;box-sizing:border-box;">
<div style="max-width:960px;margin:0 auto;background:#1a1a2e;border-radius:12px;border:1px solid #4c1d95;padding:24px;">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
<h2 style="margin:0;color:#a78bfa;">🧪 Key & Model Test — "What is your name?"</h2>
<button onclick="document.getElementById('test-modal').style.display='none'" style="background:#374151;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:1em;">✕ Close</button>
</div>
<div id="test-summary" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;"></div>
<div style="overflow-x:auto;"><table id="test-table" style="width:100%;border-collapse:collapse;min-width:600px;">
<thead><tr style="background:#2d1b69;">
<th style="padding:10px;text-align:left;color:#c4b5fd;border-bottom:1px solid #4c1d95;">Key</th>
<th style="padding:10px;text-align:left;color:#c4b5fd;border-bottom:1px solid #4c1d95;">Model</th>
<th style="padding:10px;text-align:left;color:#c4b5fd;border-bottom:1px solid #4c1d95;">Question Asked</th>
<th style="padding:10px;text-align:center;color:#c4b5fd;border-bottom:1px solid #4c1d95;">Status</th>
<th style="padding:10px;text-align:left;color:#c4b5fd;border-bottom:1px solid #4c1d95;">Response</th>
<th style="padding:10px;text-align:right;color:#c4b5fd;border-bottom:1px solid #4c1d95;">ms</th>
</tr></thead>
<tbody id="test-tbody"><tr><td colspan="6" style="text-align:center;padding:30px;color:#6b7280;">Click "Test All Keys" to run tests...</td></tr></tbody>
</table></div>
</div>
</div>
<div class="status-panel" id="status-panel"><div class="card" style="text-align:center;padding:30px;">Loading...</div></div>
<h2 style="display:flex;justify-content:space-between;align-items:center;font-size:1.2em;color:#ccc;border-bottom:1px solid #333;padding-bottom:10px;">
🔐 Secure Access Logs (last 50)
</h2>
<div class="table-wrapper"><table><thead><tr>
<th>Time</th><th>IP Address</th><th>Attempted Password</th><th>Status</th><th>Model</th><th>Response Time</th><th>Message / Prompt</th><th>Error Detail</th>
</tr></thead><tbody id="logs-body"><tr><td colspan="8" style="text-align:center;color:#666;padding:30px;">Loading logs...</td></tr></tbody></table></div>
</div>
<script>
let isSelecting=false;
document.addEventListener('selectionchange',()=>{const s=window.getSelection();isSelecting=s.toString().length>0;});

async function testAllKeys(targetKey = ''){
  const btn=document.getElementById('test-btn');
  if(!window._wapiPwd){
    const pwd=prompt('Enter your WAPI password to run key tests:');
    if(!pwd){return;}
    window._wapiPwd=pwd;
  }
  btn.innerText='⏳ Testing...'; btn.disabled=true;
  document.getElementById('test-modal').style.display='block';
  const msg = targetKey ? `⏳ Running tests on models for key ${targetKey}...` : '⏳ Running tests on all keys × models (Parallel)...';
  document.getElementById('test-tbody').innerHTML=`<tr><td colspan="6" style="text-align:center;padding:30px;color:#a78bfa;">${msg}</td></tr>`;
  document.getElementById('test-summary').innerHTML='';
  try{
    const url = targetKey ? '/router/test_keys?key='+encodeURIComponent(targetKey) : '/router/test_keys';
    const r=await fetch(url,{headers:{Authorization:'Bearer '+window._wapiPwd}});
    if(r.status===401){
      window._wapiPwd=null;
      throw new Error('Wrong password (401). Click Test again to re-enter.');
    }
    if(!r.ok){throw new Error('HTTP '+r.status);}
    renderTestResults(await r.json());
  }catch(e){
    document.getElementById('test-tbody').innerHTML=`<tr><td colspan="6" style="text-align:center;padding:20px;color:#f87171;">❌ Error: ${esc(e.message)}</td></tr>`;
  }
  btn.innerText='🧪 Test All Keys'; btn.disabled=false;
}

function renderTestResults(data){
  const ok=data.ok||0, total=data.total||0, failed=data.failed||0;
  document.getElementById('test-summary').innerHTML=`
    <div style="background:rgba(74,222,128,.15);border:1px solid #4ade80;border-radius:8px;padding:10px 18px;color:#4ade80;font-size:1.1em;font-weight:bold;">✅ Working: ${ok}</div>
    <div style="background:rgba(248,113,113,.15);border:1px solid #f87171;border-radius:8px;padding:10px 18px;color:#f87171;font-size:1.1em;font-weight:bold;">❌ Failed: ${failed}</div>
    <div style="background:rgba(156,163,175,.1);border:1px solid #4b5563;border-radius:8px;padding:10px 18px;color:#9ca3af;font-size:1.1em;">📊 Total: ${total}</div>`;
  let html='';
  (data.results||[]).forEach(r=>{
    const bg=r.ok?'rgba(74,222,128,.05)':'rgba(248,113,113,.05)';
    const statusColor=r.ok?'#4ade80':(r.status===429?'#fbbf24':'#f87171');
    const statusLabel=r.ok?'✅ 200':( r.status===429?'⚠️ 429':('❌ '+r.status));
    const responseText=r.ok?esc(r.response):('<span style="color:#f87171;font-size:.85em;">'+esc(r.response)+'</span>');
    html+=`<tr style="background:${bg};border-bottom:1px solid #2d2d2d;">
      <td style="padding:10px;font-family:monospace;color:#93c5fd;font-size:.85em;">${esc(r.key)}</td>
      <td style="padding:10px;color:#c4b5fd;font-size:.85em;">${esc(r.model)}</td>
      <td style="padding:10px;color:#fbbf24;font-size:.8em;font-style:italic;">${esc(r.question||'')}</td>
      <td style="padding:10px;text-align:center;font-weight:bold;color:${statusColor};">${statusLabel}</td>
      <td style="padding:10px;font-size:.85em;max-width:280px;word-break:break-word;">${responseText}</td>
      <td style="padding:10px;text-align:right;color:#6b7280;font-size:.8em;">${r.ms}ms</td>
    </tr>`;
  });
  document.getElementById('test-tbody').innerHTML=html||'<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:20px;">No results</td></tr>';
}

async function fetchData(){
  const btn=document.getElementById('refresh-btn');btn.innerText='⏳...';
  try{
    const r=await fetch('/router/dashboard_data',{credentials:'same-origin'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const data=await r.json();
    document.getElementById('error-msg').style.display='none';
    if(!isSelecting)updateUI(data);
  }catch(e){
    const el=document.getElementById('error-msg');el.style.display='block';el.innerText='⚠️ Could not load data. '+e.message;
  }
  btn.innerText='🔄 Refresh';
}
function updateUI(data){
  const m=data.metrics;
  // Build model -> list of penalized key last-5-digits
  const penData=data.penalized_keys||{};
  const totalKeys=data.active_keys||0;
  const allModels=(data.models||[]).map(m=>m.name);
  const modelPenMap={};
  for(const[kv] of Object.entries(penData)){
    const pipe=kv.lastIndexOf('|');
    if(pipe<0)continue;
    const keyPart=kv.slice(0,pipe);
    const modelPart=kv.slice(pipe+1);
    const last5=keyPart.slice(-5);
    if(!modelPenMap[modelPart])modelPenMap[modelPart]=new Set();
    modelPenMap[modelPart].add(last5);
  }
  let penHtml='';
  for(const modelName of allModels){
    const penKeys=modelPenMap[modelName]?[...modelPenMap[modelName]]:[];
    const penCount=penKeys.length;
    const color=penCount>0?'#f87171':'#4ade80';
    const bg=penCount>0?'rgba(248,113,113,.15)':'rgba(74,222,128,.1)';
    const border=penCount>0?'#f87171':'#4ade80';
    const clickable=penCount>0?'cursor:pointer;':'';
    const keyList=penKeys.map(k=>'...'+k).join('\n');
    const onclick=penCount>0?`onclick="alert('Penalized keys for ${esc(modelName)}:\n${keyList}')"`:'';
    penHtml+=`<span class="tag" style="background:${bg};color:${color};border-color:${border};${clickable}" ${onclick}>${esc(modelName)} — ${penCount}/${totalKeys}</span>`;
  }
  if(!penHtml)penHtml='<span style="color:#4ade80;">All Clear ✅</span>';
  let cdHtml='';
  if(Object.keys(data.rpm_cooldowns||{}).length>0){
    for(const[k,v]of Object.entries(data.rpm_cooldowns))
      cdHtml+=`<span class="tag" style="background:rgba(251,191,36,.2);color:#fbbf24;border-color:#fbbf24;">${k} (${v}s)</span>`;
  }else cdHtml='<span style="color:#4ade80;">None</span>';
  let keysHtml = '';
  if (data.key_list) {
    data.key_list.forEach(k => {
        keysHtml += `<span class="tag" style="background:#2d1b69;border:1px solid #4c1d95;cursor:pointer;" onclick="testAllKeys('${k}')" title="Test all models on this key">${k} 🧪</span>`;
    });
  }
  document.getElementById('status-panel').innerHTML=`
    <div class="card"><h3>Active Keys</h3><div class="val" style="color:#60a5fa;">${data.active_keys}</div>
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:10px;">${keysHtml}</div>
      <div class="sub flex-col" style="margin-top:8px;">Daily penalized:<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:5px;">${penHtml}</div></div>
      <div class="sub flex-col" style="margin-top:8px;">RPM cooldowns:<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:5px;">${cdHtml}</div></div>
    </div>
    <div class="card"><h3>API Traffic</h3><div class="val">${m.total_incoming_requests}</div><div class="sub">Total Requests</div></div>
    <div class="card"><h3>Google API</h3><div class="val" style="color:#4ade80;">${m.successful_api_calls}</div>
      <div class="sub">RPM Hits: <span style="color:#fbbf24">${m.rpm_cooldowns_applied||0}</span> | Daily Hits: <span style="color:#f87171">${m.daily_limits_hit||0}</span></div></div>
    <div class="card"><h3>Results</h3><div class="val" style="color:#fbbf24;">${m.rate_limit_hits}</div>
      <div class="sub">Failed: <span style="color:#f87171">${m.failed_requests}</span></div></div>`;
  const tbody=document.getElementById('logs-body');
  if(!data.logs||data.logs.length===0){tbody.innerHTML='<tr><td colspan="8" style="text-align:center;color:#666;padding:30px;">No logs yet.</td></tr>';return;}
  let html='';
  data.logs.forEach((log,idx)=>{
    const pwdClass=log.is_correct?'pwd-correct':'pwd-wrong';
    const pwdText=log.is_correct?'🛡️ '+log.password_used:(log.password_used||'NONE');
    const badgeClass=log.is_correct?'bg-green':'bg-red';
    const modelText=log.model?esc(log.model):'—';
    const msText=(log.response_ms!==null&&log.response_ms!==undefined)?log.response_ms+'ms':'—';
    const errText=log.error_detail?esc(log.error_detail):'—';
    html+=`<tr>
      <td style="white-space:nowrap;color:#888;font-size:.9em;">${log.time||''}</td>
      <td class="ip">${log.ip||''}</td>
      <td><span class="${pwdClass}">${esc(pwdText)}</span></td>
      <td><span class="badge ${badgeClass}">${esc(log.status||'')}</span></td>
      <td style="color:#c4b5fd;font-size:.85em;">${modelText}</td>
      <td style="color:#6b7280;font-size:.85em;white-space:nowrap;">${msText}</td>
      <td><div class="msg">${esc(log.message||'No message')}</div></td>
      <td>${log.error_detail?`<div class="msg" style="color:#f87171;max-width:280px;">${errText}</div>`:'<span style="color:#4ade80;">—</span>'}</td>
    </tr>`;
  });
  tbody.innerHTML=html;
}
function esc(s){return(s||'').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
fetchData();setInterval(fetchData,5000);
</script></body></html>"""
    return render_template_string(html)

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
    # Capture a conversation id BEFORE popping these -- session_id/user are
    # the clearest hints a client can give us; we fall back to the caller's
    # IP otherwise (see _client_id_from_request).
    conv_hint = data.get('session_id') or data.get('user')
    if conv_hint:
        data['_conv_hint'] = conv_hint
    data.pop('session_id', None)
    data.pop('user', None)
    data = normalize_to_chat_completions(data)  # <-- strips Responses-API/unknown fields that caused the 400s
    is_responses_api = request.path.startswith('/v1/responses')
    client_stream_requested = bool(data.get("stream"))
    if is_responses_api:
        data["stream"] = False  # always get one complete JSON back from Gemini; we rebuild the Responses stream ourselves
    requested_model = data.get("model", "")
    if "/" in requested_model:
        requested_model = requested_model.split("/")[-1]
    messages = data.get("messages", []) or []
    remote_addr = request.headers.get("X-Real-IP") or \
                  (request.headers.get("X-Forwarded-For", "").split(",")[0].strip()) or \
                  request.remote_addr
    client_id = _client_id_from_request(data, remote_addr)
    data.pop('_conv_hint', None)
    is_continuation = _is_tool_continuation(messages)

    last_resp = None
    attempt_errors = []      # short "{status} {model} (…key): reason" strings for
                              # every failed attempt this request made, so that if
                              # the request ultimately fails, the dashboard log can
                              # show WHY (not just a bare status code) -- see
                              # g.log_entry["error_detail"] set right before we
                              # return to the client below.
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

    if is_continuation:
        # PREFER the (key, model) that produced the tool call (its signature
        # is guaranteed valid), but never fail because of it: if it is
        # rate-limited / exhausted / erroring we fall through to normal
        # routing, and prepare_payload() re-injects the cached signature.
        outcome, key, model = acquire_sticky_slot_wait(client_id)
        if outcome == "ok":
            actual_model = model["name"]
            print(f"[STICKY] {client_id} → preferring key=…{key[-6:]} model={actual_model}")
            tried.add((key, actual_model))
            data["model"] = actual_model
            headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
            url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
            try:
                resp = requests.post(url, json=prepare_payload(data, actual_model), headers=headers, stream=True,timeout=600)
                resp = _heal_signature(resp, url, headers, data, actual_model)
                if resp.status_code == 200:
                    remember_sticky_slot(client_id, key, actual_model)
                    capture_signatures(resp.content)
                    if hasattr(g, "log_entry"):
                        g.log_entry["status"] = f"200 Success ({actual_model})"
                        g.log_entry["model"] = actual_model
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

    # How many total loop iterations (attempts + wait-cycles) to allow.
    # We want up to 3 full round-robin passes over the ENTIRE key×model pool
    # (first-to-last, then first-to-last again, then a third time) before
    # giving up on this request -- not 3 back-to-back tries of the SAME
    # combo. A combo that fails transiently (503/500/timeout) is only
    # excluded after MAX_ATTEMPTS_PER_COMBO tries (see attempt_counts
    # below), so it naturally gets revisited on a later pass once the rest
    # of the pool has had its turn. We also keep a small buffer of extra
    # iterations purely for RPM wait-cycles (sleeping for a slot that's
    # about to free up rather than giving up on it).
    pool_size = len(API_KEYS) * max(1, len(MODELS))
    max_attempts = pool_size * 3 + 6

    for attempt in range(max_attempts):
        # Atomic: pick a viable (key, model) AND reserve it in one lock
        # hold. This closes the race window multiple simultaneous users
        # could hit under the old "list combos, then record separately"
        # approach. Fresh (non-continuation) requests are free to spread
        # across every key/model -- this is what keeps your whole pool's
        # quota in use.
        slot = acquire_next_slot(requested_model, exclude=tried)

        if slot is None:
            # acquire_next_slot found no viable combo right now.
            # Work out whether any slot is merely RPM-throttled (transient)
            # or everything is daily-exhausted/broken (permanent for today).
            with state_lock:
                now_mono = time.monotonic()
                waits = []
                any_waitable = False
                for m_dict in get_active_models():
                    m_name = m_dict["name"]
                    for k in API_KEYS:
                        if (k, m_name) in tried:
                            continue
                        if (k, m_name) in PERMANENTLY_BROKEN_MODELS:
                            continue
                        if _is_daily_penalized(k, m_name):
                            continue
                        if not _rpd_available(k, m_name, m_dict["rpd"]):
                            continue
                        # This combo is not permanently dead — it's just
                        # RPM-limited right now. Find when it opens up.
                        any_waitable = True
                        cd = rpm_cooldown.get((k, m_name), 0)
                        if cd > now_mono:
                            waits.append(cd - now_mono)
                        window = list(rpm_window.get((k, m_name), []))
                        if window:
                            effective_limit = max(1, m_dict["rpm"] - RPM_SAFETY_MARGIN)
                            if len(window) >= effective_limit:
                                # oldest entry falls out of the 60s window
                                waits.append(max(0, window[0] + 60.0 - now_mono))

            if not any_waitable:
                # Every remaining combo is permanently dead for today.
                print("[EXHAUSTED] All key×model combos are daily-exhausted or broken.")
                break

            # At least one slot is coming back — sleep until the soonest one.
            wait_secs = min(waits) + 0.2 if waits else 2.0
            if wait_secs > 65:
                # Cooldown/window is too far away — not worth blocking the
                # HTTP request this long. Return 429 now so the caller can
                # retry; the next call will likely find a fresh slot.
                print(f"[WAIT TOO LONG] Soonest slot in {wait_secs:.0f}s — returning 429 now.")
                break
            print(f"[WAIT] All slots RPM-busy, sleeping {wait_secs:.1f}s for next available slot...")
            time.sleep(wait_secs)
            continue

        k_idx, m_idx, key, model = slot
        actual_model = model["name"]
        tried.add((key, actual_model))
        data["model"] = actual_model

        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json"
        }
        url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"

        try:
            resp = requests.post(url, json=prepare_payload(data, actual_model), headers=headers, stream=True,timeout=600)
            resp = _heal_signature(resp, url, headers, data, actual_model)
            last_resp = resp

            if resp.status_code == 200:

                # Pin this conversation to this exact (key, model) so that
                # if the assistant's reply contains a tool call, the NEXT
                # request (the tool result) lands back on the same slot and
                # its thought_signature still validates.
                remember_sticky_slot(client_id, key, actual_model)
                capture_signatures(resp.content)
                if hasattr(g, "log_entry"):
                    g.log_entry["status"] = f"200 Success ({actual_model})"
                    g.log_entry["model"] = actual_model
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

                print(f"[429] key=…{key[-6:]} model={actual_model} → instantly switching to next key/model")
                attempt_errors.append(f"429 {actual_model} (…{key[-4:]}): {kind}-limit — {err_text[:150]}")
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
                    if n >= MAX_ATTEMPTS_PER_COMBO:
                        tried.add((key, actual_model))
                        print(f"[{resp.status_code}] model={actual_model} key=…{key[-6:]} "
                              f"failed {n}x (server error) -> giving up on this combo for this request")
                    else:
                        _apply_rpm_cooldown(key, actual_model, seconds=20)
                        print(f"[{resp.status_code}] model={actual_model} key=…{key[-6:]} "
                              f"server error, attempt {n}/{MAX_ATTEMPTS_PER_COMBO} -> trying other combos first")
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
                    print(f"[{resp.status_code}] model={actual_model} bad request, trying next combo...")
                    attempt_errors.append(f"{resp.status_code} {actual_model} (…{key[-4:]}): {err_text[:150]}")
                continue  # instantly try the next key/model regardless

            else:
                with state_lock:
                    metrics["failed_requests"] += 1
                err_text = ""
                try: err_text = resp.text[:200]
                except: pass
                if hasattr(g, "log_entry"):
                    g.log_entry["error_detail"] = (
                        f"{resp.status_code} {actual_model} (…{key[-4:]}): {err_text}"
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
                if n >= MAX_ATTEMPTS_PER_COMBO:
                    tried.add((key, actual_model))
                else:
                    _apply_rpm_cooldown(key, actual_model, seconds=20)
            continue

    # Every key×model combo was tried (or the pool is genuinely exhausted).
    with state_lock:
        metrics["failed_requests"] += 1

    error_summary = " || ".join(attempt_errors[-6:]) if attempt_errors else "no combo was tried (pool empty?)"
    if hasattr(g, "log_entry"):
        g.log_entry["error_detail"] = f"exhausted after {len(attempt_errors)} attempt(s): {error_summary}"

    if last_resp is not None:
        excluded = ['content-encoding','content-length','transfer-encoding','connection']
        out_headers = [(n, v) for n, v in last_resp.raw.headers.items() if n.lower() not in excluded]
        return Response(last_resp.content, last_resp.status_code, out_headers)

    return jsonify({
        "error": {
            "message": "All API keys and models are exhausted. Daily limits may have been reached. Resets at midnight IST.",
            "type": "rate_limit_error"
        }
    }), 429

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

    TRANSCRIBE_MODEL = "gemini-1.5-flash"
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

# ─── Models List ──────────────────────────────────────────────────────────────
@app.route('/v1/models', methods=['GET', 'OPTIONS'])
def proxy_models():
    if request.method == 'OPTIONS':
        return Response(status=200)
    with dynamic_models_lock:
        if OPENAI_MODELS_LIST:
            return jsonify({"object": "list", "data": OPENAI_MODELS_LIST})
    now = int(time.time())
    data = [{"id": m["name"], "object": "model", "created": now, "owned_by": "google"}
            for m in get_active_models()]
    return jsonify({"object": "list", "data": data})

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
            MODELS.append({"name": data["model"], "rpm": int(data["rpm"]),
                           "rpd": int(data.get("rpd", 500))})
            new_model_added = True
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
        "models": get_active_models()
    })

@app.route('/ping')
@app.route('/healthz')
def ping():
    return "OK", 200

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=8085)

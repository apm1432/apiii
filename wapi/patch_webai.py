"""Build-time patches for the pinned WebAI-to-API checkout (run from the Dockerfile). Fails loudly."""
import re, sys, shutil, os
root = "/opt/webai/src/app"

# 1) route that downloads Gemini media with the logged-in session
shutil.copy("/usr/src/app/wapi/webai_artifacts.py", f"{root}/endpoints/artifact_proxy.py")
p = f"{root}/main.py"; s = open(p, encoding="utf-8").read()
if "artifact_proxy" not in s:
    anchor = "app.include_router(ui.router)"
    assert anchor in s, "main.py anchor missing"
    s = s.replace(anchor, anchor + "\nfrom app.endpoints import artifact_proxy\napp.include_router(artifact_proxy.router)", 1)
    open(p, "w", encoding="utf-8").write(s)

# 2) artifact urls -> /v1/artifacts/fetch?u=<original>  (wapi turns it into an absolute /api/web/v1 URL)
p = f"{root}/services/providers/gemini/webapi_response_builder.py"; s = open(p, encoding="utf-8").read()
if "_proxy_artifact_urls" not in s:
    s = s.replace("def build_choice_artifacts(response: Any) -> list[dict]:",
'''def _proxy_artifact_urls(artifacts: list[dict]) -> list[dict]:
    from urllib.parse import quote
    for a in artifacts:
        for key in ("url", "thumbnail_url"):
            v = a.get(key)
            if isinstance(v, str) and v.startswith("https://"):
                a["source_" + key] = v
                a[key] = "/v1/artifacts/fetch?u=" + quote(v, safe="")
    return artifacts


def build_choice_artifacts(response: Any) -> list[dict]:''', 1)
    assert s.count("    return artifacts\n") >= 1
    i = s.rindex("    return artifacts\n")
    s = s[:i] + "    return _proxy_artifact_urls(artifacts)\n" + s[i + len("    return artifacts\n"):]
    open(p, "w", encoding="utf-8").write(s)

# 2b) generated files (calculator.html / .py ...): artifacts of type "file" + "[file-tag: ...]" in text -> markdown link
p = f"{root}/services/providers/gemini/webapi_response_builder.py"; s = open(p, encoding="utf-8").read()
if "_link_file_tags" not in s:
    helpers = '''import builtins as _bi
import re as _re
_FILE_TAG_RE = _re.compile(r"\\[file-tag: [^\\]]+\\]")


def _file_store() -> dict:
    return getattr(_bi, "_WEBAI_FILES", {})


def _file_link(f: dict) -> str:
    from urllib.parse import quote
    return "/v1/artifacts/fetch?u=" + quote(f["url"], safe="") + "&n=" + quote(f.get("name") or "file", safe="")


def _link_file_tags(text: str) -> str:
    """[file-tag: code-generated-file-xxx] -> [calculator.html](/v1/artifacts/fetch?...)  (wapi makes it absolute)"""
    if not isinstance(text, str) or "[file-tag:" not in text:
        return text
    store = _file_store()
    def _sub(m):
        f = store.get(m.group(0))
        return "[" + f["name"] + "](" + _file_link(f) + ")" if f else m.group(0)
    return _FILE_TAG_RE.sub(_sub, text)


def _build_file_artifacts(response: Any) -> list:
    out = []
    try:
        files = _file_store().get(("rc", response.rcid)) or []
    except Exception:
        files = []
    for f in files:
        out.append({"type": "file", "provider": ARTIFACT_PROVIDER, "title": f["name"], "name": f["name"],
                    "mime_type": f["mime"], "url": f["url"], "tag": f["tag"]})
    return out


'''
    s = s.replace("def _proxy_artifact_urls(", helpers + "def _proxy_artifact_urls(", 1)
    # file artifacts join the list before proxying
    s = s.replace("    return _proxy_artifact_urls(artifacts)\n", "    artifacts.extend(_build_file_artifacts(response))\n    return _proxy_artifact_urls(artifacts)\n", 1)
    # proxied file urls carry the file name (download with the right name)
    s = s.replace('a[key] = "/v1/artifacts/fetch?u=" + quote(v, safe="")',
                  'a[key] = "/v1/artifacts/fetch?u=" + quote(v, safe="") + (("&n=" + quote(a.get("name") or "file", safe="")) if a.get("type") == "file" else "")', 1)
    # text (non-stream + progressive stream)
    s = s.replace("        getattr(response, \"text\", \"\") or \"\",\n        model,", "        _link_file_tags(getattr(response, \"text\", \"\") or \"\"),\n        model,", 1)
    s = s.replace("delta={\"role\": \"assistant\", \"content\": response_text},", "delta={\"role\": \"assistant\", \"content\": _link_file_tags(response_text)},", 1)
    assert s.count("_link_file_tags(") >= 3, "file-tag text patch failed"
    assert "_build_file_artifacts(response)" in s
    open(p, "w", encoding="utf-8").write(s)

# 2c) accept many more upload types (WebAI whitelist is small): Office, audio, video, code/text, more images
p = f"{root}/services/multimodal.py"; s = open(p, encoding="utf-8").read()
if "EXTRA_FILE_TYPES" not in s:
    s += '''

# --- EXTRA_FILE_TYPES (added by patch_webai.py) ---
ALLOWED_FILE_MIME_TYPES.update({
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": {".pptx"},
    "application/vnd.ms-powerpoint": {".ppt"},
    "application/vnd.ms-excel": {".xls"},
    "text/html": {".html", ".htm"},
    "text/css": {".css"},
    "text/javascript": {".js", ".mjs"},
    "application/javascript": {".js", ".mjs"},
    "text/x-python": {".py"},
    "text/x-python-script": {".py"},
    "application/x-python-code": {".py"},
    "text/x-java-source": {".java"},
    "text/x-csrc": {".c", ".h"},
    "text/x-c++src": {".cpp", ".hpp", ".cc"},
    "application/x-yaml": {".yaml", ".yml"},
    "text/yaml": {".yaml", ".yml"},
    "application/typescript": {".ts", ".tsx"},
    "text/x-sql": {".sql"},
    "application/rtf": {".rtf"},
    "text/rtf": {".rtf"},
    "image/heic": {".heic"},
    "image/heif": {".heif"},
    "image/bmp": {".bmp"},
    "audio/mpeg": {".mp3"},
    "audio/mp3": {".mp3"},
    "audio/wav": {".wav"},
    "audio/x-wav": {".wav"},
    "audio/ogg": {".ogg", ".oga"},
    "audio/flac": {".flac"},
    "audio/aac": {".aac"},
    "audio/mp4": {".m4a"},
    "audio/x-m4a": {".m4a"},
    "video/mp4": {".mp4"},
    "video/webm": {".webm"},
    "video/quicktime": {".mov"},
    "video/x-msvideo": {".avi"},
    "video/mpeg": {".mpeg", ".mpg"},
})
'''
    open(p, "w", encoding="utf-8").write(s)

# 2d) guest mode: no cookies at all -> start gemini-webapi anonymously (otherwise only playwright/* models exist
#     and every request fails with "Browser interaction failure", because the Docker image has no Chromium/login state)
p = f"{root}/services/providers/gemini/client.py"; s = open(p, encoding="utf-8").read()
if "GUEST_FALLBACK" not in s:
    anchor = "            # Step 3: Final Candidate Resolution\n"
    assert anchor in s, "client.py anchor missing"
    guest = '''            # GUEST_FALLBACK (added by patch_webai.py): nothing authenticated -> anonymous Gemini web client
            if best_client is None:
                try:
                    logger.info("No cookies available: trying anonymous guest-mode Gemini client...")
                    _ensure_gemini_cache_directory()
                    guest_client = MyGeminiClient(proxy=gemini_proxy)
                    await guest_client.init(verbose=True, auto_refresh=False)
                    best_client = guest_client
                    best_client_source_name = "guest (no cookies)"
                except Exception as e:
                    logger.warning(f"Guest-mode client could not start: {e}")

'''
    s = s.replace(anchor, guest + anchor, 1)
    open(p, "w", encoding="utf-8").write(s)

# 3) diagnostic capture of raw replies (sitecustomize)
shutil.copy("/usr/src/app/wapi/webai_capture.py", "/opt/webai/src/sitecustomize.py")
print("webai patches applied")

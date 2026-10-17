"""
Diagnostic only. Copied to /opt/webai/src/sitecustomize.py (patch_webai.py) so the WebAI process loads it.

gemini-webapi 2.1.1 does not parse Gemini's generated files / canvas documents, so their payload layout is
unknown. This saves the raw candidate payload of every reply (one file per reply id, last 25 kept) to
/tmp/webai-capture/*.json; wapi serves the newest at /api/web/v1/ui/auth/capture?n=2.
Only active with env WEBAI_CAPTURE=1 (default OFF: no reply is written to disk).
Never raises: any failure just leaves WebAI unpatched.
"""
try:
    import os, json, time, re
    DIR = "/tmp/webai-capture"

    # ---- generated files (code-generated-file): text only has "[file-tag: ...]", the real download url
    # sits in candidate[12][*]["59"][*][*] = [tag, None, [None, 3, name, ..., [thumb, download, upload], ..., mime]]
    import builtins
    if not hasattr(builtins, "_WEBAI_FILES"):
        builtins._WEBAI_FILES = {}          # tag -> {"tag","name","mime","url"}   (bounded)

    def _extract_files(candidate_data):
        out = []
        try:
            meta = candidate_data[12] if len(candidate_data) > 12 else None
            blocks = meta if isinstance(meta, list) else [meta]
            for block in blocks:
                if not isinstance(block, dict) or "59" not in block:
                    continue
                for group in block["59"] or []:
                    for item in group or []:
                        try:
                            tag = item[0]
                            info = item[2]
                            name = next((x for x in info if isinstance(x, str) and "." in x and not x.startswith(("$", "http"))), None)
                            urls = next((x for x in info if isinstance(x, list) and any(isinstance(u, str) and "/download?" in u for u in x)), None)
                            url = next((u for u in (urls or []) if isinstance(u, str) and "/download?" in u), None)
                            mime = next((x for x in reversed(info) if isinstance(x, str) and "/" in x and not x.startswith(("$", "http"))), "application/octet-stream")
                            if isinstance(tag, str) and url:
                                out.append({"tag": tag, "name": name or "file", "mime": mime, "url": url})
                        except Exception:
                            continue
        except Exception:
            pass
        return out

    def _remember_files(candidate_data):
        files = _extract_files(candidate_data)
        if files:
            store = builtins._WEBAI_FILES
            for f in files:
                store[f["tag"]] = f
            store[("rc", candidate_data[0])] = files
            while len(store) > 200:
                store.pop(next(iter(store)))
        return files

    def _install():
        from gemini_webapi.client import GeminiClient
        orig = GeminiClient._parse_candidate
        if getattr(orig, "_capture", False):
            return

        def wrapped(self, candidate_data, *a, **k):
            try:
                _remember_files(candidate_data)
            except Exception:
                pass
            try:
                if os.environ.get("WEBAI_CAPTURE") != "1":      # diagnostics are OFF by default: nothing of a reply is kept
                    raise StopIteration
                raw = json.dumps(candidate_data, default=str, ensure_ascii=False)
                rcid = candidate_data[0] if isinstance(candidate_data, list) and candidate_data else "x"
                name = re.sub(r"[^A-Za-z0-9_-]", "_", str(rcid))[:60] or "x"
                if len(raw) < 3_000_000:
                    os.makedirs(DIR, exist_ok=True)
                    with open(os.path.join(DIR, name + ".json"), "w", encoding="utf-8") as f:
                        f.write(raw)
                    files = sorted((os.path.join(DIR, x) for x in os.listdir(DIR)), key=os.path.getmtime)
                    for old in files[:-25]:
                        os.remove(old)
            except Exception:
                pass
            return orig(self, candidate_data, *a, **k)

        wrapped._capture = True
        GeminiClient._parse_candidate = wrapped

    _install()
except Exception:
    pass

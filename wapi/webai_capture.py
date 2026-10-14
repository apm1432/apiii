"""
Diagnostic only. Copied to /opt/webai/src/sitecustomize.py (patch_webai.py) so the WebAI process loads it.

gemini-webapi 2.1.1 does not parse Gemini's generated files / canvas documents, so their payload layout is
unknown. This saves the raw candidate payload of every reply (one file per reply id, last 25 kept) to
/tmp/webai-capture/*.json; wapi serves the newest at /api/web/v1/ui/auth/capture?n=2.
Never raises: any failure just leaves WebAI unpatched.
"""
try:
    import os, json, time, re
    DIR = "/tmp/webai-capture"

    def _install():
        from gemini_webapi.client import GeminiClient
        orig = GeminiClient._parse_candidate
        if getattr(orig, "_capture", False):
            return

        def wrapped(self, candidate_data, *a, **k):
            try:
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

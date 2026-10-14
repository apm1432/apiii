"""
Diagnostic only. Copied to /opt/webai/src/sitecustomize.py (Dockerfile) so the WebAI process loads it.

Gemini's code-execution files ("[file-tag: code-generated-file-...]") are NOT parsed by
gemini-webapi 2.1.1, so the download info is unknown. This saves the raw candidate payload of any
reply that mentions such a file to /tmp/webai-capture/*.json; wapi serves the newest ones at
/api/web/v1/ui/auth/capture so the real structure can be inspected and the download implemented.
Never raises: any failure just leaves WebAI unpatched.
"""
try:
    import os, json, time
    DIR = "/tmp/webai-capture"

    def _install():
        from gemini_webapi.client import GeminiClient
        orig = GeminiClient._parse_candidate
        if getattr(orig, "_capture", False):
            return

        def wrapped(self, candidate_data, *a, **k):
            try:
                raw = json.dumps(candidate_data, default=str, ensure_ascii=False)
                if "file-tag" in raw or "code-generated" in raw or "code_reference" in raw:
                    os.makedirs(DIR, exist_ok=True)
                    files = sorted(os.listdir(DIR))
                    for old in files[:-19]:
                        os.remove(os.path.join(DIR, old))
                    if len(raw) < 2_000_000:
                        with open(os.path.join(DIR, f"{int(time.time()*1000)}.json"), "w", encoding="utf-8") as f:
                            f.write(raw)
            except Exception:
                pass
            return orig(self, candidate_data, *a, **k)

        wrapped._capture = True
        GeminiClient._parse_candidate = wrapped

    _install()
except Exception:
    pass

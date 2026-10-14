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

# 3) diagnostic capture of raw replies (sitecustomize)
shutil.copy("/usr/src/app/wapi/webai_capture.py", "/opt/webai/src/sitecustomize.py")
print("webai patches applied")

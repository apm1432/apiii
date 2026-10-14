"""
Copied to /opt/webai/src/app/endpoints/artifact_proxy.py (Dockerfile) and registered in app/main.py.

Gemini's image / video / audio links (e.g. lh3.googleusercontent.com/rd-gg-dl/...) answer 403 to
anyone who is not logged in as the Gemini account.  This route downloads them with WebAI's own
logged-in session and streams the bytes back, so the artifact links work in a plain browser tab and
in any OpenAI client.  Reached through wapi as /api/web/v1/artifacts/fetch?u=<url>  (same auth).
"""
import re
from urllib.parse import urlparse, unquote
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

router = APIRouter(prefix="/v1/artifacts", tags=["Artifacts"], include_in_schema=False)

_ALLOWED = (".googleusercontent.com", ".google.com", ".gstatic.com", ".ggpht.com", ".googlevideo.com")
_SIZE_RE = re.compile(r"=s\d+(-[a-z0-9-]+)?$")


def _allowed(url: str) -> bool:
    p = urlparse(url)
    host = (p.hostname or "").lower()
    return p.scheme == "https" and any(host == d[1:] or host.endswith(d) for d in _ALLOWED)


def _candidates(url: str):
    # generated images come as small previews (=s512): try the full-size variant first
    if "/rd-gg-dl/" in url or "googleusercontent.com" in url:
        base = _SIZE_RE.sub("", url)
        if base != url or "=" not in url.rsplit("/", 1)[-1]:
            yield base + "=s2048-rj"
    yield url


@router.get("/fetch")
async def fetch_artifact(u: str = Query(..., min_length=10, max_length=8192), n: str = Query("", max_length=200)):
    url = unquote(u) if u.startswith("https%3A") else u
    if not _allowed(url):
        raise HTTPException(status_code=400, detail="URL host not allowed")
    from app.services.providers.gemini.client import get_gemini_client
    from gemini_webapi.constants import Headers
    try:
        session = get_gemini_client().client._live_client
    except Exception as e:
        raise HTTPException(status_code=424, detail=f"Gemini client not ready: {e}")
    last = None
    for candidate in _candidates(url):
        try:
            r = await session.get(candidate, headers=Headers.REFERER.value)
        except Exception as e:
            last = str(e)
            continue
        if r.status_code == 200 and r.content:
            ctype = r.headers.get("content-type", "application/octet-stream")
            mtype = ctype.split(";")[0].strip()
            if n:   # generated file (calculator.html ...): always a download, never rendered on our origin
                safe = re.sub(r'[^A-Za-z0-9._-]', "_", n)[:100] or "file"
                disp = f'attachment; filename="{safe}"'
                if safe.lower().endswith((".html", ".htm", ".svg")):
                    mtype = "application/octet-stream"
            else:
                disp = "inline"
            return Response(content=r.content, media_type=mtype,
                            headers={"Content-Disposition": disp, "Cache-Control": "private, max-age=3600"})
        last = f"HTTP {r.status_code}"
    raise HTTPException(status_code=502, detail=f"Download failed: {last}")

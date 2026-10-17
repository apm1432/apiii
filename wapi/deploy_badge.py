"""Small 'Deployed <time> - <n> min ago' badge for the dashboard pages (/logs, /api/web/v1/ui/*).

DEPLOYED_AT (unix seconds) is exported by start.sh when the container starts, so the badge shows when the
latest deployment actually came up.  The 'x min ago' text is computed in the browser (30 s timer, no requests),
so it costs the server nothing."""
import os, time

_MARK = "id=\"dpl-badge\""
_ENV_COMMIT = ("RENDER_GIT_COMMIT", "RAILWAY_GIT_COMMIT_SHA", "SOURCE_VERSION", "VERCEL_GIT_COMMIT_SHA",
               "KOYEB_GIT_SHA", "GIT_COMMIT", "COMMIT_SHA")


def _deployed_at():
    try:
        return int(float(os.environ.get("DEPLOYED_AT", "")))
    except ValueError:
        return int(time.time())          # fallback: when this process started


DEPLOYED_AT = _deployed_at()
COMMIT = next(((os.environ.get(k) or "")[:7] for k in _ENV_COMMIT if os.environ.get(k)), "")

_HTML = (
    '<div id="dpl-badge" style="position:fixed;top:6px;right:6px;z-index:2147483647;font:11px/1.3 system-ui,sans-serif;'
    'background:rgba(20,22,26,.88);color:#d1d5db;border:1px solid #374151;border-radius:999px;padding:3px 9px;'
    'pointer-events:none;white-space:nowrap">\U0001F7E2 <span id="dpl-txt"></span></div>'
    '<script>(function(){var T=__TS__*1000,C="__COMMIT__";function p(){var s=Math.max(0,(Date.now()-T)/1000),a;'
    'if(s<60)a="just now";else if(s<3600)a=Math.floor(s/60)+" min ago";'
    'else if(s<86400)a=Math.floor(s/3600)+"h "+Math.floor(s%3600/60)+"m ago";else a=Math.floor(s/86400)+"d ago";'
    'var t=new Date(T).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",hour:"2-digit",'
    'minute:"2-digit",hour12:true});var e=document.getElementById("dpl-txt");'
    'if(e)e.textContent="Deployed "+t+" IST \\u00b7 "+a+(C?" \\u00b7 "+C:"")}p();setInterval(p,30000)})();</script>'
)


def badge():
    return _HTML.replace("__TS__", str(DEPLOYED_AT)).replace("__COMMIT__", COMMIT)


def inject(html):
    """Insert the badge before </body> (or append). Safe to call twice."""
    if not isinstance(html, str) or _MARK in html:
        return html
    i = html.lower().rfind("</body>")
    b = badge()
    return html + b if i < 0 else html[:i] + b + html[i:]

"""
Router-side load balancer for the WebAI account pool.

wapi/webai_supervisor.py runs ONE WebAI-to-API process per Gemini account and writes their state to
POOL_DIR/pool.json.  This module (used inside the gunicorn process of smart_router.py) reads that file
and hands every request to the best account:

  * authenticated accounts first (guest/anonymous instances only when nothing else is logged in)
  * least requests in flight first, then least recently used  -> parallel spread, round-robin when idle
  * per-account concurrency cap (WEBAI_PER_ACCOUNT_CONCURRENCY) so one account is never hammered
  * an account that fails (401/403/429/5xx/connection error) is put on a short cooldown and the request is
    retried on another account by the caller (RETRY_STATUS / has_candidate)
  * conversation_id requests stick to the account that served them first

If pool.json does not exist (supervisor not running) a single instance at WEBAI_URL is used, i.e. the old
single-account behaviour.
"""
import os, json, time, threading
from collections import OrderedDict

POOL_DIR = os.environ.get("WEBAI_POOL_DIR", "/tmp/webai-pool")
POOL_FILE = os.path.join(POOL_DIR, "pool.json")
PER_ACCOUNT_CONCURRENCY = max(1, int(os.environ.get("WEBAI_PER_ACCOUNT_CONCURRENCY", "4")))
WAIT_SECONDS = float(os.environ.get("WEBAI_POOL_WAIT", "30"))      # max wait for a free slot, then least-loaded is used anyway
COOLDOWN_AUTH = float(os.environ.get("WEBAI_COOLDOWN_AUTH", "120"))   # 401 / 403
COOLDOWN_RATE = float(os.environ.get("WEBAI_COOLDOWN_RATE", "60"))    # 429
COOLDOWN_SOFT = float(os.environ.get("WEBAI_COOLDOWN_SOFT", "30"))    # 5xx / network error

# upstream statuses that mean "this ACCOUNT has a problem" -> try another account
RETRY_STATUS = (401, 403, 429, 500, 502, 503, 504)


class Slot:
    __slots__ = ("id", "label", "url", "guest")

    def __init__(self, iid, label, url, guest=False):
        self.id, self.label, self.url, self.guest = iid, label, url, guest


class WebAIPool:
    def __init__(self, fallback_url):
        self.fallback_url = fallback_url.rstrip("/")
        self._cv = threading.Condition()
        self._st = {}                       # id -> {"in_flight","cooldown_until","last_used","ok","fail","last_status"}
        self._file_cache = (0.0, None, [])  # (checked_at, mtime, instances)
        self._conv = OrderedDict()          # conversation_id -> account id
        self._rr = 0

    # ── instances (from the supervisor) ──────────────────────────────────────
    def instances(self):
        now = time.monotonic()
        checked, mtime, cached = self._file_cache
        if now - checked < 1.0:
            return cached
        try:
            m = os.stat(POOL_FILE).st_mtime
            if m == mtime:
                self._file_cache = (now, mtime, cached)
                return cached
            with open(POOL_FILE, encoding="utf-8") as f:
                data = json.load(f)
            items = [i for i in (data.get("instances") or []) if isinstance(i, dict) and i.get("port")]
            for i in items:
                i["url"] = f"http://127.0.0.1:{int(i['port'])}"
            self._file_cache = (now, m, items)
            return items
        except (OSError, ValueError):
            if cached:                                   # keep last good copy on a half-written / missing file
                self._file_cache = (now, mtime, cached)
                return cached
            single = [{"id": "default", "label": "default", "url": self.fallback_url, "state": "running",
                       "authenticated": None, "guest": False}]
            self._file_cache = (now, None, single)
            return single

    def count(self):
        return max(1, len([i for i in self.instances() if i.get("state") in ("running", "starting")]))

    def _state(self, iid):
        return self._st.setdefault(iid, {"in_flight": 0, "cooldown_until": 0.0, "last_used": 0.0,
                                         "ok": 0, "fail": 0, "last_status": None})

    def _candidates(self, exclude):
        insts = [i for i in self.instances() if i.get("state") in ("running", "starting") and i["id"] not in exclude]
        auth = [i for i in insts if i.get("authenticated")]
        pool = auth or insts
        now = time.monotonic()
        ready = [i for i in pool if self._state(i["id"])["cooldown_until"] <= now]
        return ready or pool            # everything cooling down -> still better than failing

    def has_candidate(self, exclude=()):
        with self._cv:
            return bool(self._candidates(set(exclude)))

    # ── picking ──────────────────────────────────────────────────────────────
    @staticmethod
    def _slot(i):
        return Slot(i["id"], i.get("label") or i["id"], i["url"], bool(i.get("guest")))

    def peek(self, exclude=()):
        """Best instance for light/read-only requests (models, dashboard...). No in-flight accounting."""
        with self._cv:
            c = self._candidates(set(exclude))
            if not c:
                return None
            c.sort(key=lambda i: (self._state(i["id"])["in_flight"], i["id"]))
            return self._slot(c[0])

    def slot_for(self, iid):
        """A specific account (artifact downloads must use the account that generated the file)."""
        for i in self.instances():
            if i["id"] == iid and i.get("state") in ("running", "starting"):
                return self._slot(i)
        return self.peek()

    def any_url(self):
        s = self.peek()
        return s.url if s else self.fallback_url

    def acquire(self, exclude=(), prefer=None, wait=None):
        """Reserve the best account for one generation request. Always pair with release()."""
        exclude = set(exclude)
        deadline = time.monotonic() + (WAIT_SECONDS if wait is None else wait)
        with self._cv:
            while True:
                cands = self._candidates(exclude)
                if not cands:
                    return None
                free = [i for i in cands if self._state(i["id"])["in_flight"] < PER_ACCOUNT_CONCURRENCY]
                timed_out = time.monotonic() >= deadline
                if free or timed_out:
                    pool = free or cands
                    pick = None
                    if prefer:
                        pick = next((i for i in pool if i["id"] == prefer), None)
                    if pick is None:
                        self._rr += 1
                        pool = sorted(pool, key=lambda i: (self._state(i["id"])["in_flight"],
                                                           self._state(i["id"])["last_used"], i["id"]))
                        pick = pool[0]
                    st = self._state(pick["id"])
                    st["in_flight"] += 1
                    st["last_used"] = time.monotonic()
                    return self._slot(pick)
                self._cv.wait(timeout=min(1.0, max(0.05, deadline - time.monotonic())))

    def release(self, slot, status=None, error=False):
        if slot is None:
            return
        with self._cv:
            st = self._state(slot.id)
            st["in_flight"] = max(0, st["in_flight"] - 1)
            st["last_status"] = status
            cool = 0.0
            if error:
                cool = COOLDOWN_SOFT
            elif status in (401, 403):
                cool = COOLDOWN_AUTH
            elif status == 429:
                cool = COOLDOWN_RATE
            elif status is not None and status >= 500:
                cool = COOLDOWN_SOFT
            if cool:
                st["fail"] += 1
                st["cooldown_until"] = max(st["cooldown_until"], time.monotonic() + cool)
            elif status is not None and status < 400:
                st["ok"] += 1
            self._cv.notify_all()

    # ── conversation stickiness ──────────────────────────────────────────────
    def conv_account(self, conv):
        if not conv:
            return None
        with self._cv:
            return self._conv.get(str(conv))

    def remember_conv(self, conv, iid):
        if not conv:
            return
        with self._cv:
            self._conv[str(conv)] = iid
            self._conv.move_to_end(str(conv))
            while len(self._conv) > 5000:
                self._conv.popitem(last=False)

    # ── for the cookie page ──────────────────────────────────────────────────
    def snapshot(self):
        now = time.monotonic()
        with self._cv:
            out = {}
            for iid, st in self._st.items():
                out[iid] = {"in_flight": st["in_flight"], "ok": st["ok"], "fail": st["fail"],
                            "last_status": st["last_status"],
                            "cooldown_left": max(0, round(st["cooldown_until"] - now))}
            return out


_pool = None
_pool_lock = threading.Lock()


def get_pool():
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = WebAIPool(os.environ.get("WEBAI_URL", "http://127.0.0.1:6969"))
        return _pool

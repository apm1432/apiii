"""image_fix.py - repair broken image parts BEFORE they are sent to Gemini, and recognise the 400s that mean
"this MODEL cannot take this input" (so smart_router forwards the request to another model instead of failing).

Why: Google answers `400 invalid_argument: unable to process input image` when
  (a) the image bytes are bad / the data-URL is malformed / the mime label is wrong / the format is not supported
      (gif, bmp, tiff ...) / the picture is tiny or huge          -> we FIX the format here, or
  (b) the chosen model cannot take images at all                  -> smart_router skips that model and tries another.
Pillow is optional: without it only the cheap fixes (base64 cleanup, correct mime label) are done.
"""
import base64
import binascii
import io
import ipaddress
import math
import re
import socket
from urllib.parse import urlparse, unquote_to_bytes

import requests

try:
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 100_000_000
except Exception:                      # Pillow not installed -> degrade gracefully
    Image = None

GEMINI_MIMES = {"image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"}
MAX_BYTES = 15 * 1024 * 1024          # re-encode anything bigger than this
MAX_SIDE = 3072                       # downscale pictures larger than this (px)
MIN_SIDE = 64                         # upscale tiny pictures (icons / 1-pixel-high crops) to at least this (px)
FETCH_TIMEOUT = 15

_B64_CLEAN = re.compile(r"[^A-Za-z0-9+/=]")


def sniff_mime(b):
    """Real mime type from the magic bytes (never trust the label in the data URL)."""
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if b[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if b[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "image/webp"
    if b[:2] == b"BM":
        return "image/bmp"
    if b[:4] in (b"II*\x00", b"MM\x00*"):
        return "image/tiff"
    if b[4:8] == b"ftyp" and b[8:12] in (b"heic", b"heix", b"hevc", b"mif1", b"msf1", b"heif"):
        return "image/heic"
    return None


def _decode_b64(s):
    s = unquote_to_bytes(s).decode("ascii", "ignore") if "%" in s else s
    s = s.replace("-", "+").replace("_", "/")          # url-safe alphabet -> standard
    s = _B64_CLEAN.sub("", s).rstrip("=")
    s += "=" * (-len(s) % 4)                           # fix missing padding
    return base64.b64decode(s)


def _safe_host(host):
    """Refuse to fetch localhost / private networks (this proxy must not become an SSRF tool)."""
    try:
        for fam, _, _, _, sa in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(sa[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        return True
    except Exception:
        return False


def _load_bytes(url):
    """-> raw image bytes from a data: URL, a bare base64 string or an http(s) URL. Raises ValueError."""
    if not isinstance(url, str) or not url.strip():
        raise ValueError("empty image url")
    u = url.strip()
    if u[:5].lower() == "data:":
        head, _, payload = u.partition(",")
        if not payload:
            raise ValueError("data URL without payload")
        if ";base64" in head.lower():
            return _decode_b64(payload)
        return unquote_to_bytes(payload)                # non-base64 data URL
    if u[:7].lower() in ("http://", "https:/"):
        p = urlparse(u)
        if not p.hostname or not _safe_host(p.hostname):
            raise ValueError("image url points to a private / unresolvable host")
        r = requests.get(u, timeout=FETCH_TIMEOUT, stream=True, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        buf = bytearray()
        for chunk in r.iter_content(65536):
            buf += chunk
            if len(buf) > 30 * 1024 * 1024:
                raise ValueError("image too large to fetch")
        return bytes(buf)
    if len(u) > 64 and not u.startswith(("/", ".", "~")):   # bare base64 without the data: prefix
        return _decode_b64(u)
    raise ValueError("unsupported image reference")


def _reencode(raw, mime):
    """Make the picture something Gemini accepts. Returns (bytes, mime, changed)."""
    if Image is None:
        return raw, mime, False
    im = Image.open(io.BytesIO(raw))
    im.load()                                           # raises on truncated / corrupt data
    w, h = im.size
    if w < 1 or h < 1:
        raise ValueError("image has no pixels")
    need = (mime not in GEMINI_MIMES) or len(raw) > MAX_BYTES or max(w, h) > MAX_SIDE or min(w, h) < MIN_SIDE \
        or im.mode not in ("RGB", "RGBA", "L")
    if not need:
        return raw, mime, False
    scale = 1.0
    if max(w, h) > MAX_SIDE:
        scale = MAX_SIDE / float(max(w, h))
    elif min(w, h) < MIN_SIDE:
        scale = min(math.ceil(MIN_SIDE / float(min(w, h))), MAX_SIDE / float(max(w, h)))
    if scale != 1.0:
        resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
        im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), resample)
    has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    out = io.BytesIO()
    if has_alpha:
        im.convert("RGBA").save(out, "PNG")
        return out.getvalue(), "image/png", True
    im = im.convert("RGB")
    if len(raw) > 2 * 1024 * 1024:                       # photos: JPEG is far smaller than PNG
        im.save(out, "JPEG", quality=90)
        return out.getvalue(), "image/jpeg", True
    im.save(out, "PNG")
    return out.getvalue(), "image/png", True


def fix_image_url(url):
    """-> (new_data_url, changed). Raises ValueError when the image is not usable at all."""
    try:
        raw = _load_bytes(url)
    except (binascii.Error, requests.RequestException) as e:
        raise ValueError(f"cannot read image: {e}")
    if not raw:
        raise ValueError("image is empty")
    mime = sniff_mime(raw)
    if mime is None:
        raise ValueError("data is not a recognised image format")
    try:
        raw2, mime2, re_changed = _reencode(raw, mime)
    except Exception as e:
        raise ValueError(f"image is corrupt: {e}")
    new = "data:%s;base64,%s" % (mime2, base64.b64encode(raw2).decode("ascii"))
    return new, (re_changed or new != url)


def _img_url_of(part):
    u = part.get("image_url")
    return (u.get("url") if isinstance(u, dict) else u)


def normalize_images(data):
    """Repair every image_url part of data['messages'] in place.
    -> {"images": N still present, "fixed": N changed, "dropped": N unusable (replaced by a text note), "notes": [...]}"""
    st = {"images": 0, "fixed": 0, "dropped": 0, "notes": []}
    for m in (data.get("messages") or []):
        c = m.get("content") if isinstance(m, dict) else None
        if not isinstance(c, list):
            continue
        for i, part in enumerate(c):
            if not (isinstance(part, dict) and part.get("type") == "image_url"):
                continue
            try:
                new, changed = fix_image_url(_img_url_of(part))
            except Exception as e:
                c[i] = {"type": "text", "text": "[An image was attached here but it was unreadable and was removed: %s]" % str(e)[:120]}
                st["dropped"] += 1
                st["notes"].append(str(e)[:120])
                continue
            st["images"] += 1
            if changed:
                st["fixed"] += 1
                part["image_url"] = {"url": new}
    return st


def strip_images(data, reason="no available model could process it"):
    """Last resort: replace every image part by a text note so the conversation can still go on. -> count."""
    n = 0
    for m in (data.get("messages") or []):
        c = m.get("content") if isinstance(m, dict) else None
        if not isinstance(c, list):
            continue
        for i, part in enumerate(c):
            if isinstance(part, dict) and part.get("type") == "image_url":
                c[i] = {"type": "text", "text": "[An image was attached here but could not be processed (%s). Tell the user if you need it.]" % reason}
                n += 1
    return n


_IMAGE_SIGS = (
    "unable to process input image", "process input image", "invalid image", "unsupported image",
    "image format", "input image", "image input", "image is not", "images are not", "image not supported",
    "does not support image", "doesn't support image", "mime type", "multimodal", "vision",
)
_CAPABILITY_SIGS = (
    "does not support", "doesn't support", "is not supported for this model", "not supported by this model",
    "not enabled for", "function calling is not", "tool use is not", "tools are not supported",
    "developer instruction is not enabled", "system instruction is not enabled", "json mode is not",
)


def is_image_error(err_text):
    t = (err_text or "").lower()
    return any(s in t for s in _IMAGE_SIGS)


def is_capability_error(err_text):
    """400s that say 'this MODEL cannot do that' (not 'your request is malformed')."""
    t = (err_text or "").lower()
    return any(s in t for s in _CAPABILITY_SIGS)

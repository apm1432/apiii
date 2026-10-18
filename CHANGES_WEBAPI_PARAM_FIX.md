# /api/web/v1: unsupported parameters are skipped automatically

Problem: WebAI-to-API rejects any field it does not know (temperature, max_tokens, top_p, response_format, message `name` ...)
with 422/400, so the request failed every time.

Now (`wapi/webapi_param_fix.py`, used by `_webapi_request()` in `smart_router.py`, for `/api/web/v1/chat/completions`
AND the Gemini-key -> WebAI fallback):
1. Request is sent. If upstream answers 400/422 and names a field, that field is removed and the SAME request is retried at once
   (client never sees the error). Works together with the existing unknown-model fix; both fixes combine in one request.
2. When the retry succeeds, the field is remembered (`/tmp/webai-pool/blocked_params.json`).
3. Every next request has that field removed BEFORE sending -> no failed round trip.
Safety: only learned after a successful retry; never removes messages/model/role/content/text/type/stream/file...; "field required"
errors are ignored. Log column `model` shows `(skipped params: ...)` / `(auto-skipped: ...)`.

View / reset: `GET /api/web/v1/param-fix` (Bearer password) -> list; `DELETE /api/web/v1/param-fix[?path=temperature]` -> forget.
Env: `WEBAPI_PARAM_FIX=0` turns it off, `WEBAPI_PARAM_FILE` changes the file.

Bug fixes in the same area
- After an unknown-model retry the old code rebuilt the body from the ORIGINAL body, so earlier fixes were lost; now each fix builds on the last.
- On the last account try a retryable status (429/5xx) threw the real upstream error away and the client got
  "WebAI-to-API unreachable: None"; now the real upstream response is returned.

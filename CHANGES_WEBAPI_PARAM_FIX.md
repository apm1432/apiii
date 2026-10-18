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

## Update (from the live logs)
- Parser now also understands UNQUOTED names: `Unsupported parameter: temperature (code: unsupported_parameter).` and
  OpenAI-style `{"error": {"param": "response_format"}}` (the first version only read quoted names).
- `POST /api/web/v1/responses` returned 404 (WebAI has no such route). It is now converted to chat/completions
  (input_text/input_image -> text/image_url) and the answer is returned in Responses format (incl. SSE when stream=true).
- A WebAI read timeout (Gemini web hung) used to be reported as "not running / crashed"; now it says it timed out.
  `WEBAPI_READ_TIMEOUT` (default 600 s) controls how long a request waits.

## Update 2: response_format keeps its meaning
Before, a 400 on `response_format` made the caller add "[OUTPUT FORMAT]: Reply with ONLY the valid JSON..." to its prompt.
Silently dropping the field removed that safety net (the answer could come back as prose). Now, when `response_format`
(json_object / json_schema) is dropped, the same JSON instruction is appended to the last user message (once).

## Update 3: answers from a logged-out (anonymous) WebAI instance are now visible
When Gemini rejects the cookies, WebAI keeps answering as an anonymous guest (patch 2d/2e): HTTP 200, but nothing is saved in
the Gemini account (no history/activity), and file upload / search do not work (requests can hang). The log row said
"WebAI account '<name>'" so it looked fine. Now: route shows "⚠ NOT LOGGED IN - answered anonymously ...", response header
`X-WebAI-Auth: anonymous`. Env `WEBAI_REQUIRE_AUTH=1` -> never use a logged-out instance (next account, or a clear 424
"cookies expired - paste fresh cookies") instead of answering anonymously.

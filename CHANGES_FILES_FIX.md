# Generated files fix (calculator.html / calculator.py ...)

Problem: Gemini returns only `[file-tag: code-generated-file-...]` in text; the real download url is in
candidate[12][*]["59"] (info[7][1]). gemini-webapi 2.1.1 ignores it, so files never showed (images did).

Changed (all in wapi/):
- webai_capture.py   : extracts field "59" from every candidate (tag, name, mime, download url)
- patch_webai.py     : response builder now adds artifacts {"type":"file","name","mime_type","url"} and replaces
                       `[file-tag: ...]` in text (normal + stream) with markdown link `[calculator.html](url)`
- webai_artifacts.py : /artifacts/fetch accepts `n=<filename>` -> sent as attachment (html is never rendered on your domain)
- smart_router.py    : also makes `](/v1/artifacts/fetch?` links absolute (/api/web/v1/artifacts/fetch?...)

## Fix: "webapi" provider 422 "Input should be a valid string"
Cause: WebAI-to-API only accepts content parts {"type":"text"} and {"type":"file"}; the project sends {"type":"image_url"}.
Fix (wapi/smart_router.py `_webapi_fix_body`): on POST /api/web/v1/.../chat/completions every image_url data-URL part
is converted to {"type":"file","file":{"filename":"image_1.jpg","file_data":"data:..."}}, so Gemini really sees the paper image
and the fallback to the "wapi" provider is no longer needed.

## Fix: HTTP 413 when uploading an image in the WebAI playground
nginx default client_max_body_size is 1m (a 1 MiB image is ~1.4 MB as base64). nginx.conf: `client_max_body_size 60m;`
in /api/web/v1 and /wapi/. Rebuild/redeploy needed.

## More upload types (patch_webai.py step 2c)
WebAI whitelist extended: pptx/ppt/xls, html/css/js/py/java/c/cpp/yaml/ts/sql/rtf, heic/heif/bmp, audio (mp3 wav ogg flac aac m4a),
video (mp4 webm mov avi mpeg). Already allowed upstream: pdf doc docx xlsx json xml txt md csv png jpg webp gif.
Limits stay: 8 files, 20 MiB each, 50 MiB total. Whether Gemini itself accepts a type is up to Gemini.

## Guest mode (no cookies) - patch_webai.py step 2d
Without cookies WebAI had no WebAPI client: the model list showed only `playwright/gemini/*` and every call failed with
"Browser interaction failure" (no Chromium / login state in the image). Now, when no cookie source works, WebAI starts
gemini-webapi anonymously ("guest (no cookies)"). Not unlimited; uploads / file downloads may not work as guest.
Remove saved cookies on /api/web/v1/ui/auth -> after the ~10s restart the webapi models (gemini-flash ...) should be back.

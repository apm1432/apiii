# Generated files fix (calculator.html / calculator.py ...)

Problem: Gemini returns only `[file-tag: code-generated-file-...]` in text; the real download url is in
candidate[12][*]["59"] (info[7][1]). gemini-webapi 2.1.1 ignores it, so files never showed (images did).

Changed (all in wapi/):
- webai_capture.py   : extracts field "59" from every candidate (tag, name, mime, download url)
- patch_webai.py     : response builder now adds artifacts {"type":"file","name","mime_type","url"} and replaces
                       `[file-tag: ...]` in text (normal + stream) with markdown link `[calculator.html](url)`
- webai_artifacts.py : /artifacts/fetch accepts `n=<filename>` -> sent as attachment (html is never rendered on your domain)
- smart_router.py    : also makes `](/v1/artifacts/fetch?` links absolute (/api/web/v1/artifacts/fetch?...)

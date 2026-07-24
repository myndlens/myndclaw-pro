#!/usr/bin/env python3
"""upload-post entrypoint — publish approved content to the user's connected
social platform(s) via the Upload-Post aggregator API. (SB613, social.publish.)

STDLIB ONLY (urllib) — no external dependency, so the skill stays OC-eligible
and the tenant image needs no pip install. Mirrors the official upload-post
Python SDK behaviour over the documented REST API.

PER-TENANT BYOK (Doctrine 1: no hardcoding, no silent failure):
  UPLOAD_POST_API_KEY   the user's own Upload-Post API key   (env, never a literal)
  UPLOAD_POST_PROFILE   the user's Upload-Post profile name   (the `user` param)
Both are injected per-tenant from services/vault.py at container spawn. If either
is missing this exits non-zero with a clear message — it never posts blind.

Platform id(s) come from --platform (mapped from the mandate's channel dim) — the
skill NEVER assumes a single platform (Doctrine 21).

Usage:
  upload.py --kind text  --platform x,linkedin --title "<approved text>"
  upload.py --kind photo --platform instagram  --title "<caption>" --file a.jpg --file b.jpg
  upload.py --kind video --platform tiktok,instagram --title "<caption>" --file clip.mp4
  upload.py --kind document --platform linkedin --title "<title>" --file deck.pdf [--description ...]
  upload.py --status --request-id <id>          # poll an async/scheduled upload

Prints the API JSON response to stdout. On success the response carries a
request_id/job_id plus per-platform post_id + post_url (the post_reference).
"""
import argparse
import json
import os
import sys
import uuid
import urllib.request
import urllib.error

API_BASE = "https://api.upload-post.com/api"

ENDPOINTS = {
    "text": "/upload_text",
    "photo": "/upload_photos",
    "video": "/upload_videos",
    "document": "/upload_document",
}
# multipart file field name per kind (text has no file)
FILE_FIELD = {"photo": "photos[]", "video": "video", "document": "document"}


def _fail(msg, code=2):
    sys.stderr.write("upload-post: %s\n" % msg)
    sys.exit(code)


def _require_env():
    api_key = os.environ.get("UPLOAD_POST_API_KEY", "").strip()
    profile = os.environ.get("UPLOAD_POST_PROFILE", "").strip()
    if not api_key:
        _fail("UPLOAD_POST_API_KEY is not set — the user's key must be injected "
              "from the vault before this skill can run (no blind post).")
    if not profile:
        _fail("UPLOAD_POST_PROFILE is not set — the user's Upload-Post profile "
              "name must be injected before this skill can run.")
    return api_key, profile


def _request(method, path, api_key, *, headers=None, data=None):
    url = API_BASE + path
    hdrs = {"Authorization": "Apikey %s" % api_key}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            body = resp.read().decode("utf-8", "replace")
            return resp.status, body
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        return e.code, body
    except urllib.error.URLError as e:
        _fail("network error reaching Upload-Post: %s" % e.reason, code=3)


def _multipart(fields, files):
    """Encode multipart/form-data with stdlib. fields: list[(name,value)],
    files: list[(field, filepath)]. Returns (content_type, body_bytes)."""
    boundary = "----upload-post-%s" % uuid.uuid4().hex
    crlf = b"\r\n"
    buf = []
    for name, value in fields:
        buf.append(b"--" + boundary.encode())
        buf.append(('Content-Disposition: form-data; name="%s"' % name).encode())
        buf.append(b"")
        buf.append(str(value).encode("utf-8"))
    for field, path in files:
        if not os.path.isfile(path):
            _fail("file not found: %s" % path)
        fname = os.path.basename(path)
        with open(path, "rb") as fh:
            content = fh.read()
        buf.append(b"--" + boundary.encode())
        buf.append(('Content-Disposition: form-data; name="%s"; filename="%s"'
                    % (field, fname)).encode())
        buf.append(b"Content-Type: application/octet-stream")
        buf.append(b"")
        buf.append(content)
    buf.append(b"--" + boundary.encode() + b"--")
    buf.append(b"")
    body = crlf.join(buf)
    return "multipart/form-data; boundary=%s" % boundary, body


def _emit(status, body):
    try:
        parsed = json.loads(body)
    except ValueError:
        parsed = {"raw": body}
    out = {"http_status": status, "ok": 200 <= status < 300, "response": parsed}
    print(json.dumps(out, indent=2))
    sys.exit(0 if out["ok"] else 1)


def do_status(args):
    api_key, _ = _require_env()
    if not args.request_id and not args.job_id:
        _fail("--status needs --request-id or --job-id")
    q = "request_id=%s" % args.request_id if args.request_id else "job_id=%s" % args.job_id
    status, body = _request("GET", "/uploadposts/status?" + q, api_key)
    _emit(status, body)


def do_upload(args):
    api_key, profile = _require_env()
    platforms = [p.strip() for p in args.platform.split(",") if p.strip()]
    if not platforms:
        _fail("--platform is required (map the mandate's channel to platform ids)")
    if not args.title:
        _fail("--title (the approved caption/text) is required")
    path = ENDPOINTS[args.kind]

    if args.kind == "text":
        payload = {"user": profile, "platform": platforms, "title": args.title}
        if args.description:
            payload["description"] = args.description
        if args.scheduled_date:
            payload["scheduled_date"] = args.scheduled_date
        data = json.dumps(payload).encode("utf-8")
        status, body = _request("POST", path, api_key,
                                headers={"Content-Type": "application/json"}, data=data)
        _emit(status, body)

    # media kinds: multipart
    if not args.file:
        _fail("--file is required for kind=%s" % args.kind)
    fields = [("user", profile), ("title", args.title)]
    for p in platforms:
        fields.append(("platform[]", p))
    if args.description:
        fields.append(("description", args.description))
    if args.scheduled_date:
        fields.append(("scheduled_date", args.scheduled_date))
    if args.async_upload:
        fields.append(("async_upload", "true"))
    field = FILE_FIELD[args.kind]
    files = [(field, f) for f in args.file]
    content_type, data = _multipart(fields, files)
    status, body = _request("POST", path, api_key,
                            headers={"Content-Type": content_type}, data=data)
    _emit(status, body)


def main():
    ap = argparse.ArgumentParser(description="Publish content via Upload-Post.")
    ap.add_argument("--kind", choices=list(ENDPOINTS.keys()),
                    help="text | photo | video | document")
    ap.add_argument("--platform", help="comma-separated platform ids "
                    "(x,linkedin,facebook,instagram,tiktok,threads,reddit,bluesky)")
    ap.add_argument("--title", help="the APPROVED caption / post text")
    ap.add_argument("--description", help="extended description / body")
    ap.add_argument("--file", action="append", default=[],
                    help="media file path (repeatable for photos)")
    ap.add_argument("--scheduled-date", dest="scheduled_date",
                    help="ISO-8601 datetime to schedule the post")
    ap.add_argument("--async", dest="async_upload", action="store_true",
                    help="background processing (returns request_id to poll)")
    ap.add_argument("--status", action="store_true", help="poll upload status")
    ap.add_argument("--request-id", dest="request_id", help="for --status")
    ap.add_argument("--job-id", dest="job_id", help="for --status (scheduled)")
    args = ap.parse_args()

    if args.status:
        do_status(args)
    elif args.kind:
        do_upload(args)
    else:
        ap.error("one of --kind or --status is required")


if __name__ == "__main__":
    main()

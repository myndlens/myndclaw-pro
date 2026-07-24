#!/usr/bin/env python3
"""upload-post entrypoint — publish approved content to the user's connected
social platform(s) via the Upload-Post aggregator API. (SB613, social.publish.)

STDLIB ONLY (urllib) — no external dependency, so the skill stays OC-eligible
and the tenant image needs no pip install. Mirrors the official upload-post
Python SDK behaviour over the documented REST API.

PER-TENANT BYOK (Doctrine 1: no hardcoding, no silent failure):
  The user's own Upload-Post API key + profile are fetched AT INVOCATION from the
  Control Plane (GET /api/internal/social-credentials/<tenant> via OBEGEE_API_URL +
  OBEGEE_INTERNAL_KEY + TENANT_ID, already present in the container). The key is
  deliberately NOT placed in the container/gateway environment — it must not be
  visible to the tenant blackbox or other tools; it lives only in THIS process for
  the duration of the post. If Upload-Post is not connected, this exits non-zero with
  a clear message — it never posts blind. (UPLOAD_POST_API_KEY/UPLOAD_POST_PROFILE are
  honored as an env override for local testing only.)

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


def _load_credentials():
    """Resolve the tenant's Upload-Post api_key + profile AT INVOCATION.

    The BYOK key is deliberately NOT placed in the container / gateway environment — it
    must not be visible to the tenant blackbox or any other tool. Instead THIS tool
    fetches it on demand from the Control Plane, so the key lives only in this process
    for the duration of the post. An explicit env override
    (UPLOAD_POST_API_KEY/UPLOAD_POST_PROFILE) is honored first, for local testing.
    """
    api_key = os.environ.get("UPLOAD_POST_API_KEY", "").strip()
    profile = os.environ.get("UPLOAD_POST_PROFILE", "").strip()
    if api_key and profile:
        return api_key, profile

    base = os.environ.get("OBEGEE_API_URL", "").strip().rstrip("/")
    tenant = os.environ.get("TENANT_ID", "").strip()
    internal_key = os.environ.get("OBEGEE_INTERNAL_KEY", "").strip()
    if not (base and tenant and internal_key):
        _fail("Upload-Post credential is not in env and the Control Plane is unreachable "
              "(OBEGEE_API_URL / TENANT_ID / OBEGEE_INTERNAL_KEY missing). Cannot post.")
    url = "%s/api/internal/social-credentials/%s" % (base, tenant)
    req = urllib.request.Request(url, headers={"X-Internal-API-Key": internal_key})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        _fail("Control Plane returned HTTP %s fetching the Upload-Post credential" % e.code, code=3)
    except urllib.error.URLError as e:
        _fail("cannot reach the Control Plane for the Upload-Post credential: %s" % e.reason, code=3)
    up = (data or {}).get("upload_post") or {}
    if not up.get("api_key") or not up.get("profile"):
        _fail("Upload-Post is not connected for this tenant — the user must add their own "
              "Upload-Post API key + profile in the dashboard before publishing.")
    return up["api_key"], up["profile"]


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
    api_key, _ = _load_credentials()
    if not args.request_id and not args.job_id:
        _fail("--status needs --request-id or --job-id")
    q = "request_id=%s" % args.request_id if args.request_id else "job_id=%s" % args.job_id
    status, body = _request("GET", "/uploadposts/status?" + q, api_key)
    _emit(status, body)


def do_upload(args):
    api_key, profile = _load_credentials()
    platforms = [p.strip() for p in args.platform.split(",") if p.strip()]
    if not platforms:
        _fail("--platform is required (map the mandate's channel to platform ids)")
    if not args.title:
        _fail("--title (the approved caption/text) is required")
    path = ENDPOINTS[args.kind]

    # Upload-Post reads form data (not JSON) for every kind — user + platform[] + title,
    # plus optional description / scheduled_date / target_linkedin_page_id.
    fields = [("user", profile), ("title", args.title)]
    for p in platforms:
        fields.append(("platform[]", p))
    if args.description:
        fields.append(("description", args.description))
    if args.scheduled_date:
        fields.append(("scheduled_date", args.scheduled_date))
    if args.linkedin_page_id:
        # Post to a LinkedIn COMPANY PAGE (e.g. myndlensai) instead of the personal feed.
        fields.append(("target_linkedin_page_id", args.linkedin_page_id))

    if args.kind == "text":
        content_type, data = _multipart(fields, [])
    else:
        if not args.file:
            _fail("--file is required for kind=%s" % args.kind)
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
    ap.add_argument("--linkedin-page-id", dest="linkedin_page_id",
                    help="target LinkedIn company Page id (post to a Page, not the personal feed)")
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

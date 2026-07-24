#!/usr/bin/env python3
"""upload-post entrypoint — publish approved content to the user's connected
social platform(s) via the Upload-Post aggregator API, and manage engagement
(list / reply-to / delete comments). (SB613, social.publish + comments.)

STDLIB ONLY (urllib) — no external dependency, so the skill stays OC-eligible
and the tenant image needs no pip install. Mirrors the official upload-post
Python SDK behaviour over the documented REST API. (The SDK does NOT expose the
comments API, and it pulls in `requests` — a non-stdlib dep — so we deliberately
stay on urllib and reach the comments endpoints directly.)

PER-TENANT BYOK (Doctrine 1: no hardcoding, no silent failure):
  The user's own Upload-Post API key + profile are fetched AT INVOCATION from the
  Control Plane (GET /api/internal/social-credentials/<tenant> via OBEGEE_API_URL +
  OBEGEE_INTERNAL_KEY + TENANT_ID, already present in the container). The key is
  deliberately NOT placed in the container/gateway environment — it must not be
  visible to the tenant blackbox or other tools; it lives only in THIS process for
  the duration of the call. If Upload-Post is not connected, this exits non-zero with
  a clear message — it never acts blind. (UPLOAD_POST_API_KEY/UPLOAD_POST_PROFILE are
  honored as an env override for local testing only.)

Platform id(s) come from --platform (mapped from the mandate's channel dim) — the
skill NEVER assumes a single platform (Doctrine 21).

Usage — publish:
  upload.py --kind text  --platform x,linkedin --title "<approved text>"
  upload.py --kind photo --platform instagram  --title "<caption>" --file a.jpg --file b.jpg
  upload.py --kind video --platform tiktok,instagram --title "<caption>" --file clip.mp4
  upload.py --kind document --platform linkedin --title "<title>" --file deck.pdf [--description ...]
  upload.py --kind text --platform linkedin --title "<text>" --linkedin-page-id urn:li:organization:<id>
  upload.py --status --request-id <id>          # poll an async/scheduled upload

Usage — engagement (comments; linkedin/instagram/facebook/youtube only, NOT tiktok):
  upload.py --list-comments --platform linkedin --post-id urn:li:share:<id> [--limit N --after CURSOR]
  upload.py --reply --platform linkedin --post-id urn:li:share:<id> --message "<reply text>"
  upload.py --reply --platform instagram --comment-id <id> --message "<reply>"   # IG requires comment-id
  upload.py --delete-comment --platform linkedin --comment-id <id> --post-id urn:li:share:<id>

Prints the API JSON response to stdout. On a successful publish the response carries a
request_id/job_id plus per-platform post_id + post_url (the post_reference).
"""
import argparse
import json
import os
import sys
import uuid
import urllib.parse
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

# Platforms Upload-Post supports for the comments API (per docs.upload-post.com/api/comments).
# TikTok is explicitly NOT supported for comments.
COMMENT_PLATFORMS = ("instagram", "facebook", "youtube", "linkedin")


def _fail(msg, code=2):
    sys.stderr.write("upload-post: %s\n" % msg)
    sys.exit(code)


def _load_credentials():
    """Resolve the tenant's Upload-Post api_key + profile AT INVOCATION.

    The BYOK key is deliberately NOT placed in the container / gateway environment — it
    must not be visible to the tenant blackbox or any other tool. Instead THIS tool
    fetches it on demand from the Control Plane, so the key lives only in this process
    for the duration of the call. An explicit env override
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
              "(OBEGEE_API_URL / TENANT_ID / OBEGEE_INTERNAL_KEY missing). Cannot proceed.")
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


def _json_request(method, path, api_key, body):
    """POST/DELETE with a JSON body (the comments create/delete endpoints)."""
    data = json.dumps(body).encode("utf-8")
    return _request(method, path, api_key,
                    headers={"Content-Type": "application/json"}, data=data)


def _comment_platform(args):
    """The comments API takes exactly ONE platform (unlike publish, which fans out)."""
    if not args.platform:
        _fail("--platform is required (one of: %s)" % ", ".join(COMMENT_PLATFORMS))
    plats = [p.strip() for p in args.platform.split(",") if p.strip()]
    if len(plats) != 1:
        _fail("the comments API takes exactly ONE --platform, got: %s" % ", ".join(plats))
    plat = plats[0]
    if plat not in COMMENT_PLATFORMS:
        _fail("platform '%s' does not support comments (supported: %s)"
              % (plat, ", ".join(COMMENT_PLATFORMS)))
    return plat


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
    platforms = [p.strip() for p in args.platform.split(",") if p.strip()] if args.platform else []
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


def do_list_comments(args):
    """GET /uploadposts/comments — list comments on a published post.
    Identify the post by --post-id (LinkedIn: the post URN) OR --post-url."""
    api_key, profile = _load_credentials()
    platform = _comment_platform(args)
    if not (args.post_id or args.post_url):
        _fail("--list-comments needs --post-id (the post URN/id) or --post-url")
    q = {"user": profile, "platform": platform}
    if args.post_id:
        q["post_id"] = args.post_id
    if args.post_url:
        q["post_url"] = args.post_url
    if args.limit:
        q["limit"] = args.limit
    if args.after:
        q["after"] = args.after
    status, body = _request("GET", "/uploadposts/comments?" + urllib.parse.urlencode(q), api_key)
    _emit(status, body)


def do_comment(args):
    """POST /uploadposts/comments/create — reply-to / comment on a post.
    Body: platform, user, message, and EXACTLY ONE of comment_id / post_id / post_url.
    LinkedIn: post_id is the post URN. Instagram: only replies (must pass --comment-id)."""
    api_key, profile = _load_credentials()
    platform = _comment_platform(args)
    if not args.message:
        _fail("--reply needs --message (the reply text)")
    targets = [t for t in (args.comment_id, args.post_id, args.post_url) if t]
    if len(targets) != 1:
        _fail("--reply needs EXACTLY ONE of --comment-id, --post-id, or --post-url")
    if platform == "instagram" and not args.comment_id:
        _fail("Instagram supports replies only — pass --comment-id")
    body = {"platform": platform, "user": profile, "message": args.message}
    if args.comment_id:
        body["comment_id"] = args.comment_id
    elif args.post_id:
        body["post_id"] = args.post_id
    else:
        body["post_url"] = args.post_url
    status, resp = _json_request("POST", "/uploadposts/comments/create", api_key, body)
    _emit(status, resp)


def do_delete_comment(args):
    """DELETE /uploadposts/comments/delete — remove a comment (moderation).
    Body: platform, user, comment_id; post_id required for LinkedIn (the post URN)."""
    api_key, profile = _load_credentials()
    platform = _comment_platform(args)
    if not args.comment_id:
        _fail("--delete-comment needs --comment-id")
    if platform == "linkedin" and not args.post_id:
        _fail("LinkedIn delete needs --post-id (the post URN) alongside --comment-id")
    body = {"platform": platform, "user": profile, "comment_id": args.comment_id}
    if args.post_id:
        body["post_id"] = args.post_id
    status, resp = _json_request("DELETE", "/uploadposts/comments/delete", api_key, body)
    _emit(status, resp)


def main():
    ap = argparse.ArgumentParser(description="Publish + manage engagement via Upload-Post.")
    # ---- publish ----
    ap.add_argument("--kind", choices=list(ENDPOINTS.keys()),
                    help="text | photo | video | document")
    ap.add_argument("--platform", help="platform ids. Publish: comma-separated "
                    "(x,linkedin,facebook,instagram,tiktok,threads,reddit,bluesky). "
                    "Comments: exactly one of instagram,facebook,youtube,linkedin")
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
    # ---- status ----
    ap.add_argument("--status", action="store_true", help="poll upload status")
    ap.add_argument("--request-id", dest="request_id", help="for --status")
    ap.add_argument("--job-id", dest="job_id", help="for --status (scheduled)")
    # ---- comments (engagement) ----
    ap.add_argument("--list-comments", dest="list_comments", action="store_true",
                    help="list comments on a post (needs --platform + --post-id/--post-url)")
    ap.add_argument("--reply", action="store_true",
                    help="reply-to / comment on a post (needs --platform + --message + one target)")
    ap.add_argument("--delete-comment", dest="delete_comment", action="store_true",
                    help="delete a comment (needs --platform + --comment-id; LinkedIn also --post-id)")
    ap.add_argument("--post-id", dest="post_id",
                    help="post identifier — LinkedIn: the post URN (urn:li:share:... / urn:li:ugcPost:...)")
    ap.add_argument("--post-url", dest="post_url", help="post URL (alternative to --post-id)")
    ap.add_argument("--comment-id", dest="comment_id",
                    help="comment id — reply target (Instagram) or delete target")
    ap.add_argument("--message", help="the reply/comment text (for --reply)")
    ap.add_argument("--limit", help="max comments per page (for --list-comments)")
    ap.add_argument("--after", help="pagination cursor (for --list-comments)")
    args = ap.parse_args()

    if args.status:
        do_status(args)
    elif args.list_comments:
        do_list_comments(args)
    elif args.reply:
        do_comment(args)
    elif args.delete_comment:
        do_delete_comment(args)
    elif args.kind:
        do_upload(args)
    else:
        ap.error("one of --kind, --status, --list-comments, --reply, or --delete-comment is required")


if __name__ == "__main__":
    main()

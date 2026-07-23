#!/usr/bin/env python3
"""news-rss — general international news from trusted RSS feeds.

Keyless. Python stdlib only (urllib + xml.etree) — NO requests/bs4, NO API key,
so it runs anywhere python3 does (incl. the OC tenant runtime, which does not
carry search-provider keys). Fetches BBC / NPR / Al Jazeera / Reuters feeds and
emits a uniform JSON list. Data-only: this skill produces news, it never sends.

Sources are trusted INTERNATIONAL outlets (Western / Global-South) — deliberately
NO Chinese sources (Captain, 2026-07-23).
"""
import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

# SEC-style declared identity; env-overridable, never a spoofed browser UA.
USER_AGENT = os.environ.get("NEWS_RSS_UA", "MyndLens Research contact@myndlens.com")

# topic -> [(source, url)]. Trusted international outlets only; no Chinese sources.
FEEDS = {
    "top": [
        ("BBC", "https://feeds.bbci.co.uk/news/rss.xml"),
        ("NPR", "https://feeds.npr.org/1001/rss.xml"),
    ],
    "world": [
        ("BBC", "https://feeds.bbci.co.uk/news/world/rss.xml"),
        ("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"),
    ],
    "business": [
        ("BBC", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    ],
    "technology": [
        ("BBC", "https://feeds.bbci.co.uk/news/technology/rss.xml"),
    ],
}
TOPICS = list(FEEDS.keys())


def _secure_ctx() -> ssl.SSLContext:
    # TLS verification is ALWAYS on — no insecure fallback (Doctrine 1).
    return ssl.create_default_context()


def _fetch(url: str, timeout: int = 15) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_secure_ctx()) as resp:
            return resp.read()
    except ssl.SSLError as e:
        raise ConnectionError("TLS verification failed for %s: %s" % (url, e)) from e
    except urllib.error.HTTPError as e:
        raise ConnectionError("HTTP %s fetching %s: %s" % (e.code, url, e.reason)) from e
    except Exception as e:  # noqa: BLE001 — surface any transport failure, never swallow
        raise ConnectionError("Failed to fetch %s: %s" % (url, e)) from e


def _iso(pubdate: str) -> str:
    if not pubdate:
        return ""
    try:
        dt = parsedate_to_datetime(pubdate)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        return pubdate.strip()


def _parse(raw: bytes, source: str) -> list:
    root = ET.fromstring(raw)
    out = []
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        desc = (item.findtext("description") or "").strip()
        pub = (item.findtext("pubDate") or "").strip()
        if not title:
            continue
        out.append({
            "title": title,
            "source": source,
            "url": link,
            "published": _iso(pub),
            "summary": desc,
        })
    return out


def fetch_news(topic: str, query: str = "", limit: int = 20) -> dict:
    feeds = []
    if topic == "all":
        for t in TOPICS:
            feeds.extend(FEEDS[t])
    else:
        feeds = FEEDS.get(topic, [])
    if not feeds:
        raise ValueError("unknown topic %r — valid: %s, all" % (topic, ", ".join(TOPICS)))

    items, failed = [], []
    seen = set()
    for source, url in feeds:
        try:
            for it in _parse(_fetch(url), source):
                key = it["title"].lower()
                if key not in seen:
                    seen.add(key)
                    items.append(it)
        except Exception as e:  # noqa: BLE001
            # Doctrine 1: a failed source is DISCLOSED, never silently dropped.
            failed.append({"source": source, "url": url, "error": str(e)[:160]})

    if query:
        q = query.lower()
        items = [it for it in items
                 if q in it["title"].lower() or q in it["summary"].lower()]

    items.sort(key=lambda it: it.get("published", ""), reverse=True)

    if not items and failed:
        # Every source failed — fail loud rather than return an empty success.
        raise ConnectionError(
            "all %d news sources failed for topic %r: %s"
            % (len(failed), topic, "; ".join("%s(%s)" % (f["source"], f["error"]) for f in failed)))

    return {
        "topic": topic,
        "query": query or None,
        "generated": datetime.now(timezone.utc).isoformat(),
        "count": len(items[:limit]),
        "sources_failed": failed,
        "items": items[:limit],
    }


def main():
    p = argparse.ArgumentParser(description="Fetch general international news from trusted RSS feeds (keyless).")
    p.add_argument("--topic", choices=TOPICS + ["all"], default="all")
    p.add_argument("--query", type=str, default="", help="case-insensitive keyword filter")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--output", choices=["json", "table"], default="json")
    args = p.parse_args()

    try:
        data = fetch_news(args.topic, args.query, args.limit)
    except ValueError as e:
        print("ERROR: %s" % e, file=sys.stderr)
        sys.exit(1)
    except ConnectionError as e:
        print("NETWORK: %s" % e, file=sys.stderr)
        sys.exit(2)

    if args.output == "json":
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        # progress/headers to stderr so table stdout stays clean if piped
        print("  %s news | %d items | %s" % (data["topic"], data["count"], data["generated"]), file=sys.stderr)
        for it in data["items"]:
            print("- [%s] %s\n  %s" % (it["source"], it["title"], it["url"]))
    if data.get("sources_failed"):
        print("  NOTE: %d source(s) failed: %s"
              % (len(data["sources_failed"]), ", ".join(f["source"] for f in data["sources_failed"])),
              file=sys.stderr)


if __name__ == "__main__":
    main()

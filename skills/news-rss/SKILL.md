---
name: news-rss
description: "General international NEWS from trusted RSS feeds (BBC, NPR, Al Jazeera, Reuters) — world, business, technology, top stories. Keyless, python stdlib only. Use for recent news on a topic or a keyword. NOT for: financial-statement fundamentals (us-stock-financials), market quotes, or social posts. No Chinese sources."
version: 1.0.0-myndlens
metadata: {"openclaw":{"emoji":"📰","requires":{"bins":["python3"],"env":[]}}}
---

# News (RSS)

Keyless general international news. Python stdlib only (urllib + xml.etree) — no
API key, no `requests`/`bs4`, so it runs wherever python3 does. Data-only: this
skill produces news, it never sends. Trusted international outlets only; NO
Chinese sources.

## Usage

```bash
# Recent world/top news (default: all topics, JSON)
python3 scripts/news_rss.py --output json

# A specific topic
python3 scripts/news_rss.py --topic world --limit 15 --output json
python3 scripts/news_rss.py --topic business --output json
python3 scripts/news_rss.py --topic technology --output json

# Keyword filter across the fetched feeds
python3 scripts/news_rss.py --topic all --query "election" --output json
```

## Output (JSON)

`{topic, query, generated, count, sources_failed, items:[{title, source, url, published, summary}]}`

- `published` is ISO-8601 UTC. `sources_failed` DISCLOSES any feed that could not
  be fetched (Doctrine 1 — never a silent drop). Exit 2 = every source failed
  (report honestly, never invent headlines).

## Topics

`top` (BBC + NPR) · `world` (BBC + Al Jazeera) · `business` (BBC) · `technology` (BBC) · `all`

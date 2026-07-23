---
name: tech-news-digest
description: "Multi-source TECH / AI / developer / crypto news aggregator from ~73 curated non-Chinese RSS feeds (blogs, Hacker News, TechCrunch, The Verge, Ars Technica, r/MachineLearning). Keyless RSS core. Use for a tech/AI briefing or a scan of what is hot in tech. NOT for general world news (news-rss), financial headlines (finance-news), or a named ticker (us-stock-financials)."
version: 3.16.0-myndlens
metadata: {"openclaw":{"emoji":"🗞️","requires":{"bins":["python3"]}}}
---

# Tech News Digest — MyndLens RSS-only adaptation

MyndLens SB520: **DATA LEGS ONLY.** Adapted from tech-news-digest 3.16.0
(github.com/draco-agent/tech-news-digest). REMOVED from upstream: fetch-twitter /
fetch-web (need API keys), fetch-github (GitHub-App auth via openssl), fetch-reddit,
generate-pdf (weasyprint), send-email (msmtp), and the merge / summarize / enrich /
orchestrator legs — delivery is CP-owned Tier-1 and summarization is the agent's own
reasoning. KEPT: the keyless RSS core only. 3 Chinese feeds removed (Captain, avoid
Chinese). Data-only: this skill produces news, it never sends.

## Usage

```bash
python3 scripts/fetch-rss.py --defaults config/defaults --hours 48 --output /tmp/tnd.json && cat /tmp/tnd.json
```

## Output (JSON)

`{generated, sources_ok, sources_total, total_articles, feedparser_available, sources:[{name, url, articles:[{title, url, published, summary}]}]}`

## Sources

~73 curated non-Chinese tech/AI RSS feeds (`config/defaults/sources.json`): Simon
Willison, Hugging Face, OpenAI, Google AI, Hacker News, TechCrunch, The Verge, Ars
Technica, Krebs on Security, r/MachineLearning, and more. Add / remove via that config.

## Dependencies

python3 + feedparser (pinned in the tenant image; stdlib urllib + regex fallback if
absent). No API key. No network egress beyond the RSS hosts.

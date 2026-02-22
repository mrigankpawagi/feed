#!/usr/bin/env python3
"""Fetch RSS/Atom feeds listed in feeds.js and write feed_data.json.

Uses only the Python standard library — no pip dependencies required.
Feeds are fetched in parallel via ThreadPoolExecutor.
"""

import html
import json
import re
import sys
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.request import Request, urlopen

# ── Configuration ────────────────────────────────────────────────────
REPO_DIR = Path(__file__).resolve().parent.parent
FEEDS_JS = REPO_DIR / "feeds.js"
OUTPUT = REPO_DIR / "feed_data.json"
EXCERPT_LEN = 300
FETCH_TIMEOUT = 60  # seconds per feed

# XML namespace prefixes used by common RSS extensions
NS = {
    "dc": "http://purl.org/dc/elements/1.1/",
    "content": "http://purl.org/rss/1.0/modules/content/",
}


# ── Helpers ──────────────────────────────────────────────────────────
def parse_feeds_js(path: Path) -> list[dict]:
    """Extract [{name, url}, ...] from the FEEDS array in feeds.js."""
    text = path.read_text(encoding="utf-8")
    feeds = []
    for m in re.finditer(
        r'name:\s*"([^"]+)"[^}]*url:\s*"([^"]+)"', text, re.DOTALL
    ):
        feeds.append({"name": m.group(1), "url": m.group(2)})
    return feeds


def strip_html(text: str) -> str:
    """Remove HTML tags and decode entities into plain text."""
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _el_text(parent, tag: str) -> str | None:
    """Return trimmed text of the first child matching *tag*, or None."""
    child = parent.find(tag)
    if child is not None and child.text:
        return child.text.strip()
    return None


def normalize_date(raw: str | None) -> str | None:
    """Best-effort conversion of an RSS/Atom date string to ISO-8601."""
    if not raw:
        return None
    # email.utils handles RFC-822 dates (the most common RSS format)
    try:
        return parsedate_to_datetime(raw.strip()).isoformat()
    except Exception:
        pass
    # ISO-8601 variants used by Atom and some RSS feeds
    for fmt in (
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S.%f%z",
        "%Y-%m-%d %H:%M:%S%z",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(raw.strip(), fmt).isoformat()
        except ValueError:
            continue
    return raw  # return as-is so the frontend can try new Date()


# ── Feed parsing ─────────────────────────────────────────────────────
def parse_rss(root, feed_name: str) -> list[dict]:
    articles = []
    for item in root.iter("item"):
        title = _el_text(item, "title") or "Untitled"
        link = _el_text(item, "link") or "#"
        date = _el_text(item, "pubDate") or _el_text(item, f"{{{NS['dc']}}}date")
        desc = (
            _el_text(item, f"{{{NS['content']}}}encoded")
            or _el_text(item, "description")
            or ""
        )
        author = (
            _el_text(item, "author")
            or _el_text(item, f"{{{NS['dc']}}}creator")
            or ""
        )
        articles.append(
            {
                "feed": feed_name,
                "title": title,
                "link": link,
                "date": normalize_date(date),
                "excerpt": strip_html(desc)[:EXCERPT_LEN],
                "author": author,
            }
        )
    return articles


def parse_atom(root, feed_name: str) -> list[dict]:
    # Detect namespace (may or may not be present)
    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"

    articles = []
    for entry in root.iter(f"{ns}entry"):
        title = _el_text(entry, f"{ns}title") or "Untitled"

        link = "#"
        for lnk in entry.iter(f"{ns}link"):
            href = lnk.get("href", "")
            if lnk.get("rel", "alternate") == "alternate" and href:
                link = href
                break
            if href and link == "#":
                link = href

        date = _el_text(entry, f"{ns}updated") or _el_text(entry, f"{ns}published")
        content = (
            _el_text(entry, f"{ns}content")
            or _el_text(entry, f"{ns}summary")
            or ""
        )
        author_el = entry.find(f"{ns}author")
        author = _el_text(author_el, f"{ns}name") if author_el is not None else ""

        articles.append(
            {
                "feed": feed_name,
                "title": title,
                "link": link,
                "date": normalize_date(date),
                "excerpt": strip_html(content)[:EXCERPT_LEN],
                "author": author or "",
            }
        )
    return articles


# ── Fetch a single feed ──────────────────────────────────────────────
def fetch_feed(feed: dict) -> dict:
    """Fetch and parse one feed.  Returns {feed, articles, error}."""
    name, url = feed["name"], feed["url"]
    try:
        req = Request(url, headers={"User-Agent": "FeedFetcher/1.0"})
        with urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            raw = resp.read()
    except Exception as e:
        return {"feed": name, "articles": [], "error": str(e)}

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")

    # Strip BOM and illegal XML control characters
    text = text.lstrip("\ufeff")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
    # Escape bare '&' not already part of a valid XML entity
    text = re.sub(
        r"&(?!(?:amp|lt|gt|apos|quot|#\d+|#x[0-9a-fA-F]+);)", "&amp;", text
    )

    try:
        root = ET.fromstring(text)
    except ET.ParseError as e:
        return {"feed": name, "articles": [], "error": f"XML parse error: {e}"}

    if root.tag == "{http://www.w3.org/2005/Atom}feed" or root.tag == "feed":
        articles = parse_atom(root, name)
    else:
        articles = parse_rss(root, name)

    return {"feed": name, "articles": articles, "error": None}


# ── Main ─────────────────────────────────────────────────────────────
def main():
    feeds = parse_feeds_js(FEEDS_JS)
    if not feeds:
        print("No feeds found in feeds.js", file=sys.stderr)
        sys.exit(1)

    print(f"Fetching {len(feeds)} feeds in parallel...")

    results = []
    with ThreadPoolExecutor(max_workers=len(feeds)) as pool:
        futures = {pool.submit(fetch_feed, f): f for f in feeds}
        for future in as_completed(futures):
            r = future.result()
            status = (
                f"{len(r['articles'])} articles"
                if not r["error"]
                else f"ERROR: {r['error']}"
            )
            print(f"  {r['feed']}: {status}")
            results.append(r)

    all_articles = []
    errors = {}
    for r in results:
        all_articles.extend(r["articles"])
        if r["error"]:
            errors[r["feed"]] = r["error"]

    output = {
        "lastUpdated": datetime.now(tz=timezone.utc).isoformat(),
        "articles": all_articles,
        "errors": errors,
    }
    OUTPUT.write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nWrote {len(all_articles)} articles to {OUTPUT.name}")
    if errors:
        print(f"Feed errors: {json.dumps(errors, indent=2)}")


if __name__ == "__main__":
    main()

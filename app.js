// CORS proxies used to bypass browser restrictions on direct RSS fetching (tried in order)
const CORS_PROXIES = [
  "https://corsproxy.io/?url=",
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.org/?url=",
];

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT_MS = 45000; // 45-second timeout per proxy attempt

let allArticles = []; // { feed, title, link, date, excerpt, author }
let activeTab = "all";
let feedErrors = {}; // feed.name -> { feed, error }

async function fetchWithProxy(url) {
  // Race all proxies in parallel; each has its own timeout.
  // The first proxy to return a successful response wins.
  const controllers = CORS_PROXIES.map(() => new AbortController());
  const timers = controllers.map((c) =>
    setTimeout(() => c.abort(), FETCH_TIMEOUT_MS)
  );

  const promises = CORS_PROXIES.map(async (proxy, i) => {
    try {
      const res = await fetch(proxy + encodeURIComponent(url), {
        signal: controllers[i].signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Read the full body here so the signal stays live while streaming
      const text = await res.text();
      // Reject empty / too-short responses (some proxies return 200 with no body)
      const trimmed = text.trimStart();
      if (trimmed.length < 50) {
        throw new Error("Proxy returned empty or too-short response");
      }
      // Reject HTML responses (proxy error pages) so Promise.any tries the next proxy
      if (/^<!DOCTYPE\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
        throw new Error("Proxy returned HTML instead of feed content");
      }
      return text;
    } finally {
      clearTimeout(timers[i]);
    }
  });

  try {
    const text = await Promise.any(promises);
    // Cancel any still-in-flight proxy requests and their timers
    controllers.forEach((c) => c.abort());
    timers.forEach((t) => clearTimeout(t));
    return { ok: true, text: () => Promise.resolve(text) };
  } catch (e) {
    const reasons =
      e instanceof AggregateError
        ? e.errors.map((err) => err.message).join("; ")
        : String(e);
    throw new Error(`Failed to fetch ${url}: all proxies failed (${reasons})`);
  }
}

function cacheKey(feed) {
  return `feed:${feed.url}`;
}

function readCache(feed) {
  try {
    const raw = localStorage.getItem(cacheKey(feed));
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) return null;
    return data.map((a) => ({ ...a, date: a.date ? new Date(a.date) : null }));
  } catch {
    return null;
  }
}

function writeCache(feed, articles) {
  try {
    localStorage.setItem(
      cacheKey(feed),
      JSON.stringify({
        data: articles.map((a) => ({
          ...a,
          date: a.date ? a.date.toISOString() : null,
        })),
        ts: Date.now(),
      })
    );
  } catch {
    // ignore storage errors (e.g. quota exceeded)
  }
}

async function fetchFeed(feed) {
  let text;
  try {
    const res = await fetchWithProxy(feed.url);
    text = await res.text();
  } catch (e) {
    // If the RSS feed is unreachable but a lightweight homepage is configured,
    // scrape article links from the homepage instead.
    if (feed.homepageUrl) return fetchFromHomepage(feed);
    throw e;
  }

  // Strip UTF-8 BOM and illegal XML control characters
  // (keep tab \x09, newline \x0A, carriage return \x0D)
  text = text.replace(/^\ufeff/, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

  const parser = new DOMParser();

  // Attempt 1: parse as-is (well-formed feeds succeed here)
  let doc = parser.parseFromString(text, "application/xml");

  if (doc.querySelector("parsererror")) {
    // Attempt 2: escape bare '&' not already part of a valid XML entity
    // (covers bare & in URLs and undefined HTML entities like &nbsp;)
    const fixed = text.replace(
      /&(?!(amp|lt|gt|apos|quot|#\d+|#x[0-9a-fA-F]+);)/g,
      "&amp;"
    );
    doc = parser.parseFromString(fixed, "application/xml");

    if (doc.querySelector("parsererror")) {
      // Attempt 3: wrap elements that commonly hold raw HTML in CDATA sections
      // so that embedded HTML tags and bare < / > no longer break XML parsing.
      doc = parser.parseFromString(wrapHtmlContentInCDATA(fixed), "application/xml");
    }
  }

  if (doc.querySelector("parsererror")) {
    // Attempt 4: regex-based fallback (handles truncated or malformed XML
    // that DOMParser cannot recover, e.g. large feeds cut short by proxies)
    const regexArticles = parseFeedWithRegex(text, feed);
    if (regexArticles.length > 0) return regexArticles;
    throw new Error("Invalid XML received from feed");
  }

  // Support both RSS and Atom
  const isAtom = !!doc.querySelector("feed");
  const entries = isAtom
    ? Array.from(doc.querySelectorAll("entry"))
    : Array.from(doc.querySelectorAll("item"));

  return entries.map((entry) => {
    let title, link, date, excerpt, author;

    if (isAtom) {
      title = entry.querySelector("title")?.textContent?.trim() || "Untitled";
      link =
        entry.querySelector('link[rel="alternate"]')?.getAttribute("href") ||
        entry.querySelector("link")?.getAttribute("href") ||
        entry.querySelector("link")?.textContent?.trim() ||
        "#";
      date = entry.querySelector("updated,published")?.textContent?.trim();
      const content =
        entry.querySelector("content,summary")?.textContent?.trim() || "";
      excerpt = stripHtml(content).slice(0, 220);
      author = entry.querySelector("author name")?.textContent?.trim() || "";
    } else {
      title = entry.querySelector("title")?.textContent?.trim() || "Untitled";
      link = entry.querySelector("link")?.textContent?.trim() || "#";
      date = entry.querySelector("pubDate,dc\\:date,date")?.textContent?.trim();
      const desc =
        entry.querySelector("description,content\\:encoded")?.textContent?.trim() || "";
      excerpt = stripHtml(desc).slice(0, 220);
      author =
        entry.querySelector("author,dc\\:creator")?.textContent?.trim() || "";
    }

    return {
      feed: feed.name,
      title,
      link,
      date: parseDate(date),
      excerpt,
      author,
    };
  });
}

// Wraps elements that commonly contain raw HTML in CDATA sections so that
// embedded HTML tags and unescaped < / > characters do not break XML parsing.
function wrapHtmlContentInCDATA(xml) {
  const htmlTags = ["description", "content", "summary", "encoded"];
  let result = xml;
  for (const tag of htmlTags) {
    result = result.replace(
      new RegExp(
        `(<(?:[a-zA-Z]+:)?${tag}(?:\\s[^>]*)?>)([\\s\\S]*?)(<\\/(?:[a-zA-Z]+:)?${tag}>)`,
        "gi"
      ),
      (_, open, content, close) => {
        // Skip elements already wrapped in CDATA
        if (/^\s*<!\[CDATA\[/.test(content)) return _;
        // Escape any ]]> in the content to prevent premature CDATA section close;
        // the standard XML technique is to split it across two adjacent CDATA sections.
        const safe = content.replace(/\]\]>/g, "]]]]><![CDATA[>");
        return `${open}<![CDATA[${safe}]]>${close}`;
      }
    );
  }
  return result;
}

// ── Regex-based fallback feed parser ──────────────────────────────
// Used when DOMParser fails (e.g. truncated responses from CORS proxies).
// Extracts complete <item>/<entry> blocks via regex — partial trailing
// items are silently skipped because the closing tag is never found.
function parseFeedWithRegex(text, feed) {
  const isAtom = /<feed[\s>]/i.test(text) && !/<rss[\s>]/i.test(text);
  const blockRe = isAtom
    ? /<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi
    : /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi;

  const articles = [];
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const b = m[0];
    let title, link, date, content, author;

    if (isAtom) {
      title = rxText(b, "title") || "Untitled";
      link = rxAtomLink(b);
      date = rxText(b, "updated") || rxText(b, "published");
      content = rxText(b, "content") || rxText(b, "summary") || "";
      author = rxNested(b, "author", "name");
    } else {
      title = rxText(b, "title") || "Untitled";
      link = rxText(b, "link") || "#";
      date = rxText(b, "pubDate") || rxText(b, "dc\\:date") || rxText(b, "date");
      content = rxText(b, "description") || rxText(b, "content\\:encoded") || "";
      author = rxText(b, "author") || rxText(b, "dc\\:creator") || "";
    }

    articles.push({
      feed: feed.name,
      title,
      link,
      date: parseDate(date),
      excerpt: stripHtml(content).slice(0, 220),
      author,
    });
  }
  return articles;
}

function rxText(xml, tag) {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "i"
  );
  const m = xml.match(re);
  if (!m) return "";
  let c = m[1].trim();
  const cd = c.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cd) c = cd[1];
  return c
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    );
}

function rxAtomLink(xml) {
  const alt =
    xml.match(
      /<link[^>]*rel\s*=\s*["']alternate["'][^>]*href\s*=\s*["']([^"']+)["']/i
    ) ||
    xml.match(
      /<link[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']alternate["']/i
    );
  if (alt) return alt[1];
  const any = xml.match(/<link[^>]*href\s*=\s*["']([^"']+)["']/i);
  return any ? any[1] : rxText(xml, "link") || "#";
}

function rxNested(xml, parent, child) {
  const re = new RegExp(`<${parent}[\\s>][\\s\\S]*?<\\/${parent}>`, "i");
  const m = xml.match(re);
  return m ? rxText(m[0], child) : "";
}

// Fallback: scrape article links from a blog homepage when the RSS feed
// is too large for CORS proxies (e.g. Dan Luu's 6 MB full-text feed).
async function fetchFromHomepage(feed) {
  const res = await fetchWithProxy(feed.homepageUrl);
  const html = await res.text();
  const articles = [];
  // Match dated article links: <d>MM/YY</d><a href=...>...</a>  (Dan Luu style)
  const re = /<d>(\d{2})\/(\d{2})<\/d>\s*<a\s+href=["']?([^"'>\s]+)["']?[^>]*>([^<]+)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, month, shortYear, link, title] = m;
    if (!link || link.startsWith("#")) continue;
    const year = +shortYear < 70 ? 2000 + +shortYear : 1900 + +shortYear;
    articles.push({
      feed: feed.name,
      title: title.trim(),
      link: link.startsWith("http") ? link : new URL(link, feed.homepageUrl).href,
      date: new Date(year, +month - 1),
      excerpt: "",
      author: "",
    });
  }
  return articles;
}

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || div.innerText || "";
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(date) {
  if (!date) return "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function sortArticles() {
  allArticles.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date - a.date;
  });
}

function buildTabs() {
  const tabs = document.getElementById("tabs");
  tabs.innerHTML = "";

  // "All" tab
  const allTab = document.createElement("button");
  allTab.className = "tab" + (activeTab === "all" ? " active" : "");
  allTab.setAttribute("role", "tab");
  allTab.setAttribute("aria-selected", activeTab === "all" ? "true" : "false");
  allTab.textContent = "All";
  allTab.onclick = () => setTab("all");
  tabs.appendChild(allTab);

  // Per-feed tabs
  FEEDS.forEach((f) => {
    const btn = document.createElement("button");
    btn.className = "tab" + (activeTab === f.name ? " active" : "");
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", activeTab === f.name ? "true" : "false");
    btn.textContent = f.name;
    btn.onclick = () => setTab(f.name);
    tabs.appendChild(btn);
  });
}

function setTab(name) {
  activeTab = name;
  buildTabs();
  renderArticles();
}

function renderArticles() {
  const container = document.getElementById("articles-container");
  container.innerHTML = "";

  // Show any feed errors/warnings in a collapsible dropdown
  const errorValues = Object.values(feedErrors);
  if (errorValues.length > 0) {
    const details = document.createElement("details");
    details.className = "issues-details";
    const summary = document.createElement("summary");
    summary.className = "issues-summary";
    const errorCount = errorValues.filter((v) => !v.stale).length;
    const warnCount = errorValues.filter((v) => v.stale).length;
    const parts = [];
    if (errorCount > 0) parts.push(`${errorCount} error${errorCount !== 1 ? "s" : ""}`);
    if (warnCount > 0) parts.push(`${warnCount} warning${warnCount !== 1 ? "s" : ""}`);
    summary.textContent = parts.join(", ");
    details.appendChild(summary);

    errorValues.forEach(({ feed, error, stale }) => {
      const err = document.createElement("div");
      if (stale) {
        err.className = "stale-msg";
        err.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span>Showing cached data for <strong>${escapeHtml(feed.name)}</strong>: could not refresh (${escapeHtml(error.message)})</span>`;
      } else {
        err.className = "error-msg";
        err.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg><span>Failed to load <strong>${escapeHtml(feed.name)}</strong>: ${escapeHtml(error.message)}</span>`;
      }
      details.appendChild(err);
    });

    container.appendChild(details);
  }

  const filtered =
    activeTab === "all"
      ? allArticles
      : allArticles.filter((a) => a.feed === activeTab);

  if (filtered.length === 0) {
    if (Object.keys(feedErrors).length === 0) {
      const status = document.createElement("div");
      status.className = "status";
      status.textContent = "No articles found.";
      container.appendChild(status);
    }
    return;
  }

  const list = document.createElement("div");
  list.className = "articles";
  filtered.forEach((a) =>
    list.appendChild(makeCard(a, activeTab === "all"))
  );
  container.appendChild(list);
}

function makeCard(article, showFeedBadge) {
  const a = document.createElement("a");
  a.className = "article-card";
  a.href = article.link;
  a.target = "_blank";
  a.rel = "noopener noreferrer";

  const meta = document.createElement("div");
  meta.className = "article-meta";
  if (showFeedBadge) {
    const badge = document.createElement("span");
    badge.className = "feed-badge";
    badge.textContent = article.feed;
    meta.appendChild(badge);
  }
  if (article.date) {
    const dateEl = document.createElement("span");
    dateEl.className = "article-date";
    dateEl.textContent = formatDate(article.date);
    meta.appendChild(dateEl);
  }

  const title = document.createElement("div");
  title.className = "article-title";
  title.textContent = article.title;

  a.appendChild(meta);
  a.appendChild(title);

  if (article.excerpt) {
    const exc = document.createElement("div");
    exc.className = "article-excerpt";
    exc.textContent = article.excerpt;
    a.appendChild(exc);
  }

  if (article.author) {
    const auth = document.createElement("div");
    auth.className = "article-author";
    auth.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>${escapeHtml(article.author)}`;
    a.appendChild(auth);
  }

  return a;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadAllFeeds() {
  const btn = document.getElementById("btn-refresh");
  btn.classList.add("spinning");
  const container = document.getElementById("articles-container");

  feedErrors = {};
  allArticles = [];

  // Show cached articles immediately while fetching fresh data
  const cachedFeeds = new Set();
  FEEDS.forEach((feed) => {
    const cached = readCache(feed);
    if (cached) {
      allArticles.push(...cached);
      cachedFeeds.add(feed.name);
    }
  });
  sortArticles();

  if (allArticles.length > 0) {
    renderArticles();
  } else {
    container.innerHTML = `<div class="status"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>Loading feeds…</div>`;
  }

  // Fetch all feeds in parallel; update the view as each one completes
  await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const articles = await fetchFeed(feed);
        writeCache(feed, articles);
        // Replace this feed's articles with the freshly fetched ones
        allArticles = allArticles.filter((a) => a.feed !== feed.name);
        allArticles.push(...articles);
        sortArticles();
        renderArticles();
      } catch (e) {
        feedErrors[feed.name] = { feed, error: e, stale: cachedFeeds.has(feed.name) };
        renderArticles();
      }
    })
  );

  btn.classList.remove("spinning");
}

document.addEventListener("DOMContentLoaded", () => {
  buildTabs();
  loadAllFeeds();
  document.getElementById("btn-refresh").addEventListener("click", loadAllFeeds);
});

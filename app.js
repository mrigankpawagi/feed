// CORS proxies used to bypass browser restrictions on direct RSS fetching (tried in order)
const CORS_PROXIES = [
  "https://corsproxy.io/?",
  "https://api.allorigins.win/raw?url=",
];

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT_MS = 10000; // 10-second timeout per proxy attempt

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
  const res = await fetchWithProxy(feed.url);
  const text = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "application/xml");

  const parserError = doc.querySelector("parsererror");
  if (parserError) {
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

  // Show any feed errors
  Object.values(feedErrors).forEach(({ feed, error, stale }) => {
    const err = document.createElement("div");
    if (stale) {
      err.className = "stale-msg";
      err.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Showing cached data for <strong>${escapeHtml(feed.name)}</strong>: could not refresh (${escapeHtml(error.message)})`;
    } else {
      err.className = "error-msg";
      err.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>Failed to load <strong>${escapeHtml(feed.name)}</strong>: ${escapeHtml(error.message)}`;
    }
    container.appendChild(err);
  });

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

  // In "all" view, group by feed if multiple feeds
  if (activeTab === "all" && FEEDS.length > 1) {
    const byFeed = {};
    FEEDS.forEach((f) => (byFeed[f.name] = []));
    filtered.forEach((a) => {
      if (byFeed[a.feed]) byFeed[a.feed].push(a);
    });

    FEEDS.forEach((f) => {
      if (byFeed[f.name].length === 0) return;
      const header = document.createElement("div");
      header.className = "feed-section-header";
      header.innerHTML = `<h2>${escapeHtml(f.name)}</h2>`;
      container.appendChild(header);

      const list = document.createElement("div");
      list.className = "articles";
      byFeed[f.name].forEach((a) => list.appendChild(makeCard(a, false)));
      container.appendChild(list);
    });
  } else {
    const list = document.createElement("div");
    list.className = "articles";
    filtered.forEach((a) =>
      list.appendChild(makeCard(a, activeTab === "all"))
    );
    container.appendChild(list);
  }
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

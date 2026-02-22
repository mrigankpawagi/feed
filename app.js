// Feed data is pre-fetched by a GitHub Actions workflow and stored in
// feed_data.json (same origin — no CORS proxies needed).

const CACHE_KEY = "feed_data_cache";
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

let allArticles = []; // { feed, title, link, date, excerpt, author }
let activeTab = "all";
let feedErrors = {}; // feed.name -> { feed, error, stale }

// ── Cache helpers ─────────────────────────────────────────────────
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    // ignore storage errors
  }
}

// ── Date / text helpers ───────────────────────────────────────────
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

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Data loading ──────────────────────────────────────────────────
function hydrateArticles(data) {
  feedErrors = {};
  if (data.errors) {
    for (const [name, msg] of Object.entries(data.errors)) {
      const feed = FEEDS.find((f) => f.name === name) || { name };
      feedErrors[name] = { feed, error: new Error(msg), stale: false };
    }
  }
  return (data.articles || []).map((a) => ({
    ...a,
    date: parseDate(a.date),
  }));
}

function sortArticles() {
  allArticles.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date - a.date;
  });
}

async function loadAllFeeds() {
  const btn = document.getElementById("btn-refresh");
  btn.classList.add("spinning");
  const container = document.getElementById("articles-container");

  feedErrors = {};
  allArticles = [];

  // Show cached data immediately while fetching fresh data
  const cached = readCache();
  if (cached) {
    allArticles = hydrateArticles(cached);
    sortArticles();
    renderArticles();
  } else {
    container.innerHTML = `<div class="status"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>Loading feeds…</div>`;
  }

  try {
    const res = await fetch("feed_data.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    writeCache(data);
    allArticles = hydrateArticles(data);
    sortArticles();
    renderArticles();
  } catch (e) {
    if (allArticles.length === 0) {
      container.innerHTML = `<div class="status">Failed to load feed data: ${escapeHtml(e.message)}</div>`;
    }
  }

  btn.classList.remove("spinning");
}

// ── Tabs ──────────────────────────────────────────────────────────
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

// ── Rendering ─────────────────────────────────────────────────────
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

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  buildTabs();
  loadAllFeeds();
  document.getElementById("btn-refresh").addEventListener("click", loadAllFeeds);
});

// Feed data is pre-fetched by a GitHub Actions workflow and stored in
// feed_data.json (same origin — no CORS proxies needed).

let allArticles = []; // { feed, title, link, date, excerpt, author }
let activeTab = "all";

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
  const container = document.getElementById("articles-container");

  allArticles = [];
  container.innerHTML = `<div class="status">Loading feeds…</div>`;

  try {
    const res = await fetch("feed_data.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allArticles = hydrateArticles(data);
    sortArticles();
    renderArticles();
  } catch (e) {
    container.innerHTML = `<div class="status">Failed to load feed data: ${escapeHtml(e.message)}</div>`;
  }
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

  const filtered =
    activeTab === "all"
      ? allArticles
      : allArticles.filter((a) => a.feed === activeTab);

  if (filtered.length === 0) {
    const status = document.createElement("div");
    status.className = "status";
    status.textContent = "No articles found.";
    container.appendChild(status);
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
});

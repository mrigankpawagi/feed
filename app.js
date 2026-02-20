// CORS proxy used to bypass browser restrictions on direct RSS fetching
const CORS_PROXY = "https://api.allorigins.win/raw?url=";

let allArticles = []; // { feed, title, link, date, excerpt, author }
let activeTab = "all";

async function fetchFeed(feed) {
  const proxyUrl = CORS_PROXY + encodeURIComponent(feed.url);
  const res = await fetch(proxyUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

  const filtered =
    activeTab === "all"
      ? allArticles
      : allArticles.filter((a) => a.feed === activeTab);

  if (filtered.length === 0) {
    container.innerHTML = `<div class="status">No articles found.</div>`;
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
  container.innerHTML = `<div class="status"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>Loading feeds…</div>`;

  allArticles = [];
  const errors = [];

  await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const articles = await fetchFeed(feed);
        allArticles.push(...articles);
      } catch (e) {
        errors.push({ feed, error: e });
      }
    })
  );

  // Sort all articles by date descending
  allArticles.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date - a.date;
  });

  btn.classList.remove("spinning");
  container.innerHTML = "";

  if (errors.length > 0) {
    errors.forEach(({ feed, error }) => {
      const err = document.createElement("div");
      err.className = "error-msg";
      err.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>Failed to load <strong>${escapeHtml(feed.name)}</strong>: ${escapeHtml(error.message)}`;
      container.appendChild(err);
    });
  }

  renderArticles();
}

document.addEventListener("DOMContentLoaded", () => {
  buildTabs();
  loadAllFeeds();
  document.getElementById("btn-refresh").addEventListener("click", loadAllFeeds);
});

// Feed data is pre-fetched by a GitHub Actions workflow and stored in
// feed_data.json (same origin — no CORS proxies needed).

let allArticles = []; // { feed, title, link, date, excerpt, author }
let selectedFeeds = new Set(); // populated on DOMContentLoaded with all feed names

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

// ── Filter ────────────────────────────────────────────────────────
function buildFilter() {
  const panel = document.getElementById("filter-panel");
  panel.innerHTML = "";

  // Select all / Deselect all
  const actions = document.createElement("div");
  actions.className = "filter-actions";

  const selectAll = document.createElement("button");
  selectAll.className = "filter-action-btn";
  selectAll.textContent = "Select all";
  selectAll.onclick = () => {
    FEEDS.forEach((f) => selectedFeeds.add(f.name));
    buildFilter();
    updateFilterLabel();
    renderArticles();
  };

  const deselectAll = document.createElement("button");
  deselectAll.className = "filter-action-btn";
  deselectAll.textContent = "Deselect all";
  deselectAll.onclick = () => {
    selectedFeeds.clear();
    buildFilter();
    updateFilterLabel();
    renderArticles();
  };

  actions.appendChild(selectAll);
  actions.appendChild(deselectAll);
  panel.appendChild(actions);

  // Checkbox per feed
  FEEDS.forEach((f) => {
    const label = document.createElement("label");
    label.className = "filter-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedFeeds.has(f.name);
    checkbox.onchange = () => {
      if (checkbox.checked) {
        selectedFeeds.add(f.name);
      } else {
        selectedFeeds.delete(f.name);
      }
      updateFilterLabel();
      renderArticles();
    };

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(f.name));
    panel.appendChild(label);
  });
}

function updateFilterLabel() {
  const label = document.getElementById("filter-label");
  const toggle = document.getElementById("filter-toggle");
  const total = FEEDS.length;
  if (selectedFeeds.size === 0) {
    label.textContent = "No feeds";
  } else if (selectedFeeds.size === total) {
    label.textContent = "All feeds";
  } else {
    label.textContent = `${selectedFeeds.size} of ${total} ${selectedFeeds.size === 1 ? "feed" : "feeds"}`;
  }
  toggle.classList.toggle("is-filtered", selectedFeeds.size !== total);
}

function toggleFilter() {
  const panel = document.getElementById("filter-panel");
  const toggle = document.getElementById("filter-toggle");
  const willOpen = panel.hidden;
  panel.hidden = !willOpen;
  toggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
}

// ── Rendering ─────────────────────────────────────────────────────
function renderArticles() {
  const container = document.getElementById("articles-container");
  container.innerHTML = "";

  const filtered = allArticles.filter((a) => selectedFeeds.has(a.feed));
  const showFeedBadge = selectedFeeds.size !== 1;
  if (filtered.length === 0) {
    const status = document.createElement("div");
    status.className = "status";
    status.textContent =
      selectedFeeds.size === 0 ? "No feeds selected." : "No articles found.";
    container.appendChild(status);
    return;
  }

  const list = document.createElement("div");
  list.className = "articles";
  filtered.forEach((a) =>
    list.appendChild(makeCard(a, showFeedBadge))
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
  // Start with all feeds selected
  selectedFeeds = new Set(FEEDS.map((f) => f.name));

  // Toggle filter panel on button click
  document.getElementById("filter-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFilter();
  });

  // Close panel when clicking outside
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("filter-panel");
    const toggle = document.getElementById("filter-toggle");
    if (!panel.hidden && !panel.contains(e.target) && !toggle.contains(e.target)) {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    }
  });

  // Close panel on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const panel = document.getElementById("filter-panel");
      const toggle = document.getElementById("filter-toggle");
      if (!panel.hidden) {
        panel.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
        toggle.focus();
      }
    }
  });

  buildFilter();
  loadAllFeeds();
});

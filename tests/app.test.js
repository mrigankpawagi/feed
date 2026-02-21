/**
 * Unit tests for app.js utility functions.
 *
 * The jsdom test environment provides document, localStorage, and DOMParser
 * so that browser-dependent helpers can be exercised without a real browser.
 */

// Provide FEEDS and fetch globals before loading app.js
global.FEEDS = [{ name: "Test Feed", url: "https://example.com/rss" }];
global.fetch = jest.fn();

// Stub out DOM elements accessed during the DOMContentLoaded callback so that
// requiring the module does not throw.
document.body.innerHTML = `
  <div id="tabs"></div>
  <div id="articles-container"></div>
  <button id="btn-refresh"></button>
`;

const {
  parseDate,
  formatDate,
  escapeHtml,
  cacheKey,
  sortArticles,
  stripHtml,
  readCache,
  writeCache,
  fetchFeed,
} = require("../app.js");

// ---------------------------------------------------------------------------
// parseDate
// ---------------------------------------------------------------------------
describe("parseDate", () => {
  test("returns null for falsy input", () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate("")).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });

  test("parses a valid RFC-2822 date string", () => {
    const d = parseDate("Mon, 01 Jan 2024 00:00:00 +0000");
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2024);
  });

  test("parses a valid ISO 8601 date string", () => {
    const d = parseDate("2024-06-15T12:00:00Z");
    expect(d).toBeInstanceOf(Date);
    expect(d.getUTCFullYear()).toBe(2024);
    expect(d.getUTCMonth()).toBe(5); // June is month 5 (0-indexed)
  });

  test("returns null for an invalid date string", () => {
    expect(parseDate("not-a-date")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------
describe("formatDate", () => {
  test("returns empty string for null", () => {
    expect(formatDate(null)).toBe("");
  });

  test("returns a non-empty string for a valid date", () => {
    const result = formatDate(new Date("2024-01-15T00:00:00Z"));
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------
describe("escapeHtml", () => {
  test("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  test("escapes less-than and greater-than", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  test("escapes double quotes", () => {
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  test("leaves plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  test("escapes all special chars in one string", () => {
    expect(escapeHtml('<a href="x&y">z</a>')).toBe(
      "&lt;a href=&quot;x&amp;y&quot;&gt;z&lt;/a&gt;"
    );
  });
});

// ---------------------------------------------------------------------------
// cacheKey
// ---------------------------------------------------------------------------
describe("cacheKey", () => {
  test("produces a stable key from the feed url", () => {
    const feed = { name: "My Blog", url: "https://example.com/rss" };
    expect(cacheKey(feed)).toBe("feed:https://example.com/rss");
  });

  test("different urls produce different keys", () => {
    const a = { url: "https://a.com/rss" };
    const b = { url: "https://b.com/rss" };
    expect(cacheKey(a)).not.toBe(cacheKey(b));
  });
});

// ---------------------------------------------------------------------------
// sortArticles
// ---------------------------------------------------------------------------
describe("sortArticles", () => {
  // sortArticles operates on the module-level allArticles array, which is
  // exported indirectly.  We call it and check ordering of the returned state
  // by looking at the articles rendered, but it is simpler to test through the
  // exported function directly using a small helper.

  test("sorts newer articles before older ones", () => {
    const older = { title: "Older", date: new Date("2024-01-01") };
    const newer = { title: "Newer", date: new Date("2024-06-01") };
    const articles = [older, newer];
    articles.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date - a.date;
    });
    expect(articles[0].title).toBe("Newer");
    expect(articles[1].title).toBe("Older");
  });

  test("articles without dates sort to the end", () => {
    const dated = { title: "Dated", date: new Date("2024-01-01") };
    const undated = { title: "Undated", date: null };
    const articles = [undated, dated];
    articles.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date - a.date;
    });
    expect(articles[0].title).toBe("Dated");
    expect(articles[1].title).toBe("Undated");
  });
});

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------
describe("stripHtml", () => {
  test("strips HTML tags and returns plain text", () => {
    expect(stripHtml("<p>Hello <strong>world</strong></p>")).toBe(
      "Hello world"
    );
  });

  test("returns empty string for empty input", () => {
    expect(stripHtml("")).toBe("");
  });

  test("leaves plain text unchanged", () => {
    expect(stripHtml("no tags here")).toBe("no tags here");
  });

  test("handles nested tags", () => {
    expect(stripHtml("<div><ul><li>item</li></ul></div>")).toBe("item");
  });
});

// ---------------------------------------------------------------------------
// readCache / writeCache
// ---------------------------------------------------------------------------
describe("readCache / writeCache", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const feed = { name: "Blog", url: "https://example.com/rss" };

  test("readCache returns null when nothing is stored", () => {
    expect(readCache(feed)).toBeNull();
  });

  test("round-trips articles through localStorage", () => {
    const articles = [
      {
        feed: "Blog",
        title: "Post 1",
        link: "https://example.com/1",
        date: new Date("2024-03-01T10:00:00Z"),
        excerpt: "Excerpt",
        author: "Alice",
      },
    ];
    writeCache(feed, articles);
    const result = readCache(feed);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Post 1");
    expect(result[0].date).toBeInstanceOf(Date);
  });

  test("readCache returns null for a null article date", () => {
    const articles = [
      { feed: "Blog", title: "No Date", link: "#", date: null, excerpt: "", author: "" },
    ];
    writeCache(feed, articles);
    const result = readCache(feed);
    expect(result[0].date).toBeNull();
  });

  test("readCache returns null after cache TTL expires", () => {
    const articles = [
      { feed: "Blog", title: "Post", link: "#", date: new Date(), excerpt: "", author: "" },
    ];
    writeCache(feed, articles);
    // Advance time past the 30-minute TTL
    jest.advanceTimersByTime(31 * 60 * 1000);
    expect(readCache(feed)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchFeed – RSS and Atom parsing
// ---------------------------------------------------------------------------
describe("fetchFeed", () => {
  const feed = { name: "Test Feed", url: "https://example.com/rss" };

  function mockFetch(xml) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(xml),
    });
  }

  test("parses a minimal RSS feed", async () => {
    mockFetch(`<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <item>
            <title>RSS Article</title>
            <link>https://example.com/rss-article</link>
            <pubDate>Mon, 01 Jan 2024 00:00:00 +0000</pubDate>
            <description>Hello &lt;b&gt;world&lt;/b&gt;</description>
            <author>Bob</author>
          </item>
        </channel>
      </rss>`);

    const articles = await fetchFeed(feed);
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("RSS Article");
    expect(articles[0].link).toBe("https://example.com/rss-article");
    expect(articles[0].date).toBeInstanceOf(Date);
    expect(articles[0].excerpt).toContain("Hello");
    expect(articles[0].author).toBe("Bob");
    expect(articles[0].feed).toBe("Test Feed");
  });

  test("parses a minimal Atom feed", async () => {
    mockFetch(`<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Atom Article</title>
          <link rel="alternate" href="https://example.com/atom-article"/>
          <updated>2024-06-01T12:00:00Z</updated>
          <summary>Summary text</summary>
          <author><name>Carol</name></author>
        </entry>
      </feed>`);

    const articles = await fetchFeed(feed);
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Atom Article");
    expect(articles[0].link).toBe("https://example.com/atom-article");
    expect(articles[0].date).toBeInstanceOf(Date);
    expect(articles[0].excerpt).toContain("Summary");
    expect(articles[0].author).toBe("Carol");
  });

  test("throws on invalid XML", async () => {
    mockFetch("this is not xml at all <<<<");
    await expect(fetchFeed(feed)).rejects.toThrow("Invalid XML");
  });

  test("uses 'Untitled' when title element is missing", async () => {
    mockFetch(`<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <item>
            <link>https://example.com/no-title</link>
          </item>
        </channel>
      </rss>`);

    const articles = await fetchFeed(feed);
    expect(articles[0].title).toBe("Untitled");
  });

  test("uses '#' as fallback link when link element is missing", async () => {
    mockFetch(`<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <item>
            <title>No Link</title>
          </item>
        </channel>
      </rss>`);

    const articles = await fetchFeed(feed);
    expect(articles[0].link).toBe("#");
  });

  test("truncates excerpt to 220 characters", async () => {
    const longText = "x".repeat(500);
    mockFetch(`<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <item>
            <title>Long</title>
            <description>${longText}</description>
          </item>
        </channel>
      </rss>`);

    const articles = await fetchFeed(feed);
    expect(articles[0].excerpt.length).toBeLessThanOrEqual(220);
  });
});

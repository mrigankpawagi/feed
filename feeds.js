// Add RSS feed URLs here
const FEEDS = [
  {
    name: "SIGPLAN Blog",
    url: "https://blog.sigplan.org/feed/",
  },
  {
    name: "Automating Mathematics",
    url: "https://siddhartha-gadgil.github.io/automating-mathematics/index.xml",
  },
  {
    name: "Matt Might",
    url: "https://matt.might.net/articles/feed.rss",
  },
  {
    name: "Dan Luu",
    url: "https://danluu.com/atom.xml",
    // The RSS feed is ~6 MB (full article text × 128 posts) which exceeds
    // free CORS-proxy limits.  Fall back to scraping the lightweight homepage.
    homepageUrl: "https://danluu.com/",
  },
  {
    name: "Hillel Wayne",
    url: "https://buttondown.email/hillelwayne/rss",
  },
];

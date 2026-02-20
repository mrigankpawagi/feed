# feed

A minimal, client-side RSS/Atom feed reader that runs entirely in the browser — no server, no login, no tracking.

## How it works

The page fetches RSS and Atom feeds via a CORS proxy ([corsproxy.io](https://corsproxy.io/), with [allorigins.win](https://allorigins.win/) as a fallback), parses the XML in the browser, and renders the latest articles as clickable cards. Feeds are loaded in parallel and articles appear as each feed is ready. Articles are sorted by date and can be filtered per feed using the tab bar at the top. Fetched articles are cached in `localStorage` for 30 minutes so the page loads instantly on repeat visits.

## Customise

Edit `feeds.js` to add or remove feeds:

```js
const FEEDS = [
  { name: "SIGPLAN Blog", url: "https://blog.sigplan.org/feed/" },
  { name: "My Blog",      url: "https://example.com/rss.xml" },
];
```

## Live site

<https://mrigankpawagi.github.io/feed/>


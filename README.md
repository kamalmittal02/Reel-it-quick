# Reel It Quick

A Chrome / Edge (Manifest V3) extension that **auto-loads, searches, filters, and
groups** an Instagram profile's recent Reels — all in a draggable overlay panel,
with nothing persisted to disk.

> Open a creator's profile, click the extension, and instantly browse their last
> ~2 months of reels: search captions, filter by hashtag, and sort by views.

## Features

- **Auto-load** — opening the panel automatically paginates the profile's reels
  in the background (no manual scrolling).
- **Search** — filter reels live by caption text or hashtag.
- **Hashtag grouping** — auto-detected hashtag chips with counts; click one to
  filter. Junk/filler tags (function words, noise, one-offs) are removed with a
  stopword list + heuristics + a recurrence threshold.
- **Sort** — most viewed or recently loaded.
- **Recent-only** — stops at reels older than ~2 months (a hard limit).
- **Draggable & minimizable** floating panel.
- **Private** — runs entirely on your own logged-in session; data is in-memory
  only and never leaves the browser.

## Why it works this way

Instagram's Reels grid only shows thumbnails and view counts. The caption text
(the closest thing to a reel "title") loads via Instagram's internal API/GraphQL,
**not** in the page HTML. So the extension intercepts those network responses,
extracts each reel's data, and builds its own UI on top.

## Install (developer mode)

1. Clone this repo or download it as a ZIP and unzip.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder (the one with
   `manifest.json`).
5. Pin the extension, then visit any profile, e.g.
   `https://www.instagram.com/<username>/reels/`.

## Usage

1. Open a profile, then click the **Reel It Quick** toolbar icon (or the
   floating **Reels** button bottom-right).
2. Reels load automatically; hashtag chips and the list populate.
3. **Search** captions/hashtags, click a **hashtag chip** to filter, or change
   the **sort**.
4. Drag the panel by its header; **minimize** with `–`, restore with `▢`.
5. Click any result to open that reel in a new tab.

Use **Load all reels** to re-run or **Stop loading** to halt early.

## How it's built

| File | World | Role |
|------|-------|------|
| `manifest.json` | — | MV3 config; registers the background worker + content scripts |
| `src/background.js` | service worker | Toggles the panel from the toolbar icon |
| `src/interceptor.js` | MAIN | Wraps `fetch`/`XHR`, forwards Instagram JSON, drives `clips/user` pagination |
| `src/extractor.js` | ISOLATED | Parses reels, extracts hashtags/keywords, cleans noise |
| `src/content.js` | ISOLATED | In-memory store (30-min TTL, profile-scoped) + the overlay panel UI |
| `src/panel.css` | — | Panel styles (namespaced with `.igrf-`) |

Pagination resolves the profile's user id (from captured payloads or a
`web_profile_info` lookup) and calls Instagram's `clips/user` endpoint directly,
stopping automatically at the ~2-month mark.

## Notes & limitations

- **In-memory only** — reload the page and the cache clears (by design); entries
  also expire after 30 minutes and are scoped to the profile you're viewing.
- **Desktop Chrome/Edge** (Manifest V3).
- Instagram changes its private API often. The extractor walks the JSON
  generically (any video media with a shortcode), so it tolerates shape changes,
  but a major Instagram change could still require updates.
- Compound non-English hashtags (e.g. a transliterated phrase as one tag) can't
  be detected without a dictionary and may still appear if used repeatedly.
- This uses Instagram's own responses in your authenticated session; it does not
  scrape anything you couldn't already see. Use responsibly and within
  Instagram's Terms of Service.

## License

[MIT](LICENSE)

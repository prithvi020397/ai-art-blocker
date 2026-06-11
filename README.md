# AI Art Blocker

Minimal Chrome extension (Manifest V3, vanilla JS, no build step) that marks
or hides AI-generated art on `*.deviantart.com` and `*.pinterest.com`.

Two display modes (popup radio, applies live):

- **Mark** (default): red ✕ + red border over AI art; still clickable
- **Hide**: placeholder with a per-item Reveal button

## Architecture

One shared engine (scanning, MutationObserver, mark/hide, counters) plus a
small adapter per site. An adapter defines: the thumbnail selector, where the
searchable text lives, and how to get the site's official AI label.

| Site | Thumbnail hook | Official AI flag |
|---|---|---|
| DeviantArt | `[data-testid="thumb"]` | internal API `isAiGenerated` (verified) |
| Pinterest | `[data-grid-item="true"]` / `[data-test-id="pin"]` | not wired yet — needs authenticated recon of the pin API; layers 1–2 active |

## Install (load unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder (`ai-art-blocker/`)
5. Browse DeviantArt — hidden items show an "AI hidden — Reveal" placeholder,
   and a floating counter appears bottom-right

## How detection works (three layers)

| Layer | What | Notes |
|---|---|---|
| 1. DOM badge | Looks for a "Created using AI tools" marker inside each thumbnail | DeviantArt does **not** currently render its AI label on thumbnails (verified against the live site) — kept as a cheap forward-compatible check in case they add one |
| 2. Keywords | Whole-word match against the thumb's title, alt text, and URL slug | `ai` will not match "p**ai**nting" — single words are token-matched |
| 3. Deep check | Queries DeviantArt's internal deviation API and reads the official `isAiGenerated` flag | This is the reliable, zero-false-positive layer. One GET per deviation (cached, max 3 concurrent). Toggleable in the popup |

Layer 3 exists because the official AI label is *not* exposed anywhere in the
thumbnail DOM — only via DA's internal `_puppy/dadeviation/init` endpoint
(same one the site itself uses; works logged-in and logged-out using the CSRF
token embedded in the page).

## Popup

- **ON/OFF toggle** — applies live, no reload needed (`chrome.storage.sync`)
- **Blocked this session** — running total, resets when the browser closes
- **Deep check toggle** — disable to stop all API calls (layers 1–2 still work)
- **Keyword editor** — one keyword per line, click *Save keywords*

## Behavior notes

- Hiding is non-destructive: the grid cell keeps its size, content is
  `visibility: hidden`, and a placeholder with a **Reveal** button is overlaid.
  Reveal un-hides that one item and decrements the counters.
- A `MutationObserver` on `document.body` catches infinite scroll and
  DeviantArt's client-side route changes (no reload between pages).
- Thumbnails are matched via `[data-testid="thumb"]` — DeviantArt's hashed CSS
  class names are intentionally never used.
- If the deep-check API ever returns an auth error, the extension stops
  calling it for that page and falls back to layers 1–2 silently.

## Files

```
ai-art-blocker/
├── manifest.json     MV3 manifest — storage permission only
├── content.js        detection, hiding, observer, floating counter
├── background.js     session total + toolbar badge count
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
└── README.md
```

## Out of scope (by design)

Multi-site support, Firefox, community blocklists, account blocking, image
analysis, bundlers, backends.

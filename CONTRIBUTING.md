# Contributing

The most valuable contribution is a **site adapter** — support for a new site
in ~40 lines, no build step, no dependencies.

## How the extension works

`content.js` contains a shared engine (scanning, MutationObserver, mark/hide
overlays, counters) and one adapter per site. The engine asks the adapter
three questions:

| Adapter member | Question it answers |
|---|---|
| `thumbSelector` | What CSS selector finds artwork thumbnails? |
| `resolve(thumb)` | Which element is the grid cell, and what link identifies the item? Returns `{ cell, link, thumb, key }` or `null`. |
| `text(item)` | What text should keywords match against? (title, alt text, URL slug) |
| `badge(item)` | Does the site render an official AI label inside the cell? |
| `official(item)` | Optional. Returns a `Promise<boolean>` from the site's API for the official AI flag, or `null`. |

## Writing an adapter

1. Find a stable thumbnail hook. Never use hashed CSS class names (`_2vUXu`)
   — they change every deploy. Prefer `data-testid` / `data-test-id`
   attributes, ARIA labels, or schema.org markup.
2. Add your adapter object in `content.js` next to the existing ones, and a
   hostname branch in `pickAdapter()`.
3. Add the site's match pattern to `content_scripts.matches` in
   `manifest.json`.
4. Test: page load, infinite scroll, the site's client-side navigation, both
   mark and hide modes, and the Reveal button.

## Ground rules

- Vanilla JS, Manifest V3, no dependencies, no build step
- Blocking must never be destructive (`visibility`/overlay, not removal)
- No data leaves the browser — no analytics, no remote requests except the
  site's own APIs for official AI labels
- Whole-word keyword matching (`ai` must not match "painting")

## Found a broken selector?

Sites redesign. Open an issue with the page URL and, if you can, the output
of this console snippet on the affected page:

```js
({ injected: !!document.getElementById('aib-styles'),
   checked: document.querySelectorAll('[data-aib-checked]').length,
   blocked: document.querySelectorAll('[data-aib-state]').length })
```

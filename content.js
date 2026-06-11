// AI Art Blocker — content script (DeviantArt + Pinterest)
//
// Structure: a shared engine (scanning, marking/hiding, counters, observer)
// plus one adapter per site. An adapter answers three questions:
//   - what is a thumbnail, and which element is its grid cell?
//   - where does its searchable text live?
//   - is there an official AI label for it? (DOM badge and/or API)
//
// Detection layers, in order:
//   1. DOM badge  — official AI label rendered in the cell, if the site does that
//   2. Keywords   — whole-word match against title / alt text / URL slug
//   3. Deep check — site API returning the official AI flag (zero false positives)
//
// Blocking is never destructive: "mark" overlays a red X, "hide" keeps the
// cell's footprint and overlays a placeholder with a Reveal button.

const DEFAULTS = {
  enabled: true,
  mode: "mark", // "mark" = red X over AI art, "hide" = placeholder + reveal
  deepCheck: true,
  sites: { deviantart: true, pinterest: true },
  keywords: [
    "ai",
    "aiart",
    "aigenerated",
    "ai generated",
    "midjourney",
    "dreamup",
    "stable diffusion",
    "dall-e"
  ]
};

let settings = { ...DEFAULTS };
let keywordRegexes = [];
let blockedCount = 0; // currently marked/hidden on this page

// ---- site adapters ---------------------------------------------------------

// Shared deep-check helper: per-item flag fetcher with an in-memory +
// persistent (chrome.storage.local) cache and a concurrency-limited queue.
// Resolved flags survive restarts so revisited pages cost zero requests.
function createFlagChecker({ storeKey, maxConcurrent, fetchFlag }) {
  const cache = new Map(); // id -> boolean | Promise<boolean>
  const queue = [];
  const STORE_CAP = 20000;
  let inFlight = 0;
  let persistMap = {};
  let saveTimer = null;

  async function init() {
    try {
      const stored = (await chrome.storage.local.get(storeKey))[storeKey] || {};
      if (Object.keys(stored).length > STORE_CAP) {
        await chrome.storage.local.remove(storeKey); // oversized: start fresh
        return;
      }
      persistMap = stored;
      for (const [id, v] of Object.entries(persistMap)) cache.set(id, !!v);
    } catch (_) {
      // storage unavailable — in-memory cache still works
    }
  }

  function persist(id, value) {
    persistMap[id] = value ? 1 : 0;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ [storeKey]: persistMap });
      } catch (_) {}
    }, 2000);
  }

  function pump() {
    while (inFlight < maxConcurrent && queue.length) {
      const job = queue.shift();
      inFlight++;
      fetchFlag(job)
        .then(
          (flag) => {
            persist(job.id, flag);
            job.resolve(flag);
          },
          (err) => job.reject(err)
        )
        .finally(() => {
          inFlight--;
          pump();
        });
    }
  }

  function check(id, payload) {
    const cached = cache.get(id);
    if (cached !== undefined) return Promise.resolve(cached);
    const p = new Promise((resolve, reject) => {
      queue.push(Object.assign({ id, resolve, reject }, payload));
      pump();
    });
    cache.set(id, p);
    p.then(
      (v) => cache.set(id, v),
      () => cache.delete(id)
    );
    return p;
  }

  return { init, check };
}

const deviantartAdapter = (() => {
  // Deep check: DA's internal API, the same one the site uses.
  let csrfToken = null;
  let apiBroken = false; // set on auth failure so we stop hammering the API

  const LINK_RE = /deviantart\.com\/([^/]+)\/([^/]+)\/[^/]*?-(\d+)(?:[#?].*)?$/i;

  function findCsrfToken() {
    // The token lives in DA's embedded state JSON, escaped or not:
    //   \"csrfToken\":\"XXX\"   or   "csrfToken":"XXX"
    for (const script of document.querySelectorAll("script")) {
      const m = script.textContent.match(/csrfToken\\?["']:\\?["']([^"'\\]+)/);
      if (m) return m[1];
    }
    return null;
  }

  const checker = createFlagChecker({
    storeKey: "aiFlags_deviantart",
    maxConcurrent: 3,
    async fetchFlag(job) {
      if (apiBroken) throw new Error("api disabled");
      if (!csrfToken) csrfToken = findCsrfToken();
      if (!csrfToken) {
        apiBroken = true;
        throw new Error("no csrf token found");
      }
      const url =
        `${location.origin}/_puppy/dadeviation/init` +
        `?deviationid=${job.id}` +
        `&username=${encodeURIComponent(job.username)}` +
        `&type=${encodeURIComponent(job.type)}` +
        `&include_session=false&csrf_token=${csrfToken}`;
      const res = await fetch(url, { credentials: "same-origin" });
      if (res.status === 401 || res.status === 403) {
        apiBroken = true;
        throw new Error(`api auth error ${res.status}`);
      }
      if (!res.ok) throw new Error(`api error ${res.status}`);
      const data = await res.json();
      return !!(data && data.deviation && data.deviation.isAiGenerated);
    }
  });

  return {
    init: checker.init,
    thumbSelector: '[data-testid="thumb"]',
    resolve(thumb) {
      const link = thumb.closest("a[href]");
      if (!link) return null;
      return { cell: link.parentElement || link, link, thumb, key: link.href };
    },
    text({ link, thumb }) {
      const img = thumb.querySelector("img");
      return [
        link.getAttribute("aria-label") || "",
        img ? img.alt : "",
        decodeURIComponent(link.pathname || "")
      ]
        .join(" ")
        .toLowerCase();
    },
    badge({ cell }) {
      // DA does not currently render its AI label on thumbnails; cheap
      // forward-compatible check in case it ever does.
      return !!cell.querySelector(
        '[aria-label*="Created using AI" i], [title*="Created using AI" i], [alt*="Created using AI" i]'
      );
    },
    official({ link }) {
      if (apiBroken) return null;
      const m = link.href.match(LINK_RE);
      if (!m) return null;
      return checker.check(m[3], { username: m[1], type: m[2] });
    }
  };
})();

const pinterestAdapter = (() => {
  // Deep check: Pinterest renders its official "AI generated" / "AI modified"
  // label only on pin closeup pages, as an element with this test-id. The
  // label is not exposed in grid markup or any anonymous API, so we fetch the
  // closeup HTML (same-origin, the user's own session) and look for the
  // marker — plus the gen_ai_topics field if pin JSON is embedded. Heavier
  // than a JSON API, hence concurrency 2 and the persistent cache.
  const AI_LABEL_MARKER = "closeup-image-overlay-layer-ai-generated-label";
  const PIN_ID_RE = /\/pin\/(?:[^/]*--)?(\d+)/;
  let apiBroken = false;

  const checker = createFlagChecker({
    storeKey: "aiFlags_pinterest",
    maxConcurrent: 2,
    async fetchFlag(job) {
      if (apiBroken) throw new Error("checks disabled");
      const res = await fetch(`${location.origin}/pin/${job.id}/`, {
        credentials: "same-origin"
      });
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        apiBroken = true; // auth wall or rate limit: stop for this page
        throw new Error(`closeup fetch blocked ${res.status}`);
      }
      if (!res.ok) throw new Error(`closeup fetch error ${res.status}`);
      const html = await res.text();
      if (html.includes(AI_LABEL_MARKER)) return true;
      const m = html.match(/"gen_ai_topics"\s*:\s*(\[[^\]]*\]|null)/);
      return !!(m && m[1] !== "null" && m[1] !== "[]");
    }
  });

  return {
    init: checker.init,
    thumbSelector: '[data-grid-item], [data-test-id="pin"], [data-test-id="pinWrapper"]',
    resolve(thumb) {
      const link =
        thumb.querySelector('a[href*="/pin/"]') || thumb.closest('a[href*="/pin/"]');
      if (!link) return null;
      // the grid item itself is the cell (Pinterest positions it absolutely)
      const cell = thumb.closest("[data-grid-item]") || thumb;
      return { cell, link, thumb, key: link.href };
    },
    text({ cell, link }) {
      const img = cell.querySelector("img");
      return [
        img ? img.alt : "",
        link.getAttribute("aria-label") || "",
        cell.getAttribute("aria-label") || ""
      ]
        .join(" ")
        .toLowerCase();
    },
    badge({ cell }) {
      // Official label element (closeups) plus text variants on other surfaces
      return !!cell.querySelector(
        `[data-test-id="${AI_LABEL_MARKER}"], ` +
          '[aria-label*="AI generated" i], [aria-label*="AI modified" i], ' +
          '[title*="AI generated" i], [title*="AI modified" i]'
      );
    },
    official({ link }) {
      if (apiBroken) return null;
      const m = link.href.match(PIN_ID_RE);
      if (!m) return null;
      return checker.check(m[1], {});
    }
  };
})();

function pickSite() {
  const host = location.hostname;
  if (host.endsWith("deviantart.com")) return { key: "deviantart", adapter: deviantartAdapter };
  if (host.endsWith("pinterest.com")) return { key: "pinterest", adapter: pinterestAdapter };
  return null;
}

const SITE = pickSite();
const adapter = SITE && SITE.adapter;

function isActive() {
  if (!SITE || !settings.enabled) return false;
  const sites = settings.sites || {};
  return sites[SITE.key] !== false;
}

// ---- keyword matching ------------------------------------------------------

function buildKeywordRegexes() {
  keywordRegexes = (settings.keywords || [])
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .map((k) => {
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Whole-token match: "ai" must not match "painting" or "fairy".
      return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`);
    });
}

function matchesKeywords(text) {
  return keywordRegexes.some((r) => r.test(text));
}

// ---- mark / hide / reveal ----------------------------------------------------

function injectStyles() {
  const style = document.createElement("style");
  style.id = "aib-styles";
  style.textContent = `
    [data-aib-state="hidden"] > :not(.aib-overlay) { visibility: hidden !important; }
    .aib-overlay { display: none; }
    [data-aib-state="hidden"] > .aib-overlay {
      display: flex;
      position: absolute;
      inset: 0;
      z-index: 100;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: rgba(40, 40, 48, 0.9);
      border-radius: 4px;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #cfcfd8;
    }
    .aib-overlay button {
      cursor: pointer;
      border: 1px solid #6a6a78;
      border-radius: 12px;
      background: transparent;
      color: #cfcfd8;
      font-size: 11px;
      padding: 3px 12px;
    }
    .aib-overlay button:hover { background: #55555f; }
    [data-aib-state="marked"] {
      outline: 3px solid rgba(255, 59, 59, 0.9);
      outline-offset: -3px;
    }
    [data-aib-state="marked"]::after {
      content: "\\2715";
      position: absolute;
      inset: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
      font: 700 72px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: rgba(255, 59, 59, 0.85);
      text-shadow: 0 0 10px rgba(0, 0, 0, 0.7);
      pointer-events: none;
    }
    [data-aib-state="revealed"]::after {
      content: "AI";
      position: absolute;
      top: 6px;
      left: 6px;
      z-index: 100;
      background: rgba(20, 20, 26, 0.85);
      color: #ffd166;
      font: 700 10px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 4px 6px;
      border-radius: 4px;
      pointer-events: none;
    }
    #aib-badge {
      position: fixed;
      right: 14px;
      bottom: 14px;
      z-index: 999999;
      background: rgba(20, 20, 26, 0.92);
      color: #e8e8ee;
      font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 8px 12px;
      border-radius: 16px;
      pointer-events: none;
    }
  `;
  document.documentElement.appendChild(style);
}

function updateFloatingBadge() {
  let badge = document.getElementById("aib-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "aib-badge";
    document.documentElement.appendChild(badge);
  }
  badge.textContent = `${settings.mode === "mark" ? "AI marked" : "AI blocked"}: ${blockedCount}`;
  badge.style.display = isActive() && blockedCount > 0 ? "block" : "none";
}

function bump(delta) {
  blockedCount = Math.max(0, blockedCount + delta);
  updateFloatingBadge();
  try {
    chrome.runtime.sendMessage({ type: "aib:delta", delta, tabCount: blockedCount });
  } catch (_) {
    // extension was reloaded; page script is orphaned — ignore
  }
}

function block(cell) {
  if (cell.dataset.aibState) return;
  if (getComputedStyle(cell).position === "static") cell.style.position = "relative";
  if (settings.mode === "mark") {
    cell.dataset.aibState = "marked";
    bump(1);
    return;
  }
  cell.dataset.aibState = "hidden";
  if (!cell.querySelector(":scope > .aib-overlay")) {
    const overlay = document.createElement("div");
    overlay.className = "aib-overlay";
    const label = document.createElement("span");
    label.textContent = "AI hidden";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Reveal";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      cell.dataset.aibState = "revealed";
      bump(-1);
    });
    overlay.append(label, btn);
    cell.appendChild(overlay);
  }
  bump(1);
}

function unhideAll() {
  for (const cell of document.querySelectorAll("[data-aib-state]")) {
    delete cell.dataset.aibState;
  }
  blockedCount = 0;
  updateFloatingBadge();
}

function resetAndRescan() {
  for (const cell of document.querySelectorAll("[data-aib-checked]")) {
    delete cell.dataset.aibChecked;
    delete cell.dataset.aibState;
  }
  blockedCount = 0;
  updateFloatingBadge();
  scan();
}

// ---- scanning ----------------------------------------------------------

function evaluate(item) {
  // Layer 1: official badge rendered in the DOM
  if (adapter.badge(item)) {
    block(item.cell);
    return;
  }

  // Layer 2: keywords
  if (matchesKeywords(adapter.text(item))) {
    block(item.cell);
    return;
  }

  // Layer 3: official AI flag via the site's API, when the adapter has one
  if (!settings.deepCheck || !adapter.official) return;
  const check = adapter.official(item);
  if (!check) return;
  const { cell, key } = item;
  check.then(
    (isAi) => {
      // Infinite-scroll grids recycle nodes; only block if this cell still
      // shows the same item we checked.
      if (isAi && isActive() && cell.isConnected && cell.dataset.aibChecked === key) {
        block(cell);
      }
    },
    () => {}
  );
}

function scan() {
  if (!isActive()) return;
  for (const thumb of document.querySelectorAll(adapter.thumbSelector)) {
    const item = adapter.resolve(thumb);
    if (!item) continue;
    const { cell, key } = item;
    if (cell.dataset.aibChecked === key) continue; // already done
    if (cell.dataset.aibChecked) {
      // recycled node now showing a different item — reset
      delete cell.dataset.aibState;
    }
    cell.dataset.aibChecked = key;
    evaluate(item);
  }
}

// ---- wiring -------------------------------------------------------------

let scanScheduled = false;
function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  setTimeout(() => {
    scanScheduled = false;
    scan();
  }, 150);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    settings[key] = newValue;
  }
  buildKeywordRegexes();
  if (!isActive()) {
    unhideAll();
  } else {
    resetAndRescan();
  }
});

// Popup asks for page status so it can show "N found here" vs "not active".
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "aib:status") {
    sendResponse({
      site: SITE ? SITE.key : null,
      active: isActive(),
      count: blockedCount,
      mode: settings.mode
    });
  }
});

(async function init() {
  if (!adapter) return;
  settings = await chrome.storage.sync.get(DEFAULTS);
  buildKeywordRegexes();
  injectStyles();
  if (adapter.init) await adapter.init();
  scan();
  // One observer on body survives client-side route changes, which replace
  // the grid container entirely on both sites.
  new MutationObserver(scheduleScan).observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });
})();

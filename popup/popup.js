// AI Art Blocker — popup

const DEFAULTS = {
  enabled: true,
  mode: "mark",
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

const $enabled = document.getElementById("enabled");
const $deepCheck = document.getElementById("deepCheck");
const $keywords = document.getElementById("keywords");
const $count = document.getElementById("count");
const $save = document.getElementById("save");
const $status = document.getElementById("status");

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  $enabled.checked = settings.enabled;
  $deepCheck.checked = settings.deepCheck;
  const modeRadio = document.querySelector(`input[name="mode"][value="${settings.mode}"]`);
  if (modeRadio) modeRadio.checked = true;
  $keywords.value = settings.keywords.join("\n");
  const sites = settings.sites || DEFAULTS.sites;
  for (const site of Object.keys(DEFAULTS.sites)) {
    const box = document.getElementById(`site-${site}`);
    if (box) box.checked = sites[site] !== false;
  }

  const { blockedTotal } = await chrome.storage.session.get({ blockedTotal: 0 });
  $count.textContent = blockedTotal;
  loadPageStatus();
}

// Ask the active tab's content script what's happening on this page, so
// "nothing visible" never looks like "broken".
function loadPageStatus() {
  const $page = document.getElementById("pageStatus");
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      $page.textContent = "Not active on this page";
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: "aib:status" }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.site) {
        $page.textContent = "Not active here — works on DeviantArt & Pinterest";
        return;
      }
      if (!resp.active) {
        $page.textContent = `Paused on ${resp.site}`;
        return;
      }
      const verb = resp.mode === "mark" ? "marked" : "hidden";
      $page.textContent = `Active on ${resp.site} — ${resp.count} ${verb} on this page`;
    });
  });
}

$enabled.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: $enabled.checked });
});

$deepCheck.addEventListener("change", () => {
  chrome.storage.sync.set({ deepCheck: $deepCheck.checked });
});

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", () => {
    if (radio.checked) chrome.storage.sync.set({ mode: radio.value });
  });
}

for (const site of Object.keys(DEFAULTS.sites)) {
  const box = document.getElementById(`site-${site}`);
  if (!box) continue;
  box.addEventListener("change", async () => {
    const { sites } = await chrome.storage.sync.get({ sites: DEFAULTS.sites });
    sites[site] = box.checked;
    await chrome.storage.sync.set({ sites });
    setTimeout(loadPageStatus, 300);
  });
}

$save.addEventListener("click", async () => {
  const keywords = $keywords.value
    .split(/\r?\n/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  await chrome.storage.sync.set({ keywords });
  $status.textContent = "Saved";
  setTimeout(() => ($status.textContent = ""), 1500);
});

// live-update the session counter while the popup is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.blockedTotal) {
    $count.textContent = changes.blockedTotal.newValue || 0;
  }
});

load();

// AI Blocker for DeviantArt — popup

const DEFAULTS = {
  enabled: true,
  mode: "mark",
  deepCheck: true,
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

  const { blockedTotal } = await chrome.storage.session.get({ blockedTotal: 0 });
  $count.textContent = blockedTotal;
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

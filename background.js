// AI Blocker for DeviantArt — background service worker (MV3, non-persistent)
//
// Keeps the session-wide blocked total in chrome.storage.session (survives
// service-worker shutdowns, resets when the browser closes) and mirrors the
// per-tab count onto the toolbar icon badge.

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "aib:delta") return;

  chrome.storage.session.get({ blockedTotal: 0 }).then(({ blockedTotal }) => {
    chrome.storage.session.set({
      blockedTotal: Math.max(0, blockedTotal + msg.delta)
    });
  });

  const tabId = sender.tab && sender.tab.id;
  if (tabId != null) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#5a5a66" });
    chrome.action.setBadgeText({
      tabId,
      text: msg.tabCount > 0 ? String(msg.tabCount) : ""
    });
  }
});

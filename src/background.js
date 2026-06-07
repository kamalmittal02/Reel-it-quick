// Toggles the in-page panel when the user clicks the extension toolbar icon.

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  const onInstagram =
    tab.url &&
    /^https:\/\/(www\.)?instagram\.com\//.test(tab.url);

  if (!onInstagram) {
    await chrome.tabs.create({ url: "https://www.instagram.com/" });
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "IGRF_TOGGLE" });
  } catch (_) {
    // Content script may not be ready yet on a freshly opened tab.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/extractor.js", "src/content.js"],
      });
      await chrome.tabs.sendMessage(tab.id, { type: "IGRF_TOGGLE" });
    } catch (err) {
      console.error("[IGRF] Failed to toggle panel:", err);
    }
  }
});

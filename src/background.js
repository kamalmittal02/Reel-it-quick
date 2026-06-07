// Toggles the in-page panel when the user clicks the extension toolbar icon.
//
// `browser` (Firefox) and `chrome` (Chrome/Edge) both expose these APIs; we
// prefer `browser` because it returns promises natively, then fall back to
// `chrome` (which also returns promises in MV3 Chrome when no callback is given).
const api = globalThis.browser || globalThis.chrome;

api.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  const onInstagram =
    tab.url &&
    /^https:\/\/(www\.)?instagram\.com\//.test(tab.url);

  if (!onInstagram) {
    await api.tabs.create({ url: "https://www.instagram.com/" });
    return;
  }

  try {
    await api.tabs.sendMessage(tab.id, { type: "IGRF_TOGGLE" });
  } catch (_) {
    // Content script may not be ready yet on a freshly opened tab.
    try {
      await api.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/extractor.js", "src/content.js"],
      });
      await api.tabs.sendMessage(tab.id, { type: "IGRF_TOGGLE" });
    } catch (err) {
      console.error("[Reel It Quick] Failed to toggle panel:", err);
    }
  }
});

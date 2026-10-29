// Service worker: opens the side panel (granting activeTab), context menu, page extraction.
import { extractPage } from "./extract.js";
import { pdfPageFromUrl, fileUrlToLocalPath } from "./paths.js";
export { pdfPageFromUrl, fileUrlToLocalPath };

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({ id: "ask-selection", title: "Ask Grok Browser about selection", contexts: ["selection"] });
  chrome.contextMenus.create({ id: "ask-page", title: "Ask Grok Browser about this page", contexts: ["page", "frame"] });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});

// Toolbar click or the Alt+Shift+G shortcut (_execute_action). Both grant activeTab for this tab.
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  chrome.storage.session.set({ lastGrant: { tabId: tab.id, at: Date.now() } });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  if (info.menuItemId === "ask-selection" && info.selectionText) {
    chrome.storage.session.set({ pendingSelection: { tabId: tab.id, text: info.selectionText, frameId: info.frameId ?? 0, at: Date.now() } });
  }
});

// Side panel asks the worker to extract the page (so one code path owns injection).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "extract") {
    extractFromTab(msg.tabId, msg.maxChars).then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e) }));
    return true;
  }
  if (msg && msg.type === "capture") {
    captureTab(msg.tabId, msg.maxBytes).then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e) }));
    return true;
  }
});

// Screenshot of what's on screen in this tab (the PDF viewer's text isn't readable by extensions, so
// the model looks at the picture: page number in the toolbar, the passage on screen).
// Needs activeTab (toolbar icon / Alt+Shift+G / right-click on this tab) or the optional all-sites permission;
// file:// tabs also need "Allow access to file URLs". JPEG, downscaled until it's under maxBytes.
const CAPTURE_MAX_BYTES = 400 * 1024;
async function captureTab(tabId, maxBytes = CAPTURE_MAX_BYTES) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) return { error: "not-active" };
  let dataUrl;
  try { dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 }); }
  catch (e) {
    const m = String(e && e.message || e);
    return { error: /permission|activeTab|all_urls|Cannot access|host/i.test(m) ? "no-access" : "capture-failed", detail: m };
  }
  if (approxBytes(dataUrl) <= maxBytes) return { screenshot: dataUrl, bytes: approxBytes(dataUrl) };
  try {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    let scale = Math.min(1, 1600 / bmp.width), quality = 0.7;
    for (let i = 0; i < 8; i++) {
      const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
      const c = new OffscreenCanvas(w, h); c.getContext("2d").drawImage(bmp, 0, 0, w, h);
      const blob = await c.convertToBlob({ type: "image/jpeg", quality });
      if (blob.size <= maxBytes) return { screenshot: await blobToDataUrl(blob), bytes: blob.size, width: w, height: h };
      if (quality > 0.55) quality = 0.55; else scale *= 0.8;
    }
  } catch (e) { return { error: "capture-failed", detail: String(e && e.message || e) }; }
  return { error: "too-large" };
}
const approxBytes = (dataUrl) => Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
async function blobToDataUrl(blob) {
  const u = new Uint8Array(await blob.arrayBuffer()); let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return "data:" + blob.type + ";base64," + btoa(s);
}

function isPdfUrl(u) { try { return /\.pdf$/i.test(new URL(u).pathname); } catch { return false; } }

function addLocal(out) {
  if (/^file:/i.test(out.url || "")) { out.source = "local_file"; out.local_path = fileUrlToLocalPath(out.url); }
  const pg = pdfPageFromUrl(out.url || "") || pdfPageFromUrl(out.pdf_url || "");
  if (pg) out.pdf_page = pg;
  return out;
}

async function extractFromTab(tabId, maxChars) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab && tab.url || "";
  const title = tab && tab.title || "";
  if (/^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(url) || /chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons/i.test(url)) {
    return { error: "restricted", url, title };
  }
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: extractPage, args: [maxChars] });
  } catch (e) {
    try { results = await chrome.scripting.executeScript({ target: { tabId }, func: extractPage, args: [maxChars] }); }
    catch (e2) {
      const msg = String(e2 && e2.message || e2);
      if (isPdfUrl(url) || /^file:/i.test(url)) return addLocal({ url, title, pdf_url: isPdfUrl(url) ? url : "", page_text: "", visible_text: "", selection: "", truncated: false, note: "text-not-readable" });
      return { error: /permission|Cannot access|host/i.test(msg) ? "no-access" : "inject-failed", detail: msg, url, title };
    }
  }
  const frames = (results || []).map((r) => r && r.result).filter(Boolean);
  const top = (results || []).find((r) => r.frameId === 0)?.result || frames[0] || {};
  // Merge readable text from same-origin child frames (e.g. EPUB readers render chapters in iframes).
  const out = { ...top, url: top.url || url, title: top.title || title };
  const children = (results || []).filter((r) => r.frameId !== 0 && r.result && (r.result.page_text || "").length > 200);
  for (const c of children) {
    out.page_text = (out.page_text || "") + `\n\n[frame: ${c.result.url}]\n` + c.result.page_text;
    if (!out.selection && c.result.selection) out.selection = c.result.selection;
    if (c.result.visible_text) out.visible_text = ((out.visible_text || "") + "\n" + c.result.visible_text).trim();
    if (c.result.pdf_url && !out.pdf_url) out.pdf_url = c.result.pdf_url;
  }
  if ((out.page_text || "").length > maxChars) { out.page_text = out.page_text.slice(0, maxChars); out.truncated = true; }
  if ((out.visible_text || "").length > 12000) out.visible_text = out.visible_text.slice(0, 12000);
  if (!out.pdf_url && isPdfUrl(out.url)) out.pdf_url = out.url;
  return addLocal(out);
}

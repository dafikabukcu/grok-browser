import { renderMarkdown } from "./markdown.js";
import { ask, waitForAnswer, getSettings, isConfigured, assistantName, askXai, PAGE_TEXT_MAX } from "./api.js";

const $ = (id) => document.getElementById(id);
const threadEl = $("thread"), emptyEl = $("empty"), q = $("question"), sendBtn = $("send");
let tabId = null, tabWindowId = null, selectionOverride = "", busy = new Set();
const streams = new Map(); // ts -> { text, ctrl } for xAI answers streaming in this panel

const key = (id) => `thread:${id}`;
const loadThread = async (id) => (await chrome.storage.session.get(key(id)))[key(id)] || [];
const saveThread = (id, t) => chrome.storage.session.set({ [key(id)]: t.slice(-40) });

function notice(text, kind = "warn", action = null) {
  const n = $("notice");
  if (!text) { n.classList.add("hidden"); return; }
  n.textContent = text; n.className = "notice" + (kind === "error" ? " error" : "");
  if (action) {
    const b = document.createElement("button"); b.className = "notice-action"; b.textContent = action.label;
    b.addEventListener("click", action.onClick); n.appendChild(document.createTextNode(" ")); n.appendChild(b);
  }
}

const ALL_SITES = { origins: ["<all_urls>"] };
const SHORT_TEXT = 200;
const isPdfLike = (ctx) => !!ctx.pdf_url || /\.pdf(?:$|[?#])/i.test(ctx.url || "");
// PDFs (Chrome's viewer hides its text and current page from extensions) and pages with little readable
// text get a screenshot of what's on screen, so the model can see the page number and the passage.
export const wantsScreenshot = (ctx) => !ctx.error && (isPdfLike(ctx) || (ctx.visible_text || "").trim().length < SHORT_TEXT) || ctx.error === "no-access" || ctx.error === "inject-failed";

const FILE_ACCESS_MSG = "This is a local file, but \"Allow access to file URLs\" is off for Grok Browser. Turn it on in the extensions page → Details, then ask again.";
const fileAccessOn = () => new Promise((r) => { try { chrome.extension.isAllowedFileSchemeAccess(r); } catch { r(true); } });
const CAPTURE_ERRORS = {
  "no-access": "the extension isn't allowed to capture this tab",
  "not-active": "the tab wasn't the active tab when you asked",
  "too-large": "the screenshot couldn't be made small enough",
  "capture-failed": "the browser refused the capture",
};

async function capture(id) {
  return await chrome.runtime.sendMessage({ type: "capture", tabId: id }).catch((e) => ({ error: String(e) }));
}

async function refreshTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const changed = tab.id !== tabId;
  tabId = tab.id; tabWindowId = tab.windowId;
  $("pageTitle").textContent = tab.title || "This tab";
  $("pageUrl").textContent = tab.url ? decodeURI(tab.url) : "Press Alt+Shift+G or click the toolbar icon to let me read this page";
  if (changed) { selectionOverride = ""; showSelection(); await renderThread(); }
}

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

function botMessage(m) {
  const wrap = el("div", "msg bot" + (m.error ? " error" : ""));
  wrap.dataset.ts = m.ts;
  if (m.pending) {
    const live = streams.get(m.ts);
    if (live && live.text) { wrap.classList.add("streaming"); wrap.appendChild(el("div", "body", renderMarkdown(live.text))); return wrap; }
    wrap.appendChild(el("div", "thinking", `<span class="dots"><span></span><span></span><span></span></span><span>Reading the page…</span>`));
    return wrap;
  }
  const body = el("div", "body", renderMarkdown(m.text));
  wrap.appendChild(body);
  body.querySelectorAll(".copy-code").forEach((b) => b.addEventListener("click", () => {
    navigator.clipboard.writeText(b.nextElementSibling.innerText); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200);
  }));
  if (!m.error) {
    const tools = el("div", "tools"); const copy = el("button", "tool", "Copy");
    copy.addEventListener("click", () => { navigator.clipboard.writeText(m.text); copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1200); });
    tools.appendChild(copy); wrap.appendChild(tools);
  }
  return wrap;
}

async function renderThread() {
  const t = tabId == null ? [] : await loadThread(tabId);
  threadEl.querySelectorAll(".msg").forEach((n) => n.remove());
  emptyEl.classList.toggle("hidden", t.length > 0);
  for (const m of t) {
    if (m.role === "user") {
      const u = el("div", "msg user"); u.textContent = m.text;
      if (m.ctx) { const c = el("span", "ctx"); c.textContent = m.ctx; u.appendChild(c); }
      threadEl.appendChild(u);
    } else threadEl.appendChild(botMessage(m));
  }
  threadEl.scrollTop = threadEl.scrollHeight;
  // Resume polling for questions still pending (e.g. the panel was closed and reopened).
  for (const m of t) if (m.pending && m.request_id && !busy.has(m.request_id)) resume(tabId, m);
  // xAI streams can't survive the panel closing; mark those as interrupted.
  for (const m of t) if (m.pending && m.xai && !streams.has(m.ts)) finish(tabId, m.ts, { error: true, text: "Interrupted (the panel was closed while the answer was streaming). Ask again." });
}

function showSelection() {
  $("selectionChip").classList.toggle("hidden", !selectionOverride);
  $("selectionText").textContent = selectionOverride;
}

async function extract(id) {
  return await chrome.runtime.sendMessage({ type: "extract", tabId: id, maxChars: PAGE_TEXT_MAX });
}

function describe(ctx) {
  const extra = (ctx.pdf_page ? ` · page ${ctx.pdf_page}` : "") + (ctx.screenshot ? " · screenshot" : "");
  if (ctx.source === "local_file") return `Local file: ${ctx.local_path}${extra}`;
  if (ctx.pdf_url) return "PDF" + (ctx.page_text ? " (text + link)" : " (link only)") + extra;
  const kb = Math.round((ctx.page_text || "").length / 1000);
  return `Page text: ${kb}k chars${ctx.truncated ? " (truncated)" : ""}${ctx.selection ? " · selection" : ""}${extra}`;
}

async function send(text) {
  text = text.trim(); if (!text || tabId == null) return;
  const s = await getSettings();
  if (!isConfigured(s)) { notice(s.mode === "xai" ? "Open Settings (⚙) and add your xAI API key first." : "Open Settings (⚙) and add the relay URL and extension token first.", "error"); return; }
  const who = assistantName(s), Who = who[0].toUpperCase() + who.slice(1);
  const myTab = tabId;
  q.value = ""; autosize();
  let ctx = await extract(myTab).catch((e) => ({ error: String(e) }));
  if (!ctx) ctx = { error: "inject-failed" };
  if (ctx.error === "restricted") notice("Browser pages (chrome://, edge://, the Web Store) can't be read. I'll answer without page content.");
  else if (ctx.error === "no-access") notice(/^file:/i.test(ctx.url || "") && !(await fileAccessOn()) ? FILE_ACCESS_MSG : "I can't read this page. Press Alt+Shift+G (or click the toolbar icon) on it, or check the extension's site access is \"On all sites\".");
  else if (ctx.error) notice("Couldn't read this page's text (" + (ctx.detail || ctx.error) + "). Answering with what I have.");
  else if (ctx.note === "text-not-readable") notice(ctx.source === "local_file" ? (s.mode === "xai" ? "This local file's text isn't readable in the browser, so Grok only sees the screenshot of what's on screen." : "This local file's text isn't readable in the browser; your Grok Bot can open it if it has access to your computer.") : `This PDF's text isn't readable in the browser; ${who} will use ${s.mode === "xai" ? "the screenshot" : "the PDF link"}.`);
  else notice("");
  const selection = selectionOverride || ctx.selection || "";

  let screenshot = "", screenshotError = "";
  if (wantsScreenshot(ctx)) {
    const shot = await capture(myTab);
    if (shot && shot.screenshot) {
      screenshot = shot.screenshot;
      if (ctx.note === "text-not-readable") notice("The PDF viewer hides its text from extensions, so I'm sending a screenshot of the page on screen" + (s.mode === "xai" ? "." : ctx.source === "local_file" ? " and the file path." : " plus the PDF link."));
    }
    else {
      // Never silent: say why, and tell the model too (screenshot_error) so it doesn't guess.
      const code = (shot && shot.error) || "capture-failed";
      screenshotError = (code + (shot && shot.detail ? ": " + shot.detail : "")).slice(0, 300);
      const why = CAPTURE_ERRORS[code] || code;
      if (/^file:/i.test(ctx.url || "") && !(await fileAccessOn())) notice(FILE_ACCESS_MSG, "error");
      else if (code === "no-access" && !(await chrome.permissions.contains(ALL_SITES).catch(() => false))) {
        notice(`No screenshot sent (${why}), so ${who} can't see which page you're on. Press Alt+Shift+G on this tab and ask again, or allow site access:`, "error", {
          label: "Allow on all sites",
          onClick: async () => { const okd = await chrome.permissions.request(ALL_SITES).catch(() => false); notice(okd ? "Done. Ask again and I'll include what's on screen." : "Not allowed. Press Alt+Shift+G on the tab before asking."); },
        });
      } else notice(`No screenshot sent (${why}${shot && shot.detail ? ": " + shot.detail : ""}). ${Who} can't see which page you're on; tell it the page number or select the passage.`, "error");
    }
  }

  const thread = await loadThread(myTab);
  const history = [];
  for (let i = 0; i < thread.length - 1; i++) if (thread[i].role === "user" && thread[i + 1].role === "bot" && !thread[i + 1].error && !thread[i + 1].pending) history.push({ q: thread[i].text, a: thread[i + 1].text });
  const body = {
    question: text,
    url: ctx.url || "", title: ctx.title || "",
    selection, visible_text: ctx.visible_text || "", page_text: ctx.page_text || "",
    truncated: !!ctx.truncated, pdf_url: ctx.pdf_url || "",
    history: history.slice(-6),
  };
  if (ctx.pdf_page) body.pdf_page = ctx.pdf_page;
  if (screenshot) body.screenshot = screenshot;
  else if (screenshotError) body.screenshot_error = screenshotError;
  if (ctx.pdf_page) body.pdf_page_source = "url_fragment"; // the #page= the PDF was opened at; may be stale after scrolling
  body.ext_version = chrome.runtime.getManifest().version;
  if (ctx.source === "local_file") { body.source = "local_file"; body.local_path = ctx.local_path || ""; }

  const userMsg = { role: "user", text, ctx: describe({ ...ctx, selection, screenshot: !!screenshot }) + (screenshotError ? " · no screenshot" : ""), ts: Date.now() };
  const pending = { role: "bot", pending: true, ts: Date.now() };
  if (s.mode === "xai") { pending.xai = true; streams.set(pending.ts, { text: "", ctrl: new AbortController() }); }
  thread.push(userMsg, pending); await saveThread(myTab, thread);
  selectionOverride = ""; showSelection();
  if (myTab === tabId) await renderThread();

  if (s.mode === "xai") { await streamXai(myTab, pending, body); return; }

  try {
    const r = await ask(body);
    pending.request_id = r.request_id; pending.started = Date.now();
    const t2 = await loadThread(myTab); const p = t2.find((m) => m.pending && m.ts === pending.ts);
    if (p) { p.request_id = r.request_id; p.started = pending.started; await saveThread(myTab, t2); }
    await resume(myTab, pending);
  } catch (e) {
    await finish(myTab, pending.ts, { error: true, text: e.message });
  }
}

// xAI mode: stream tokens straight into the pending message.
async function streamXai(tid, pending, body) {
  const live = streams.get(pending.ts);
  let queued = false;
  const r = await askXai(body, {
    signal: live.ctrl.signal,
    onDelta: (text) => {
      live.text = text;
      if (queued || tid !== tabId) return; queued = true;
      setTimeout(() => { // setTimeout, not rAF: rAF pauses while the panel is hidden or occluded
        queued = false;
        if (!streams.has(pending.ts)) return; // already finished; don't overwrite the final answer
        const node = threadEl.querySelector(`.msg.bot[data-ts="${pending.ts}"]`); if (!node) return;
        const stick = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 40;
        node.replaceWith(botMessage({ ...pending }));
        if (stick) threadEl.scrollTop = threadEl.scrollHeight;
      }, 60);
    },
  });
  streams.delete(pending.ts);
  if (r.cancelled) { await finish(tid, pending.ts, { error: true, text: "Stopped." }); return; }
  await finish(tid, pending.ts, r.answer != null ? { text: r.answer } : { error: true, text: r.error });
}

async function resume(tid, m) {
  busy.add(m.request_id);
  const r = await waitForAnswer(m.request_id, m.started || m.ts);
  busy.delete(m.request_id);
  if (r.cancelled) return;
  await finish(tid, m.ts, r.answer != null ? { text: r.answer } : { error: true, text: r.error });
}

async function finish(tid, ts, patch) {
  const t = await loadThread(tid);
  const i = t.findIndex((m) => m.role === "bot" && m.ts === ts);
  if (i < 0) return;
  t[i] = { role: "bot", ts, ...patch }; await saveThread(tid, t);
  if (tid === tabId) await renderThread();
}

function autosize() { q.style.height = "auto"; q.style.height = Math.min(160, q.scrollHeight) + "px"; sendBtn.disabled = !q.value.trim(); }

$("askForm").addEventListener("submit", (e) => { e.preventDefault(); send(q.value); });
q.addEventListener("input", autosize);
q.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(q.value); } });
document.querySelectorAll(".sugg").forEach((b) => b.addEventListener("click", () => send(b.textContent)));
$("newChat").addEventListener("click", async () => { if (tabId != null) { for (const v of streams.values()) v.ctrl.abort(); await chrome.storage.session.remove(key(tabId)); notice(""); renderThread(); } });
$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("clearSelection").addEventListener("click", () => { selectionOverride = ""; showSelection(); });

chrome.tabs.onActivated.addListener(refreshTab);
chrome.tabs.onUpdated.addListener((id, info) => { if (id === tabId && (info.title || info.url || info.status === "complete")) refreshTab(); });
chrome.tabs.onRemoved.addListener((id) => chrome.storage.session.remove(key(id)));
chrome.windows?.onFocusChanged?.addListener(() => refreshTab());

async function takePendingSelection() {
  const { pendingSelection: p } = await chrome.storage.session.get("pendingSelection");
  if (!p || Date.now() - p.at > 60000) return;
  await chrome.storage.session.remove("pendingSelection");
  await refreshTab();
  if (p.tabId === tabId) { selectionOverride = p.text; showSelection(); q.value = q.value || "Explain this passage"; autosize(); q.focus(); q.select(); }
}
chrome.storage.onChanged.addListener((c, area) => {
  if (area === "session" && c.pendingSelection?.newValue) takePendingSelection();
  if (area === "local" && (c.mode || c.relayUrl || c.extToken || c.xaiKey)) getSettings().then((s) => { $("modeBadge").textContent = s.mode === "xai" ? "xAI API" : "Grok Bot"; if (isConfigured(s)) notice(""); });
});

(async () => {
  await refreshTab(); await renderThread(); await takePendingSelection(); autosize(); q.focus();
  const s = await getSettings();
  $("modeBadge").textContent = s.mode === "xai" ? "xAI API" : "Grok Bot";
  if (!isConfigured(s)) notice("Open Settings (⚙) to connect your Grok Bot or add an xAI API key.", "error");
})();

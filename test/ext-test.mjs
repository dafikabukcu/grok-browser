import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "extension"), EXT = path.join(process.env.TMPDIR || "/tmp", "grok-browser-ext-test");
const PAGES_URL = "file://" + path.join(ROOT, "test", "pages").split(path.sep).map(encodeURIComponent).join("/");
const SHOTS = process.env.UPDATE_SCREENSHOTS ? path.join(ROOT, "docs", "screenshots") : path.join(process.env.TMPDIR || "/tmp", "grok-browser-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH; if (!CHROME) { console.error("Set CHROME_PATH to a Chrome for Testing / Chromium binary (run-tests.sh does this)."); process.exit(1); }
fs.rmSync(EXT, { recursive: true, force: true }); fs.cpSync(SRC, EXT, { recursive: true });
const m = JSON.parse(fs.readFileSync(EXT + "/manifest.json")); m.host_permissions = ["<all_urls>"]; // test-only: stands in for the activeTab grant
fs.writeFileSync(EXT + "/manifest.json", JSON.stringify(m));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--window-size=420,800"], enableExtensions: [EXT] }).catch(async (e) => { console.error(e.message); process.exit(1); });
const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"), { timeout: 15000 });
const extId = new URL(sw.url()).host; console.log("extension id", extId);
const results = {}; let pass = 0, fail = 0;
const ok = (c, n, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${n} ${x}`); };

// Enable "Allow access to file URLs" the way the user would on chrome://extensions.
const ce = await browser.newPage(); await ce.goto("chrome://extensions");
await ce.evaluate((id) => new Promise((r) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, fileAccess: true }, r)), extId).catch((e) => console.log("fileAccess toggle failed", e.message));
await ce.close();
await new Promise((r) => setTimeout(r, 1500));

const opt = await browser.newPage(); await opt.goto(`chrome-extension://${extId}/options.html`);
await opt.evaluate((tok) => chrome.storage.local.set({ relayUrl: "http://127.0.0.1:8787", extToken: tok }), process.env.TEST_EXT);

async function extractUrl(url, setup) {
  const p = await browser.newPage(); await p.goto(url, { waitUntil: "load" }); if (setup) await setup(p);
  await new Promise((r) => setTimeout(r, 800));
  const r = await opt.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({}); const t = tabs.find((x) => x.url === u || decodeURI(x.url || "") === decodeURI(u));
    return chrome.runtime.sendMessage({ type: "extract", tabId: t.id, maxChars: 60000 });
  }, p.url());
  return { page: p, r };
}

let { page, r } = await extractUrl("http://127.0.0.1:8800/article.html", async (p) => p.evaluate(() => { const s = getSelection(); const rg = document.createRange(); rg.selectNodeContents(document.getElementById("sel")); s.removeAllRanges(); s.addRange(rg); }));
ok(r.title.includes("Loomings"), "article: title");
ok(r.selection.startsWith("It is a way I have"), "article: selection");
ok(r.visible_text.includes("Call me Ishmael") && !r.visible_text.includes("FAR-BELOW-THE-FOLD"), "article: visible_text = viewport only");
ok(r.page_text.includes("FAR-BELOW-THE-FOLD") && !r.page_text.includes("ADVERT") && !r.page_text.includes("Footer junk"), "article: page_text readable, nav/aside/footer stripped", `(${r.page_text.length} chars)`);
results.article = r;

({ r } = await extractUrl("http://127.0.0.1:8800/frames.html"));
ok(r.page_text.includes("Whaleman's Chapel"), "iframe reader: same-origin frame text merged");

({ r } = await extractUrl("http://127.0.0.1:8800/sample-book.pdf"));
ok(r.pdf_url === "http://127.0.0.1:8800/sample-book.pdf", "PDF viewer: pdf_url detected", JSON.stringify({ err: r.error, note: r.note, len: (r.page_text || "").length }));

const fileUrl = PAGES_URL + "/local%20book%20%C3%A7.html";
({ r } = await extractUrl(fileUrl));
ok(r.source === "local_file" && r.local_path === path.join(ROOT, "test", "pages", "local book ç.html") && (r.page_text || "").includes("local file on disk"), "file:// page: source/local_path + text", JSON.stringify({ err: r.error, local_path: r.local_path }));
results.file = r;

({ r } = await extractUrl(PAGES_URL + "/sample-book.pdf"));
ok(r.source === "local_file" && r.pdf_url && r.local_path.endsWith("sample-book.pdf"), "local PDF: local_path + pdf_url", JSON.stringify({ err: r.error, note: r.note, local_path: r.local_path }));

// Screenshots of the visible tab (PDF viewer text/current page isn't readable by extensions).
const capture = (tabUrl, maxBytes) => opt.evaluate(async (u, mb) => {
  const tabs = await chrome.tabs.query({}); const t = tabs.find((x) => decodeURI(x.url || "") === decodeURI(u));
  return chrome.runtime.sendMessage({ type: "capture", tabId: t.id, maxBytes: mb });
}, tabUrl, maxBytes);
const b64len = (d) => Math.floor((d.length - d.indexOf(",") - 1) * 3 / 4);
let pdfPage = await browser.newPage(); await pdfPage.setViewport({ width: 1280, height: 900 });
await pdfPage.goto("http://127.0.0.1:8800/sample-book.pdf#page=2", { waitUntil: "load" }); await new Promise((r) => setTimeout(r, 1500));
({ r } = await extractUrl("http://127.0.0.1:8800/sample-book.pdf#page=2")); r.page?.close?.();
ok(r.pdf_page === 2, "PDF #page=2 -> pdf_page 2", JSON.stringify({ pdf_page: r.pdf_page }));
await pdfPage.bringToFront(); await new Promise((r) => setTimeout(r, 300));
let shot = await capture(pdfPage.url());
ok(shot.screenshot && shot.screenshot.startsWith("data:image/jpeg;base64,/9j/") && b64len(shot.screenshot) <= 400 * 1024, "capture PDF tab: JPEG under 400 KB", JSON.stringify({ err: shot.error, detail: shot.detail, bytes: shot.bytes }));
const pdfShot = shot.screenshot;
shot = await capture(pdfPage.url(), 15000);
ok(shot.screenshot && b64len(shot.screenshot) <= 15000 && shot.width < 1280, "capture downscales to fit a byte budget", JSON.stringify({ err: shot.error, bytes: shot.bytes, w: shot.width }));
const otherTab = await browser.newPage(); await otherTab.goto("http://127.0.0.1:8800/article.html");
shot = await capture(pdfPage.url());
ok(shot.error === "not-active", "capture refuses a background tab (would shoot the wrong page)");
await otherTab.close();
const localPdf = await browser.newPage(); await localPdf.setViewport({ width: 1280, height: 900 });
await localPdf.goto(PAGES_URL + "/sample-book.pdf#page=1"); await new Promise((r) => setTimeout(r, 1500)); await localPdf.bringToFront();
shot = await capture(localPdf.url());
ok(shot.screenshot && shot.screenshot.startsWith("data:image/jpeg"), "capture local file:// PDF tab", JSON.stringify({ err: shot.error, detail: shot.detail, bytes: shot.bytes }));
await localPdf.close();

// Question + screenshot through the relay: the mock bot gets screenshot_url and fetches the JPEG with the reply token.
const shotAns = await opt.evaluate(async (s) => { const api = await import("./api.js");
  const rr = await api.ask({ question: "Explain what I'm looking at right now", url: "http://127.0.0.1:8800/sample-book.pdf#page=2", title: "sample-book.pdf", selection: "", visible_text: "", page_text: "", truncated: false, pdf_url: "http://127.0.0.1:8800/sample-book.pdf#page=2", pdf_page: 2, screenshot: s, history: [] });
  return { rr, a: await api.waitForAnswer(rr.request_id, Date.now()) }; }, pdfShot);
let mlog = await (await fetch("http://127.0.0.1:8799/_log")).json(); let mlast = mlog.find((x) => x.question && x.question.startsWith("Explain what I'm looking"));
ok(shotAns.rr.screenshot === true && mlast && mlast.shot_status === 200 && mlast.shot_jpeg && mlast.pdf_page === 2 && !mlast.has_image_field && shotAns.a.answer, "extension screenshot -> relay -> bot fetches screenshot_url", JSON.stringify(mlast || {}).slice(0, 200));

// Real side panel send on a PDF tab: the panel itself must attach the screenshot.
await pdfPage.bringToFront();
const spWin = await opt.evaluate(async (id) => (await chrome.windows.create({ url: `chrome-extension://${id}/sidepanel.html`, type: "popup", focused: false, width: 400, height: 700 })).id, extId);
const spT = await browser.waitForTarget((t) => t.url().endsWith("/sidepanel.html"), { timeout: 10000 });
const spp = await spT.page(); await new Promise((r) => setTimeout(r, 1000));
const panelTab = await spp.$eval("#pageUrl", (e) => e.textContent);
await spp.evaluate(() => { const q = document.getElementById("question"); q.value = "Explain what I'm looking at right now"; q.dispatchEvent(new Event("input")); document.getElementById("askForm").requestSubmit(); });
let mshot = null;
for (let i = 0; i < 30 && !mshot; i++) { await new Promise((r) => setTimeout(r, 500)); mlog = await (await fetch("http://127.0.0.1:8799/_log")).json(); mshot = mlog.filter((x) => x.question && x.question.startsWith("Explain what I'm looking"))[1]; }
ok(mshot && mshot.screenshot_url && mshot.shot_status === 200 && mshot.shot_jpeg && mshot.pdf_page === 2, "side panel send on PDF tab attaches screenshot + pdf_page", JSON.stringify({ panelTab, m: mshot }).slice(0, 260));
await new Promise((r) => setTimeout(r, 2500));
const chip = await spp.$$eval(".msg.user .ctx", (e) => e.map((x) => x.textContent));
ok(chip.some((c) => /page 2/.test(c) && /screenshot/.test(c)), "side panel shows 'page 2 · screenshot' context", JSON.stringify(chip));
await opt.evaluate((w) => chrome.windows.remove(w), spWin);

// Full round trip through the relay + mock bot using the extension's own api.js.
const art = results.article;
const ans = await opt.evaluate(async (ctx) => {
  const api = await import("./api.js");
  const rr = await api.ask({ question: "Summarize", url: ctx.url, title: ctx.title, selection: ctx.selection, visible_text: ctx.visible_text, page_text: ctx.page_text, truncated: ctx.truncated, pdf_url: "", history: [] });
  return api.waitForAnswer(rr.request_id, Date.now());
}, art);
ok(ans.answer && ans.answer.includes("Mock answer"), "extension -> relay -> mock bot -> extension poll", JSON.stringify(ans).slice(0, 120));
const ping = await opt.evaluate(async () => { const api = await import("./api.js"); const rr = await api.ask({ question: "__ping__", history: [] }); return api.waitForAnswer(rr.request_id, Date.now()); });
ok(ping.answer === "pong", "options Test connection path (__ping__ -> pong)");
await opt.setViewport({ width: 900, height: 1400 }); await opt.reload(); await new Promise((r) => setTimeout(r, 800));
const promptShown = await opt.$eval("#botPrompt", (e) => e.textContent);
ok(promptShown === fs.readFileSync(path.join(SRC, "bot-prompt.txt"), "utf8") && /ROUTINE PROMPT \(start\)/.test(promptShown), "options: 'paste this to your Grok Bot' prompt is shown verbatim");
await opt.bringToFront(); await opt.evaluate(() => document.getElementById("genTokens").click());
const toks = await opt.evaluate(() => [document.getElementById("tokExt").textContent, document.getElementById("tokReply").textContent, document.getElementById("extToken").value]);
ok(/^[A-Za-z0-9_-]{43}$/.test(toks[0]) && /^[A-Za-z0-9_-]{43}$/.test(toks[1]) && toks[0] !== toks[1] && toks[2] === toks[0], "options: Generate tokens makes two different 256-bit tokens and fills EXT_TOKEN");
await opt.evaluate((tok) => { document.getElementById("extToken").value = tok; document.getElementById("tokens").classList.add("hidden"); }, process.env.TEST_EXT);
await opt.bringToFront(); await opt.screenshot({ path: path.join(SHOTS, "options.png"), fullPage: true });

// Side panel UI rendering with a seeded thread.
const sp = await browser.newPage(); await sp.setViewport({ width: 400, height: 760 });
await sp.goto(`chrome-extension://${extId}/sidepanel.html`);
await sp.evaluate(async () => {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  await chrome.storage.session.set({ ["thread:" + t.id]: [
    { role: "user", text: "What is this chapter about?", ctx: "Page text: 12k chars · selection", ts: 1 },
    { role: "bot", ts: 2, text: "### Chapter 1 — Loomings\nIshmael explains **why he goes to sea**:\n\n1. He's restless and broke\n2. The sea *cures his gloom*\n\n> Call me Ishmael.\n\n```js\nconsole.log('code block')\n```\nSee [the text](https://www.gutenberg.org/ebooks/2701)." },
    { role: "user", text: "And the next chapter?", ctx: "Page text: 12k chars", ts: 3 },
    { role: "bot", ts: 4, pending: true },
  ] });
});
await sp.bringToFront(); await sp.reload(); await new Promise((r) => setTimeout(r, 800));
await sp.screenshot({ path: path.join(SHOTS, "sidepanel.png") });
const html = await sp.$eval("#thread", (e) => e.innerHTML);
ok(html.includes("<strong>why he goes to sea</strong>") && html.includes("<ol>") && html.includes("thinking") && html.includes('href="https://www.gutenberg.org/ebooks/2701"'), "side panel renders Markdown + thinking state");
const xss = await sp.evaluate(async () => (await import("./markdown.js")).renderMarkdown("<img src=x onerror=alert(1)> [x](javascript:alert(1))"));
ok(!xss.includes("<img") && !xss.includes('href="javascript'), "markdown renderer escapes HTML / blocks javascript: links");

// ---------- xAI API key mode (against a local mock of /v1/chat/completions) ----------
const XAI = "http://127.0.0.1:8798/v1";
const xlog = async () => (await fetch("http://127.0.0.1:8798/_log")).json();
await opt.evaluate((base) => chrome.storage.local.set({ mode: "xai", xaiKey: "xai-wrong", xaiBaseUrl: base, xaiModel: "grok-4.7", xaiEffort: "low" }), XAI);
let xr = await opt.evaluate(async () => (await import("./api.js")).askXai({ question: "hi", url: "https://example.com", title: "t", page_text: "x", history: [] }));
ok(/rejected the API key/.test(xr.error || ""), "xAI mode: bad key -> clear error", JSON.stringify(xr));
await opt.evaluate(() => chrome.storage.local.set({ xaiKey: "xai-test-key" }));
xr = await opt.evaluate(async () => (await import("./api.js")).testXai());
ok(xr.answer === "pong", "xAI mode: Test key (non-streaming) works", JSON.stringify(xr));
const deltas = await opt.evaluate(async (s) => { const api = await import("./api.js"); const seen = [];
  const r = await api.askXai({ question: "Explain what I'm looking at right now", url: "http://127.0.0.1:8800/sample-book.pdf#page=2", title: "sample-book.pdf", pdf_url: "http://127.0.0.1:8800/sample-book.pdf", pdf_page: 2, pdf_page_source: "url_fragment", screenshot: s, page_text: "", history: [{ q: "earlier q", a: "earlier a" }] }, { onDelta: (t) => seen.push(t.length) });
  return { r, n: seen.length }; }, pdfShot);
let xl = (await xlog()).at(-1);
ok(deltas.r.answer && deltas.r.answer.startsWith("**Streamed answer** about the screenshot (page 2)") && deltas.n > 3, "xAI mode: answer streams in (SSE deltas)", JSON.stringify({ n: deltas.n, a: (deltas.r.answer || deltas.r.error || "").slice(0, 60) }));
ok(xl.auth && xl.model === "grok-4.7" && xl.stream === true && xl.effort === "low" && xl.system && xl.n_messages === 4 && xl.has_image && xl.image_jpeg && xl.untrusted_fence, "xAI mode: request has key, model, system prompt, history, JPEG screenshot, fenced page content", JSON.stringify(xl));
// Real side panel send in xAI mode on the PDF tab.
await pdfPage.bringToFront();
const xWin = await opt.evaluate(async (id) => (await chrome.windows.create({ url: `chrome-extension://${id}/sidepanel.html`, type: "popup", focused: false, width: 400, height: 700 })).id, extId);
await new Promise((r) => setTimeout(r, 300));
const xT = await browser.waitForTarget((t) => t.url().endsWith("/sidepanel.html"), { timeout: 10000 });
const xsp = await xT.page(); await new Promise((r) => setTimeout(r, 1000));
const badge = await xsp.$eval("#modeBadge", (e) => e.textContent);
await xsp.evaluate(() => { const q = document.getElementById("question"); q.value = "Explain what I'm looking at (xai)"; q.dispatchEvent(new Event("input")); document.getElementById("askForm").requestSubmit(); });
let sawStreaming = false, final = "";
for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 150)); const st = await xsp.evaluate(() => { const b = [...document.querySelectorAll(".msg.bot")].at(-1); return b ? { s: b.classList.contains("streaming"), t: b.textContent, p: !!b.querySelector(".thinking") } : null; });
  if (st && st.s) sawStreaming = true; if (st && !st.s && !st.p && st.t) { final = st.t; break; } }
xl = (await xlog()).at(-1);
ok(badge === "xAI API" && sawStreaming && /Streamed answer/.test(final) && xl.has_image && xl.question.startsWith("Explain what I'm looking at (xai)"), "xAI mode: side panel streams the answer and sends the screenshot", JSON.stringify({ badge, sawStreaming, final: final.slice(0, 50), img: xl.has_image }));
await new Promise((r) => setTimeout(r, 500));
{ // README shot: snapshot the (unfocused) panel's DOM into a visible page with the panel CSS inlined; scripts stripped.
  const html = await xsp.evaluate(() => document.documentElement.outerHTML.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<link[^>]*stylesheet[^>]*>/g, ""));
  const snap = await browser.newPage(); await snap.setViewport({ width: 400, height: 640 });
  await snap.setContent(html.replace(/src="icons\/icon32\.png"/g, `src="data:image/png;base64,${fs.readFileSync(path.join(SRC, "icons/icon32.png")).toString("base64")}"`).replace("</head>", `<style>${fs.readFileSync(path.join(SRC, "sidepanel.css"), "utf8")}</style></head>`));
  await snap.screenshot({ path: path.join(SHOTS, "sidepanel-pdf.png") }); await snap.close();
}
const saved = await xsp.evaluate(async () => { const all = await chrome.storage.session.get(null); const msgs = Object.values(all).filter(Array.isArray).flat(); const i = msgs.findIndex((m) => m && m.role === "user" && /\(xai\)/.test(m.text || "")); const b = msgs.slice(i + 1).find((m) => m && m.role === "bot"); return i < 0 || !b ? [true] : [!!b.pending || !/Streamed answer/.test(b.text || "")]; });
ok(saved.length > 0 && saved.every((p) => !p), "xAI mode: finished answer saved to the tab's chat (not left pending)", JSON.stringify(saved));
await opt.evaluate((w) => chrome.windows.remove(w), xWin);
await opt.evaluate(() => chrome.storage.local.set({ mode: "relay" }));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); process.exit(fail ? 1 : 0);


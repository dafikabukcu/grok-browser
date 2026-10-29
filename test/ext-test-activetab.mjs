// Real-world access test: NO host permission (as if site access were limited), file access on,
// a local multi-page PDF in Chrome's PDF viewer, access only via the toolbar action (activeTab).
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "extension"), EXT = path.join(process.env.TMPDIR || "/tmp", "grok-browser-ext-test-at");
const SHOTS = process.env.UPDATE_SCREENSHOTS ? path.join(ROOT, "docs", "screenshots") : path.join(process.env.TMPDIR || "/tmp", "grok-browser-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH; if (!CHROME) { console.error("Set CHROME_PATH to a Chrome for Testing / Chromium binary (run-tests.sh does this)."); process.exit(1); }
fs.rmSync(EXT, { recursive: true, force: true }); fs.cpSync(SRC, EXT, { recursive: true });
const m = JSON.parse(fs.readFileSync(EXT + "/manifest.json")); delete m.host_permissions; m.optional_host_permissions = ["<all_urls>"];
fs.writeFileSync(EXT + "/manifest.json", JSON.stringify(m));
const PDF = "file://" + path.join(ROOT, "test", "pages", "sample-book.pdf").split(path.sep).map(encodeURIComponent).join("/");
let pass = 0, fail = 0; const ok = (c, n, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${n} ${x}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--window-size=1280,900"], enableExtensions: [EXT] });
let swT = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"));
const extId = new URL(swT.url()).host;
const ce = await browser.newPage(); await ce.goto("chrome://extensions");
await ce.evaluate((id) => new Promise((r) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, fileAccess: true }, r)), extId); await ce.close();
await sleep(1500);
const ext = [...(await browser.extensions()).values()].find((e) => e.id === extId);
const opt = await browser.newPage(); await opt.goto(`chrome-extension://${extId}/options.html`);
await opt.evaluate((tok) => chrome.storage.local.set({ relayUrl: "http://127.0.0.1:8787", extToken: tok }), process.env.TEST_EXT);
const perms = await opt.evaluate(() => chrome.permissions.getAll());
ok(perms.origins.length === 0, "setup: no host permissions (activeTab only)", JSON.stringify(perms.origins));
await sleep(500);
const access = await opt.$eval("#access", (e) => e.textContent);
ok(/limited/.test(access) && /Local files: allowed/.test(access), "options shows limited site access + file access state", JSON.stringify(access));

const mlog = async () => (await fetch("http://127.0.0.1:8799/_log")).json();
async function panelAsk(question) {
  const win = await opt.evaluate(async (id) => (await chrome.windows.create({ url: `chrome-extension://${id}/sidepanel.html`, type: "popup", focused: false, width: 400, height: 700 })).id, extId);
  const t = await browser.waitForTarget((t) => t.url().endsWith("/sidepanel.html")); const sp = (await t.page()) || (await t.asPage()); await sleep(1000);
  const before = (await mlog()).length;
  await sp.evaluate((q) => { const el = document.getElementById("question"); el.value = q; el.dispatchEvent(new Event("input")); document.getElementById("askForm").requestSubmit(); }, question);
  let hit = null; for (let i = 0; i < 30 && !hit; i++) { await sleep(500); const l = await mlog(); hit = l.slice(before).find((x) => x.question === question.slice(0, 40)); }
  await sleep(2500);
  const out = { hit, notice: await sp.$eval("#notice", (e) => e.classList.contains("hidden") ? "" : e.textContent), chips: await sp.$$eval(".msg.user .ctx", (e) => e.map((x) => x.textContent)), url: await sp.$eval("#pageUrl", (e) => e.textContent) };
  await opt.evaluate((w) => chrome.windows.remove(w), win); await sleep(300);
  return out;
}

// 1. Local PDF tab, no click on the toolbar yet -> no access: must NOT be silent.
const pdf = await browser.newPage(); await pdf.setViewport({ width: 1280, height: 900 });
await pdf.goto(PDF + "#page=9"); await sleep(3500); await pdf.bringToFront();
let r = await panelAsk("Explain what I'm looking at (no grant)");
ok(r.hit && !r.hit.screenshot_url && /^no-access/.test(r.hit.screenshot_error || ""), "without activeTab: bot is told screenshot_error=no-access", JSON.stringify(r.hit && { e: r.hit.screenshot_error, v: r.hit.ext_version }));
ok(/No screenshot sent/.test(r.notice) && /Alt\+Shift\+G/.test(r.notice), "without activeTab: panel shows a visible error", JSON.stringify(r.notice).slice(0, 160));
ok(r.chips.some((c) => /no screenshot/.test(c)), "without activeTab: chip says 'no screenshot'", JSON.stringify(r.chips));

// 2. Press the toolbar icon / Alt+Shift+G on the PDF tab (activeTab grant), then ask.
await pdf.bringToFront(); await pdf.triggerExtensionAction(ext); await sleep(800);
r = await panelAsk("Explain what I'm looking at (granted)");
ok(r.hit && r.hit.shot_status === 200 && r.hit.shot_jpeg && r.hit.pdf_page === 9 && r.hit.ext_version === m.version, "activeTab on local file:// PDF: screenshot arrives + pdf_page 9", JSON.stringify(r.hit && { s: r.hit.shot_status, bytes: r.hit.shot_bytes, pg: r.hit.pdf_page, src: r.hit.pdf_page_source, v: r.hit.ext_version }));
ok(r.chips.some((c) => /page 9 · screenshot/.test(c)), "panel chip: 'page 9 · screenshot'", JSON.stringify(r.chips));
// Save what the bot would see so a human can check the toolbar shows "9 / 16".
const shotId = r.hit && r.hit.screenshot_url && r.hit.screenshot_url.split("/").pop();
if (shotId) { const s = await fetch(`http://127.0.0.1:8787/screenshot/${shotId}`, { headers: { Authorization: `Bearer ${process.env.TEST_REPLY}` } }); fs.writeFileSync(path.join(SHOTS, "pdf-screenshot-page9.jpg"), Buffer.from(await s.arrayBuffer())); }

// 3. Scroll in the viewer, ask again on the same tab (grant persists on the same document).
await pdf.bringToFront(); await pdf.mouse.click(800, 500); for (let i = 0; i < 6; i++) await pdf.keyboard.press("PageDown"); await sleep(1200);
r = await panelAsk("Explain what I'm looking at (scrolled)");
ok(r.hit && r.hit.shot_status === 200, "after scrolling on the same tab: screenshot still arrives", JSON.stringify(r.hit && { s: r.hit.shot_status, e: r.hit.screenshot_error }));
if (r.hit && r.hit.screenshot_url) { const s = await fetch(`http://127.0.0.1:8787/screenshot/${r.hit.screenshot_url.split("/").pop()}`, { headers: { Authorization: `Bearer ${process.env.TEST_REPLY}` } }); fs.writeFileSync(path.join(process.env.TMPDIR || "/tmp", "grok-browser-pdf-scrolled.jpg"), Buffer.from(await s.arrayBuffer())); }

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); process.exit(fail ? 1 : 0);

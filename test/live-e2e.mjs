// Optional LIVE end-to-end run against a real deployed relay and a real Grok Bot (not part of `npm test`):
// the wizard opens on install, imports the settings file from `npm run setup`, waits for a real "pong", then the
// side panel asks about page 2 of the sample PDF (with a screenshot) and prints the answer and latencies.
//   CHROME_PATH=... GB_LIVE_SETTINGS=relay/grok-browser-settings.json node test/live-e2e.mjs
// Your bot must already have the relay URL and reply token. Uses real routine runs; prints no tokens.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "extension"), EXT = path.join(process.env.TMPDIR || "/tmp", "grok-browser-live-ext");
fs.rmSync(EXT, { recursive: true, force: true }); fs.cpSync(SRC, EXT, { recursive: true });
const SETTINGS = path.resolve(process.env.GB_LIVE_SETTINGS || path.join(ROOT, "relay", "grok-browser-settings.json"));
if (!fs.existsSync(SETTINGS)) { console.error("Settings file not found: " + SETTINGS); process.exit(1); }
const PDF = path.join(ROOT, "test", "pages", "sample-book.pdf");
if (!fs.existsSync(PDF)) { console.error("Run `node test/gen-test-pdf.mjs` first."); process.exit(1); }
const srv = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "application/pdf" }); r.end(fs.readFileSync(PDF)); }).listen(8801);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = () => new Date().toTimeString().slice(0, 8);
const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ["--no-sandbox", "--window-size=1280,900"], enableExtensions: [EXT] });
const sw = await b.waitForTarget((t) => t.type() === "service_worker", { timeout: 15000 }); const extId = new URL(sw.url()).host;
const obT = await b.waitForTarget((t) => t.url().includes("/onboarding.html"), { timeout: 10000 }).catch(() => null);
console.log(T(), "wizard opened on install:", !!obT);
const ob = await obT.page(); await ob.setViewport({ width: 860, height: 900 });
const step = () => ob.evaluate(() => document.body.dataset.step);
const next = async () => { const before = await step(); await ob.evaluate(() => document.getElementById("next").click()); for (let i = 0; i < 60; i++) { await sleep(100); if ((await step()) !== before) break; } await sleep(450); return step(); };
await ob.waitForFunction(() => document.body.classList.contains("ready"), { timeout: 10000 });
const log = [];
log.push(await step()); log.push(await next());
await ob.evaluate(() => document.querySelector('input[name=mode][value=relay]').closest("label").click()); await sleep(200);
log.push(await next()); log.push(await next()); log.push(await next()); // prompt, deploy, connect
const inp = await ob.$("#importFile"); await inp.uploadFile(SETTINGS); await sleep(800);
const imp = await ob.evaluate(() => ({ status: document.getElementById("importStatus").textContent, url: document.getElementById("relayUrl").value, tokLen: document.getElementById("extToken").value.length, next: document.getElementById("next").disabled }));
console.log(T(), "import:", JSON.stringify(imp));
log.push(await next()); // bot
const bot = await ob.evaluate(() => ({ msg: document.getElementById("botMsg")?.textContent, relay: document.getElementById("showRelay")?.textContent, reply: document.getElementById("showReply")?.textContent, hint: document.getElementById("replyHint")?.textContent, replyRowHidden: document.getElementById("replyRow")?.hidden }));
console.log(T(), "bot step:", JSON.stringify(bot));
const t0 = Date.now(); log.push(await next()); // test, auto-runs ping
let st = ""; for (let i = 0; i < 90; i++) { st = await ob.$eval("#relayTest", (e) => e.className); if (/\bok\b|\berr\b/.test(st)) break; await sleep(2000); }
const txt = await ob.$eval("#relayTestText", (e) => e.textContent);
console.log(T(), `wizard ping: ${st} "${txt}" in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
log.push(await next()); log.push(await next());
console.log("steps:", log.join(" > "));
// Side panel: real PDF question
const pdf = await b.newPage(); await pdf.setViewport({ width: 1280, height: 900 });
await pdf.goto("http://127.0.0.1:8801/sample-book.pdf#page=2", { waitUntil: "load" }); await sleep(2000); await pdf.bringToFront();
const win = await ob.evaluate(async (id) => (await chrome.windows.create({ url: `chrome-extension://${id}/sidepanel.html`, type: "popup", focused: false, width: 400, height: 760 })).id, extId);
const spp = await (await b.waitForTarget((t) => t.url().endsWith("/sidepanel.html"))).page(); await sleep(1200);
const t1 = Date.now();
await spp.evaluate(() => { const q = document.getElementById("question"); q.value = "Explain what I'm looking at right now"; q.dispatchEvent(new Event("input")); document.getElementById("askForm").requestSubmit(); });
let ans = null; for (let i = 0; i < 120; i++) { await sleep(2000); ans = await spp.evaluate(() => { const m = [...document.querySelectorAll(".msg.bot")].pop(); return m && !m.classList.contains("pending") && m.textContent.trim().length > 20 ? m.innerText : null; }); if (ans) break; }
const ctx = await spp.$$eval(".msg.user .ctx", (e) => e.map((x) => x.textContent));
console.log(T(), `side panel answer in ${((Date.now() - t1) / 1000).toFixed(1)}s, ctx ${JSON.stringify(ctx)}:\n${ans}`);
await b.close(); srv.close();
process.exit(/\bok\b/.test(st) && ans ? 0 : 1);

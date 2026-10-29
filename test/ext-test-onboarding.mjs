// Onboarding wizard: opens on install, navigation (buttons + keyboard), validation, persistence, copy buttons,
// both setup paths against the local relay + mock bot / mock xAI, direction-aware transitions and reduced motion.
// With UPDATE_SCREENSHOTS=1 it writes docs/screenshots/onboarding-*.png.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "extension"), EXT = path.join(process.env.TMPDIR || "/tmp", "grok-browser-ext-test-ob");
const SHOTS = process.env.UPDATE_SCREENSHOTS ? path.join(ROOT, "docs", "screenshots") : path.join(process.env.TMPDIR || "/tmp", "grok-browser-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH; if (!CHROME) { console.error("Set CHROME_PATH (run-tests.sh does this)."); process.exit(1); }
fs.rmSync(EXT, { recursive: true, force: true }); fs.cpSync(SRC, EXT, { recursive: true });
const PROMPT = fs.readFileSync(path.join(SRC, "bot-prompt.txt"), "utf8");
let pass = 0, fail = 0;
const ok = (c, n, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${n} ${x}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--window-size=900,1000"], enableExtensions: [EXT] }); // CDP load only, so onInstalled reports a real "install"
const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"), { timeout: 15000 });
const extId = new URL(sw.url()).host;
const obT = await browser.waitForTarget((t) => t.url().startsWith(`chrome-extension://${extId}/onboarding.html`), { timeout: 10000 }).catch(() => null);
ok(!!obT, "install opens the onboarding tab");
await browser.defaultBrowserContext().overridePermissions(`chrome-extension://${extId}`, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
const ob = obT ? await obT.page() : await browser.newPage();
if (!obT) await ob.goto(`chrome-extension://${extId}/onboarding.html`);
await ob.setViewport({ width: 860, height: 900 });
await ob.bringToFront();
const step = () => ob.evaluate(() => document.body.dataset.step);
const waitStep = async (name) => { for (let i = 0; i < 40; i++) { if ((await step()) === name) break; await sleep(50); } await sleep(420); return step(); };
const state = () => ob.evaluate(() => ({ next: document.getElementById("next").disabled, skip: !document.getElementById("skip").hidden, count: document.getElementById("stepCount").textContent, visible: [...document.querySelectorAll(".step:not([hidden])")].map((s) => s.dataset.step), back: getComputedStyle(document.getElementById("back")).visibility, dots: document.querySelectorAll("#dots i").length }));
const click = (id) => ob.evaluate((i) => document.getElementById(i).click(), id);
const press = async (key) => { await ob.keyboard.press(key); };
// Layout check for the current screen: nothing wider than the page, no visible text cut off, copy buttons clear of their text.
const layout = () => ob.evaluate(() => {
  const issues = []; const sec = document.querySelector(".step:not([hidden])");
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push("page scrolls sideways");
  for (const e of sec.querySelectorAll("h1,p,b,span,label,button,a,li,.desc,.meta,.lead")) {
    if (!e.offsetParent || e.closest("code,.cmd")) continue; const cs = getComputedStyle(e);
    if (e.scrollWidth > e.clientWidth + 2 && cs.overflowX !== "visible" && cs.overflowX !== "auto") issues.push("clipped: " + (e.id || e.className || e.tagName) + " " + e.textContent.slice(0, 30));
  }
  const card = document.querySelector(".shell").getBoundingClientRect();
  for (const e of sec.querySelectorAll("button,a.btn,input,.cmd,.choice,.check,.way")) { if (!e.offsetParent) continue; const r = e.getBoundingClientRect(); if (r.right > card.right - 8 || r.left < card.left + 8) issues.push("outside card: " + (e.id || e.className)); }
  const overlap = (a, b) => { const x = a.getBoundingClientRect(), y = b.getBoundingClientRect(); return x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom; };
  for (const btn of sec.querySelectorAll(".cmd .btn")) { const code = btn.parentElement.querySelector("code"); if (code && overlap(btn, code)) issues.push("copy button overlaps " + code.id); }
  const cp = sec.querySelector("#copyPrompt"), pre = sec.querySelector("#botPrompt"); if (cp && pre && overlap(cp, pre)) issues.push("Copy prompt overlaps the prompt");
  return issues;
});
const shot = async (n, name) => { const issues = await layout(); ok(issues.length === 0, `layout clean: ${name}`, issues.join("; ")); await sleep(350); await ob.screenshot({ path: path.join(SHOTS, `onboarding-${n}-${name}.png`), fullPage: true }); };

// 1. Welcome
await waitStep("welcome");
let st = await state();
ok(st.visible.join() === "welcome" && st.back === "hidden" && st.count === "Step 1 of 9" && st.dots === 9, "welcome is step 1 of 9, Back hidden", JSON.stringify(st));
await shot("01", "welcome");

// Forward transition: incoming slides in from the right (moves left), outgoing leaves to the left.
const fwd = await ob.evaluate(async () => { document.getElementById("next").click(); await new Promise((r) => setTimeout(r, 40));
  return { dir: document.body.dataset.lastTransition, frames: document.getAnimations().map((a) => [a.effect.target.dataset.step || a.effect.target.id, a.effect.getKeyframes()[0].transform || "", a.effect.getTiming().duration]), both: document.querySelectorAll(".step:not([hidden])").length }; });
const inF = fwd.frames.find((f) => f[0] === "mode"), outF = fwd.frames.find((f) => f[0] === "welcome");
ok(fwd.dir === "forward" && inF && inF[1] === "translateX(56px)" && outF && fwd.both === 2 && inF[2] >= 250 && inF[2] <= 350, "Next: direction-aware slide+fade (forward, 300 ms)", JSON.stringify(fwd));
await waitStep("mode");
st = await state();
ok(st.visible.join() === "mode", "after the transition only the new screen is shown", JSON.stringify(st.visible));

// 2. Mode: Next disabled until a card is chosen; Enter / ArrowRight don't skip ahead.
ok(st.next === true, "mode: Next disabled until a mode is picked");
await ob.focus("body"); await press("Enter"); await press("ArrowRight"); await sleep(400);
ok((await step()) === "mode", "mode: Enter / → can't skip past an empty choice");
await ob.evaluate(() => document.querySelector('input[name=mode][value=relay]').closest("label").click()); await sleep(200);
st = await state();
ok(st.next === false && (await ob.evaluate(() => chrome.storage.local.get("mode"))).mode === "relay", "mode: choosing Bring your own Grok Bot enables Next and saves the mode");
await shot("02", "mode");
await press("Enter");

// 3a. Prompt + copy button
ok((await waitStep("byo-prompt")) === "byo-prompt", "Enter goes to the next screen");
const shown = await ob.$eval("#botPrompt", (e) => e.textContent);
ok(shown === PROMPT, "prompt: shown verbatim from bot-prompt.txt");
await click("copyPrompt"); await sleep(100);
const copied = await ob.evaluate(async () => ({ label: document.getElementById("copyPrompt").textContent, cls: document.getElementById("copyPrompt").classList.contains("copied"), clip: await navigator.clipboard.readText() }));
ok(copied.label === "Copied ✓" && copied.cls && copied.clip === PROMPT, "prompt: Copy puts the exact prompt on the clipboard and shows “Copied ✓”", JSON.stringify({ label: copied.label, len: copied.clip.length }));
await shot("03", "paste-prompt");
await sleep(1900);
ok((await ob.$eval("#copyPrompt", (e) => e.textContent)) === "Copy prompt", "prompt: Copy button resets after a moment");

// Back transitions: Esc and ←, direction reversed.
await ob.focus("body");
const bk = await ob.evaluate(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await new Promise((r) => setTimeout(r, 40));
  return { dir: document.body.dataset.lastTransition, frames: document.getAnimations().map((a) => [a.effect.target.dataset.step || a.effect.target.id, a.effect.getKeyframes()[0].transform || ""]) }; });
const inB = bk.frames.find((f) => f[0] === "mode");
ok(bk.dir === "back" && inB && inB[1] === "translateX(-56px)", "Esc goes back with the reverse slide", JSON.stringify(bk));
await waitStep("mode"); await ob.focus("body"); await press("ArrowRight");
ok((await waitStep("byo-prompt")) === "byo-prompt", "→ moves forward again");
await press("ArrowLeft"); ok((await waitStep("mode")) === "mode", "← moves back"); await press("ArrowRight"); await waitStep("byo-prompt");
await click("next");

// 3b. Deploy + Generate tokens
await waitStep("byo-deploy");
await click("genTokens");
const toks = await ob.evaluate(async () => ({ ext: document.getElementById("tokExt").textContent, reply: document.getElementById("tokReply").textContent, ses: (await chrome.storage.session.get("obTokens")).obTokens, field: document.getElementById("extToken").value }));
ok(/^[A-Za-z0-9_-]{43}$/.test(toks.ext) && /^[A-Za-z0-9_-]{43}$/.test(toks.reply) && toks.ext !== toks.reply && toks.ses.reply === toks.reply && toks.field === toks.ext, "deploy: Generate tokens makes two different 256-bit tokens, pre-fills EXT_TOKEN, keeps them in session storage only");
ok(!JSON.stringify(await ob.evaluate(() => chrome.storage.local.get(null))).includes(toks.reply), "deploy: REPLY_TOKEN is never written to persistent storage");
await shot("04", "deploy-relay");
await click("next");

// 3c. Connect: validation
await waitStep("byo-connect");
await ob.evaluate(() => { const u = document.getElementById("relayUrl"); u.value = ""; u.dispatchEvent(new Event("input")); });
ok((await state()).next === true, "connect: Next disabled without a relay URL");
await ob.click("#relayUrl"); await ob.keyboard.type("http://example.com");
st = await state(); const err = await ob.$eval("#relayUrlErr", (e) => e.textContent);
ok(st.next === true && /https:\/\//.test(err), "connect: non-https relay URL rejected with a hint", err);
await press("Enter"); await sleep(400); ok((await step()) === "byo-connect", "connect: Enter can't continue while invalid");
await ob.evaluate((tok) => { const u = document.getElementById("relayUrl"); u.value = "http://127.0.0.1:8787"; u.dispatchEvent(new Event("input")); const t = document.getElementById("extToken"); t.value = tok; t.dispatchEvent(new Event("input")); }, process.env.TEST_EXT);
ok((await state()).next === false, "connect: valid URL + token enable Next");
await shot("05", "connect");
await click("next");
await waitStep("byo-bot");
const saved = await ob.evaluate(() => chrome.storage.local.get(["relayUrl", "extToken", "mode", "onboarding"]));
ok(saved.relayUrl === "http://127.0.0.1:8787" && saved.extToken === process.env.TEST_EXT && saved.mode === "relay", "connect: Next saves the relay settings");
ok(!JSON.stringify(saved.onboarding).includes(process.env.TEST_EXT), "connect: wizard progress doesn't store the token");

// 3d. Tell the bot
const bot = await ob.evaluate(() => ({ relay: document.getElementById("showRelay").textContent, row: !document.getElementById("replyRow").hidden, masked: document.getElementById("showReply").textContent }));
ok(bot.relay === "http://127.0.0.1:8787" && bot.row && !bot.masked.includes(toks.reply), "bot step: shows the relay URL and a masked reply token");
await ob.evaluate(() => document.querySelector("[data-copy-secret=reply]").click()); await sleep(100);
ok((await ob.evaluate(() => navigator.clipboard.readText())) === toks.reply, "bot step: Copy copies the real REPLY_TOKEN");
await shot("06", "tell-your-bot");

// Persistence: reopening resumes on the same screen with values kept.
await ob.reload(); await sleep(900);
ok((await step()) === "byo-bot" && (await ob.$eval("#relayUrl", (e) => e.value)) === "http://127.0.0.1:8787", "reopening the wizard resumes where you left off");
await click("next");

// 3e. Test connection: auto ping -> mock bot answers pong.
await waitStep("byo-test");
ok((await state()).next === true && (await state()).skip, "test: Next disabled and Skip offered while waiting");
let tst = "";
for (let i = 0; i < 60; i++) { tst = await ob.$eval("#relayTest", (e) => e.className); if (/\bok\b|\berr\b/.test(tst)) break; await sleep(250); }
const ttxt = await ob.$eval("#relayTestText", (e) => e.textContent);
st = await state();
ok(/\bok\b/.test(tst) && /pong/.test(ttxt) && st.next === false && !st.skip, "test: ping through the relay gets “pong” and unlocks Next", ttxt);
await shot("07", "test-connection");
await click("next");

// 5. Access
await waitStep("access");
const accRead = () => ob.evaluate(() => ({ a: document.body.dataset.access, fixFiles: !!document.getElementById("fixFiles").offsetParent, fixSites: !!document.getElementById("fixSites").offsetParent }));
const acc0 = await accRead();
ok(acc0.a === "sites,files" && !acc0.fixFiles && !acc0.fixSites, "access: both permissions granted, no fix buttons", JSON.stringify(acc0));
// An unpacked test install always has file access; simulate a Web Store install where "Allow access to file URLs" is off, then Re-check.
await ob.evaluate(() => { chrome.extension.isAllowedFileSchemeAccess = (cb) => cb(false); document.getElementById("recheck").click(); }); await sleep(300);
const acc = await accRead();
ok(acc.a === "sites,nofiles" && acc.fixFiles && !acc.fixSites, "access: shows site access OK and offers a fix for file URLs", JSON.stringify(acc));
await shot("08", "permissions");
const before = (await browser.pages()).length;
await click("fixFiles"); await sleep(800);
const tabsNow = browser.targets().filter((t) => t.type() === "page").map((t) => t.url());
ok(tabsNow.some((u) => (u || "").startsWith(`chrome://extensions/?id=${extId}`)), "access: “Open extension details” opens the extension's page");
await ob.bringToFront();
await click("next");

// 6. Done
await waitStep("done");
st = await state();
ok(st.count === "Step 9 of 9" && (await ob.$eval("#next", (e) => e.textContent)) === "Finish", "done: last step with Finish");
await shot("09", "done");
await ob.evaluate(() => { window.__keepOpen = true; document.getElementById("next").click(); }); await sleep(300);
ok((await ob.evaluate(() => chrome.storage.local.get("onboarding"))).onboarding.done === true, "Finish marks setup as done");

// ---------- xAI path ----------
await ob.evaluate(() => chrome.storage.local.set({ xaiBaseUrl: "http://127.0.0.1:8798/v1" }));
const opts = await browser.newPage(); await opts.goto(`chrome-extension://${extId}/options.html`); await sleep(400);
const rerun = await opts.$eval("#rerun", (e) => e.getAttribute("href"));
ok(rerun === "onboarding.html?restart=1", "settings has “Run setup again”");
await opts.close();
await ob.goto(`chrome-extension://${extId}/onboarding.html?restart=1`); await ob.bringToFront(); await sleep(700);
ok((await step()) === "welcome" && (await ob.$eval("#relayUrl", (e) => e.value)) === "http://127.0.0.1:8787", "Run setup again starts at Welcome and keeps saved settings");
await click("next"); await waitStep("mode");
await ob.evaluate(() => document.querySelector('input[name=mode][value=xai]').closest("label").click()); await sleep(200);
st = await state();
ok(st.count === "Step 2 of 6" && st.dots === 6, "xAI path has 6 steps", st.count);
await click("next"); await waitStep("xai-key");
ok((await state()).next === true, "xAI key: Next disabled until a key is pasted");
await ob.click("#xaiKey"); await ob.keyboard.type("xai-wrong-key");
await press("Enter");
await waitStep("xai-test");
for (let i = 0; i < 40; i++) { tst = await ob.$eval("#xaiTest", (e) => e.className); if (/\bok\b|\berr\b/.test(tst)) break; await sleep(150); }
st = await state();
ok(/\berr\b/.test(tst) && /rejected the API key/.test(await ob.$eval("#xaiTestText", (e) => e.textContent)) && st.next && st.skip, "xAI test: wrong key shows the error, Next stays disabled, Skip offered");
await click("skip"); ok((await waitStep("access")) === "access", "Skip moves past an optional step");
await click("back"); await waitStep("xai-test"); await click("back"); await waitStep("xai-key");
await ob.evaluate(() => { const k = document.getElementById("xaiKey"); k.value = "xai-test-key"; k.dispatchEvent(new Event("input")); });
await shot("10", "xai-key");
await click("next"); await waitStep("xai-test");
for (let i = 0; i < 40; i++) { tst = await ob.$eval("#xaiTest", (e) => e.className); if (/\bok\b/.test(tst)) break; await sleep(150); }
st = await state();
const xs = await ob.evaluate(() => chrome.storage.local.get(["mode", "xaiKey", "xaiModel"]));
ok(/\bok\b/.test(tst) && st.next === false && xs.mode === "xai" && xs.xaiKey === "xai-test-key" && xs.xaiModel === "grok-4.7", "xAI test: correct key passes, settings saved in xAI mode");
await shot("11", "xai-test");
await click("next"); await waitStep("access"); await click("next"); await waitStep("done");
ok((await ob.$eval("#doneNote", (e) => e.textContent)) === "", "done: no 'skipped test' note once the test passed");

// ---------- reduced motion ----------
const rm = await browser.newPage(); await rm.setViewport({ width: 860, height: 900 });
await rm.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await rm.goto(`chrome-extension://${extId}/onboarding.html?restart=1`); await sleep(600);
const red = await rm.evaluate(async () => { document.getElementById("next").click(); await new Promise((r) => setTimeout(r, 40));
  return { dir: document.body.dataset.lastTransition, anims: document.getAnimations().filter((a) => a.effect && a.effect.getKeyframes().some((k) => k.transform)).length, visible: [...document.querySelectorAll(".step:not([hidden])")].map((s) => s.dataset.step) }; });
ok(red.dir === "reduced" && red.anims === 0 && red.visible.join() === "mode", "prefers-reduced-motion: steps switch instantly, no slide", JSON.stringify(red));
await rm.close();

// Restore relay mode for anything that runs after.
await ob.evaluate(() => chrome.storage.local.set({ mode: "relay" }));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); process.exit(fail ? 1 : 0);

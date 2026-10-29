// First-run setup wizard: one screen per step, direction-aware slide+fade, progress saved in chrome.storage.
import * as core from "./setup-core.js";
const $ = (id) => document.getElementById(id);
const stepEl = (name) => document.querySelector(`.step[data-step="${name}"]`);

export const PATHS = {
  relay: ["welcome", "mode", "byo-prompt", "byo-deploy", "byo-connect", "byo-bot", "byo-test", "access", "done"],
  xai: ["welcome", "mode", "xai-key", "xai-test", "access", "done"],
};
const DURATION = 300, EASE = "cubic-bezier(.22,.7,.25,1)", SHIFT = 56;

let state = { step: "welcome", mode: null, tested: { relay: false, xai: false }, skipped: {}, done: false };
let busy = false, running = [];
const path = () => PATHS[state.mode || "relay"];
const idx = () => Math.max(0, path().indexOf(state.step));
const fingerprint = (v) => { let h = 2166136261; for (const c of v) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h.toString(36) + "." + v.length; };
const save = () => chrome.storage.local.set({ onboarding: state });

// ---------- per-step rules ----------
const relayOk = () => !core.checkRelayUrl($("relayUrl").value).error && !core.checkExtToken($("extToken").value).error;
const STEPS = {
  welcome: { next: "Get started →" },
  mode: { valid: () => !!state.mode, why: "Pick one to continue." },
  "byo-prompt": { next: "I've sent it →" },
  "byo-deploy": { next: "My relay is deployed →" },
  "byo-connect": {
    valid: relayOk, why: "Add a relay URL and EXT_TOKEN to continue.",
    onNext: async () => { const r = await core.saveRelay($("relayUrl").value, $("extToken").value); if (r.error) { showErrors(true); return false; }
      const sig = r.relayUrl + "|" + fingerprint($("extToken").value.trim()); // no secret in the saved wizard state
      if (state.savedRelay !== sig) { state.tested.relay = false; state.savedRelay = sig; } return true; },
  },
  "byo-bot": { next: "Done, test it →", enter: fillBotStep },
  "byo-test": { valid: () => state.tested.relay, why: "Waiting for “pong”. You can skip and test later in Settings.", skip: "Skip for now", enter: () => autoTest("relay") },
  "xai-key": {
    valid: () => !core.checkXaiKey($("xaiKey").value).error, why: "Paste your key to continue.",
    onNext: async () => { const k = $("xaiKey").value.trim(); const changed = state.savedKey !== fingerprint(k);
      await core.saveXai({ xaiKey: k, xaiModel: $("xaiModel").value, xaiEffort: $("xaiEffort").value }); if (changed) { state.tested.xai = false; state.savedKey = fingerprint(k); } return true; },
  },
  "xai-test": { valid: () => state.tested.xai, why: "Run the test first, or skip it.", skip: "Skip for now", enter: () => autoTest("xai") },
  access: { enter: refreshAccess },
  done: { next: "Finish", enter: fillDone, onNext: async () => { state.done = true; await save(); const t = await chrome.tabs.getCurrent(); if (t && !window.__keepOpen) chrome.tabs.remove(t.id); return false; } },
};

// ---------- rendering ----------
function renderChrome() {
  const p = path(), i = idx(), cfg = STEPS[state.step] || {};
  const dots = $("dots");
  if (dots.children.length !== p.length) dots.replaceChildren(...p.map(() => document.createElement("i")));
  [...dots.children].forEach((d, k) => { d.className = k < i ? "done" : k === i ? "on" : ""; });
  $("stepCount").textContent = `Step ${i + 1} of ${p.length}`;
  $("back").style.visibility = i === 0 ? "hidden" : "visible";
  const valid = cfg.valid ? cfg.valid() : true;
  $("next").disabled = !valid;
  $("next").textContent = cfg.next || "Next →";
  $("next").title = valid ? "" : cfg.why || "";
  $("skip").hidden = !cfg.skip || valid; $("skip").textContent = cfg.skip || "Skip";
  document.body.dataset.step = state.step;
}

function transition(fromEl, toEl, dir) {
  for (const a of running) a.finish(); running = [];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.body.dataset.lastTransition = !fromEl || fromEl === toEl ? "none" : reduce ? "reduced" : dir > 0 ? "forward" : "back";
  if (!fromEl || fromEl === toEl || reduce) { if (fromEl && fromEl !== toEl) fromEl.hidden = true; toEl.hidden = false; return; }
  const stage = $("stage"), h0 = stage.getBoundingClientRect().height;
  fromEl.classList.add("leaving"); toEl.hidden = false;
  const h1 = stage.getBoundingClientRect().height;
  stage.classList.add("animating");
  const out = fromEl.animate([{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${-dir * SHIFT}px)`, opacity: 0 }], { duration: DURATION * 0.85, easing: EASE, fill: "forwards" });
  const inn = toEl.animate([{ transform: `translateX(${dir * SHIFT}px)`, opacity: 0 }, { transform: "translateX(0)", opacity: 1 }], { duration: DURATION, easing: EASE });
  const hh = stage.animate([{ height: h0 + "px" }, { height: h1 + "px" }], { duration: DURATION, easing: EASE });
  running = [out, inn, hh];
  Promise.all(running.map((a) => a.finished.catch(() => {}))).then(() => {
    fromEl.hidden = true; fromEl.classList.remove("leaving"); out.cancel(); stage.classList.remove("animating"); running = [];
  });
}

async function show(name, dir = 1) {
  const from = document.querySelector(".step:not([hidden]):not(.leaving)");
  const to = stepEl(name) || stepEl("welcome");
  state.step = to.dataset.step; await save();
  transition(from, to, dir);
  renderChrome();
  const cfg = STEPS[state.step] || {};
  if (cfg.enter) cfg.enter();
  const focusT = to.querySelector("input:not([type=radio]):not([type=file])") || to.querySelector("h1");
  setTimeout(() => focusT && focusT.focus({ preventScroll: true }), from ? 40 : 0);
}

async function next() {
  if (busy) return; const cfg = STEPS[state.step] || {};
  if (cfg.valid && !cfg.valid()) { nudge(); return; }
  busy = true;
  try { if (cfg.onNext && (await cfg.onNext()) === false) return; const p = path(); if (idx() < p.length - 1) await show(p[idx() + 1], 1); }
  finally { busy = false; }
}
async function back() { if (busy || idx() === 0) return; await show(path()[idx() - 1], -1); }
async function skip() { const cfg = STEPS[state.step] || {}; if (!cfg.skip) return; state.skipped[state.step] = true; const p = path(); await show(p[idx() + 1], 1); }
function nudge() { if (matchMedia("(prefers-reduced-motion: reduce)").matches) return; $("next").animate([{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(0)" }], { duration: 220 }); }

// ---------- step helpers ----------
function showErrors(force) {
  const u = $("relayUrl").value, t = $("extToken").value;
  $("relayUrlErr").textContent = (u || force) ? core.checkRelayUrl(u).error || "" : "";
  $("extTokenErr").textContent = (t || force) ? core.checkExtToken(t).error || "" : "";
  $("xaiKeyErr").textContent = $("xaiKey").value ? core.checkXaiKey($("xaiKey").value).error || "" : "";
}

async function sessionTokens() { return (await chrome.storage.session.get("obTokens")).obTokens || null; }

async function fillBotStep() {
  const s = await chrome.storage.local.get("relayUrl");
  $("showRelay").textContent = s.relayUrl || "(your relay URL)";
  const t = await sessionTokens();
  $("replyRow").hidden = !t;
  if (t) { $("showReply").textContent = "•".repeat(12) + t.reply.slice(-4); $("replyHint").textContent = "The REPLY_TOKEN you generated on the Deploy screen. Only paste it into your bot's secure secret request."; }
  else $("replyHint").innerHTML = "Use the REPLY_TOKEN from your deploy. If you ran <code>npm run setup</code>, print it with <code>node relay/scripts/setup.mjs --show-tokens</code> (add <code>--name &lt;worker&gt;</code> if you deployed under another name).";
}

function setTest(which, cls, text) { const box = $(which === "relay" ? "relayTest" : "xaiTest"); box.className = "test " + cls; $(which === "relay" ? "relayTestText" : "xaiTestText").textContent = text; }
const testing = { relay: false, xai: false };
async function runTest(which) {
  if (testing[which]) return; testing[which] = true;
  const btn = $(which === "relay" ? "runRelayTest" : "runXaiTest"); btn.disabled = true;
  setTest(which, "wait", which === "relay" ? "Sending a test ping…" : "Checking the key…");
  const r = which === "relay" ? await core.pingBot((t) => setTest(which, "wait", t)) : await core.checkXai();
  testing[which] = false; btn.disabled = false;
  state.tested[which] = r.ok; await save();
  setTest(which, r.ok ? "ok" : "err", r.text);
  btn.textContent = r.ok ? "Test again" : "Try again";
  if (state.step === (which === "relay" ? "byo-test" : "xai-test")) renderChrome();
}
function autoTest(which) {
  if (state.tested[which]) { setTest(which, "ok", which === "relay" ? "Connected: your Grok Bot answered “pong”." : "Your key works."); $(which === "relay" ? "runRelayTest" : "runXaiTest").textContent = "Test again"; return; }
  if (!window.__noAutoTest) runTest(which);
}

async function refreshAccess() {
  const a = await core.accessState();
  $("chkSites").className = "check " + (a.all ? "ok" : "warn");
  $("chkSitesText").textContent = a.all ? "Allowed. The side panel can read whichever tab you're on." : "Limited. Screenshots only work after you press Alt+Shift+G or click the toolbar icon on a tab.";
  $("fixSites").hidden = a.all;
  $("chkFiles").className = "check " + (a.files ? "ok" : "warn");
  $("chkFilesText").textContent = a.files ? "Allowed. You can ask about PDFs and pages opened from your disk." : "Off. In the extension's Details, turn on “Allow access to file URLs”.";
  $("fixFiles").hidden = a.files;
  document.body.dataset.access = (a.all ? "sites" : "nosites") + "," + (a.files ? "files" : "nofiles");
}

function fillDone() {
  const skipped = state.mode === "xai" ? state.skipped["xai-test"] && !state.tested.xai : state.skipped["byo-test"] && !state.tested.relay;
  $("doneNote").textContent = skipped ? "You skipped the connection test. Run it any time from Settings → Test." : "";
}

// ---------- wiring ----------
function wire() {
  $("next").addEventListener("click", next);
  $("back").addEventListener("click", back);
  $("skip").addEventListener("click", skip);
  document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", async () => {
    if (!r.checked) return; state.mode = r.value; await chrome.storage.local.set({ mode: r.value }); await save(); renderChrome();
  }));
  $("copyPrompt").addEventListener("click", (e) => core.copyText($("botPrompt").textContent, e.currentTarget));
  document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => core.copyText($(b.dataset.copy).textContent, b)));
  document.querySelector("[data-copy-secret=reply]").addEventListener("click", async (e) => { const t = await sessionTokens(); if (t) core.copyText(t.reply, e.currentTarget); });
  $("genTokens").addEventListener("click", async () => {
    const t = { ext: core.randomToken(), reply: core.randomToken() };
    await chrome.storage.session.set({ obTokens: t });
    $("tokExt").textContent = t.ext; $("tokReply").textContent = t.reply; $("tokens").hidden = false;
    $("extToken").value = t.ext; $("genTokens").textContent = "Generate new tokens";
  });
  for (const id of ["relayUrl", "extToken", "xaiKey"]) $(id).addEventListener("input", () => { showErrors(); renderChrome(); });
  $("showTok").addEventListener("click", (e) => { const i = $("extToken"); i.type = i.type === "password" ? "text" : "password"; e.currentTarget.textContent = i.type === "password" ? "Show" : "Hide"; });
  $("showKey").addEventListener("click", (e) => { const i = $("xaiKey"); i.type = i.type === "password" ? "text" : "password"; e.currentTarget.textContent = i.type === "password" ? "Show" : "Hide"; });
  $("importFile").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const { url, tok } = core.parseSettingsFile(await f.text()); $("relayUrl").value = url; $("extToken").value = tok; $("importStatus").textContent = "Imported. You can delete the settings file now."; $("importStatus").className = "status ok"; }
    catch (err) { $("importStatus").textContent = "Couldn't read that file: " + err.message; $("importStatus").className = "status err"; }
    e.target.value = ""; showErrors(); renderChrome();
  });
  $("runRelayTest").addEventListener("click", () => runTest("relay"));
  $("runXaiTest").addEventListener("click", () => runTest("xai"));
  $("fixSites").addEventListener("click", async () => { await core.requestAllSites(); refreshAccess(); });
  $("fixFiles").addEventListener("click", () => core.openExtensionDetails());
  $("recheck").addEventListener("click", refreshAccess);
  addEventListener("focus", () => state.step === "access" && refreshAccess());
  document.addEventListener("visibilitychange", () => !document.hidden && state.step === "access" && refreshAccess());

  document.addEventListener("keydown", (e) => {
    if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target, tag = t.tagName, type = (t.type || "").toLowerCase();
    const typing = tag === "TEXTAREA" || tag === "SELECT" || (tag === "INPUT" && type !== "radio" && type !== "file");
    const control = tag === "BUTTON" || tag === "A" || tag === "SUMMARY" || (tag === "LABEL" && t.classList.contains("file"));
    if (e.key === "Enter" && !e.shiftKey) { if (control || tag === "TEXTAREA") return; e.preventDefault(); next(); }
    else if (e.key === "Escape") { if (typing && t.value) { t.blur(); return; } e.preventDefault(); back(); }
    else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !typing && type !== "radio" && tag !== "PRE") { e.preventDefault(); e.key === "ArrowRight" ? next() : back(); }
  });
}

async function init() {
  wire();
  const [loc, ses] = await Promise.all([chrome.storage.local.get(["onboarding", "relayUrl", "extToken", "xaiKey", "xaiModel", "xaiEffort"]), sessionTokens()]);
  if (loc.onboarding) state = { ...state, ...loc.onboarding, tested: { ...state.tested, ...(loc.onboarding.tested || {}) }, skipped: { ...(loc.onboarding.skipped || {}) } };
  const restart = new URLSearchParams(location.search).has("restart");
  if (restart) { state.step = "welcome"; state.done = false; history.replaceState(null, "", location.pathname); }
  else if (state.done) state.step = "done";
  if (!path().includes(state.step)) state.step = "welcome";
  if (state.mode) document.querySelector(`input[name=mode][value="${state.mode}"]`).checked = true;
  $("relayUrl").value = loc.relayUrl || ""; $("extToken").value = loc.extToken || (ses ? ses.ext : "");
  if (ses) { $("tokExt").textContent = ses.ext; $("tokReply").textContent = ses.reply; $("tokens").hidden = false; $("genTokens").textContent = "Generate new tokens"; }
  $("xaiKey").value = loc.xaiKey || ""; $("xaiModel").value = loc.xaiModel || core.XAI_DEFAULT_MODEL;
  $("xaiEffort").value = loc.xaiEffort == null ? core.XAI_DEFAULT_EFFORT : loc.xaiEffort;
  $("botPrompt").textContent = await core.loadBotPrompt();
  await show(state.step, 1);
  document.body.classList.add("ready");
}
init();

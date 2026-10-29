import { ask, waitForAnswer, testXai, XAI_DEFAULT_MODEL, XAI_DEFAULT_EFFORT } from "./api.js";
const $ = (id) => document.getElementById(id);
const setStatus = (id) => (t, ok) => { $(id).textContent = t; $(id).className = "status " + (ok === true ? "ok" : ok === false ? "err" : ""); };
const status = setStatus("status"), xaiStatus = setStatus("xaiStatus");
const ALL = { origins: ["<all_urls>"] };

export function randomToken(bytes = 32) {
  const b = new Uint8Array(bytes); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function showMode(mode) {
  $("relaySection").classList.toggle("hidden", mode !== "relay");
  $("xaiSection").classList.toggle("hidden", mode !== "xai");
  document.querySelectorAll('input[name=mode]').forEach((r) => (r.checked = r.value === mode));
}

async function load() {
  const s = await chrome.storage.local.get(["mode", "relayUrl", "extToken", "xaiKey", "xaiModel", "xaiEffort"]);
  showMode(s.mode === "xai" ? "xai" : "relay");
  $("relayUrl").value = s.relayUrl || ""; $("extToken").value = s.extToken || "";
  $("xaiKey").value = s.xaiKey || ""; $("xaiModel").value = s.xaiModel || XAI_DEFAULT_MODEL;
  $("xaiEffort").value = s.xaiEffort == null ? XAI_DEFAULT_EFFORT : s.xaiEffort;
  $("ver").textContent = chrome.runtime.getManifest().version;
  $("botPrompt").textContent = await (await fetch(chrome.runtime.getURL("bot-prompt.txt"))).text();
  await loadAccess();
}

async function loadAccess() {
  const all = await chrome.permissions.contains(ALL);
  const files = await new Promise((r) => chrome.extension.isAllowedFileSchemeAccess(r));
  const a = $("access");
  a.textContent = (all ? "✓ Site access: all sites. " : "⚠ Site access is limited, so screenshots only work after Alt+Shift+G on a tab. ") + (files ? "✓ Local files: allowed." : "⚠ Local files: turn on \"Allow access to file URLs\" in the extension's Details.");
  a.className = "status " + (all && files ? "ok" : "err");
  if (!all) { const b = document.createElement("button"); b.textContent = "Allow on all sites"; b.addEventListener("click", async () => { await chrome.permissions.request(ALL); loadAccess(); }); a.append(" ", b); }
}

document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener("change", async () => {
  if (!r.checked) return; await chrome.storage.local.set({ mode: r.value }); showMode(r.value);
}));

async function copy(text, btn) {
  await navigator.clipboard.writeText(text);
  const t = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(() => (btn.textContent = t), 1400);
}
$("copyPrompt").addEventListener("click", (e) => copy($("botPrompt").textContent, e.currentTarget));
document.querySelectorAll("button[data-copy]").forEach((b) => b.addEventListener("click", () => copy($(b.dataset.copy).textContent, b)));

$("genTokens").addEventListener("click", () => {
  $("tokExt").textContent = randomToken(); $("tokReply").textContent = randomToken();
  $("tokens").classList.remove("hidden"); $("extToken").value = $("tokExt").textContent;
});

async function save(relayUrl, extToken) {
  relayUrl = (relayUrl || "").trim().replace(/\/+$/, ""); extToken = (extToken || "").trim();
  if (relayUrl && !/^https:\/\/[^\s/]+/i.test(relayUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(relayUrl)) { status("The relay URL must start with https://", false); return false; }
  await chrome.storage.local.set({ relayUrl, extToken, mode: "relay" });
  status("Saved.", true); return true;
}

$("save").addEventListener("click", () => save($("relayUrl").value, $("extToken").value));

$("importFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const url = j.relay_url || j.relayUrl, tok = j.ext_token || j.extToken;
    if (!url || !tok) throw new Error("missing relay_url / ext_token");
    $("relayUrl").value = url; $("extToken").value = tok;
    if (await save(url, tok)) status("Imported and saved. You can delete the settings file now.", true);
  } catch (err) { status("Couldn't read that file: " + err.message, false); }
  e.target.value = "";
});

$("test").addEventListener("click", async () => {
  if (!(await save($("relayUrl").value, $("extToken").value))) return;
  status("Asking your Grok Bot for a pong (can take up to a minute)…");
  try {
    const r = await ask({ question: "__ping__", url: "", title: "", selection: "", visible_text: "", page_text: "", truncated: false, pdf_url: "", history: [] });
    status("Relay OK, your Grok Bot woke up. Waiting for its reply…");
    const a = await waitForAnswer(r.request_id, Date.now());
    if (a.answer != null) status(/pong/i.test(a.answer) ? "Connected: your Grok Bot answered “pong”." : "Connected, got: " + a.answer.slice(0, 200), true);
    else status((a.error || "No answer.") + " If the relay works but no answer comes, check that your bot saved the relay URL and reply token (step 4).", false);
  } catch (err) { status(err.message, false); }
});

async function saveXai() {
  const xaiKey = $("xaiKey").value.trim(), xaiModel = $("xaiModel").value.trim() || XAI_DEFAULT_MODEL, xaiEffort = $("xaiEffort").value;
  await chrome.storage.local.set({ xaiKey, xaiModel, xaiEffort, mode: "xai" });
  xaiStatus("Saved.", true);
}
$("saveXai").addEventListener("click", saveXai);
$("testXai").addEventListener("click", async () => {
  await saveXai(); xaiStatus("Checking the key…");
  const r = await testXai();
  if (r.error) xaiStatus(r.error, false); else xaiStatus(`Key works (${r.model}): “${(r.answer || "").slice(0, 80)}”`, true);
});

load();

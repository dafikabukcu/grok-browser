import * as core from "./setup-core.js";
const $ = (id) => document.getElementById(id);
const setStatus = (id) => (t, ok) => { $(id).textContent = t; $(id).className = "status " + (ok === true ? "ok" : ok === false ? "err" : ""); };
const status = setStatus("status"), xaiStatus = setStatus("xaiStatus");
export const randomToken = core.randomToken;

function showMode(mode) {
  $("relaySection").classList.toggle("hidden", mode !== "relay");
  $("xaiSection").classList.toggle("hidden", mode !== "xai");
  document.querySelectorAll("input[name=mode]").forEach((r) => (r.checked = r.value === mode));
}

async function load() {
  const s = await chrome.storage.local.get(["mode", "relayUrl", "extToken", "xaiKey", "xaiModel", "xaiEffort"]);
  showMode(s.mode === "xai" ? "xai" : "relay");
  $("relayUrl").value = s.relayUrl || ""; $("extToken").value = s.extToken || "";
  $("xaiKey").value = s.xaiKey || ""; $("xaiModel").value = s.xaiModel || core.XAI_DEFAULT_MODEL;
  $("xaiEffort").value = s.xaiEffort == null ? core.XAI_DEFAULT_EFFORT : s.xaiEffort;
  $("ver").textContent = chrome.runtime.getManifest().version;
  $("botPrompt").textContent = await core.loadBotPrompt();
  await loadAccess();
}

async function loadAccess() {
  const { all, files } = await core.accessState();
  const a = $("access");
  a.textContent = (all ? "✓ Site access: all sites. " : "⚠ Site access is limited, so screenshots only work after Alt+Shift+G on a tab. ") + (files ? "✓ Local files: allowed." : "⚠ Local files: turn on \"Allow access to file URLs\" in the extension's Details.");
  a.className = "status " + (all && files ? "ok" : "err");
  if (!all) { const b = document.createElement("button"); b.textContent = "Allow on all sites"; b.addEventListener("click", async () => { await core.requestAllSites(); loadAccess(); }); a.append(" ", b); }
  if (!files) { const b = document.createElement("button"); b.textContent = "Open extension details"; b.addEventListener("click", core.openExtensionDetails); a.append(" ", b); }
}

document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", async () => {
  if (!r.checked) return; await chrome.storage.local.set({ mode: r.value }); showMode(r.value);
}));
$("copyPrompt").addEventListener("click", (e) => core.copyText($("botPrompt").textContent, e.currentTarget));

async function save() {
  const r = await core.saveRelay($("relayUrl").value, $("extToken").value);
  if (r.error) { status(r.error, false); return false; }
  $("relayUrl").value = r.relayUrl; status("Saved.", true); return true;
}
$("save").addEventListener("click", save);
$("importFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const { url, tok } = core.parseSettingsFile(await f.text()); $("relayUrl").value = url; $("extToken").value = tok;
    if (await save()) status("Imported and saved. You can delete the settings file now.", true);
  } catch (err) { status("Couldn't read that file: " + err.message, false); }
  e.target.value = "";
});
$("test").addEventListener("click", async () => {
  if (!(await save())) return;
  const r = await core.pingBot((t) => status(t));
  status(r.text, r.ok);
});

async function saveXai() { await core.saveXai({ xaiKey: $("xaiKey").value, xaiModel: $("xaiModel").value, xaiEffort: $("xaiEffort").value }); xaiStatus("Saved.", true); }
$("saveXai").addEventListener("click", saveXai);
$("testXai").addEventListener("click", async () => { await saveXai(); xaiStatus("Checking the key…"); const r = await core.checkXai(); xaiStatus(r.text, r.ok); });

load();

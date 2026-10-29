// Shared by the onboarding wizard and the settings page: validation, saving, connection tests, page access.
import { ask, waitForAnswer, testXai, XAI_DEFAULT_MODEL, XAI_DEFAULT_EFFORT } from "./api.js";
export { XAI_DEFAULT_MODEL, XAI_DEFAULT_EFFORT };
export const ALL_SITES = { origins: ["<all_urls>"] };

export function randomToken(bytes = 32) {
  const b = new Uint8Array(bytes); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Returns { url } or { error }. https:// only, except a local dev relay.
export function checkRelayUrl(u) {
  const url = (u || "").trim().replace(/\/+$/, "");
  if (!url) return { error: "Paste your relay URL." };
  if (!/^https:\/\/[^\s/]+\.[^\s/]+/i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)) return { error: "The relay URL must start with https:// (like https://grok-browser-relay.<name>.workers.dev)." };
  try { new URL(url); } catch { return { error: "That doesn't look like a URL." }; }
  return { url };
}
export function checkExtToken(t) {
  const tok = (t || "").trim();
  if (!tok) return { error: "Paste EXT_TOKEN." };
  if (tok.length < 16 || /\s/.test(tok)) return { error: "EXT_TOKEN looks too short. Paste the whole value." };
  return { token: tok };
}
export const checkXaiKey = (k) => ((k || "").trim().length >= 8 && !/\s/.test(k.trim()) ? { key: k.trim() } : { error: "Paste your xAI API key." });

export async function saveRelay(relayUrl, extToken) {
  const u = checkRelayUrl(relayUrl); if (u.error) return { error: u.error };
  const t = checkExtToken(extToken); if (t.error) return { error: t.error };
  await chrome.storage.local.set({ relayUrl: u.url, extToken: t.token, mode: "relay" });
  return { ok: true, relayUrl: u.url };
}

export function parseSettingsFile(text) {
  const j = JSON.parse(text);
  const url = j.relay_url || j.relayUrl, tok = j.ext_token || j.extToken;
  if (!url || !tok) throw new Error("missing relay_url / ext_token");
  return { url, tok };
}

// Sends __ping__ through the relay and waits for the bot's "pong". onStatus(text) reports progress.
export async function pingBot(onStatus = () => {}) {
  try {
    onStatus("Sending a test ping to your relay…");
    const r = await ask({ question: "__ping__", url: "", title: "", selection: "", visible_text: "", page_text: "", truncated: false, pdf_url: "", history: [] });
    onStatus("Relay OK, your Grok Bot woke up. Waiting for “pong” (usually 10–60 s)…");
    const a = await waitForAnswer(r.request_id, Date.now());
    if (a.answer != null) return /pong/i.test(a.answer) ? { ok: true, text: "Connected: your Grok Bot answered “pong”." } : { ok: true, text: "Connected, got: " + a.answer.slice(0, 200) };
    return { ok: false, text: (a.error || "No answer.") + " If the relay works but no answer comes, check that your bot saved the relay URL and reply token." };
  } catch (err) { return { ok: false, text: err.message }; }
}

export async function saveXai({ xaiKey, xaiModel, xaiEffort }) {
  await chrome.storage.local.set({ xaiKey: (xaiKey || "").trim(), xaiModel: (xaiModel || "").trim() || XAI_DEFAULT_MODEL, xaiEffort: xaiEffort ?? XAI_DEFAULT_EFFORT, mode: "xai" });
}
export async function checkXai() {
  const r = await testXai();
  return r.error ? { ok: false, text: r.error } : { ok: true, text: `Key works (${r.model}): “${(r.answer || "").slice(0, 80)}”` };
}

export async function accessState() {
  const all = await chrome.permissions.contains(ALL_SITES);
  const files = await new Promise((r) => chrome.extension.isAllowedFileSchemeAccess(r));
  return { all, files };
}
export const requestAllSites = () => chrome.permissions.request(ALL_SITES).catch(() => false);
export const openExtensionDetails = () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });

export const loadBotPrompt = async () => (await fetch(chrome.runtime.getURL("bot-prompt.txt"))).text();

// Copies text and flips the button to a "Copied ✓" state for a moment.
export async function copyText(text, btn) {
  let done = false;
  try { await navigator.clipboard.writeText(text); done = true; } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text }); ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta); ta.select(); try { done = document.execCommand("copy"); } catch {} ta.remove();
  }
  if (!btn) return done;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  clearTimeout(btn._t);
  btn.textContent = done ? "Copied ✓" : "Copy failed"; btn.classList.toggle("copied", done);
  btn._t = setTimeout(() => { btn.textContent = btn.dataset.label; btn.classList.remove("copied"); }, 1800);
  return done;
}

#!/usr/bin/env node
// One-command relay setup: `npm run setup` (from the repo root or relay/).
// 1. signs you in to Cloudflare (wrangler login) if needed
// 2. generates EXT_TOKEN + REPLY_TOKEN (kept in relay/.grok-browser-secrets.json, mode 600, git-ignored; reused on re-runs)
// 3. asks for your Grok Bot routine's webhook URL + key (key input hidden), or reads GROKBOT_WEBHOOK_URL / GROKBOT_WEBHOOK_KEY from env
// 4. deploys the Worker, sets the 4 secrets (via stdin, never printed), smoke-tests it
// 5. writes grok-browser-settings.json (relay URL + extension token) to import in the extension's settings
// Tokens are never printed unless you pass --show-tokens.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const RELAY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = path.join(RELAY_DIR, ".grok-browser-secrets.json");
const SETTINGS = path.join(RELAY_DIR, "grok-browser-settings.json");
const SHOW = process.argv.includes("--show-tokens");
const ROTATE = process.argv.includes("--rotate-tokens");
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
process.chdir(RELAY_DIR);

const say = (s = "") => process.stdout.write(s + "\n");
const wr = (args, opts = {}) => spawnSync(NPX, ["--yes", "wrangler", ...args], { encoding: "utf8", shell: process.platform === "win32", ...opts });

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else if (!/[\r\n]/.test(s)) rl.output.write("*"); };
    }
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(a.trim()); });
  });
}

function writePrivate(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

async function main() {
  say("Grok Browser relay setup (community project, not affiliated with xAI)\n");
  if (!fs.existsSync(path.join(RELAY_DIR, "node_modules", "wrangler"))) {
    say("== installing wrangler");
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"], { stdio: "inherit", shell: process.platform === "win32" });
    if (r.status) process.exit(r.status);
  }

  say("== checking Cloudflare sign-in");
  let who = wr(["whoami"]);
  if (!/You are logged in|associated with the email/i.test((who.stdout || "") + (who.stderr || ""))) {
    say("Not signed in. Opening the Cloudflare sign-in (a free account is enough)...");
    const r = spawnSync(NPX, ["--yes", "wrangler", "login"], { stdio: "inherit", shell: process.platform === "win32" });
    if (r.status) { say("wrangler login failed."); process.exit(1); }
  }

  let secrets = {};
  if (fs.existsSync(SECRETS) && !ROTATE) { try { secrets = JSON.parse(fs.readFileSync(SECRETS, "utf8")); } catch {} }
  if (!secrets.EXT_TOKEN) secrets.EXT_TOKEN = randomBytes(32).toString("base64url");
  if (!secrets.REPLY_TOKEN) secrets.REPLY_TOKEN = randomBytes(32).toString("base64url");

  let url = process.env.GROKBOT_WEBHOOK_URL || "";
  let key = process.env.GROKBOT_WEBHOOK_KEY || "";
  if (!url) {
    say("\nPaste the webhook \"POST to\" URL of your Grok Bot's \"Grok Browser\" routine.");
    say("(Don't have it yet? Paste the prompt from extension/bot-prompt.txt into your Grok Bot first.)");
    url = await ask("Webhook URL: ");
  }
  if (!/^https:\/\/\S+$/i.test(url)) { say("That doesn't look like an https:// URL."); process.exit(1); }
  if (!key) key = await ask("Webhook key (input hidden): ", { hidden: true });
  if (!key) { say("The webhook key is required."); process.exit(1); }
  writePrivate(SECRETS, { EXT_TOKEN: secrets.EXT_TOKEN, REPLY_TOKEN: secrets.REPLY_TOKEN });

  say("\n== deploying the Worker");
  const dep = wr(["deploy"]);
  const out = (dep.stdout || "") + (dep.stderr || "");
  if (dep.status) {
    say(out);
    if (/workers\.dev subdomain|register a workers\.dev/i.test(out)) say("Pick a workers.dev subdomain in the Cloudflare dashboard (Workers & Pages), then run this again.");
    process.exit(1);
  }
  const relayUrl = (out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) || [])[0];
  if (!relayUrl) { say(out); say("Couldn't find the workers.dev URL in the deploy output."); process.exit(1); }
  say("deployed: " + relayUrl);

  for (const [name, value] of [["EXT_TOKEN", secrets.EXT_TOKEN], ["REPLY_TOKEN", secrets.REPLY_TOKEN], ["GROKBOT_WEBHOOK_URL", url], ["GROKBOT_WEBHOOK_KEY", key]]) {
    const r = wr(["secret", "put", name], { input: value });
    if (r.status) { say(`failed to set secret ${name}:\n` + String((r.stderr || "") + (r.stdout || "")).split(value).join("<hidden>")); process.exit(1); }
    say(`secret ${name} set`);
  }

  say("\n== smoke test");
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const h = await fetch(relayUrl + "/health"); say("health: " + h.status + " " + (await h.text()));
    const u = await fetch(relayUrl + "/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"question":"x"}' });
    say(u.status === 401 ? "auth check OK (unauthenticated /ask -> 401)" : "WARNING: unauthenticated /ask returned " + u.status);
  } catch (e) { say("smoke test failed (the Worker may need a few more seconds): " + e.message); }

  writePrivate(SETTINGS, { relay_url: relayUrl, ext_token: secrets.EXT_TOKEN });
  say(`
Done!

1. In the extension's settings choose "Bring your own Grok Bot", click "Import settings file..." and pick:
     ${SETTINGS}
   (or paste the relay URL and EXT_TOKEN by hand). Delete that file afterwards if you like.
2. Tell your Grok Bot: "My Grok Browser relay is deployed. Ask me for the relay URL and reply token."
   Relay URL:   ${relayUrl}
   Reply token: the REPLY_TOKEN value in ${SECRETS}${SHOW ? "\n   REPLY_TOKEN = " + secrets.REPLY_TOKEN + "\n   EXT_TOKEN   = " + secrets.EXT_TOKEN : "\n   (run with --show-tokens to print it here)"}
3. Press "Test connection" in the extension. Your Grok Bot should answer "pong".
`);
}

main().catch((e) => { console.error(e); process.exit(1); });

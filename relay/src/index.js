import { DurableObject } from "cloudflare:workers";

// Grok Browser relay (Cloudflare Worker + SQLite Durable Object). Community project, not affiliated with xAI.
// Browser extension  --POST /ask-->  relay  --webhook-->  your Grok Bot's "Grok Browser" routine
// Your Grok Bot      --POST /answer-->  relay  <--GET /answer/:id--  extension

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

function num(env, k, d) { const v = parseInt(env[k], 10); return Number.isFinite(v) && v > 0 ? v : d; }

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  let ok = false;
  if (origin) ok = allowed.length ? allowed.includes(origin) : /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin);
  const h = { "Vary": "Origin" };
  if (ok) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(req, env, status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(req, env), ...extra },
  });
}

async function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// Tokens shorter than this are treated as unset, so a placeholder or weak secret (for example one typed into the
// Deploy to Cloudflare form before the real values are set) can never authenticate.
const MIN_TOKEN_LENGTH = 24;
async function authed(req, secret) {
  if (typeof secret !== "string" || secret.length < MIN_TOKEN_LENGTH) return false;
  const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  return !!m && (await safeEqual(m[1].trim(), secret));
}

async function readBody(req, max) {
  const len = parseInt(req.headers.get("Content-Length") || "0", 10);
  if (len > max) return { tooBig: true };
  const buf = await req.arrayBuffer();
  if (buf.byteLength > max) return { tooBig: true };
  try { return { data: JSON.parse(new TextDecoder().decode(buf)) }; } catch { return { bad: true }; }
}

const str = (v, max) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
const bytes = (s) => new TextEncoder().encode(s).length;

// Screenshot of the visible tab (data URL or bare base64). Returns Uint8Array of a JPEG/PNG/WebP, or null.
export function decodeScreenshot(v, maxBytes) {
  if (typeof v !== "string" || !v) return null;
  const m = v.match(/^data:(image\/(?:jpeg|png|webp));base64,(.*)$/s);
  const b64 = (m ? m[2] : v).replace(/\s+/g, "");
  if (!b64 || b64.length > Math.ceil(maxBytes / 3) * 4 + 4 || !/^[A-Za-z0-9+/_-]+=*$/.test(b64)) return null;
  let bin; try { bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/")); } catch { return null; }
  if (bin.length > maxBytes || bin.length < 8) return null;
  const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  let type = "";
  if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) type = "image/jpeg";
  else if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) type = "image/png";
  else if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 && u[8] === 0x57 && u[9] === 0x45) type = "image/webp";
  return type ? { data: u, type } : null;
}

function pageNum(v) { const n = typeof v === "number" ? v : parseInt(v, 10); return Number.isInteger(n) && n > 0 && n < 1e6 ? n : null; }

function newId() {
  const b = new Uint8Array(18); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Build the webhook body and trim page_text (then other fields) so it fits maxBytes.
export function buildForwardBody(id, input, maxBytes) {
  const history = Array.isArray(input.history)
    ? input.history.slice(-6).map((h) => ({ q: str(h && h.q, 2000), a: str(h && h.a, 3000) }))
    : [];
  const body = {
    request_id: id,
    question: str(input.question, 4000),
    url: str(input.url, 2048),
    title: str(input.title, 500),
    selection: str(input.selection, 20000),
    visible_text: str(input.visible_text, 20000),
    page_text: str(input.page_text, 400000),
    truncated: !!input.truncated,
    pdf_url: str(input.pdf_url, 2048),
    history,
  };
  const pg = pageNum(input.pdf_page);
  if (pg) { body.pdf_page = pg; if (input.pdf_page_source) body.pdf_page_source = str(input.pdf_page_source, 40); }
  if (input.screenshot_error && !input.screenshot_url) body.screenshot_error = str(input.screenshot_error, 300);
  if (input.ext_version) body.ext_version = str(input.ext_version, 20);
  // The image itself is never forwarded; the bot fetches it from the relay with the reply token.
  if (input.screenshot_url) body.screenshot_url = str(input.screenshot_url, 512);
  // Local files opened in the browser (file://): a bot with access to the user's computer can read the file itself.
  if (input.source === "local_file") { body.source = "local_file"; body.local_path = str(input.local_path, 1024); }
  let s = JSON.stringify(body);
  if (bytes(s) <= maxBytes) return { body, text: s };
  body.truncated = true;
  // Trim page_text proportionally until it fits.
  for (let i = 0; i < 20 && bytes(s) > maxBytes && body.page_text.length > 0; i++) {
    const over = bytes(s) - maxBytes;
    const ratio = body.page_text.length / Math.max(1, bytes(JSON.stringify(body.page_text)));
    const cut = Math.max(256, Math.ceil(over * ratio) + 64);
    body.page_text = body.page_text.slice(0, Math.max(0, body.page_text.length - cut));
    s = JSON.stringify(body);
  }
  for (const k of ["visible_text", "selection"]) {
    while (bytes(s) > maxBytes && body[k].length > 0) { body[k] = body[k].slice(0, Math.floor(body[k].length / 2)); s = JSON.stringify(body); }
  }
  while (bytes(s) > maxBytes && body.history.length) { body.history.shift(); s = JSON.stringify(body); }
  return { body, text: s };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    const store = env.STORE.get(env.STORE.idFromName("global"));
    const ttl = num(env, "ANSWER_TTL_SECONDS", 900);

    try {
      if (url.pathname === "/" || url.pathname === "/health") return json(req, env, 200, { ok: true, service: "grok-browser-relay" });

      if (url.pathname === "/ask" && req.method === "POST") {
        if (!env.EXT_TOKEN || !(await authed(req, env.EXT_TOKEN))) return json(req, env, 401, { error: "unauthorized" });
        if (!env.GROKBOT_WEBHOOK_URL || !env.GROKBOT_WEBHOOK_KEY) return json(req, env, 500, { error: "relay not configured (webhook secrets missing)" });
        const rb = await readBody(req, num(env, "MAX_ASK_BYTES", 1572864));
        if (rb.tooBig) return json(req, env, 413, { error: "request too large" });
        if (rb.bad || !rb.data || typeof rb.data !== "object") return json(req, env, 400, { error: "invalid JSON" });
        if (!str(rb.data.question, 4000).trim()) return json(req, env, 400, { error: "question is required" });

        const rl = await store.rateLimit([["ask-m", 60, num(env, "ASK_PER_MINUTE", 8)], ["ask-h", 3600, num(env, "ASK_PER_HOUR", 60)]]);
        if (!rl.ok) return json(req, env, 429, { error: "rate limited", retry_after: rl.retryAfter }, { "Retry-After": String(rl.retryAfter) });

        const id = newId();
        const shot = decodeScreenshot(rb.data.screenshot, num(env, "MAX_SCREENSHOT_BYTES", 1048576));
        const input = { ...rb.data, screenshot: undefined, screenshot_url: shot ? `${url.origin}/screenshot/${id}` : "" };
        if (!shot && rb.data.screenshot) input.screenshot_error = "relay rejected the screenshot (not a JPEG/PNG/WebP or over the size limit)";
        const { body, text } = buildForwardBody(id, input, num(env, "MAX_FORWARD_BYTES", 98304));
        await store.createPending(id, ttl, shot);

        let resp;
        try {
          resp = await fetch(env.GROKBOT_WEBHOOK_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${env.GROKBOT_WEBHOOK_KEY}`,
              "X-Automation-Key": env.GROKBOT_WEBHOOK_KEY,
            },
            body: text,
            signal: AbortSignal.timeout(10000),
          });
        } catch (e) {
          await store.remove(id);
          return json(req, env, 502, { error: "could not reach Grok Bot webhook" });
        }
        if (!resp.ok) {
          await store.remove(id);
          const status = resp.status === 413 ? 413 : resp.status === 429 ? 429 : 502;
          return json(req, env, status, { error: `Grok Bot webhook returned ${resp.status}`, upstream_status: resp.status });
        }
        return json(req, env, 200, { request_id: id, forwarded_bytes: bytes(text), truncated: body.truncated, screenshot: !!shot, screenshot_rejected: !shot && !!rb.data.screenshot });
      }

      if (url.pathname === "/answer" && req.method === "POST") {
        if (!env.REPLY_TOKEN || !(await authed(req, env.REPLY_TOKEN))) return json(req, env, 401, { error: "unauthorized" });
        const rb = await readBody(req, num(env, "MAX_ANSWER_BYTES", 65536));
        if (rb.tooBig) return json(req, env, 413, { error: "answer too large" });
        if (rb.bad || !rb.data) return json(req, env, 400, { error: "invalid JSON" });
        const id = str(rb.data.request_id, 100);
        const answer = str(rb.data.answer, 60000);
        if (!ID_RE.test(id) || !answer) return json(req, env, 400, { error: "request_id and answer are required" });
        const r = await store.putAnswer(id, answer, ttl);
        if (!r.ok) return json(req, env, 404, { error: "unknown or expired request_id" });
        return json(req, env, 200, { ok: true });
      }

      const sm = url.pathname.match(/^\/screenshot\/([^/]+)$/);
      if (sm && req.method === "GET") {
        if (!env.REPLY_TOKEN || !(await authed(req, env.REPLY_TOKEN))) return json(req, env, 401, { error: "unauthorized" });
        if (!ID_RE.test(sm[1])) return json(req, env, 400, { error: "bad id" });
        const shot = await store.getShot(sm[1]);
        if (!shot) return json(req, env, 404, { error: "no screenshot for this request_id (none sent, or expired)" });
        return new Response(shot.data, { status: 200, headers: { "Content-Type": shot.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
      }

      const m = url.pathname.match(/^\/answer\/([^/]+)$/);
      if (m && req.method === "GET") {
        if (!env.EXT_TOKEN || !(await authed(req, env.EXT_TOKEN))) return json(req, env, 401, { error: "unauthorized" });
        if (!ID_RE.test(m[1])) return json(req, env, 400, { error: "bad id" });
        const rl = await store.rateLimit([["poll-m", 60, num(env, "POLL_PER_MINUTE", 120)]]);
        if (!rl.ok) return json(req, env, 429, { error: "rate limited", retry_after: rl.retryAfter }, { "Retry-After": String(rl.retryAfter) });
        const r = await store.get(m[1]);
        if (!r) return json(req, env, 404, { status: "unknown" });
        return json(req, env, 200, r.answer == null ? { status: "pending" } : { status: "done", answer: r.answer });
      }

      return json(req, env, 404, { error: "not found" });
    } catch (e) {
      console.error("relay error", e && e.stack || e);
      return json(req, env, 500, { error: "internal error" });
    }
  },
};

export class RelayStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.storage = ctx.storage;
    this.sql.exec("CREATE TABLE IF NOT EXISTS req (id TEXT PRIMARY KEY, answer TEXT, expires INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS shot (id TEXT PRIMARY KEY, data BLOB NOT NULL, type TEXT NOT NULL, expires INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL)");
  }
  now() { return Date.now(); }
  async sweep() {
    this.sql.exec("DELETE FROM req WHERE expires < ?", this.now());
    this.sql.exec("DELETE FROM shot WHERE expires < ?", this.now());
    this.sql.exec("DELETE FROM rl WHERE reset < ?", this.now());
  }
  async ensureAlarm() {
    if ((await this.storage.getAlarm()) == null) await this.storage.setAlarm(this.now() + 10 * 60 * 1000);
  }
  async alarm() {
    await this.sweep();
    const left = this.sql.exec("SELECT (SELECT COUNT(*) FROM req) + (SELECT COUNT(*) FROM shot) AS c").one().c;
    if (left > 0) await this.storage.setAlarm(this.now() + 10 * 60 * 1000);
  }
  async rateLimit(rules) {
    const t = this.now();
    for (const [k, win, max] of rules) {
      const row = this.sql.exec("SELECT n, reset FROM rl WHERE k = ?", k).toArray()[0];
      if (row && row.reset > t && row.n >= max) return { ok: false, retryAfter: Math.ceil((row.reset - t) / 1000) };
    }
    for (const [k, win] of rules) {
      const row = this.sql.exec("SELECT n, reset FROM rl WHERE k = ?", k).toArray()[0];
      if (!row || row.reset <= t) this.sql.exec("INSERT OR REPLACE INTO rl (k, n, reset) VALUES (?, 1, ?)", k, t + win * 1000);
      else this.sql.exec("UPDATE rl SET n = n + 1 WHERE k = ?", k);
    }
    return { ok: true };
  }
  async createPending(id, ttl, shot) {
    this.sql.exec("INSERT OR REPLACE INTO req (id, answer, expires) VALUES (?, NULL, ?)", id, this.now() + ttl * 1000);
    if (shot) this.sql.exec("INSERT OR REPLACE INTO shot (id, data, type, expires) VALUES (?, ?, ?, ?)", id, shot.data.buffer.slice(shot.data.byteOffset, shot.data.byteOffset + shot.data.byteLength), shot.type, this.now() + ttl * 1000);
    await this.ensureAlarm();
  }
  async putAnswer(id, answer, ttl) {
    const row = this.sql.exec("SELECT expires FROM req WHERE id = ?", id).toArray()[0];
    if (!row || row.expires < this.now()) return { ok: false };
    this.sql.exec("UPDATE req SET answer = ?, expires = ? WHERE id = ?", answer, this.now() + ttl * 1000, id);
    return { ok: true };
  }
  async get(id) {
    const row = this.sql.exec("SELECT answer, expires FROM req WHERE id = ?", id).toArray()[0];
    if (!row || row.expires < this.now()) return null;
    return { answer: row.answer };
  }
  async getShot(id) {
    const row = this.sql.exec("SELECT data, type, expires FROM shot WHERE id = ?", id).toArray()[0];
    if (!row || row.expires < this.now()) return null;
    return { data: row.data, type: row.type };
  }
  async remove(id) { this.sql.exec("DELETE FROM req WHERE id = ?", id); this.sql.exec("DELETE FROM shot WHERE id = ?", id); }
}

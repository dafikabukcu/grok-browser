// Mock Grok Bot webhook: accepts the routine POST, then plays the user's Grok Bot by POSTing the answer to the relay.
import http from "node:http";
const PORT = +process.env.MOCK_PORT || 8799;
const RELAY = process.env.RELAY || "http://127.0.0.1:8787";
const KEY = process.env.MOCK_KEY, REPLY = process.env.MOCK_REPLY;
const LIMIT = +process.env.MOCK_LIMIT || 0; // optional: simulate a body limit (413)
export const log = [];
http.createServer((req, res) => {
  if (req.url === "/_log") { res.end(JSON.stringify(log)); return; }
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    const authOk = req.headers.authorization === `Bearer ${KEY}` && req.headers["x-automation-key"] === KEY;
    let body = null; try { body = JSON.parse(raw); } catch {}
    log.push({ bytes: raw.length, authOk, keys: body ? Object.keys(body) : [], truncated: body?.truncated, page_text_len: body?.page_text?.length, source: body?.source, local_path: body?.local_path, question: body?.question?.slice(0, 40), screenshot_url: body?.screenshot_url, pdf_page: body?.pdf_page, pdf_page_source: body?.pdf_page_source, screenshot_error: body?.screenshot_error, ext_version: body?.ext_version, has_image_field: !!body && ("screenshot" in body) });
    // Play the bot fetching the screenshot with the reply token.
    if (body?.screenshot_url) {
      try { const sr = await fetch(body.screenshot_url.replace(/^https?:\/\/[^/]+/, RELAY), { headers: { Authorization: `Bearer ${REPLY}` } });
        const buf = Buffer.from(await sr.arrayBuffer()); Object.assign(log[log.length - 1], { shot_status: sr.status, shot_type: sr.headers.get("content-type"), shot_bytes: buf.length, shot_jpeg: buf[0] === 0xff && buf[1] === 0xd8 });
      } catch (e) { log[log.length - 1].shot_status = String(e); }
    }
    if (!authOk) { res.writeHead(401); res.end(); return; }
    if (LIMIT && raw.length > LIMIT) { res.writeHead(413); res.end(); return; }
    res.writeHead(200); res.end("{}");
    if (body?.question === "__noanswer__") return;
    setTimeout(async () => {
      const answer = body.question === "__ping__" ? "pong" : `**Mock answer** for "${body.question}" about *${body.title}* (${body.page_text.length} chars).\n\n- item 1\n- item 2`;
      try {
        const r = await fetch(`${RELAY}/answer`, { method: "POST", headers: { "Authorization": `Bearer ${REPLY}`, "Content-Type": "application/json" }, body: JSON.stringify({ request_id: body.request_id, answer }) });
        log[log.length - 1].answer_status = r.status;
      } catch (e) { console.log("answer post failed", e.message); }
    }, 1500);
  });
}).listen(PORT, "127.0.0.1", () => console.log("mock webhook on", PORT));

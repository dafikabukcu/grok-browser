// Mock of xAI's OpenAI-compatible POST /v1/chat/completions with SSE streaming, for the xAI-mode tests.
import http from "node:http";
const PORT = +process.env.MOCK_XAI_PORT || 8798;
const KEY = process.env.MOCK_XAI_KEY || "xai-test-key";
const log = [];
http.createServer((req, res) => {
  if (req.url === "/_log") { res.end(JSON.stringify(log)); return; }
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", async () => {
    let body = null; try { body = JSON.parse(Buffer.concat(chunks)); } catch {}
    const user = body?.messages?.at(-1);
    const parts = Array.isArray(user?.content) ? user.content : [{ type: "text", text: user?.content }];
    const img = parts.find((p) => p.type === "image_url");
    const text = parts.find((p) => p.type === "text")?.text || "";
    const entry = { path: req.url, auth: req.headers.authorization === `Bearer ${KEY}`, model: body?.model, stream: body?.stream, effort: body?.reasoning_effort,
      system: body?.messages?.[0]?.role === "system", n_messages: body?.messages?.length, has_image: !!img, image_jpeg: !!img && /^data:image\/jpeg;base64,\/9j\//.test(img.image_url?.url || ""),
      untrusted_fence: /<page_content untrusted="true">/.test(text), question: (text.split("Question: ")[1] || "").slice(0, 60), pdf_page: (text.match(/"pdf_page": (\d+)/) || [])[1] };
    log.push(entry);
    if (req.url !== "/v1/chat/completions") { res.writeHead(404); res.end("{}"); return; }
    if (!entry.auth) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Incorrect API key provided" })); return; }
    if (!body.stream) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: "pong" } }] })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const answer = `**Streamed answer** about ${entry.has_image ? "the screenshot" : "the page"}${entry.pdf_page ? ` (page ${entry.pdf_page})` : ""}.\n\nYou're on **page ${entry.pdf_page || "?"}** of the sample book (read from the viewer toolbar).\n\n- It opens with *"Call me Ishmael"*.\n- Exercise ${entry.pdf_page || "?"}.1 asks what drives the narrator to sea.\n\n> (Mock answer from the test suite.)`;
    const pieces = answer.match(/.{1,6}/gs);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "thinking" } }] })}\n\n`);
    for (const p of pieces) { res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: p } }] })}\n\n`); await new Promise((r) => setTimeout(r, 40)); }
    res.write("data: [DONE]\n\n"); res.end();
  });
}).listen(PORT, "127.0.0.1", () => console.log("mock xAI on", PORT));

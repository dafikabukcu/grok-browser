// End-to-end tests: extension -> relay (wrangler dev) -> mock webhook -> relay /answer -> extension poll.
const R = process.env.RELAY || "http://127.0.0.1:8787";
const EXT = process.env.TEST_EXT, REPLY = process.env.TEST_REPLY;
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"} ${name} ${extra}`); };
const H = (tok) => ({ "Authorization": `Bearer ${tok}`, "Content-Type": "application/json", "Origin": ORIGIN });
const askBody = (o = {}) => ({ question: "What is this chapter about?", url: "https://example.com/book/ch1", title: "Book ch1", selection: "", visible_text: "visible", page_text: "Once upon a time. ".repeat(100), truncated: false, pdf_url: "", history: [{ q: "hi", a: "hello" }], ...o });
const post = (p, tok, b) => fetch(R + p, { method: "POST", headers: H(tok), body: typeof b === "string" ? b : JSON.stringify(b) });
const get = (p, tok) => fetch(R + p, { headers: H(tok) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitAns(id) { for (let i = 0; i < 20; i++) { const r = await (await get(`/answer/${id}`, EXT)).json(); if (r.status !== "pending") return r; await sleep(500); } return { status: "timeout" }; }
const mocklog = async () => (await fetch("http://127.0.0.1:8799/_log")).json();

// CORS preflight
let r = await fetch(R + "/ask", { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } });
ok(r.status === 204 && r.headers.get("access-control-allow-origin") === ORIGIN, "CORS preflight allows chrome-extension origin");
r = await fetch(R + "/ask", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
ok(!r.headers.get("access-control-allow-origin"), "CORS rejects web origins");

// Auth
ok((await post("/ask", "wrong", askBody())).status === 401, "ask rejects bad EXT_TOKEN");
ok((await post("/ask", REPLY, askBody())).status === 401, "ask rejects REPLY_TOKEN");
ok((await get("/answer/aaaaaaaaaaaaaaaaaaaaaaaa", "wrong")).status === 401, "poll rejects bad token");
ok((await post("/answer", EXT, { request_id: "aaaaaaaaaaaaaaaaaaaaaaaa", answer: "x" })).status === 401, "answer rejects EXT_TOKEN");
ok((await post("/answer", REPLY, { request_id: "aaaaaaaaaaaaaaaaaaaaaaaa", answer: "x" })).status === 404, "answer rejects unknown request_id");
ok((await post("/ask", EXT, "{not json")).status === 400, "ask rejects invalid JSON");
ok((await post("/ask", EXT, askBody({ question: "  " }))).status === 400, "ask requires question");

// Happy path + ping
r = await post("/ask", EXT, askBody()); let j = await r.json();
ok(r.status === 200 && /^[\w-]{16,64}$/.test(j.request_id), "ask returns request_id", JSON.stringify({ forwarded_bytes: j.forwarded_bytes }));
ok((await (await get(`/answer/${j.request_id}`, EXT)).json()).status === "pending", "poll shows pending first");
let a = await waitAns(j.request_id);
ok(a.status === "done" && a.answer.includes("Mock answer"), "answer round-trip");
r = await post("/ask", EXT, askBody({ question: "__ping__" })); j = await r.json(); a = await waitAns(j.request_id);
ok(a.answer === "pong", "__ping__ -> pong");
let log = await mocklog(); let last = log[log.length - 1];
ok(last.authOk, "relay sends Bearer + X-Automation-Key to webhook");
ok(["request_id","question","url","title","selection","visible_text","page_text","truncated","pdf_url","history"].every((k) => last.keys.includes(k)), "webhook body has all routine fields");
ok((await get(`/answer/zzzzzzzzzzzzzzzzzzzzzzzz`, EXT)).status === 404, "unknown id -> 404 unknown");

// Local file fields
r = await post("/ask", EXT, askBody({ url: "file:///C:/Users/reader/Books/x.pdf", pdf_url: "file:///C:/Users/reader/Books/x.pdf", source: "local_file", local_path: "C:\\Users\\reader\\Books\\x.pdf", page_text: "" }));
await r.json(); log = await mocklog(); last = log[log.length - 1];
ok(last.source === "local_file" && last.local_path === "C:\\Users\\reader\\Books\\x.pdf", "local_file + local_path forwarded");

// Size trimming: 300k ASCII chars and 150k Greek chars (2 bytes each)
for (const [name, txt] of [["ascii 300k", "a".repeat(300000)], ["greek 150k", "αβγδ".repeat(37500)]]) {
  r = await post("/ask", EXT, askBody({ question: "__noanswer__", page_text: txt })); j = await r.json();
  log = await mocklog(); last = log[log.length - 1];
  ok(r.status === 200 && last.bytes <= 98304 && last.truncated === true, `page_text trimmed to fit forward cap (${name})`, `-> ${last.bytes} bytes, page_text ${last.page_text_len} chars`);
}
// Screenshot: stored in the DO, never forwarded, served to REPLY_TOKEN only.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300000, 7), Buffer.from([0xff, 0xd9])]);
const shotUrl = "data:image/jpeg;base64," + JPEG.toString("base64");
r = await post("/ask", EXT, askBody({ question: "__noanswer__", url: "file:///home/reader/Books/sample%20book.pdf#page=9", pdf_url: "file:///home/reader/Books/sample%20book.pdf", source: "local_file", local_path: "/home/reader/Books/sample book.pdf", page_text: "", visible_text: "", pdf_page: 9, screenshot: shotUrl }));
j = await r.json(); const shotId = j.request_id;
ok(r.status === 200 && j.screenshot === true, "ask with ~400 KB screenshot accepted", JSON.stringify({ forwarded_bytes: j.forwarded_bytes }));
await sleep(300); log = await mocklog(); last = log[log.length - 1];
ok(last.screenshot_url && last.screenshot_url.endsWith(`/screenshot/${shotId}`) && !last.has_image_field && last.bytes < 4000, "webhook body has screenshot_url, no image data", `(${last.bytes} bytes)`);
ok(last.pdf_page === 9, "pdf_page forwarded");
ok(last.shot_status === 200 && last.shot_type === "image/jpeg" && last.shot_bytes === JPEG.length && last.shot_jpeg, "bot (reply token) can GET the screenshot");
r = await fetch(`${R}/screenshot/${shotId}`, { headers: { Authorization: `Bearer ${REPLY}` } });
ok(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(JPEG), "GET /screenshot/:id returns the exact bytes");
ok((await fetch(`${R}/screenshot/${shotId}`)).status === 401, "GET /screenshot without token -> 401");
ok((await fetch(`${R}/screenshot/${shotId}`, { headers: { Authorization: `Bearer ${EXT}` } })).status === 401, "GET /screenshot with EXT_TOKEN -> 401");
ok((await fetch(`${R}/screenshot/zzzzzzzzzzzzzzzzzzzzzzzz`, { headers: { Authorization: `Bearer ${REPLY}` } })).status === 404, "GET /screenshot unknown id -> 404");
r = await post("/ask", EXT, askBody({ question: "__noanswer__", screenshot: "data:image/jpeg;base64," + Buffer.from("<html>not an image</html>").toString("base64") })); j = await r.json();
log = await mocklog(); last = log[log.length - 1];
ok(r.status === 200 && j.screenshot === false && !last.screenshot_url, "non-image screenshot ignored, question still sent");
r = await post("/ask", EXT, askBody({ question: "__noanswer__", screenshot_url: "https://evil.example/x.jpg" })); await r.json();
log = await mocklog(); last = log[log.length - 1];
ok(!last.screenshot_url, "client can't inject its own screenshot_url");
r = await post("/ask", EXT, askBody({ question: "__noanswer__", page_text: "a".repeat(300000), screenshot: shotUrl })); j = await r.json();
log = await mocklog(); last = log[log.length - 1];
ok(r.status === 200 && j.screenshot && last.bytes <= 98304 && last.screenshot_url, "big page_text + screenshot: forward still under cap with screenshot_url", `(${last.bytes} bytes)`);

r = await post("/ask", EXT, askBody({ question: "__noanswer__", screenshot_error: "no-access: Either the '<all_urls>' or 'activeTab' permission is required.", ext_version: "1.0.0", pdf_page: 9, pdf_page_source: "url_fragment" })); await r.json();
log = await mocklog(); last = log[log.length - 1];
ok(/^no-access/.test(last.screenshot_error || "") && !last.screenshot_url && last.ext_version === "1.0.0" && last.pdf_page_source === "url_fragment", "screenshot_error, ext_version, pdf_page_source forwarded");
r = await post("/ask", EXT, askBody({ question: "__noanswer__", screenshot: "data:image/jpeg;base64," + Buffer.from("not an image at all").toString("base64") })); await r.json();
log = await mocklog(); last = log[log.length - 1];
ok(/relay rejected/.test(last.screenshot_error || ""), "rejected screenshot -> screenshot_error tells the bot");

ok((await (await fetch(R + "/health")).json()).service === "grok-browser-relay", "health endpoint names the service");

// Over MAX_ASK_BYTES (1.5 MB)
r = await post("/ask", EXT, askBody({ page_text: "x".repeat(1600000) }));
ok(r.status === 413, "ask > 1.5 MB -> 413");
// Answer size limit
r = await post("/answer", REPLY, { request_id: "aaaaaaaaaaaaaaaaaaaaaaaa", answer: "x".repeat(70000) });
ok(r.status === 413, "answer > 64 KB -> 413");

console.log(`\n${pass} passed, ${fail} failed`);
// Rate limit last (it consumes the per-minute budget)
let codes = [];
for (let i = 0; i < 30; i++) { const x = await post("/ask", EXT, askBody({ question: "__noanswer__" })); codes.push(x.status); if (x.status === 429) break; }
const limited = codes.includes(429);
console.log(`${limited ? "PASS" : "FAIL"} rate limit hits 429 (statuses: ${codes.join(",")})`);
process.exit(fail || !limited ? 1 : 0);

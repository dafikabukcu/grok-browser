// Fast tests with no browser or relay: pure helpers, the xAI request shape, docs/prompt consistency, and a secret scan.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, n, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${n} ${x}`); };

const paths = await import(path.join(ROOT, "extension/paths.js"));
ok(paths.fileUrlToLocalPath("file:///C:/Users/me/My%20Books/x.pdf") === "C:\\Users\\me\\My Books\\x.pdf", "file URL -> Windows path");
ok(paths.fileUrlToLocalPath("file://nas/share/b.pdf") === "\\\\nas\\share\\b.pdf", "file URL -> UNC path");
ok(paths.fileUrlToLocalPath("file:///Users/me/Books/%C3%A7.pdf") === "/Users/me/Books/ç.pdf", "file URL -> macOS/Linux path");
ok(paths.fileUrlToLocalPath("https://example.com/x.pdf") === "", "non-file URL -> empty path");
ok(paths.pdfPageFromUrl("https://e.com/a.pdf#page=12") === 12 && paths.pdfPageFromUrl("https://e.com/a.pdf#zoom=2&page=3") === 3 && paths.pdfPageFromUrl("https://e.com/a.pdf") === null, "#page=N parsing");

const { renderMarkdown } = await import(path.join(ROOT, "extension/markdown.js"));
const md = renderMarkdown("**b** _i_ `c` [x](javascript:alert(1)) <script>1</script>\n\n- a\n- b");
ok(md.includes("<strong>b</strong>") && md.includes("<ul>") && !md.includes("<script>") && !md.includes('href="javascript'), "markdown renders safely");

const api = await import(path.join(ROOT, "extension/api.js"));
const req = api.buildXaiRequest({ question: "What is this?", url: "https://e.com", title: "T", selection: "", visible_text: "v", page_text: "p", truncated: false, pdf_url: "", screenshot: "data:image/jpeg;base64,/9j/AAA", history: [{ q: "q1", a: "a1" }] }, { xaiModel: "grok-4.7", xaiEffort: "low" });
const last = req.messages.at(-1);
ok(req.model === "grok-4.7" && req.stream === true && req.reasoning_effort === "low", "xAI request: model, stream, reasoning_effort");
ok(req.messages[0].role === "system" && req.messages[1].content === "q1" && req.messages[2].role === "assistant" && req.messages.length === 4, "xAI request: system + history turns");
ok(last.content[0].type === "image_url" && last.content[0].image_url.url.startsWith("data:image/jpeg") && last.content[1].type === "text" && /Question: What is this\?$/.test(last.content[1].text), "xAI request: screenshot as image_url + question");
ok(/<page_content untrusted="true">/.test(last.content[1].text) && /untrusted page content/i.test(api.SYSTEM_PROMPT), "xAI request: page content fenced as untrusted");
const noEffort = api.buildXaiRequest({ question: "q", history: [] }, { xaiModel: "grok-4.3", xaiEffort: "" });
ok(!("reasoning_effort" in noEffort) && typeof noEffort.messages.at(-1).content[0].text === "string", "xAI request: no reasoning_effort when 'model default', text-only without screenshot");

const prompt = fs.readFileSync(path.join(ROOT, "extension/bot-prompt.txt"), "utf8");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
ok(readme.includes(prompt.trim()), "README contains the exact 'paste this to your Grok Bot' prompt");
for (const f of ["request_id", "question", "url", "title", "selection", "visible_text", "page_text", "truncated", "pdf_url", "pdf_page", "pdf_page_source", "screenshot_url", "screenshot_error", "ext_version", "local_path", "source", "history"])
  if (!prompt.includes(f)) ok(false, "routine prompt mentions field " + f);
ok(/__ping__/.test(prompt) && /curl/.test(prompt) && /\/answer/.test(prompt) && /~\/\.config\/grok-browser\/config\.json/.test(prompt), "routine prompt covers ping, curl delivery and the config file");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
ok(manifest.name === "Grok Browser" && manifest.version === pkg.version, "manifest name + version match package.json", manifest.version);
ok(manifest.host_permissions.includes("https://api.x.ai/*"), "manifest has api.x.ai host permission");
ok(/not affiliated with[^.]*xAI/i.test(readme), "README says it's not affiliated with xAI");

// Secret / leftover scan over every file that would be committed.
const SKIP = /(^|\/)(node_modules|\.git|\.cache|\.wrangler|dist)(\/|$)|\.(png|jpe?g|pdf|zip)$|package-lock\.json$/;
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), rel = path.relative(ROOT, p); if (SKIP.test(rel) || /^relay\/(\.dev\.vars|\.grok-browser-secrets\.json|grok-browser-settings\.json)$/.test(rel)) continue; e.isDirectory() ? walk(p) : files.push(p); } })(ROOT);
const BAD = [
  [/gh[opsur]_[A-Za-z0-9]{30,}/, "GitHub token"], [/xai-[A-Za-z0-9]{30,}/, "xAI API key"], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/automations\/webhook\/[0-9a-f]{8}-/i, "Grok Bot webhook URL"], [/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i, "real workers.dev URL"],
  [/\b[A-Za-z]:\\\\?Users\\\\?(?!me\b|reader\b)[A-Za-z0-9._-]+/, "personal Windows user path"],
];
const extra = (process.env.EXTRA_FORBIDDEN || "").split(",").map((s) => s.trim()).filter(Boolean);
const hits = [];
for (const f of files) {
  const t = fs.readFileSync(f, "utf8"); const rel = path.relative(ROOT, f);
  for (const [re, what] of BAD) { const m = t.match(re); if (m && !/example|<|your-|grok-browser-relay\.\w+\.workers\.dev/.test(m[0])) hits.push(`${rel}: ${what}`); }
  for (const w of extra) if (t.toLowerCase().includes(w.toLowerCase())) hits.push(`${rel}: forbidden word #${extra.indexOf(w)}`);
}
ok(hits.length === 0, `secret scan over ${files.length} files`, hits.join("; "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

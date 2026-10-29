// Injected into the page with chrome.scripting.executeScript. Must be self-contained.
export function extractPage(maxChars) {
  maxChars = maxChars || 60000;
  const doc = document;
  const url = location.href;
  const title = (doc.title || "").trim();
  const clean = (s) => (s || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();

  // PDF detection: Chrome/Edge PDF viewer pages have contentType application/pdf and an <embed type=application/pdf>.
  const embed = doc.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
  const isPdf = doc.contentType === "application/pdf" || !!embed || /\.pdf$/i.test(location.pathname);
  let pdf_url = "";
  if (isPdf) {
    const src = embed && (embed.getAttribute("original-url") || embed.getAttribute("src") || embed.getAttribute("data"));
    pdf_url = src && !/^about:/.test(src) ? new URL(src, url).href : url;
  }

  // Selection (including inside inputs/textareas).
  let selection = String(window.getSelection ? window.getSelection() : "");
  const ae = doc.activeElement;
  if (!selection && ae && (ae.tagName === "TEXTAREA" || (ae.tagName === "INPUT" && /text|search/.test(ae.type))) && ae.selectionEnd > ae.selectionStart) {
    selection = ae.value.slice(ae.selectionStart, ae.selectionEnd);
  }
  selection = clean(selection).slice(0, 20000);

  const NOISE = "script,style,noscript,template,svg,canvas,iframe,nav,header,footer,aside,form,button,select,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[aria-hidden=true],.sidebar,.advert,.ads,.ad,.cookie,.cookies,.newsletter,.share,.social,.comments,#comments";

  // Visible text: text nodes whose box intersects the viewport.
  function visibleText() {
    const out = []; let total = 0;
    if (!doc.body) return "";
    const vw = innerWidth, vh = innerHeight;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement; if (!p || p.closest("script,style,noscript,template")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const range = doc.createRange(); let lastBlock = null;
    for (let n = walker.nextNode(); n && total < 15000; n = walker.nextNode()) {
      range.selectNodeContents(n);
      const rects = range.getClientRects(); let vis = false;
      for (const r of rects) { if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw) { vis = true; break; } }
      if (!vis) continue;
      const cs = getComputedStyle(n.parentElement);
      if (cs.visibility === "hidden" || cs.opacity === "0") continue;
      const block = n.parentElement.closest("p,div,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,section,article");
      const t = n.nodeValue.replace(/\s+/g, " ");
      out.push(block !== lastBlock ? "\n" + t : t); lastBlock = block; total += t.length;
    }
    return clean(out.join(""));
  }

  // Readability-style main content: score candidate containers by text density vs link density.
  function mainText() {
    if (!doc.body) return "";
    const cands = new Set();
    doc.querySelectorAll("article,main,[role=main],#content,.content,#main,.post,.entry-content,.article,.chapter,.book,.reader,#reader,.page").forEach((e) => cands.add(e));
    doc.querySelectorAll("p").forEach((p) => { if (p.parentElement) { cands.add(p.parentElement); if (p.parentElement.parentElement) cands.add(p.parentElement.parentElement); } });
    let best = null, bestScore = 0;
    for (const el of cands) {
      if (el.closest(NOISE)) continue;
      const text = el.innerText || ""; const len = text.length; if (len < 200) continue;
      let linkLen = 0; el.querySelectorAll("a").forEach((a) => (linkLen += (a.innerText || "").length));
      const pCount = el.querySelectorAll("p").length;
      const score = len * (1 - Math.min(0.9, linkLen / len)) + pCount * 100 + (/article|main/i.test(el.tagName) ? 2000 : 0);
      if (score > bestScore) { bestScore = score; best = el; }
    }
    const bodyLen = (doc.body.innerText || "").length;
    let root = best;
    // Fall back to the whole body when the best block covers too little of the page (e.g. app-like readers).
    if (!root || (root.innerText || "").length < bodyLen * 0.25) root = doc.body;
    // innerText on a live element respects layout; strip noise by collecting text of non-noise children.
    const parts = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (c.matches(NOISE) && root === doc.body) continue;
        if (c.matches("script,style,noscript,template,svg,canvas")) continue;
        if (c.children.length && c.innerText && c.innerText.length > 4000) walk(c);
        else { const t = c.innerText; if (t && t.trim()) parts.push(t); }
      }
    };
    walk(root);
    let txt = clean(parts.join("\n\n"));
    if (txt.length < 200) txt = clean(root.innerText || doc.body.textContent || "");
    return txt;
  }

  let page_text = "", visible_text = "";
  try { visible_text = visibleText(); } catch (e) {}
  try { page_text = mainText(); } catch (e) { page_text = clean(doc.body ? doc.body.innerText : ""); }
  const fullLen = page_text.length;
  const truncated = fullLen > maxChars;
  if (truncated) page_text = page_text.slice(0, maxChars);
  const meta = (n) => (doc.querySelector(`meta[name="${n}"],meta[property="${n}"]`) || {}).content || "";
  return { url, title, selection, visible_text, page_text, truncated, full_length: fullLen, pdf_url,
    description: meta("description") || meta("og:description"), author: meta("author"), lang: doc.documentElement.lang || "" };
}

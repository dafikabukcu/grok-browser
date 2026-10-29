// Pure URL helpers (no chrome.* APIs), shared by the service worker and unit tests.

// "#page=9" (Chrome/Edge PDF viewer open-parameters) -> 9
export function pdfPageFromUrl(u) {
  try { const m = new URL(u).hash.match(/(?:^#|&)page=(\d{1,6})(?:&|$)/i); return m ? parseInt(m[1], 10) : null; } catch { return null; }
}

// file:///C:/Users/me/Books/x.pdf -> C:\Users\me\Books\x.pdf ; file://server/share/x -> \\server\share\x ;
// file:///home/me/Books/x.pdf -> /home/me/Books/x.pdf (macOS / Linux)
export function fileUrlToLocalPath(u) {
  try {
    const p = new URL(u);
    if (p.protocol !== "file:") return "";
    const path = decodeURIComponent(p.pathname);
    if (p.host) return "\\\\" + p.host + path.replace(/\//g, "\\");
    if (/^\/[A-Za-z]:/.test(path)) return path.slice(1).replace(/\//g, "\\");
    return path;
  } catch { return ""; }
}

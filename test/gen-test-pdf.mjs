// Generates test/pages/sample-book.pdf: a 16-page public-domain "book" (Herman Melville, Moby-Dick, 1851)
// with a big page marker on every page, so screenshot tests can check which page is on screen.
// No dependencies: writes a minimal PDF by hand (Helvetica, WinAnsi).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "pages", "sample-book.pdf");
export const PAGES = 16;

const OPENING = "Call me Ishmael. Some years ago - never mind how long precisely - having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world. It is a way I have of driving off the spleen and regulating the circulation. Whenever I find myself growing grim about the mouth; whenever it is a damp, drizzly November in my soul; whenever I find myself involuntarily pausing before coffin warehouses, and bringing up the rear of every funeral I meet; and especially whenever my hypos get such an upper hand of me, that it requires a strong moral principle to prevent me from deliberately stepping into the street, and methodically knocking people's hats off - then, I account it high time to get to sea as soon as I can.";
const FILLER = "There now is your insular city of the Manhattoes, belted round by wharves as Indian isles by coral reefs - commerce surrounds it with her surf. Circumambulate the city of a dreamy Sabbath afternoon. Go from Corlears Hook to Coenties Slip, and from thence, by Whitehall, northward. What do you see? Posted like silent sentinels all around the town, stand thousands upon thousands of mortal men fixed in ocean reveries.";

function wrap(text, max = 78) {
  const out = []; let line = "";
  for (const w of text.split(/\s+/)) { if ((line + " " + w).trim().length > max) { out.push(line); line = w; } else line = (line + " " + w).trim(); }
  if (line) out.push(line); return out;
}
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function pageStream(n) {
  const ops = ["BT", "/F1 30 Tf", "72 720 Td", `(SAMPLE PAGE ${n}) Tj`, "ET", "BT", "/F1 13 Tf", "72 690 Td", `(Moby-Dick - Chapter ${n}: practice exercise ${n}.1) Tj`, "ET"];
  const body = wrap(n === 1 ? OPENING : `Exercise ${n}.1. ` + FILLER + " " + FILLER);
  ops.push("BT", "/F1 11 Tf", "15 TL", "72 660 Td");
  for (const l of body) ops.push(`(${esc(l)}) Tj T*`);
  ops.push("ET", "BT", "/F1 10 Tf", "290 40 Td", `(- ${n} -) Tj`, "ET");
  return ops.join("\n");
}

export function buildPdf() {
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Title (Moby-Dick sample \\(public domain\\)) /Author (Herman Melville) >>";
  const kids = [];
  for (let n = 1; n <= PAGES; n++) {
    const pid = 3 + n * 2, cid = pid + 1, s = pageStream(n);
    kids.push(`${pid} 0 R`);
    objs[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cid} 0 R >>`;
    objs[cid] = `<< /Length ${Buffer.byteLength(s, "latin1")} >>\nstream\n${s}\nendstream`;
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${PAGES} >>`;
  let pdf = "%PDF-1.4\n"; const offs = [];
  for (let i = 1; i < objs.length; i++) { offs[i] = Buffer.byteLength(pdf, "latin1"); pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offs.slice(1).map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.writeFileSync(OUT, buildPdf()); console.log("wrote", OUT);
}

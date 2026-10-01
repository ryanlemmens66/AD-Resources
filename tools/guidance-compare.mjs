#!/usr/bin/env node
/*
  tools/guidance-compare.mjs -- compare a Tasking & Operating Guidelines PDF with the wording
  embedded in the app, section by section, before any guidance update.

    node tools/guidance-compare.mjs "Tasking Guidelines V2.02.pdf"
    node tools/guidance-compare.mjs "Tasking Guidelines V2.01.pdf" --record-baseline

  Reports:
    - whether the PDF is the approved one (SHA-256 pinned in the template) and the version
      printed in it;
    - every embedded section whose wording differs from the PDF: the words the app has that the
      PDF does not ("app only") and the reverse ("PDF only");
    - numbered headings in the PDF that the app does not carry (new sections, or ones left out
      by design; see ARCHITECTURE.md, *Tasking & Clinical Guidance*).
  It changes nothing in the app. The wording is updated by hand from this list, section by
  section, keeping the issued numbering and wording (typos included).

  How it compares. Words, not layout: case, punctuation, quote and dash styles, line breaks,
  bullets, list numbers and word order within a section are ignored, so a table read in a
  different column order is not a change. A table the PDF extracts under the neighbouring
  heading is matched back to its own section. What still differs for the approved PDF (labels
  the app adds, such as table column headings and "Operational principle", or "For example"
  shown as an Example box) is recorded once in tools/guidance-baseline.json with
  --record-baseline, which only accepts the approved PDF; later comparisons subtract it, so
  what is reported is what changed in the new PDF. Re-record after each approved update.
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { APP_FILE } from './lib.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')), recordBaseline = args.includes('--record-baseline');
if (!file) { console.log('Usage: node tools/guidance-compare.mjs <guidelines.pdf> [--record-baseline]'); process.exit(2); }
const BASELINE = new URL('./guidance-baseline.json', import.meta.url);
let pdfjs;
try { pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); }
catch { console.error('pdfjs-dist is not installed: run npm ci first.'); process.exit(2); }

/* ------------------------------------------------------------------ words -- */
const decode = (s) => s.replace(/&(lt|gt|quot|apos|amp|nbsp|#(\d+)|#x([0-9a-f]+));/gi, (m, n, dec, hex) =>
  dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16)) : { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', nbsp: ' ' }[n.toLowerCase()]);
const tokens = (text) => text.normalize('NFKC').toLowerCase().replace(/­/g, '')
  .match(/[\p{L}\p{N}]+(?:[.'’][\p{L}\p{N}]+)*/gu) || [];
/* Typesetting that is not wording: "2 nd" (superscript) is "2nd", "A N T S" (letter-spaced) is
   "ants", and "o" is a bullet glyph. */
function words(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (w === 'o') continue;
    if (/^\d+$/.test(w) && /^(st|nd|rd|th)$/.test(list[i + 1] || '')) { out.push(w + list[++i]); continue; }
    if (/^\p{L}$/u.test(w) && /^\p{L}$/u.test(list[i + 1] || '')) {
      let run = w; while (/^\p{L}$/u.test(list[i + 1] || '')) run += list[++i];
      out.push(run); continue;
    }
    out.push(w);
  }
  return out;
}

/* ------------------------------------------------------------- app side -- */
const html = readFileSync(APP_FILE, 'utf8');
const template = /<template id="airdesk-tasking-clinical-guidance-content"([^>]*)>([\s\S]*?)<\/template>/.exec(html);
if (!template) { console.error('Guidance template not found in the app.'); process.exit(1); }
const attr = (name) => decode(new RegExp(`${name}="([^"]*)"`).exec(template[1])?.[1] || '');
const sections = [...template[2].matchAll(/<section\b[^>]*data-tg-section="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)].map(([, id, body]) => {
  const title = decode(/<strong class="tg-section-title">([\s\S]*?)<\/strong>/.exec(body)?.[1].replace(/<[^>]+>/g, '') || id).trim();
  return { id, title, titleWords: words(tokens(title)), words: words(tokens(decode(body.replace(/<[^>]+>/g, ' ')))) };
});

/* ------------------------------------------------------------- PDF side -- */
const bytes = readFileSync(file);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
const pages = [];
for (let n = 1; n <= doc.numPages; n++) {
  const content = await (await doc.getPage(n)).getTextContent();
  /* Text arrives in fragments, often split inside a word: add a space only at a visible gap. */
  let line = '', lines = [], prev = null;
  for (const item of content.items) {
    const [a, b, , , x] = item.transform, size = Math.hypot(a, b) || 10;
    if (prev && item.str && !/^\s/.test(item.str) && !/\s$/.test(line) && x - prev.end > size * 0.18) line += ' ';
    line += item.str;
    prev = { end: x + item.width };
    if (item.hasEOL) { lines.push(line.trim()); line = ''; prev = null; }
  }
  if (line.trim()) lines.push(line.trim());
  pages.push(lines.filter(Boolean));
}
/* Page headers and footers: lines (digits masked) that recur on more than a third of the pages. */
const mask = (l) => l.replace(/\d+/g, '#');
const seen = new Map();
for (const lines of pages) for (const l of new Set(lines.map(mask))) seen.set(l, (seen.get(l) || 0) + 1);
const furniture = new Set([...seen].filter(([, c]) => c > pages.length / 3).map(([l]) => l));
/* The body as words, each flagged when it starts a line; list numbers ("1", "2.") are dropped. */
const pdfWords = [], lineStart = [];
for (const lines of pages) for (const l of lines) {
  if (furniture.has(mask(l))) continue;
  const w = words(tokens(l));
  if (/^\d{1,2}\.?\s+\p{L}/u.test(l) && !/^\d{1,2}\.\d/.test(l)) w.shift();
  w.forEach((x, i) => { pdfWords.push(x); lineStart.push(i === 0); });
}
const printedVersion = /\bVersion\s*(?:No\.?|Number)?\s*:?\s*(\d+\.\d+)/i.exec(pages.flat().join('\n'))?.[1] || '(not found)';

/* -------------------------------------------------------------- compare -- */
const isNumber = (w) => /^\d+$/.test(w || '');
const isHeadingNumber = (w) => /^\d{1,2}(\.\d{1,2}){0,2}$/.test(w || '');
/* A section starts where its title begins a line in the body, not in the contents list (whose
   entries end with a page number); with several candidates, the best-matching text wins. */
function findStart(s) {
  const t = s.titleWords, n = t.length, body = new Set(s.words.slice(n, n + 60));
  let best = -1, bestScore = -1;
  for (let i = 0; i + n <= pdfWords.length; i++) {
    if (!lineStart[i] || !t.every((w, k) => pdfWords[i + k] === w) || isNumber(pdfWords[i + n])) continue;
    const score = pdfWords.slice(i + n, i + n + 80).filter((w) => body.has(w)).length;
    if (score > bestScore) { best = i; bestScore = score; }
  }
  return best;
}
const known = new Set(sections.map((s) => s.id));
const starts = new Map(), missing = [];
for (const s of sections) { const at = findStart(s); if (at < 0) missing.push(s); else starts.set(s, at); }
/* Numbered headings at the start of a line. One the app folds into its parent (4.25.1 inside
   4.25) does not end the parent. */
const headings = [];
for (let i = 0; i < pdfWords.length; i++)
  if (lineStart[i] && isHeadingNumber(pdfWords[i]) && pdfWords[i].includes('.') && /^\p{L}/u.test(pdfWords[i + 1] || '') && !isNumber(pdfWords[i + 2]))
    headings.push({ at: i, id: pdfWords[i] });
const parentKnown = (id) => id.split('.').slice(0, -1).some((_, k, parts) => known.has(id.split('.').slice(0, k + 1 + 1).join('.')) && id.split('.').slice(0, k + 2).join('.') !== id);
const boundaries = [...new Set([...starts.values(), ...headings.filter((h) => !known.has(h.id) && !parentKnown(h.id)).map((h) => h.at)])].sort((a, b) => a - b);
const bag = (list) => list.reduce((m, w) => m.set(w, (m.get(w) || 0) + 1), new Map());
const surplus = (a, b) => new Map([...a].map(([w, c]) => [w, c - (b.get(w) || 0)]).filter(([, c]) => c > 0));
const take = (from, to) => { for (const [w, c] of to) { const k = Math.min(c, from.get(w) || 0); if (!k) continue; to.set(w, c - k); from.set(w, from.get(w) - k); } };
const diffs = [...starts].sort((x, y) => x[1] - y[1]).map(([s, at]) => {
  const n = s.titleWords.length, next = boundaries.find((b) => b > at + n) ?? at + n + s.words.length * 2;
  const app = bag(s.words.slice(n)), pdf = bag(pdfWords.slice(at + n, next));
  return { s, appOnly: surplus(app, pdf), pdfOnly: surplus(pdf, app) };
});
/* A table extracted under the next (or previous) heading: the same words are app-only in one
   section and PDF-only in its neighbour. */
for (let k = 0; k + 1 < diffs.length; k++) { take(diffs[k + 1].pdfOnly, diffs[k].appOnly); take(diffs[k].pdfOnly, diffs[k + 1].appOnly); }
const clean = (m) => new Map([...m].filter(([, c]) => c > 0));
for (const d of diffs) { d.appOnly = clean(d.appOnly); d.pdfOnly = clean(d.pdfOnly); }
const unmapped = [...new Set(headings.map((h) => h.id))].filter((id) => !known.has(id) && !parentKnown(id));

/* ------------------------------------------------------------- baseline -- */
const pinned = attr('data-source-sha256');
if (recordBaseline) {
  if (sha256 !== pinned) { console.error('Only the approved PDF (the SHA-256 pinned in the template) can be recorded as the baseline.'); process.exit(1); }
  const record = { note: 'Differences between the approved guidelines PDF and the embedded wording that are presentation, not wording (labels the app adds, extraction artefacts). Written by tools/guidance-compare.mjs --record-baseline; re-record after each approved guidance update.',
    sha256, version: attr('data-guidance-version'),
    sections: Object.fromEntries(diffs.filter((d) => d.appOnly.size || d.pdfOnly.size)
      .map((d) => [d.s.id, { appOnly: Object.fromEntries(d.appOnly), pdfOnly: Object.fromEntries(d.pdfOnly) }])) };
  writeFileSync(BASELINE, JSON.stringify(record, null, 2) + '\n');
  console.log(`Recorded ${Object.keys(record.sections).length} sections' presentation differences for version ${record.version} in tools/guidance-baseline.json.`);
  process.exit(0);
}
let baseline = null;
try { baseline = JSON.parse(readFileSync(BASELINE, 'utf8')); } catch {}
if (baseline) for (const d of diffs) {
  const known = baseline.sections[d.s.id]; if (!known) continue;
  take(new Map(Object.entries(known.appOnly)), d.appOnly); take(new Map(Object.entries(known.pdfOnly)), d.pdfOnly);
  d.appOnly = clean(d.appOnly); d.pdfOnly = clean(d.pdfOnly);
}
const changed = diffs.filter((d) => d.appOnly.size || d.pdfOnly.size);

/* --------------------------------------------------------------- report -- */
const list = (m) => { const w = [...m].flatMap(([x, c]) => Array(c).fill(x)); return `${w.slice(0, 24).join(' ')}${w.length > 24 ? ` ...and ${w.length - 24} more` : ''}`; };
const count = (m) => [...m.values()].reduce((a, b) => a + b, 0);
console.log(`\nTasking & Operating Guidelines: ${file}`);
console.log(`  PDF: ${doc.numPages} pages, version printed ${printedVersion}, SHA-256 ${sha256.slice(0, 16)}...`);
console.log(sha256 === pinned
  ? `  This is the approved PDF the app was built from (version ${attr('data-guidance-version')}).`
  : `  Not the approved PDF (the app carries version ${attr('data-guidance-version')}, SHA-256 ${pinned.slice(0, 16)}...).`);
if (!baseline) console.log('  No tools/guidance-baseline.json: presentation differences are included below.');
else if (baseline.sha256 !== pinned) console.log('  tools/guidance-baseline.json is for a different PDF: re-record it from the approved PDF.');
console.log(`\n  Sections compared: ${starts.size} of ${sections.length}`);
console.log(`  Wording differs: ${changed.length}`);
for (const { s, appOnly, pdfOnly } of changed) {
  console.log(`\n    ${s.title}`);
  if (appOnly.size) console.log(`      app only (${count(appOnly)} words): ${list(appOnly)}`);
  if (pdfOnly.size) console.log(`      PDF only (${count(pdfOnly)} words): ${list(pdfOnly)}`);
}
if (missing.length) console.log(`\n  Not found in the PDF (renumbered, retitled or removed): ${missing.map((s) => s.title).join('; ')}`);
console.log(`\n  PDF headings the app does not carry: ${unmapped.length ? unmapped.join(', ') : 'none'}`);
console.log('  (Sections outside the mapped pages are left out by design; see ARCHITECTURE.md.)\n');

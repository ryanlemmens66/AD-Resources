#!/usr/bin/env node
/*
  tools/visual-check.mjs -- prove a visual or stylesheet change did (or did not)
  change what the desk sees.

    node tools/visual-check.mjs baseline   before editing
    node tools/visual-check.mjs compare    after editing

  Takes 54 screenshots (18 screens x desktop 1440x900, iPad 1180x820 and phone
  390x844): every workflow tab empty and with a scene set, CAD notes, Resources,
  five dialogs, the Heli Status Board live and in Edit mode, the map type menu,
  Board View desk and wall, and Tasking & Clinical Guidance. The phone profile
  catches narrow-viewport bugs desktop and iPad cannot. The clock is frozen, animations are
  off, outside providers are blocked, and version numbers are blanked, so a
  version bump alone never shows as a change and two runs of the same file
  match exactly.

  Screens are compared pixel by pixel in Chromium; up to 40 changed pixels is
  reported as anti-aliasing noise. Changed screens are listed with pixel counts
  and both images are kept for review. Screenshots are written to the system
  temp folder (never the package), so they cannot be uploaded to Netlify.

  It complements, and does not replace, npm run test:all.
  Set AIRDESK_CHROMIUM=/path/to/chrome if Playwright's browser is unavailable.
*/
import { chromium } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_FILE, APP_NAME, REPO_DIR } from './lib.mjs';

const mode = process.argv[2];
if (mode !== 'baseline' && mode !== 'compare') {
  console.log('Usage: node tools/visual-check.mjs baseline|compare');
  process.exit(2);
}
const ROOT = path.join(os.tmpdir(), 'airdesk-visual-check');
const OUT = path.join(ROOT, mode === 'baseline' ? 'baseline' : 'current');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/* A representative fleet, so the boards have rows to draw. */
const SEED = `(() => {
  const S = (callsign, tail, caps, extra) => Object.assign({ callsign, tail, caps, notes: '', oos: false, oosReason: '' }, extra || {});
  const slots = {
    'NRES-WRE': [S('NRES6', 'ZK-HQC', ['IFR', 'Land Day', 'Wets Day', 'Land Night']), S('NRES1', 'ZK-HLH', ['IFR', 'Land Day', 'Wets Day'])],
    'NRES-AKL': [S('NRES2', 'ZK-IZB', ['IFR', 'Land Day', 'Wets Day', 'Decks Day', 'Land Night', 'Wets Night']), S('NRES5', 'ZK-IHB', ['IFR'])],
    A1WAIK: [S('A1WAIK', 'ZK-IXN', ['IFR', 'Land Day'])],
    A1TAPO: [S('A1TAPO', 'ZK-IXD', ['VFR', 'Land Day'], { oos: true, oosReason: 'mechanical' })],
    A1TEUP: [S('A1TEUP', 'ZK-IXS', ['VFR', 'Land Day'])],
    A1DUN: [S('A2DUN', 'ZK-IDU', ['IFR', 'Land Day']), S('A3DUN', 'ZK-IDH', ['IFR', 'Land Day']), S('A5DUN', 'ZK-IWD', ['IFR', 'Land Day', 'Wets Day'])]
  };
  try { localStorage.setItem('airdesk_heli_status_board_v1', JSON.stringify({ rosterOnly: true, slots })); } catch (e) {}
})();`;
const FREEZE = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' +
  '#error-banner,.airdesk-action-toast{visibility:hidden!important}';

const server = http.createServer((req, res) => {
  const rel = req.url === '/' ? '/' + APP_NAME : decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(REPO_DIR, rel);
  if (!file.startsWith(REPO_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.AIRDESK_CHROMIUM || undefined });

const profiles = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'ipad', viewport: { width: 1180, height: 820 }, hasTouch: true },
  { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true },
];
try {
  for (const profile of profiles) {
    const context = await browser.newContext({ viewport: profile.viewport, hasTouch: !!profile.hasTouch, deviceScaleFactor: 1 });
    await context.addInitScript(SEED);
    await context.route('**/*', route => { new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'); });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-09-22T09:30:00+12:00'));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.AirDesk?.system?.configStatus?.valid === true, null, { timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('shared-map')?.dataset.mapStatus !== 'loading', null, { timeout: 15000 }).catch(() => {});
    await page.addStyleTag({ content: FREEZE });
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /standard mode/i.test(x.textContent)); if (b) b.click(); });
    await page.waitForTimeout(600);
    /* the "What's new" card appears 1.2 s after load; wait for it so the first screen is deterministic */
    await page.waitForSelector('.ad-whatsnew', { timeout: 2500 }).catch(() => {});

    /* blank every version number so a version bump is not reported as a change */
    const blankVersions = () => page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (/\bv?\d+\.\d+(\.\d+)?\b/.test(n.nodeValue) && /AirDesk|^\s*v\d/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/\bv?\d+\.\d+(\.\d+)?\b/g, 'v0.0');
      }
    });
    const shot = async name => { await page.waitForTimeout(350); await blankVersions(); await page.screenshot({ path: path.join(OUT, `${profile.name}-${name}.png`) }); };
    const tab = async t => { await page.evaluate(t => [...document.querySelectorAll('.tabs .tab')].find(x => x.textContent.trim().startsWith(t))?.click(), t); };
    const dialog = async (selector, name) => {
      await page.evaluate(s => document.querySelector(s)?.click(), selector);
      await shot(name);
      await page.evaluate(() => document.getElementById('modal-close')?.click());
      await page.waitForTimeout(200);
    };

    await tab('Primary'); await shot('primary-empty');
    await page.fill('#primary-scene-search', '-38.0103, 175.3247'); await page.press('#primary-scene-search', 'Enter'); await page.waitForTimeout(2200);
    await page.evaluate(() => document.querySelector('#primary-skill-pills [data-skill="CCP"]')?.click());
    await page.fill('#primary-eta-scene', '18'); await page.dispatchEvent('#primary-eta-scene', 'input'); await shot('primary-filled');
    await page.evaluate(() => { document.querySelectorAll('.left, .left *').forEach(e => { if (e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY !== 'visible') e.scrollTop = 900; }); });
    await shot('primary-filled-scrolled');
    await dialog('#primary-cad-btn', 'primary-cad');
    await tab('Transfer'); await shot('transfers-empty');
    await tab('Search'); await page.fill('#sar-scene-search', '-36.9529, 174.4676'); await page.press('#sar-scene-search', 'Enter'); await page.waitForTimeout(2200); await shot('sar-filled');
    await tab('Resources'); await shot('resources');
    await dialog('[data-document-id="daily-duties"]', 'dialog-daily-duties');
    await dialog('[data-modal="coord"]', 'dialog-coordination');
    await dialog('[data-modal="keyq"]', 'dialog-key-questions');
    await dialog('[data-document-id="recognised-hospitals"]', 'dialog-hospitals');
    await dialog('#build-version', 'dialog-system-status');
    await page.evaluate(() => document.querySelector('[data-foundation-action="heli-status"]')?.click()); await shot('heli-status');
    await page.locator('#modal-body button:has-text("Edit")').first().click(); await shot('heli-status-edit');
    await page.evaluate(() => document.getElementById('modal-close')?.click()); await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelector('[data-foundation-action="map-type"]')?.click()); await shot('map-type-menu');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { const b = [...document.querySelectorAll('button,a')].find(x => /Clinical Guidance/i.test(x.textContent)); if (b) b.click(); });
    await shot('tasking-clinical-guidance');
    await page.evaluate(() => document.getElementById('modal-close')?.click()); await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('board-view')?.click()); await shot('board-desk');
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /^wall$/i.test(x.textContent.trim())); if (b) b.click(); });
    await page.waitForTimeout(600); await shot('board-wall');
    await context.close();
  }
  if (mode === 'baseline') console.log(`Baseline saved: ${fs.readdirSync(OUT).length} screenshots of ${APP_NAME}\n  ${OUT}`);
  if (mode === 'compare') await compare();
} finally {
  await browser.close();
  server.close();
}
process.exit(process.exitCode || 0);

/* Pixel comparison, done in the same Chromium (no extra dependencies). A few
   anti-aliased pixels at rounded corners can differ between two runs of the
   same file, so up to NOISE changed pixels is reported as noise; genuine
   changes have been well over 100 pixels. */
async function compare() {
  const NOISE = 40;
  const base = path.join(ROOT, 'baseline');
  if (!fs.existsSync(base)) { console.log('No baseline yet -- run: node tools/visual-check.mjs baseline'); process.exitCode = 2; return; }
  const shots = fs.readdirSync(OUT).filter(f => f.endsWith('.png')).sort();
  const page = await (await browser.newContext()).newPage();
  let changed = 0, noisy = 0;
  for (const f of shots) {
    const b = path.join(base, f);
    if (!fs.existsSync(b)) { console.log(`  NEW      ${f}`); changed++; continue; }
    const diff = await page.evaluate(async ([x, y]) => {
      const load = src => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
      const [A, B] = await Promise.all([load(x), load(y)]);
      if (A.width !== B.width || A.height !== B.height) return -1;
      const read = img => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
      const p = read(A), q = read(B); let n = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (Math.abs(p[i] - q[i]) > 24 || Math.abs(p[i + 1] - q[i + 1]) > 24 || Math.abs(p[i + 2] - q[i + 2]) > 24) n++;
      }
      return n;
    }, ['data:image/png;base64,' + fs.readFileSync(b).toString('base64'), 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, f)).toString('base64')]);
    if (diff < 0) { console.log(`  SIZE     ${f}`); changed++; }
    else if (diff > NOISE) { console.log(`  CHANGED  ${f}  (${diff} px)`); changed++; }
    else if (diff > 0) noisy++;
  }
  console.log(changed
    ? `\n${changed} of ${shots.length} screens changed. Compare the images in:\n  ${base}\n  ${OUT}`
    : `\nAll ${shots.length} screens match the baseline (${APP_NAME})` + (noisy ? `; ${noisy} had <=${NOISE}px anti-aliasing noise.` : '.'));
  if (changed) process.exitCode = 1;
}

#!/usr/bin/env node
/**
 * Real-browser regression check.
 *
 * This complements check.mjs and verify.mjs. It uses Chromium to exercise the
 * rendered application shell at desktop, iPad-sized and Citrix-profile
 * viewports, opens a real dialog, checks for horizontal overflow and runs Axe
 * against serious and critical accessibility findings.
 *
 * Live providers are intentionally blocked. Their availability is monitored
 * by AirDesk at runtime and should not make the deterministic UI regression
 * suite depend on API quotas or third-party uptime.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { APP_FILE, APP_NAME, guidanceMeta, ok, fail, section, summary } from './lib.mjs';

const ROOT = process.cwd();
const HOST = '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function safePath(url) {
  const pathname = new URL(url, `http://${HOST}`).pathname;
  if (pathname === '/' || pathname === '/index.html') return APP_FILE;
  const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
  if (relative.startsWith('..')) return null;
  return join(ROOT, relative);
}

const server = createServer(async (req, res) => {
  const path = safePath(req.url || '/');
  if (!path) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, HOST, resolve);
});

const address = server.address();
const origin = `http://${HOST}:${address.port}`;
/* With every provider blocked the map cannot load, and the app correctly
   raises its "Map unavailable" alert over the header. Wait until the map has
   finished trying (#shared-map leaves "loading"), then dismiss the alert the
   way an operator would -- checking any earlier races the alert. */
async function settleMap(page) {
  await page.waitForFunction(() => document.getElementById('shared-map')?.dataset.mapStatus !== 'loading',
    null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  if (await page.locator('#error-banner').isVisible()) await page.locator('#error-dismiss').click();
}

const profiles = [
  { name: 'phone', viewport: { width: 390, height: 844 }, mode: 'standard', hasTouch: true },
  { name: 'desktop', viewport: { width: 1440, height: 900 }, mode: 'standard' },
  { name: 'Citrix', viewport: { width: 1366, height: 768 }, mode: 'citrix' },
  {
    name: 'iPad-sized',
    viewport: { width: 1024, height: 1366 },
    mode: 'standard',
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
  },
];

section(`Browser verification - ${APP_NAME}`);

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    /* Optional: point at an already-installed Chromium when the bundled
       Playwright build cannot be downloaded (AIRDESK_CHROMIUM=/path/chrome). */
    executablePath: process.env.AIRDESK_CHROMIUM || undefined,
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'],
  });
} catch (error) {
  fail('Chromium launches', String(error?.message || error));
  console.log('        Install it with: npx playwright install chromium');
  server.close();
  process.exit(summary() || 1);
}

try {
  for (const profile of profiles) {
    const context = await browser.newContext({
      viewport: profile.viewport,
      hasTouch: Boolean(profile.hasTouch),
      userAgent: profile.userAgent,
      reducedMotion: profile.mode === 'citrix' ? 'reduce' : 'no-preference',
    });
    await context.addInitScript(({ mode }) => {
      localStorage.setItem('airdesk_map_performance_v1', mode);
      localStorage.setItem('airdesk_citrix_prompt_v1', mode);
    }, { mode: profile.mode });
    await context.route('**/*', route => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin === origin) route.continue();
      else route.abort('blockedbyclient');
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error?.message || error)));
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.AirDesk?.system?.configStatus?.valid === true, null, { timeout: 30000 });

    const state = await page.evaluate(expectedMode => {
      const rect = selector => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { width: box.width, height: box.height };
      };
      return {
        chip: document.getElementById('build-version')?.textContent?.trim() || '',
        mode: document.documentElement.dataset.airdeskPerformance || '',
        expectedMode,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        header: rect('.header'),
        tabs: rect('.tabs[role="tablist"]'),
        workspace: rect('#workspace'),
        backdropHidden: document.getElementById('modal')?.hidden,
      };
    }, profile.mode);

    /* the chip must match the version in the filename -- read it, never
       hard-code it, or every release bump fails this line */
    const expectedChip = 'v' + (String(APP_FILE).match(/AirDesk-v([\d.]+)\.html/) || [])[1];
    ok(state.chip === expectedChip, `${profile.name}: version chip is ${expectedChip}`, `found ${state.chip || 'nothing'}`);
    ok(state.mode === state.expectedMode, `${profile.name}: ${profile.mode} profile applied`, `found ${state.mode || 'nothing'}`);
    ok(Boolean(state.header?.height && state.tabs?.height && state.workspace?.height), `${profile.name}: shell has rendered dimensions`);
    ok(state.overflow <= 2, `${profile.name}: no page-level horizontal overflow`, `${state.overflow}px overflow`);
    ok(state.backdropHidden === true, `${profile.name}: no dialog covers the viewport at rest`);
    ok(pageErrors.length === 0, `${profile.name}: no uncaught browser errors`, pageErrors.slice(0, 3).join(' | '));

    await settleMap(page);
    /* The compact phone header (650px and narrower) deliberately hides the
       version chip and Board View; the phone reaches build identity through
       Desk Status. Assert that design, then drive the controls directly so
       the dialog and board checks below still run at phone size. */
    const compactHeader = profile.viewport.width <= 650;
    const chipVisible = await page.locator('#build-version').isVisible();
    const boardVisible = await page.locator('#board-view').isVisible();
    ok(chipVisible === !compactHeader && boardVisible === !compactHeader,
      `${profile.name}: header shows the ${compactHeader ? 'compact phone' : 'full'} action set`,
      `version chip ${chipVisible ? 'visible' : 'hidden'}, Board View ${boardVisible ? 'visible' : 'hidden'}`);
    if (profile.viewport.width <= 980) {
      const edges = await page.evaluate(() => {
        const box = (e) => e && e.getBoundingClientRect();
        const card = box(document.querySelector('#screen-primary .card')), map = box(document.getElementById('shared-map'));
        return card && map ? [card.left, card.right, map.left, map.right].map(Math.round) : null;
      });
      ok(Boolean(edges) && edges[0] === edges[2] && edges[1] === edges[3],
        `${profile.name}: map card lines up with the form cards`, JSON.stringify(edges));
    }
    const press = (selector) => compactHeader
      ? page.locator(selector).dispatchEvent('click')
      : page.locator(selector).click();
    await press('#build-version');
    await page.locator('#modal:not([hidden])').waitFor({ state: 'visible', timeout: 5000 });
    ok(await page.locator('#modal-dialog[role="dialog"]').isVisible(), `${profile.name}: System Status dialog opens`);
    ok((await page.locator('#modal-title').textContent())?.trim() === 'System Status', `${profile.name}: dialog has the correct accessible title`);

    await page.locator('[data-system-self-check]').click();
    const selfCheckCount = await page.locator('.system-self-check-item').count();
    ok(selfCheckCount === 7, `${profile.name}: deployment self-check returns all 7 results`, `found ${selfCheckCount}`);
    ok((await page.locator('#system-self-check-results').textContent())?.includes('No provider request was made.'),
      `${profile.name}: self-check confirms it made no provider request`);
    ok(await page.locator('.system-self-check-item.info').filter({ hasText: 'Local test environment' }).count() === 1,
      `${profile.name}: localhost is reported as local test information`);
    ok(await page.locator('.system-self-check-item.pass').filter({ hasText: 'Embedded datasets' }).count() === 1,
      `${profile.name}: embedded datasets use the canonical module registry`);

    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = axe.violations.filter(item => item.impact === 'serious' || item.impact === 'critical');
    ok(serious.length === 0, `${profile.name}: no serious or critical Axe findings`,
      serious.map(item => `${item.id} (${item.nodes.length})`).join(', '));

    await page.keyboard.press('Escape');
    await page.locator('#modal').waitFor({ state: 'hidden', timeout: 5000 });
    ok(await page.locator('#modal').isHidden(), `${profile.name}: Escape closes the dialog`);

    /* The guidance button lives in the Response Plan card, which stays
       collapsed until a scene is set -- trigger it the way verify.mjs does
       rather than waiting for a pointer-visible button that never appears. */
    await page.evaluate(() => document.getElementById('primary-tg-btn').click());
    await page.locator('#modal:not([hidden])').waitFor({ state: 'visible', timeout: 5000 });
    ok((await page.locator('#modal-title').textContent())?.trim() === 'Tasking & Clinical Guidance',
      `${profile.name}: Tasking & Clinical Guidance opens from inert template content`);
    ok(await page.locator('#modal-body .tg-section').count() >= 50,
      `${profile.name}: guidance content is populated`);
    const hero = await page.locator('#modal-body .tg-hero').textContent(), guidance = guidanceMeta();
    ok(Boolean(guidance.version) && hero?.includes(`Version ${guidance.version}`) && hero?.includes(guidance.documentDate),
      `${profile.name}: full-guideline source metadata is visible`);
    ok(await page.locator('#modal-body table[data-tg-keep-table="true"]').count() === 1 &&
      (await page.locator('#modal-body').textContent())?.includes('4.25.1 Secondary & Tertiary Maternity Facilities'),
      `${profile.name}: Clinical Conditions retains the 4.25.1 maternity table`);
    const tgBoundary = await page.evaluate(() => ({
      metabolic: document.querySelector('#modal-body [data-tg-section="4.18"]')?.textContent || '',
      sepsis: document.querySelector('#modal-body [data-tg-section="4.19"]')?.textContent || '',
      vascular: document.querySelector('#modal-body [data-tg-section="4.21"]')?.textContent || '',
      anaphylaxis: document.querySelector('#modal-body [data-tg-section="4.22"]')?.textContent || ''
    }));
    ok(tgBoundary.metabolic.includes('Severe Hyperkalaemia') && !tgBoundary.sepsis.includes('Hyperkalaemia'),
      `${profile.name}: Metabolic thresholds stay out of Sepsis`);
    ok(tgBoundary.vascular.includes('Undifferentiated profound shock') && !tgBoundary.anaphylaxis.includes('Undifferentiated profound shock'),
      `${profile.name}: Vascular thresholds stay out of Anaphylaxis`);
    await page.locator('#modal-body [data-tg-category-button="criteria"]').click();
    ok(await page.locator('#modal-body [data-tg-category="criteria"]:not([hidden]) [data-tg-section="3.0"]').count() === 1 &&
       await page.locator('#modal-body [data-tg-category="criteria"]:not([hidden]) [data-tg-section="4.29"]').count() === 1,
      `${profile.name}: ANTS Criteria & Specific Skills renders sections 3.0 and 4.29`);
    await page.locator('#modal-body [data-tg-category-button="areas"]').click();
    ok(await page.locator('#modal-body [data-tg-category="areas"]:not([hidden]) [data-tg-section="5.3"]').count() === 1 &&
       await page.locator('#modal-body [data-tg-category="areas"]:not([hidden]) [data-tg-section="5.10"]').count() === 1 &&
       await page.locator('#modal-body [data-tg-category="areas"]:not([hidden]) [data-tg-section="5.14"]').count() === 1,
      `${profile.name}: Area Specific Considerations renders Coromandel, Fiordland and Ski-field sections`);
    await page.locator('#modal-body [data-tg-category-button="tasking"]').click();
    ok(await page.locator('#modal-body [data-tg-category="tasking"]:not([hidden]) [data-tg-section="11.0"]').count() === 1 &&
       await page.locator('#modal-body [data-tg-category="tasking"]:not([hidden]) [data-tg-section="6.1"]').count() === 1 &&
       await page.locator('#modal-body [data-tg-category="tasking"]:not([hidden]) [data-tg-section="17.9.1"]').count() === 1,
      `${profile.name}: Tasking, Landing & Destinations renders sections 6.1, 11.0 and 17.9.1`);
    await page.locator('#modal-body [data-tg-category-button="escalation"]').click();
    ok(await page.locator('#modal-body [data-tg-category="escalation"]:not([hidden]) [data-tg-section="14.0"]').count() === 1 &&
       await page.locator('#modal-body [data-tg-category="escalation"]:not([hidden]) [data-tg-section="19.1"]').count() === 1,
      `${profile.name}: Escalation, Coordination & Major Incidents renders sections 14.0 and 19.1`);
    await page.locator('#modal-body [data-tg-category-button="agencies"]').click();
    ok(await page.locator('#modal-body [data-tg-category="agencies"]:not([hidden]) [data-tg-section="8.0"]').count() === 1 &&
       await page.locator('#modal-body [data-tg-category="agencies"]:not([hidden]) [data-tg-section="12.0"]').count() === 1 &&
       await page.locator('#modal-body [data-tg-category="agencies"]:not([hidden]) [data-tg-section="21.0"]').count() === 1,
      `${profile.name}: Other Agencies & RCCNZ Advice renders sections 8.0, 12.0 and 21.0`);
    await page.locator('#modal-body [data-tg-category-button="definitions"]').click();
    ok(await page.locator('#modal-body [data-tg-category="definitions"]:not([hidden]) [data-tg-section="2.0"]').count() === 1,
      `${profile.name}: Principles & Definitions category renders section 2.0`);
    ok(await page.locator('#modal-body [data-tg-section="3.1.2"]').count() === 1 &&
       (await page.locator('#modal-body [data-tg-section="3.1.2"]').innerText()).includes('MARINECOM'),
      `${profile.name}: ANTS 3.1.2 Marine Incidents renders as its own navigable section`);

    await page.locator('#modal-body [data-tg-search]').fill('cardioversion');
    ok(await page.locator('#modal-body [data-tg-section="4.29"]:not([hidden])').count() === 1,
      `${profile.name}: global search surfaces Specific Skills across categories`);
    const guidanceOverflow = await page.evaluate(() => {
      const shell = document.querySelector('#modal-body .tg-shell');
      const content = document.querySelector('#modal-body .tg-content');
      return {
        shell: shell ? shell.scrollWidth - shell.clientWidth : 999,
        content: content ? content.scrollWidth - content.clientWidth : 999
      };
    });
    ok(guidanceOverflow.shell <= 2 && guidanceOverflow.content <= 2,
      `${profile.name}: guidance dialog has no horizontal overflow`, JSON.stringify(guidanceOverflow));
    /* close with the dialog's own button: after a scripted open, focus is not
       inside the dialog, so Escape is not guaranteed to reach it */
    await page.locator('#modal-body [data-tg-close]').click();
    await page.locator('#modal').waitFor({ state: 'hidden', timeout: 5000 });

    /* Capability boards. A legacy record (Wet/Dry/No Winch + Blood) is loaded so the
       conversion is exercised, then both boards are checked for the agreed
       columns and for no clipped Winch cell. */
    await page.evaluate(() => {
      const slot = (callsign, tail, caps) => ({ callsign, tail, caps, notes: '', oos: false, oosReason: '' });
      localStorage.setItem('airdesk_heli_status_board_v1', JSON.stringify({ rosterOnly: true, slots: {
        'NRES-WRE': [slot('NRES6', 'ZK-HQC', ['IFR', 'Wet Winch']), slot('NRES1', 'ZK-HLH', ['IFR', 'Wet Winch'])],
        'NRES-AKL': [slot('NRES2', 'ZK-IZB', ['IFR', 'Wet Winch', 'Blood']), slot('NRES5', 'ZK-IHB', ['IFR', 'No Winch'])],
        'A1MANA': [slot('A1MANA', 'ZK-IRU', ['VFR', 'Dry Winch'])],
      } }));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.AirDesk?.system?.configStatus?.valid === true, null, { timeout: 30000 });
    await settleMap(page);
    await page.evaluate(() => document.querySelector('[data-foundation-action="heli-status"]').click());
    await page.locator('#modal:not([hidden])').waitFor({ state: 'visible', timeout: 5000 });
    const hsb = await page.evaluate(() => {
      const body = document.getElementById('modal-body');
      const row = body.querySelector('tr[data-base="NRES-AKL"][data-idx="0"]');
      const nres5 = body.querySelector('tr[data-base="NRES-AKL"][data-idx="1"]');
      return {
        heads: [...body.querySelectorAll('table.airdesk-hsb-table th')].map(th => th.textContent.trim()).join('|'),
        blood: body.textContent.includes('Blood'),
        nres2: row ? [...row.querySelectorAll('.ad-slot.on')].map(s => s.title).join('|') : '',
        nres2NoWinch: row ? row.querySelectorAll('.ad-winch-none').length : -1,
        nres5: nres5 ? nres5.querySelectorAll('.ad-slot.on').length : -1,
        nres5NoWinch: nres5 ? nres5.querySelectorAll('.ad-winch-none').length : -1,
        liveInactive: body.querySelectorAll('td.hsb-td-winch .ad-slot.off').length,
        clipped: [...body.querySelectorAll('td.hsb-td-winch')].some(td => td.scrollWidth > td.clientWidth + 1),
      };
    });
    ok(hsb.heads === 'Status|Base|Role|Callsign|Tail|Type|Flt|Winch', `${profile.name}: status board has Flt and Winch columns only`, hsb.heads);
    ok(!hsb.blood, `${profile.name}: Blood no longer appears on the status board`);
    ok(hsb.nres2 === 'Day land: available|Day wets: available', `${profile.name}: Wet Winch converts to Land and Wets by day`, hsb.nres2);
    ok(hsb.nres2NoWinch === 1, `${profile.name}: absent night winch is labelled explicitly`, String(hsb.nres2NoWinch));
    ok(hsb.nres5 === 0 && hsb.nres5NoWinch === 2, `${profile.name}: no winch is shown separately for Day and Night`, JSON.stringify({ active: hsb.nres5, noWinch: hsb.nres5NoWinch }));
    ok(hsb.liveInactive === 0, `${profile.name}: live Winch hides inactive dashed capability slots`, String(hsb.liveInactive));
    ok(!hsb.clipped, `${profile.name}: status board Winch cells are not clipped`);

    /* v5.33 edit-stability regression. Native iPad controls used to be
       detached because every selection rebuilt the full table. Keep object
       references and prove routine edits plus a background refresh preserve
       the same connected nodes. */
    await page.locator('#modal-body [data-hsb-edit="start"]').click();
    const stableSeed = await page.evaluate(() => {
      const row = document.querySelector('#modal-body tr[data-base="NRES-AKL"][data-idx="0"]');
      const winch = row?.querySelector('[data-winch-cap="Decks Day"]');
      const flt = row?.querySelector('select[data-field="flt"]');
      window.__airdeskHsbStableRefs = { winch, flt };
      return { winch: Boolean(winch), flt: Boolean(flt), winchPressed: winch?.getAttribute('aria-pressed') };
    });
    ok(stableSeed.winch && stableSeed.flt, `${profile.name}: Heli Status edit controls are present`);
    await page.locator('#modal-body tr[data-base="NRES-AKL"][data-idx="0"] [data-winch-cap="Decks Day"]').click();
    const winchStable = await page.evaluate(() => {
      const current = document.querySelector('#modal-body tr[data-base="NRES-AKL"][data-idx="0"] [data-winch-cap="Decks Day"]');
      return { same: current === window.__airdeskHsbStableRefs?.winch, connected: Boolean(current?.isConnected), pressed: current?.getAttribute('aria-pressed') };
    });
    ok(winchStable.same && winchStable.connected && winchStable.pressed === 'true',
      `${profile.name}: winch tap updates in place without replacing its button`, JSON.stringify(winchStable));
    await page.locator('#modal-body tr[data-base="NRES-AKL"][data-idx="0"] select[data-field="flt"]').selectOption('VFR');
    const fltStable = await page.evaluate(() => {
      const current = document.querySelector('#modal-body tr[data-base="NRES-AKL"][data-idx="0"] select[data-field="flt"]');
      return { same: current === window.__airdeskHsbStableRefs?.flt, connected: Boolean(current?.isConnected), value: current?.value };
    });
    ok(fltStable.same && fltStable.connected && fltStable.value === 'VFR',
      `${profile.name}: flight-rule selection updates in place without replacing its select`, JSON.stringify(fltStable));
    await page.evaluate(() => AirDesk.internal.heliStatusParts.ui.render(false));
    const refreshStable = await page.evaluate(() => {
      const row = document.querySelector('#modal-body tr[data-base="NRES-AKL"][data-idx="0"]');
      return {
        winch: row?.querySelector('[data-winch-cap="Decks Day"]') === window.__airdeskHsbStableRefs?.winch,
        flt: row?.querySelector('select[data-field="flt"]') === window.__airdeskHsbStableRefs?.flt
      };
    });
    ok(refreshStable.winch && refreshStable.flt, `${profile.name}: Edit-mode background refresh keeps controls mounted`, JSON.stringify(refreshStable));

    /* Persistent additional aircraft. Extra rows must use the
       same Heli Status state and identity lookup as configured rows so map
       callsign ownership, Board View and shared persistence all see them. */
    const addWaikato = page.locator('#modal-body [data-hsb-add="A1WAIK"]');
    await addWaikato.click();
    const extra = page.locator('#modal-body tr[data-base="A1WAIK"][data-idx="1"]');
    ok(await extra.count() === 1, `${profile.name}: additional aircraft row can be added to a base`);
    await extra.locator('[data-field="callsign"]').fill('A2WAIK');
    await extra.locator('[data-field="callsign"]').press('Tab');
    /* An added aircraft stays visible in the live table before a tail is
       entered; only empty configured slots are hidden. */
    await page.locator('#modal-body [data-hsb-edit="done"]').click();
    const liveExtraBeforeTail = page.locator('#modal-body tr[data-base="A1WAIK"][data-idx="1"]');
    ok(await liveExtraBeforeTail.count() === 1 && await liveExtraBeforeTail.isVisible(),
      `${profile.name}: additional aircraft stays visible in live view before tail entry`);
    ok((await liveExtraBeforeTail.innerText()).includes('A2WAIK') && (await liveExtraBeforeTail.innerText()).includes('Additional'),
      `${profile.name}: additional live row keeps its own callsign and role before tail entry`);
    await page.locator('#modal-body [data-hsb-edit="start"]').click();
    const extraAgain = page.locator('#modal-body tr[data-base="A1WAIK"][data-idx="1"]');
    await extraAgain.locator('[data-field="tail"]').fill('ZK-XYZ');
    await extraAgain.locator('[data-field="tail"]').press('Tab');
    await extraAgain.locator('[data-field="aircraftType"]').fill('H145');
    await extraAgain.locator('[data-field="aircraftType"]').press('Tab');
    const extraIdentity = await page.evaluate(() => {
      const hit = AirDesk.fleet.heliStatus.lookupByTailExact('ZK-XYZ');
      const row = AirDesk.fleet.heliStatus.rows().find(r => r.tail === 'ZK-XYZ');
      const saved = JSON.parse(localStorage.getItem('airdesk_heli_status_board_v1') || '{}');
      const slot = saved?.slots?.A1WAIK?.[1];
      return { hit, row, mapCallsign: AirDesk.fleet.tracPlus.callsignForAircraft({regn:'ZK-XYZ',name:'ZK-XYZ'}), saved: slot ? { additional: slot.additional, id: slot.id, aircraftType: slot.aircraftType, callsign: slot.callsign, tail: slot.tail } : null };
    });
    ok(extraIdentity.saved?.tail === 'ZK-XYZ',
      `${profile.name}: tail normalisation is idempotent across edit and persistence`, JSON.stringify(extraIdentity.saved));
    ok(extraIdentity.hit?.callsign === 'A2WAIK' && extraIdentity.hit?.aircraftType === 'H145' && extraIdentity.mapCallsign === 'A2WAIK',
      `${profile.name}: additional aircraft owns its map callsign/tail identity`, JSON.stringify(extraIdentity.hit));
    ok(extraIdentity.row?.role === 'A' && extraIdentity.row?.aircraftType === 'H145',
      `${profile.name}: additional aircraft projects into Board View with type`, JSON.stringify(extraIdentity.row));
    ok(extraIdentity.saved?.additional === true && Boolean(extraIdentity.saved?.id),
      `${profile.name}: additional aircraft persists with a stable id`, JSON.stringify(extraIdentity.saved));

    await page.locator('#modal-close').click();
    await page.locator('#modal').waitFor({ state: 'hidden', timeout: 5000 });
    await press('#board-view');
    await page.locator('.board-fleet table').waitFor({ state: 'visible', timeout: 5000 });
    const board = await page.evaluate(() => ({
      heads: [...document.querySelectorAll('.board-fleet th')].map(th => th.textContent.trim()).join('|'),
      clipped: [...document.querySelectorAll('.board-fleet td.b-winch')].some(td => td.scrollWidth > td.clientWidth + 1),
    }));
    ok(board.heads === 'Status|Base|Aircraft|Flt|Winch', `${profile.name}: wall board has Flt and Winch, no Airborne`, board.heads);
    ok(!board.clipped, `${profile.name}: wall board Winch cells are not clipped`);

    await context.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

process.exit(summary());

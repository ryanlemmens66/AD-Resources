#!/usr/bin/env node
/**
 * Static audit — parses the HTML file without a browser.
 *
 * Catches the things you can prove by reading the file: syntax errors, broken
 * markup, duplicate ids, dead code, debug leftovers, and the deployment
 * couplings that are easy to break on a version bump. Runs in about a second
 * and needs no dependencies, so it is the cheap check to run on every edit.
 *
 *   node tools/check.mjs
 *
 * Exit code 0 = clean, 1 = at least one check failed. Checks printed OPEN are
 * non-blocking review items, not defects, and do not affect the exit code.
 */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { APP_FILE, APP_NAME, REPO_DIR, datasetSource, guidanceMeta, ok, note, fail, section, summary, netlifyToml } from './lib.mjs';
import { PROTECTED_DATASETS, countAndIds } from './dataset-baseline.mjs';

const src = readFileSync(APP_FILE, 'utf8');
const toml = netlifyToml();

// Embedded base64 (fonts, icons, imagery) would swamp every regex below.
// Replace each payload with a marker.
const lean = src.replace(/(data:[a-zA-Z0-9/.+-]+;base64,)[A-Za-z0-9+/=]{200,}/g, '$1X');

// MapLibre GL JS ships minified inside the file. It is vendor code, not ours,
// and it contains console.log calls and minifier artefacts that would fail the
// hygiene checks below for no useful reason. Locate it once and exclude it.
const vendorRe = /<script[^>]*id="maplibre-gl-[^"]*"[^>]*>([\s\S]*?)<\/script>/;
const vendorMatch = vendorRe.exec(src);
const vendorBody = vendorMatch ? vendorMatch[1] : '';
const ours = vendorBody ? src.replace(vendorBody, '/* vendor: maplibre */') : src;
const oursLean = vendorBody ? lean.replace(vendorBody, '/* vendor: maplibre */') : lean;

section(`Static audit — ${APP_NAME}`);

/* ---------------------------------------------------------------- syntax -- */
// Every inline <script> is checked with `node --check`, and every embedded
// dataset block must be valid JSON. A syntax error kills that whole block
// silently in the browser, which loses a module or a map layer with no error.
const scripts = [...src.matchAll(/<script(?![^>]*src=)(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)];
const dataBlocks = [...src.matchAll(/<script type="application\/json" id="(airdesk-data-[^"]+)">([\s\S]*?)<\/script>/g)];
const badData = dataBlocks.filter(m => { try { JSON.parse(m[2]); return false; } catch { return true; } }).map(m => m[1]);
ok(dataBlocks.length > 0 && !badData.length, `${dataBlocks.length} embedded dataset blocks are valid JSON`, `invalid: ${badData.join(', ')}`);
const loaderIds = [...src.matchAll(/AirDesk\.util\.dataset\('([^']+)'\)/g)].map(m => m[1]);
const blockIds = dataBlocks.map(m => m[1].slice('airdesk-data-'.length));
ok(loaderIds.length === blockIds.length && loaderIds.every(id => blockIds.includes(id)),
  'every dataset a module loads has exactly one data block, and every block is used',
  `loaded=${loaderIds.join(', ')}\nblocks=${blockIds.join(', ')}`);
const tmp = mkdtempSync(join(tmpdir(), 'airdesk-audit-'));
let syntaxFailures = 0;
scripts.forEach((m, i) => {
  const f = join(tmp, `b${i}.js`);
  writeFileSync(f, m[1]);
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    syntaxFailures++;
    const line = src.slice(0, m.index).split('\n').length;
    const id = /id="([^"]+)"/.exec(m[0].slice(0, 200))?.[1] || '(no id)';
    fail(`script block ${i} "${id}" (file line ${line}) has a syntax error`,
      String(e.stderr || e).split('\n').slice(0, 4).join('\n'));
  }
});
rmSync(tmp, { recursive: true, force: true });
ok(syntaxFailures === 0, `${scripts.length} inline script blocks parse`);

/* --------------------------------------------------------- comment pairs -- */
// An HTML comment opened with <!-- and closed with */ instead of --> does not
// raise an error anywhere. The browser keeps consuming markup as inert comment
// text until the next real --> — which has previously swallowed an entire CSS
// block and a whole script, silently, with a clean syntax check. Counting the
// delimiters is the cheapest way to catch it.
const opens = (lean.match(/<!--/g) || []).length;
const closes = (lean.match(/-->/g) || []).length;
ok(opens === closes, `${opens} HTML comment pairs balance`,
  `${opens} "<!--" vs ${closes} "-->" — an unclosed comment swallows everything up to the next "-->"`);

/* ------------------------------------------------------------ html shape -- */
// Tag balance and duplicate ids. Scripts/styles are blanked first so their
// contents (which contain plenty of angle brackets) do not confuse the scan.
const markup = lean
  // Blank executable/style bodies, but preserve the opening tag and its id.
  // Script/style elements are still DOM elements, so their ids belong in the
  // duplicate-id audit even though their contents must not be parsed as HTML.
  .replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/g, '$1</script>')
  .replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/g, '$1</style>');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr', 'path', 'circle', 'line', 'polyline',
  'polygon', 'rect', 'stop', 'use', 'ellipse']);

const stack = [];
const structural = [];
const idCounts = new Map();
const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
for (const m of markup.matchAll(tagRe)) {
  const [, closing, rawTag, attrs] = m;
  const tag = rawTag.toLowerCase();
  // IDs on void/self-closing elements are just as significant as IDs on
  // container elements. Count every opening tag before the structural early
  // return so inputs, images, links, etc. are covered by the duplicate-ID
  // regression check as well.
  if (!closing) {
    const id = /\bid\s*=\s*"([^"]+)"/.exec(attrs);
    if (id) idCounts.set(id[1], (idCounts.get(id[1]) || 0) + 1);
  }
  if (VOID.has(tag) || /\/\s*$/.test(attrs)) continue;
  if (closing) {
    if (!stack.length) { structural.push(`stray </${tag}>`); continue; }
    if (stack[stack.length - 1] === tag) stack.pop();
    else {
      const at = stack.lastIndexOf(tag);
      if (at === -1) structural.push(`stray </${tag}>`);
      else { structural.push(`unclosed <${stack[stack.length - 1]}>`); stack.length = at; }
    }
  } else {
    stack.push(tag);
  }
}
ok(structural.length === 0, 'HTML tags balance', structural.slice(0, 5).join(', '));
const dupIds = [...idCounts].filter(([, n]) => n > 1);
ok(dupIds.length === 0, `${idCounts.size} element ids, none duplicated`,
  dupIds.map(([k, n]) => `${k} x${n}`).join(', '));

/* ------------------------------------------------------------- dead code -- */
// Comments are stripped first, otherwise a function merely *mentioned* in a
// comment looks referenced. Vendor code is excluded — its minified internals
// are not ours to police.
const code = ours.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const declared = new Set([...code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
// Named IIFEs — `(function bindSkillPills(){...})()` — are self-executing and
// self-referential by design. This codebase uses them heavily to scope a
// binding step inside boot(); they are not dead.
const iifes = new Set([...code.matchAll(/\(\s*function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
const unreferenced = [...declared].filter(n => {
  if (iifes.has(n)) return false;
  const hits = code.match(new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'));
  return (hits ? hits.length : 0) <= 1;
}).sort();
ok(unreferenced.length === 0, `${declared.size} named functions, none unreferenced`,
  unreferenced.join(', '));

/* ------------------------------------------- Heli Status model invariants -- */
{
  const modelBody = /<script[^>]*id="airdesk-heli-status-model"[^>]*>([\s\S]*?)<\/script>/.exec(src)?.[1] || '';
  const context = { AirDesk: { internal: {} } };
  try {
    runInNewContext(modelBody, context, { timeout: 1000 });
    const formatTail = context.AirDesk.internal.heliStatusModel?.formatTail;
    const cases = ['XYZ', 'ZKXYZ', 'ZK-XYZ', 'ZK-ZK-XYZ'].map(v => [v, formatTail?.(v)]);
    ok(cases.every(([, got]) => got === 'ZK-XYZ') && formatTail?.('ZK-') === 'ZK-',
      'Heli Status tail formatter is idempotent and canonical',
      cases.map(([input, got]) => `${input} -> ${got}`).join(', '));
  } catch (error) {
    fail('Heli Status model can execute in isolation', error && error.stack || String(error));
  }
}

/* ------------------------------------------------ Heli Status stability -- */
// Routine editor interactions must not rebuild the table. Replacing a native
// select/button during its own touch/change event made the iPad editor jumpy
// and intermittently ignored winch taps. Structural actions may still redraw.
{
  const hsb = /<script[^>]*id="airdesk-heli-status"[^>]*>([\s\S]*?)<\/script>/.exec(src)?.[1] || '';
  ok(/if\s*\(!force\s*&&\s*editing\)\s*\{\s*refreshEditorProjection\(\);\s*return;\s*\}/.test(hsb),
    'Heli Status background refresh is non-structural in Edit mode',
    'render(false) can replace native edit controls while the operator is using them');
  ok(/slot\.caps=normalizeCaps\(caps\);\s*save\(\);\s*updateWinchControl\(baseId,idx,cap\)/.test(hsb),
    'Heli Status winch taps update their existing button in place',
    'winch edits must not call render(true)');
  const routineRedraw = /field==='(?:callsign|tail|oosReason|flt)'[\s\S]{0,900}?save\(\);\s*render\(true\)/.test(hsb);
  ok(!routineRedraw && /boardCoreEqual\(value,state\)/.test(hsb),
    'Heli Status routine selections and matching sync echoes do not redraw the editor',
    'routine selection branch or Firebase echo can still rebuild the table');
  ok(/MAX_ADDITIONAL_PER_BASE=MODEL\.MAX_ADDITIONAL_PER_BASE\|\|3/.test(hsb) && /function addAdditionalAircraft\(/.test(hsb) && /function deleteAdditionalAircraft\(/.test(hsb),
    'Heli Status owns persistent additional-aircraft rows in its primary model',
    'additional aircraft must not be implemented as a separate overlay or temporary UI row');
  ok(/base\.maxSlots\+MAX_ADDITIONAL_PER_BASE/.test(hsb) && /additional:\s*!!additional/.test(hsb),
    'Heli Status sync and normalization preserve additional rows beyond configured slots',
    'Firebase field registration or normalization can truncate additional aircraft');
  ok(/aircraftType:String\(slot\.aircraftType/.test(hsb) && /lookupByTailExact/.test(hsb),
    'Heli Status identity records carry aircraft type alongside callsign and tail',
    'aircraft type or map identity integration is missing');
  ok(/if\(!editing && !hasRealTail\(slot\.tail\) && !isAdditionalSlot\(b,slot,i\)\) continue;/.test(hsb),
    'Heli Status live view preserves additional rows before a tail is entered',
    'live rendering can still hide persistent additional aircraft when their tail is blank');
  ok(/!isAdditionalSlot\(baseDef,slot,idx\)\s*&&\s*defaultCallsignFor\(baseDef\)/.test(hsb),
    'Additional rows do not inherit a configured base callsign fallback',
    'blank additional callsigns can be displayed as a misleading configured callsign');
  ok(/if\(!edit && !activeCount\)\s*\{[\s\S]{0,250}?ad-winch-none/.test(hsb) &&
      /return on\?'<span class=\"'\+cls/.test(hsb),
    'Heli Status live Winch shows active capabilities only and labels an empty period',
    'live Winch must hide inactive dashed slots and show No Winch separately for Day and Night');
}

/* --------------------------------------- maintained operational defaults -- */
// Defaults that are deliberately maintained in AirDesk.rules must not be
// copied into downstream fallback branches. A copied 10-minute turnout or
// 0.539957 conversion looks harmless until the approved default changes and
// only one workflow updates.
{
  const nearest = /<script[^>]*id="airdesk-primary-nearest-resources"[^>]*>([\s\S]*?)<\/script>/.exec(src)?.[1] || '';
  const response = /<script[^>]*id="airdesk-primary-response-calculations"[^>]*>([\s\S]*?)<\/script>/.exec(src)?.[1] || '';
  const transfer = /<script[^>]*id="airdesk-transfer"[^>]*>([\s\S]*?)<\/script>/.exec(src)?.[1] || '';
  const sar = /<script[^>]*id="airdesk-sar-scene"[^>]*>([\s\S]*?)<\/script>/.exec(src)?.[1] || '';
  const trac = /<script[^>]*id="airdesk-tracplus-live"[^>]*>([\s\S]*?)<\/script>/.exec(src)?.[1] || '';
  const rulesOwned =
    /DEFAULT_TAKEOFF_MIN=AirDesk\.rules\.aviation\.daytimeTakeoffMinutes/.test(nearest) &&
    /AIRBORNE_KNOTS=AirDesk\.rules\.aircraft\.airborneKnots/.test(nearest) &&
    /DEFAULT_TAKEOFF_MIN=RULES\.aviation\.daytimeTakeoffMinutes/.test(response) &&
    /DEFAULT_TAKEOFF_MIN=AirDesk\.rules\.aviation\.daytimeTakeoffMinutes/.test(transfer) &&
    /DEFAULT_TAKEOFF_MIN=AirDesk\.rules\.aviation\.daytimeTakeoffMinutes/.test(sar) &&
    /DEFAULT_TAKEOFF_MIN=RULES\.aviation\.daytimeTakeoffMinutes/.test(trac);
  ok(rulesOwned,
    'Primary, IHT, SAR and live-aircraft fallbacks read maintained AirDesk.rules defaults',
    'a downstream fallback no longer points at the central operational defaults');

  const kmLiteralCopies = (ours.match(/0\.539957/g) || []).length;
  ok(kmLiteralCopies === 1,
    'km-to-NM conversion literal exists only in AirDesk.rules',
    `found ${kmLiteralCopies} copies — downstream conversions can drift on a future rule update`);
}

/* --------------------------------------- driving-route reliability -- */
{
  const scene = /<script[^>]*id="airdesk-primary-scene"[^>]*>([\s\S]*?)<\/script>/.exec(src)?.[1] || '';
  const response = /<script[^>]*id="airdesk-primary-response-calculations"[^>]*>([\s\S]*?)<\/script>/.exec(src)?.[1] || '';
  ok(/const ROAD_ROUTE_COLOR='#008a8f'/.test(response) &&
      /'line-color':ROAD_ROUTE_COLOR/.test(response) &&
      /'line-color':'#ffffff','line-width':6/.test(response),
    'Driving route uses the approved teal line with a white halo',
    'scene-to-hospital route colour or halo no longer matches the production map role');
  ok(/if\(raw===lastAppliedQuery&&current\)[\s\S]{0,220}?refreshCurrentResponseRoute\(\)/.test(scene) &&
      /if\(same\)refreshCurrentResponseRoute\(\)/.test(scene) &&
      /responseCalculations\?\.renderCalculations\?\.\(\{\.\.\.current\}\)/.test(scene),
    'Unchanged address and coordinate searches can retry the response route without re-geocoding',
    'same-scene search no longer refreshes the scene-to-hospital route calculation');
  ok(/ROAD_ROUTE_DRAW_RETRY_MS=250,ROAD_ROUTE_DRAW_MAX_TRIES=80/.test(response) &&
      /if\(!m\|\|!m\.isStyleLoaded\(\)\)\{scheduleRoadRouteDraw\(\);return;\}/.test(response) &&
      /m\.on\('style\.load',\(\)=>\{ if\(lastEncodedRoute\) drawRoadRoute\(lastEncodedRoute\); \}\)/.test(response) &&
      /clearTimeout\(roadRouteDrawTimer\);roadRouteDrawTimer=0;roadRouteDrawTries=0;[\s\S]{0,80}?lastEncodedRoute=null/.test(response),
    'Fetched driving-route geometry survives map-style readiness transitions with bounded retry',
    'route redraw retry, style-load redraw or reset cleanup is missing');
}

/* ---------------------------------------------- handover update routes -- */
{
  const guidePath = join(REPO_DIR, 'ARCHITECTURE.md');
  const readme = existsSync(guidePath) ? readFileSync(guidePath, 'utf8') : '';
  ok(/### Map data update routes/.test(readme) && /tools\/data\.mjs import/.test(readme) && /`aerodromes-lzs`/.test(readme) && /#airdesk-clinical-pathway-layers/.test(readme),
    'ARCHITECTURE documents canonical map-data update routes',
    'mapping handover route is missing or incomplete');
  ok(/### Operational timing and default updates/.test(readme) && /AirDesk\.rules/.test(readme) && /helipadToEDMin/.test(readme),
    'ARCHITECTURE documents the single timing/default update route',
    'future timing changes could be applied to downstream formulas instead of their owning source');
}

/* --------------------------------------------------------------- hygiene -- */
const codeLines = oursLean.split('\n').filter(l => l.length < 600 && !/^\s*(\/\/|\*|<!--)/.test(l));
const countIn = re => codeLines.filter(l => re.test(l)).length;
ok(countIn(/\bconsole\.(log|debug)\s*\(/) === 0,
  'no console.log / console.debug in app code (vendor excluded)');
ok(countIn(/\bdebugger\b/) === 0, 'no debugger statements');
ok(countIn(/(?<![.\w])alert\s*\(/) === 0, 'no native alert() (the app has its own dialog)');

/* ------------------------------------------------------------ deployment -- */
// The app filename carries the version, so netlify.toml's root rewrite has to
// be bumped in step. Miss it and the site root is a 404 while the versioned
// path still works — so it looks fine to whoever just deployed it, and broken
// to everyone who uses the bookmark.
if (toml) {
  const rewrites = [...toml.matchAll(/to\s*=\s*"\/([^"]+\.html)"/g)].map(m => m[1]);
  const stale = [...new Set(rewrites)].filter(p => p !== APP_NAME);
  ok(rewrites.length > 0 && stale.length === 0,
    `netlify.toml rewrites point at ${APP_NAME}`,
    rewrites.length === 0
      ? 'no root rewrite found — the site root will 404'
      : `stale path(s): ${stale.join(', ')} — the site root will 404`);
} else {
  fail('netlify.toml present', 'not found — the site root rewrite and headers are missing');
}

if (toml) {
  /* Everything packaged except the app and the worker is maintainer material. */
  const privatePaths = readdirSync(REPO_DIR, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== APP_NAME && e.name !== 'sw.js')
    .map(e => e.isDirectory() ? `/${e.name}/*` : `/${e.name}`);
  const missingPrivate = privatePaths.filter(path => !toml.includes(`from = "${path}"`));
  ok(missingPrivate.length === 0,
    'Netlify blocks every packaged maintainer file from public delivery',
    `not blocked: ${missingPrivate.join(', ')}`);
}

/* ------------------------------------------ tasking guidance content safety -- */
// Tasking & Clinical Guidance is inert HTML, not an executable JavaScript
// string. The full approved guideline PDF is the maintenance source for this
// curated operational reference, so ordinary source punctuation can be
// updated without turning clinical or operational wording into executable code.
const tgTemplates = [...src.matchAll(/<template[^>]*id="airdesk-tasking-clinical-guidance-content"[^>]*>([\s\S]*?)<\/template>/g)];
const tgContent = tgTemplates[0]?.[1] || '';
ok(tgTemplates.length === 1, 'one inert Tasking & Clinical Guidance template is present',
  `found ${tgTemplates.length} templates`);
ok(tgContent.length > 90000, `Tasking & Clinical Guidance reference content present (${tgContent.length.toLocaleString()} chars)`,
  'the inert tasking guidance template is missing or unexpectedly short');
ok(/const TG_HTML\s*=\s*document\.getElementById\(TEMPLATE_ID\)\?\.innerHTML\.trim\(\)\s*\|\|\s*''/.test(src) &&
   /const TEMPLATE_ID=['"]airdesk-tasking-clinical-guidance-content['"]/.test(src),
  'guidance renderer reads the inert template',
  'TG_HTML is not sourced from airdesk-tasking-clinical-guidance-content');
ok(!/const TG_HTML\s*=\s*`/.test(src), 'tasking guidance is not executable template-literal content');
ok(!/airdesk-clinical-conditions-guidance-content|primary-ccg-btn/.test(src),
  'legacy standalone Clinical Conditions template and trigger are removed');

/* The approved Tasking & Operating Guidelines issue. This is the one place a new
   PDF is recorded for the checks: the template attributes must match it, and the
   System Status catalogue entry must name the same version and document date.
   `pages`/`sections` record the whole document's mapped coverage, independent of
   how categories group it (expectedTgCategoryMap covers the grouping). */
const APPROVED_GUIDANCE = Object.freeze({
  version: '2.01',
  documentDate: '15 May 2026',
  controlDate: '12/05/26',
  approvedDate: '15/05/2025',
  pages: '8-10;11-14;15-28;29-50;51-61;62-63;64;65-76;82-84;84-88;89-91;92-95;115-116;119-122;123-127;130-131',
  sections: '1.0-1.2;2.0-2.2;3.0-3.5;4.0-4.29;5.0-5.14;6.0-6.1;7.0-8.0;9.0-9.6;11.0-11.2;12.0-12.3;13.0-14.0;15.0-16.4;17.9-17.9.1;18.0-18.1;19.0-19.2;21.0',
  sha256: 'e46521c06de475024639dd5df7a501fdde18eaf48b70f50685c94f1298facda2'
});
const guidance = guidanceMeta();
const guidanceDiff = Object.keys(APPROVED_GUIDANCE).filter(key => guidance[key] !== APPROVED_GUIDANCE[key]);
ok(!guidanceDiff.length,
  `guidance template records the approved v${APPROVED_GUIDANCE.version} issue (dates, source map, PDF fingerprint)`,
  guidanceDiff.map(key => `${key}: template=${guidance[key] || '(missing)'}, approved=${APPROVED_GUIDANCE[key]}`).join('\n'));

const isoDate = text => { const d = new Date(`${text} UTC`); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); };
const taskingConfigEntry = /id: 'tasking-guidelines'[\s\S]{0,420}?versionLabel: '([^']+)'[\s\S]{0,180}?reviewedDate: '([^']*)'/.exec(ours);
ok(taskingConfigEntry?.[1]?.includes(APPROVED_GUIDANCE.version) && taskingConfigEntry?.[2] === isoDate(APPROVED_GUIDANCE.documentDate),
  `core document catalogue identifies Tasking Guidelines v${APPROVED_GUIDANCE.version}`,
  taskingConfigEntry ? `version=${taskingConfigEntry[1]}, reviewed=${taskingConfigEntry[2] || '(blank)'}, expected reviewed=${isoDate(APPROVED_GUIDANCE.documentDate)}` : 'tasking-guidelines config entry not found');


const tgCategories = [...tgContent.matchAll(/data-tg-category="([^"]+)"/g)].map(m => m[1]);
const expectedTgCategories = ['clinical','criteria','areas','tasking','escalation','agencies','definitions'];
ok(JSON.stringify(tgCategories) === JSON.stringify(expectedTgCategories),
  'guidance categories are complete and ordered', `found: ${tgCategories.join(', ')}`);
const tgCategoryMap = Object.fromEntries([...tgContent.matchAll(/<div[^>]*data-tg-category="([^"]+)"[^>]*data-source-sections="([^"]+)"[^>]*data-source-pages="([^"]+)"/g)].map(m => [m[1], `${m[2]}@${m[3]}`]));
const expectedTgCategoryMap = {clinical:'4.0-4.28@29-49',criteria:'3.0-3.5;4.29@15-28;50',areas:'5.0-5.14@51-61',tasking:'6.0-6.1;9.0-9.6;11.0-11.2;17.9-17.9.1@62-63;65-76;82-84;115-116',escalation:'13.0-14.0;15.0-16.4;18.0-18.1;19.0-19.2@89-91;92-95;119-122;123-127',agencies:'7.0-8.0;12.0-12.3;21.0@64;84-88;130-131',definitions:'1.0-1.2;2.0-2.2@8-10;11-14'};
ok(JSON.stringify(tgCategoryMap) === JSON.stringify(expectedTgCategoryMap),
  'each guidance category carries its source section and page map', JSON.stringify(tgCategoryMap));

const tgSections = [...tgContent.matchAll(/<section\b[^>]*data-tg-section="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)];
const sectionsIn = category => {
  const cat = new RegExp(`<div[^>]*data-tg-category="${category}"[^>]*>([\\s\\S]*?)(?=<div[^>]*data-tg-category=|<\\/div>\\s*<\\/div>\\s*$)`, 'i').exec(tgContent)?.[1] || '';
  return [...cat.matchAll(/<section\b[^>]*data-tg-section="([^"]+)"/g)].map(m => m[1]);
};
// Use explicit category windows because the clinical source intentionally has
// duplicate section number 4.14, matching the issued guideline.
const catStart = name => tgContent.indexOf(`data-tg-category="${name}"`);
const catSlice = (name, next) => tgContent.slice(catStart(name), next ? catStart(next) : tgContent.length);
const CATEGORY_ORDER = {clinical:'criteria',criteria:'areas',areas:'tasking',tasking:'escalation',escalation:'agencies',agencies:'definitions'};
const seq = name => [...catSlice(name, CATEGORY_ORDER[name]).matchAll(/<section\b[^>]*data-tg-section="([^"]+)"/g)].map(m=>m[1]);
const expectedClinical = [
  '4.0','4.1','4.2','4.3','4.4','4.5','4.6','4.7','4.8','4.9','4.10','4.11','4.12','4.13',
  '4.14','4.14','4.15','4.16','4.17','4.18','4.19','4.20','4.21','4.22','4.23','4.24','4.25','4.26','4.27','4.28'
];
ok(JSON.stringify(seq('clinical')) === JSON.stringify(expectedClinical),
  'Clinical Conditions sequence matches the issued sections 4.0 to 4.28',
  `found: ${seq('clinical').join(', ')}`);
ok(JSON.stringify(seq('criteria')) === JSON.stringify(['3.0','3.1','3.1.1','3.1.2','3.1.3','3.2','3.3','3.3.1','3.4','3.5','4.29']),
  'ANTS Criteria & Specific Skills covers sections 3.0 to 3.5 (incl. 3.1.1-3.1.3) then 4.29');
ok(JSON.stringify(seq('areas')) === JSON.stringify(['5.1','5.2','5.2.1','5.2.2','5.2.3','5.3','5.4','5.5','5.6','5.7','5.8','5.9','5.10','5.11','5.12','5.13','5.14']),
  'Area Specific Considerations covers the issued sections 5.1 to 5.14 including Hauraki Gulf subsections');
ok(/data-tg-section="3\.1\.2"[\s\S]*Information for Incidents on Vessels[\s\S]*MARINECOM/.test(tgContent) &&
   /data-tg-section="3\.1\.3"[\s\S]*Information for access incidents/.test(tgContent) &&
   /data-tg-section="3\.1"[\s\S]*All MEDEVACs/.test(tgContent),
  'Access Criteria Guidance 3.1-3.1.3 render as structured sections, not a raw text dump');
ok(JSON.stringify(seq('tasking')) === JSON.stringify(['9.0','9.1','9.2','9.3','9.4','9.5','9.6','6.0','6.1','11.0','11.1','11.2','17.9','17.9.1']),
  'Tasking, Landing & Destinations covers 9.0-9.6, then 6.0-6.1 and 11.0-11.2, then 17.9-17.9.1');
ok(JSON.stringify(seq('escalation')) === JSON.stringify(['13.0','14.0','15.0','16.1','16.2','16.3','16.4','18.0','18.1','19.0','19.1','19.2']),
  'Escalation, Coordination & Major Incidents covers 13.0-14.0, 15.0-16.4 and 18.0-18.1, then 19.0-19.2');
ok(JSON.stringify(seq('agencies')) === JSON.stringify(['7.0','8.0','12.0','12.1','12.2','12.3','21.0']),
  'Other Agencies & RCCNZ Advice covers sections 7.0, 8.0, 12.0 to 12.3, then 21.0');
ok(JSON.stringify(seq('definitions')) === JSON.stringify(['2.0','2.1','2.2','1.1','1.2']),
  'Principles & Definitions covers sections 2.0 to 2.2, then 1.1 and 1.2');

ok(/4\.25\.1 Secondary &amp; Tertiary Maternity Facilities/.test(tgContent) &&
   /data-tg-keep-table="true"/.test(tgContent),
  'Clinical Conditions retains the 4.25.1 maternity-facility source table');
ok(/data-tg-section="4\.29"[\s\S]*Drug-assisted airway management[\s\S]*Advanced analgesia for severe uncontrollable pain/.test(tgContent),
  'Specific Skills preserves issued examples across the time thresholds');
ok(/data-tg-section="3\.0"[\s\S]*Time-critical clinical condition[\s\S]*Lifesaving skill required/.test(tgContent),
  'ANTS core Time and Skill thresholds are present');
ok(/data-tg-section="5\.3"[\s\S]*Cathedral Cove[\s\S]*MARINECOM/.test(tgContent) &&
   /data-tg-section="5\.10"[\s\S]*Te Anau RWAA is 35mins[\s\S]*Milford Road Alliance/.test(tgContent) &&
   /data-tg-section="5\.11"[\s\S]*Stewart Island Flights[\s\S]*minimum one-hour activation time/.test(tgContent) &&
   /data-tg-section="5\.14"[\s\S]*Whakapapa[\s\S]*Treble Cone/.test(tgContent),
  'Area Specific guidance retains Cathedral Cove, Fiordland, Rakiura and Ski-field operational details');
ok(/data-tg-section="9\.0"[\s\S]*Rapid[\s\S]*Investigated[\s\S]*Scene/.test(tgContent) &&
   /RESPAOTH/.test(catSlice('tasking','escalation')),
  'Tasking Methods retains issued methods and response-code reference');
ok(/data-tg-section="16\.2"[\s\S]*Active Incident Review/i.test(tgContent),
  'Escalation & Review retains Active Incident Review');
ok(/data-tg-section="11\.0"[\s\S]*40 meters by 40 meters[\s\S]*Degrees, Decimal Minutes/.test(tgContent) && /data-tg-section="11\.1"[\s\S]*\/CADLZ/.test(tgContent),
  'Landing Sites retains issued LZ dimensions, coordinate format and FENZ request pathway');
ok(/data-tg-section="17\.9\.1"[\s\S]*HELICHANGE[\s\S]*F8 TEST/.test(tgContent),
  'Callsign Management retains the issued HELICHANGE airframe-change process');
ok(/data-tg-section="19\.1"[\s\S]*RWAA Major Incident Priorities[\s\S]*Logistical transportation support/.test(tgContent),
  'Major Incidents retains the issued RWAA coordination priorities');
ok(/data-tg-section="21\.0"[\s\S]*RESPARCC RCCNZ Tasking[\s\S]*\/RCCNZ shortcode/.test(tgContent),
  'RCCNZ Clinical Advice retains the issued CAD workflow');
ok(/data-tg-section="1\.2"[\s\S]*must[\s\S]*should[\s\S]*time-critical condition/i.test(tgContent),
  'Definitions retain key issued tasking terminology');
ok(/data-tg-section="2\.0"[\s\S]*RAS acronym[\s\S]*Specific requirements/.test(tgContent),
  'General Principles retains the RAS radio-request acronym');
ok(/data-tg-section="6\.1"[\s\S]*Staging following the major trauma pathway/.test(tgContent),
  'Hospital Destinations retains the staging rules');
ok(/data-tg-section="8\.0"[\s\S]*HOTEL callsign/.test(tgContent),
  'Other Resource Requests retains the Air Ambulance RRV HOTEL callsign step');
ok(/data-tg-section="12\.0"[\s\S]*Ability to Delay[\s\S]*PURPLE/.test(tgContent) &&
   /12\.2\.1 Recognised Hospital Facilities/.test(tgContent) && /Kaitaia Hospital/.test(tgContent),
  'Tasking for Another Agency retains the response-colour/delay table and the Recognised Hospital Facilities table');
ok(/data-tg-section="14\.0"[\s\S]*SAROP coordination guide[\s\S]*Emergency locator beacons/.test(tgContent),
  'Coordination Frameworks retains the Police/RCCNZ SAROP coordination guide');
ok(/data-tg-section="18\.1"[\s\S]*hand coordination back to the EAS road/.test(tgContent),
  'Coordination Frameworks retains the Ambulance Centre hand-back rule');

ok(/Skill criteria indications/.test(tgContent) &&
   /Indications of Time and\/or Skill Critical Incidents/.test(tgContent) &&
   /Out-of-hospital ANTS tasking response codes/.test(tgContent) &&
   /ANTS Codes for Primary Taskings/.test(tgContent) &&
   /Pathway Codes for Primary Taskings/.test(tgContent) &&
   /16\.0 Conflicts and Escalation/.test(tgContent) &&
   /Active incident review process/.test(tgContent) &&
   /1\.0 Acronyms &amp; Definitions/.test(tgContent),
  'issued source table and group labels are retained');

const tgSection = number => tgSections.find(m => m[1] === number)?.[2] || '';
const metabolic = tgSection('4.18');
const sepsis = tgSection('4.19');
const vascular = tgSection('4.21');
const anaphylaxis = tgSection('4.22');
ok(/Altered level of consciousness with Hypoglycaemia/.test(metabolic) &&
   /Severe Hyperkalaemia/.test(metabolic) &&
   !/Hypoglycaemia|Hyperkalaemia/.test(sepsis),
  'Metabolic thresholds stay within 4.18, not 4.19 Sepsis');
ok(/Undifferentiated profound shock/.test(vascular) && /Ischaemic limb/.test(vascular) &&
   !/Undifferentiated profound shock|Ischaemic limb/.test(anaphylaxis),
  'Vascular thresholds stay within 4.21, not 4.22 Anaphylaxis');

/* --------------------------------------------------- dataset id retention -- */
// The single most important rule in the dataset update contract: a feature that
// survives an approved re-import keeps its existing id, even when its name,
// coordinates or metadata change. Everything cross-references by id — priority
// styling, saved scenes, the LZ pack, base callsigns — so an export that
// renumbers silently detaches all of it.
//
// Nothing in the app enforces this. validateFeatures() checks that a feature is
// a Feature with a supported geometry and stops; validateUniqueIds() guards the
// CONFIG registries, not the data. A re-import that renumbered all 748 LZs
// would register cleanly, boot cleanly, and pass every other check here —
// counting features cannot see it, because the count is unchanged.
//
// So the baseline stores the id sets themselves. Sites legitimately come and
// go, so a small diff is reported rather than failed; wholesale replacement of
// the id space is what fails. The printed added/removed lists are the id-level
// diff the contract asks a maintainer to check, produced automatically.
const RETENTION_FLOOR = 0.9;   // below this, the id space was replaced, not edited

let baseline = null;
try {
  baseline = JSON.parse(readFileSync(join(REPO_DIR, 'tools', 'dataset-baseline.json'), 'utf8'));
} catch { /* reported below */ }

ok(!!baseline, 'dataset baseline present',
  'tools/dataset-baseline.json is missing — id retention cannot be checked');

if (baseline) {
  const failures = [];
  const diffs = [];
  const unbaselined = PROTECTED_DATASETS.filter(id => !(baseline.datasets || {})[id]);
  if (unbaselined.length) failures.push(`not in the baseline: ${unbaselined.join(', ')} (run node tools/dataset-baseline.mjs after review)`);
  for (const [id, expected] of Object.entries(baseline.datasets || {})) {
    const blockText = datasetSource(src, id);
    if (blockText == null) { failures.push(`${id}: dataset not found`); continue; }

    const { features } = countAndIds(blockText);
    const found = [...blockText.matchAll(/"properties"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
    const unique = new Set(found);
    const was = new Set(expected.ids || []);

    if (unique.size !== found.length) {
      const dupes = found.filter((v, i) => found.indexOf(v) !== i);
      failures.push(`${id}: ${found.length - unique.size} duplicate id(s) — e.g. ${[...new Set(dupes)].slice(0, 3).join(', ')}`);
    }

    const retained = [...was].filter(x => unique.has(x));
    const removed = [...was].filter(x => !unique.has(x));
    const added = [...unique].filter(x => !was.has(x));

    if (was.size && retained.length / was.size < RETENTION_FLOOR) {
      failures.push(`${id}: only ${retained.length} of ${was.size} baseline ids survive ` +
        `(${Math.round(retained.length / was.size * 100)}%) — the id space was replaced, not edited. ` +
        `Re-import kept feature count at ${features} but renumbered.`);
    }
    if (added.length || removed.length) {
      diffs.push(`${id}: ${features} features (was ${expected.features}) · ` +
        `+${added.length} -${removed.length}` +
        (removed.length ? `\n          removed: ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? ` …+${removed.length - 5}` : ''}` : '') +
        (added.length ? `\n          added:   ${added.slice(0, 5).join(', ')}${added.length > 5 ? ` …+${added.length - 5}` : ''}` : ''));
    }
  }

  ok(failures.length === 0,
    `dataset ids retained across ${Object.keys(baseline.datasets || {}).length} datasets`,
    failures.join('\n'));
  note(diffs.length === 0, 'dataset ids match the baseline exactly',
    diffs.join('\n') +
    '\n        If this is an approved import, check the diff above, then regenerate' +
    '\n        the baseline (node tools/dataset-baseline.mjs) in the same commit.');
}

/* ------------------------------------- Air Desk Guidance source integrity -- */
{
  let guidance = null;
  try { guidance = JSON.parse(datasetSource(src, 'air-desk-guidance')); } catch { guidance = null; }
  ok(!!guidance, 'Air Desk Guidance canonical GeoJSON parses');
  if (guidance) {
    const features = guidance.features || [];
    const cats = features.map(f => f?.properties?.category || '');
    const count = name => cats.filter(x => x === name).length;
    ok(features.length === 274,
      'Air Desk Guidance contains 274 approved features', `found ${features.length}`);
    ok(count('Rafting Evac Site') === 11 && count('Makara Peak Evac Site') === 16 && count('Taranaki Basin Oil/Gas') === 9,
      'selected MapIT operational points are complete (8C=11, 8D=16, 8F=9)',
      `rafting=${count('Rafting Evac Site')}, makara=${count('Makara Peak Evac Site')}, oil/gas=${count('Taranaki Basin Oil/Gas')}`);
    ok(count('Major Trauma 40km Ring') === 17,
      'only the 17 approved 40km major-trauma road-distance rings are present',
      `found ${count('Major Trauma 40km Ring')} 40km rings`);
    const trial40min = features.filter(f => /40\s*(?:minute|min)\b|drive[- ]?time\s*ring/i.test(
      `${f?.properties?.name||''} ${f?.properties?.category||''} ${f?.properties?.note||''}`));
    ok(trial40min.length === 0,
      '40-minute trial trauma rings are not embedded',
      trial40min.slice(0,5).map(f => f?.properties?.name || '(unnamed)').join(', '));
    const sourceIds = features.map(f => f?.properties?.id).filter(id => /^adg-(?:rafting|makara|oil)-/.test(id || ''));
    ok(new Set(sourceIds).size === 36,
      'all 36 imported MapIT points have stable source-specific ids',
      `found ${sourceIds.length} ids, ${new Set(sourceIds).size} unique`);
  }
}

/* --------------------------------------- v6 stable operational confirmations -- */
// These four records were explicitly confirmed by the operational owner for
// the v6.0 freeze. They are intentionally checked here because each replaces a
// stale/future-dated statement that could otherwise creep back during a data
// merge while keeping exactly the same feature id.
ok(/"id":"adg-3"[\s\S]{0,900}?Closure remains current until further notice; operational status confirmed 24 September 2026\./.test(ours) &&
   !/"id":"adg-3"[\s\S]{0,900}?End 26 Dec 2025/.test(ours),
  'Haast–Lake Moeraki closure is the owner-confirmed until-further-notice v6 baseline');
ok(/"id":"adg-69"[\s\S]{0,500}?permanent 30-minute road-time adjustment[\s\S]{0,500}?Permanent rule confirmed 24 September 2026\./i.test(ours) &&
   !/"id":"adg-69"[\s\S]{0,500}?foreseeable future/i.test(ours),
  'PARAPARA carries the owner-confirmed permanent 30-minute adjustment');
ok(/"id":"lz-370"[\s\S]{0,500}?"status":"Inactive"[\s\S]{0,500}?Waihi Bowling Club is the primary LZ/.test(ours),
  'Morgan Park is inactive and points operators to Waihi Bowling Club');
ok(/"id":"lz-583"[\s\S]{0,500}?"status":"Active"[\s\S]{0,500}?"operationalPriority":"Preferred"[\s\S]{0,500}?Primary LZ replacing Morgan Park/.test(ours) &&
   !/"id":"lz-583"[\s\S]{0,500}?1st October 2026/.test(ours),
  'Waihi Bowling Club is active/preferred now with no future transition date');

/* --------------------------------------------------------------- version -- */
// Build identity lives in APP in #airdesk-core-config. Three places have to
// agree: that constant, the filename (which netlify.toml rewrites to), and the
// header chip the desk actually reads, so the chip is checked, not trusted.
const appVersion = /version:\s*'([\d.]+)'/.exec(
  /const APP = Object\.freeze\(\{[\s\S]{0,400}?\}\)/.exec(ours)?.[0] || '')?.[1];
const fileVersion = /AirDesk-v([\d.]+)\.html/i.exec(APP_NAME)?.[1];
const chipVersion = /id="build-version"[^>]*>v?([\d.]+)</.exec(ours)?.[1];
const appBuildDate = /buildDate:\s*'(\d{4}-\d{2}-\d{2})'/.exec(
  /const APP = Object\.freeze\(\{[\s\S]{0,400}?\}\)/.exec(ours)?.[0] || '')?.[1];
const headerBuildDate = /Build date:\s*(\d{4}-\d{2}-\d{2})/.exec(ours)?.[1];

ok(!!appVersion, `APP.version declared (${appVersion || 'absent'})`,
  'no version constant found in #airdesk-core-config');
ok(appVersion === fileVersion, `APP.version matches filename (${fileVersion})`,
  `APP says ${appVersion}, filename says ${fileVersion}`);
ok(chipVersion === appVersion, `header build chip matches APP.version (v${chipVersion})`,
  `chip reads v${chipVersion}, APP.version is ${appVersion} — the desk would display the wrong build`);
ok(!!appBuildDate && appBuildDate === headerBuildDate,
  `APP.buildDate matches file header (${appBuildDate || 'absent'})`,
  `APP.buildDate=${appBuildDate || '(missing)'}, header Build date=${headerBuildDate || '(missing)'}`);
const packageJsonPath = join(REPO_DIR, 'package.json');
const packageLockPath = join(REPO_DIR, 'package-lock.json');
const packageJson = existsSync(packageJsonPath) ? JSON.parse(readFileSync(packageJsonPath, 'utf8')) : {};
const packageLock = existsSync(packageLockPath) ? JSON.parse(readFileSync(packageLockPath, 'utf8')) : {};
const packageVersion = packageJson.version || '';
const lockVersion = packageLock.version || '';
ok(packageVersion === `${appVersion}.0` && lockVersion === packageVersion,
  `package metadata matches APP.version (${packageVersion})`,
  `package=${packageVersion || '(missing)'}, lock=${lockVersion || '(missing)'}, APP=${appVersion}`);

// The locked browser-test package has its own Node floor. The project engine
// must not claim support for an older Node version than Playwright can run on.
const minEngineMajor = range => Number(/>=\s*(\d+)/.exec(range || '')?.[1] || 0);
const projectNodeEngine = packageJson.engines?.node || '';
const playwrightNodeEngine = packageLock.packages?.['node_modules/@playwright/test']?.engines?.node || '';
ok(minEngineMajor(projectNodeEngine) >= minEngineMajor(playwrightNodeEngine) && minEngineMajor(playwrightNodeEngine) > 0,
  `declared Node engine (${projectNodeEngine}) satisfies locked Playwright (${playwrightNodeEngine})`,
  'raise package.json/package-lock root engines.node when the locked Playwright minimum increases');

const appBlock = /const APP = Object\.freeze\(\{[\s\S]{0,500}?\}\)/.exec(ours)?.[0] || '';
const appBaseline = /baseline:\s*'([^']+)'/.exec(appBlock)?.[1] || '';
const headerBaselineVersion = /Stable production baseline:\s*v?([\d.]+)/.exec(ours)?.[1] || '';
const appBaselineVersion = /^([\d.]+)/.exec(appBaseline)?.[1] || '';
ok(!!appBaseline && !!headerBaselineVersion && appBaselineVersion === headerBaselineVersion,
  `stable-baseline metadata agrees (${appBaseline || 'missing'})`,
  `header=v${headerBaselineVersion || '(missing)'}, APP.baseline=${appBaseline || '(missing)'}`);

const appDataVersion = /dataVersion:\s*'(\d{4}\.\d{2}\.\d{2})'/.exec(appBlock)?.[1] || '';
const baselineUpdated = baseline?.updated || '';
ok(!!appDataVersion && baselineUpdated.replaceAll('-', '.') === appDataVersion,
  `APP.dataVersion matches protected dataset verification date (${appDataVersion || 'missing'})`,
  `dataset-baseline updated=${baselineUpdated || '(missing)'}, APP.dataVersion=${appDataVersion || '(missing)'}`);

// Release identity also appears in the handover documents. These were previously
// easy to leave one edition behind during a filename/version bump, which makes a
// clean package look internally inconsistent to the next maintainer. Check only
// the current-release heading/status in each document; historical version entries
// are intentionally preserved below them.
const readText = name => {
  const path = join(REPO_DIR, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};
const readmeText = readText('README.md');
const architectureText = readText('ARCHITECTURE.md');
const changelogText = readText('CHANGELOG.md');
const noticeText = readText('NOTICE.md');
const visualCheckText = readText('tools/visual-check.mjs');
const docVersions = [
  ['README.md', /\*\*Status:\*\*[^\n]*?\bv([\d.]+)/.exec(readmeText)?.[1]],
  ['ARCHITECTURE.md', /currently `AirDesk-v([\d.]+)\.html`/.exec(architectureText)?.[1]],
  ['CHANGELOG.md', /^## v([\d.]+),/m.exec(changelogText)?.[1]],
];
const staleDocs = docVersions.filter(([, version]) => version !== appVersion);
ok(staleDocs.length === 0 && readmeText.includes(`AirDesk-v${appVersion}.html`),
  `release documentation identifies v${appVersion}`,
  staleDocs.map(([name, version]) => `${name}: ${version || '(missing current version)'}`).join(', ') ||
    `README.md does not reference AirDesk-v${appVersion}.html`);

const visualDirectShotCount = [...visualCheckText.matchAll(/await\s+shot\(['"`][^'"`]+['"`]\)/g)].length;
const visualDialogShotCount = [...visualCheckText.matchAll(/await\s+dialog\([^\n]+?['"`][^'"`]+['"`]\)/g)].length;
const visualShotCount = visualDirectShotCount + visualDialogShotCount;
const visualProfileBlock = /const\s+profiles\s*=\s*\[([\s\S]*?)\];/.exec(visualCheckText)?.[1] || '';
const visualProfileCount = [...visualProfileBlock.matchAll(/\bname\s*:\s*['"`][^'"`]+['"`]/g)].length;
const visualTotal = visualShotCount * visualProfileCount;
const currentHeaderBlock = src.slice(0, Math.max(src.indexOf('-->') + 3, 8000));
ok(visualTotal > 0 &&
   currentHeaderBlock.includes(`${visualTotal} screenshots`) &&
   architectureText.includes(`${visualTotal} screenshots in total`),
  `visual-regression documentation matches ${visualShotCount} screens × ${visualProfileCount} profiles (${visualTotal} screenshots)`,
  'update the maintainer header and ARCHITECTURE.md when visual-check.mjs coverage changes');
ok(!/Department of Conservation API/i.test(noticeText),
  'NOTICE describes DOC as embedded source data, not a live API dependency',
  'AirDesk makes no DOC API call; keep NOTICE aligned with runtime dependencies');
ok(ours.includes('data-system-self-check') && ours.includes('system-self-check-results'),
  'deployment self-check control and results region present');
ok(ours.includes('Object.keys(AirDesk.data || {}).length') && !ours.includes('referenceCount >= 20'),
  'embedded dataset self-check uses the canonical data registry');
ok(ours.includes("['localhost','127.0.0.1','::1'].includes(location.hostname)") && ours.includes("localHost?'info'"),
  'localhost is classified as local test information');
ok(ours.includes('const STALE_AFTER={tracplus:3*60*1000}') && ours.includes("if(n==='stale')return 'stale'"),
  'TracPlus freshness threshold and stale state present');

/* ------------------------------------------------------------------- csp -- */
// netlify.toml says: "when an endpoint is added there, add it here". This is
// that promise, checked. Every https origin the app fetches from must appear
// in connect-src, or the request dies the moment the policy is enforced.
const cspLine = /Content-Security-Policy(?:-Report-Only)?\s*=\s*"([\s\S]*?)"\s*$/m.exec(toml || '');
const csp = cspLine ? cspLine[1] : '';
const connectSrc = /connect-src([^;"]*)/.exec(csp)?.[1] || '';
const fetched = new Set(
  [...ours.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)]
    .map(m => m[1].toLowerCase())
    // Only origins the app actually fetches from. Documentation links and
    // href targets are navigations, which connect-src does not govern.
    .filter(h => /googleapis|linz\.govt\.nz|arcgis|doc\.govt\.nz|workers\.dev|firebasedatabase|openstreetmap/.test(h))
    // "https://....firebasedatabase.app" is placeholder text inside the
    // Firebase config dialog, not a real origin.
    .filter(h => !h.startsWith('...'))
);
// connect-src entries may be exact hosts or *.suffix wildcards.
const allowed = connectSrc.trim().split(/\s+/).filter(Boolean)
  .map(v => v.replace(/^(https|wss):\/\//, ''));
const covers = host => allowed.some(a =>
  a === host || (a.startsWith('*.') && host.endsWith(a.slice(1))));
const missing = [...fetched].filter(h => !covers(h));
ok(!csp || missing.length === 0,
  `CSP connect-src covers all ${fetched.size} fetched origins`,
  `missing: ${missing.join(', ')}`);

// Whether the policy is actually enforced is a decision, not a defect.
note(/(?<!-)\bContent-Security-Policy\s*=/.test(toml || ''),
  'CSP is enforced',
  'still Content-Security-Policy-Report-Only — nothing is blocked. Rename the header once the report-only period has shown no legitimate violations.');

/* ---------------------------------------------------------- release workflow -- */
// This edition is maintained as versioned ZIP files and uploaded directly to
// Netlify. A dormant GitHub workflow would imply protection that the actual
// release path does not have, so the package and header must both say no CI.
const hasWorkflow = existsSync(join(REPO_DIR, '.github', 'workflows', 'checks.yml'));
/* read the whole leading header comment, not a fixed window */
const headerBlock = src.slice(0, Math.max(src.indexOf('-->') + 3, 8000));
const headerClaimsNoCI = /Neither runs in CI|no GitHub Actions workflow/i.test(headerBlock);
const headerClaimsCI = /Both run in CI|runs? in CI on every push/i.test(headerBlock);
ok(!hasWorkflow && headerClaimsNoCI && !headerClaimsCI,
  'the package documents its manual ZIP release workflow',
  hasWorkflow
    ? 'remove the unused GitHub workflow from this filesystem-only release'
    : 'the header must state that no GitHub Actions workflow is active');

/* ------------------------------------------------------------ credentials -- */
// Browser credentials are client-visible by design. The maintainability control
// here is ownership and single-source placement, not pretending they are secret.
// Four expected client configuration values exist:
//   1) Google Maps Platform key in runtimeConfig,
//   2) LINZ Basemaps key in runtimeConfig,
//   3) LINZ Data Service key in runtimeConfig (Powerlines WFS), and
//   4) Firebase web API key in firebaseConfig.
// Provider-side restrictions/rules are external controls and cannot be proved
// from this package.
const mapsKey = /googleMapsApiKey\s*:\s*["']([^"']+)["']/.exec(ours)?.[1] || null;
const linzBasemapKey = /linzApiKey\s*:\s*["']([^"']+)["']/.exec(ours)?.[1] || null;
const linzDataServiceKey = /linzDataServiceApiKey\s*:\s*["']([^"']+)["']/.exec(ours)?.[1] || null;
const firebaseKey = /firebaseConfig[\s\S]{0,400}?apiKey\s*:\s*["']([^"']+)["']/.exec(ours)?.[1] || null;

ok(!!mapsKey, 'Google Maps key is declared in runtimeConfig');
ok(!!linzBasemapKey, 'LINZ Basemaps key is declared in runtimeConfig');
ok(!!linzDataServiceKey, 'LINZ Data Service key is declared in runtimeConfig');
ok(!!firebaseKey, 'Firebase web API key is declared in firebaseConfig');
ok(!!linzBasemapKey && !!linzDataServiceKey && linzBasemapKey !== linzDataServiceKey,
  'LINZ Basemaps and Data Service use distinct keys',
  'the two LINZ products must not silently collapse onto one credential');

const googleFormatKeys = new Set(ours.match(/AIzaSy[A-Za-z0-9_-]{20,}/g) || []);
const expectedGoogleFormatKeys = new Set([mapsKey, firebaseKey].filter(Boolean));
const unexpectedGoogleFormatKeys = [...googleFormatKeys].filter(k => !expectedGoogleFormatKeys.has(k));
ok(unexpectedGoogleFormatKeys.length === 0,
  `${googleFormatKeys.size} Google-format API keys accounted for (Maps + Firebase)`,
  `unrecognised Google-format key(s): ${unexpectedGoogleFormatKeys.map(k => k.slice(0, 12) + '…').join(', ')}`);

const credentialOccurrences = [
  ['Google Maps', mapsKey],
  ['LINZ Basemaps', linzBasemapKey],
  ['LINZ Data Service', linzDataServiceKey]
].map(([name, value]) => [name, value, value ? (ours.split(value).length - 1) : 0]);

for (const [name, value, count] of credentialOccurrences) {
  ok(!!value && count === 1, `${name} key appears once (single source)`,
    value ? `found ${count} copies — rotation could miss one` : `${name} key is missing`);
}

ok(/linzKey\s*:\s*AirDesk\.runtimeConfig\.linzDataServiceApiKey/.test(ours),
  'Powerlines reads the canonical LINZ Data Service key',
  'outdoor-access must not carry a second hidden/copy credential');
ok(!/atob\s*\([^)]{0,200}(?:linz|power|key)/i.test(ours),
  'no base64-obfuscated LINZ/Powerlines credential path remains',
  'declare provider credentials in runtimeConfig instead of hiding them in a module');

/* ------------------------------------------------- csp resource types -- */
// connect-src coverage is checked above. This covers the rest: a resource
// type the policy has no directive for is blocked the moment it appears, and
// a blocked resource fails silently. Each entry is "if the app starts doing
// X, the policy must gain Y first".
const cspHas = d => new RegExp(`(?:^|;)\\s*${d}\\s`).test(csp);
const cspGuards = [
  [/<link[^>]*rel="?manifest"?/i.test(oursLean), 'manifest-src',
   'a <link rel=manifest> appeared; manifest-src falls back to default-src \'self\', which blocks a data: manifest'],
  [/<form\b/i.test(oursLean), 'form-action',
   'a <form> appeared and form-action is not declared'],
  [/<base\s/i.test(oursLean), 'base-uri',
   'a <base> tag appeared and base-uri is not declared'],
  [/<(?:audio|video)\b|new Audio\(/i.test(oursLean), 'media-src',
   'audio or video appeared and media-src is not declared'],
  [/<(?:embed|object)\b/i.test(oursLean), 'object-src',
   'an <embed> or <object> appeared and object-src is not declared'],
];
const uncovered = cspGuards.filter(([used, dir]) => used && !cspHas(dir));
ok(uncovered.length === 0,
  `CSP covers every resource type the app uses (${cspGuards.length} checked)`,
  uncovered.map(g => g[2]).join('; '));

// script-src carries no 'unsafe-eval', so any eval reintroduced into app code
// dies under the enforced policy. The one historical new Function() is inside
// a comment describing code that was removed.
const evalUse = /(?:^|[^.\w])eval\s*\(|new Function\s*\(/.exec(
  oursLean.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
ok(!evalUse, "no eval or new Function (script-src has no 'unsafe-eval')",
  'enforced CSP will throw on it at runtime');

/* ------------------------------------------------------- offline shell -- */
// The worker is a second file that must deploy with the HTML. It caches the
// shell only; the risk it introduces is a stale build, which the cache
// headers and the no-literal rule below are what actually prevent.
const swPath = join(REPO_DIR, 'sw.js');
const swPresent = existsSync(swPath);
const sw = swPresent ? readFileSync(swPath, 'utf8') : '';
const registers = /serviceWorker\.register\(/.test(ours);

ok(swPresent === registers,
  swPresent ? 'sw.js present and registered by the app' : 'no service worker (neither file nor registration)',
  swPresent
    ? 'sw.js is deployed but nothing registers it — the offline shell never installs'
    : 'the app registers /sw.js but the file is not in the repo — registration fails on every load');

if (swPresent) {
  const revalidates = /Cache-Control\s*=\s*"[^"]*must-revalidate/.test(toml || '') &&
                      /Cache-Control\s*=\s*"[^"]*max-age=0/.test(toml || '');
  ok(revalidates, 'netlify.toml revalidates the HTML and the worker',
    'without max-age=0, must-revalidate a cached sw.js cannot replace itself and pins an old build');

  // The shell is cached under a fixed key, not a filename, so a version bump
  // needs no edit here. A literal would be a fourth place for the version to
  // drift, alongside APP.version, the header chip and the toml rewrites.
  const literal = /AirDesk-v[\d.]+\.html/i.exec(sw);
  ok(!literal, 'sw.js carries no filename or version literal',
    `found ${literal ? literal[0] : ''} — it will go stale on the next bump`);

  ok(!/cache\.put\([^)]*(?:googleapis|firebase|tracplus|journeys|linz|arcgis)/i.test(sw),
    'the worker caches no live-service response',
    'a cached live response is stale operational data shown as current');
}

/* Typography: DM Sans for all UI text, Roboto Mono for callsigns and tails,
   both embedded as woff2 in #airdesk-fonts. Refuse a third family and any
   external font link or source. */
{
  const block = (src.match(/<style id="airdesk-fonts">([\s\S]*?)<\/style>/) || [])[1] || '';
  const families = [...block.matchAll(/font-family:\s*'([^']+)'/g)].map(m => m[1]);
  const extra = [...new Set(families)].filter(f => f !== 'DM Sans' && f !== 'Roboto Mono');
  const external = /<link[^>]+fonts\.(?:googleapis|gstatic)\.com/.test(src);
  const nonEmbedded = [...block.matchAll(/src:\s*url\(([^)]{0,24})/g)].filter(m => !m[1].startsWith('data:font/woff2')).length;
  ok(families.length > 0 && extra.length === 0 && !external && nonEmbedded === 0,
    'only DM Sans and Roboto Mono are loaded, embedded',
    extra.length ? `also loads ${extra.join(', ')}` : external ? 'an external font link is back'
      : nonEmbedded ? 'a font source is not an embedded woff2' : 'no embedded @font-face found');
}

/* `font:` shorthand mixed with `inherit` (e.g. "font:800 10px inherit")
   is invalid, so the browser silently drops the whole declaration. Two such
   rules had never applied. Catch any return of the pattern. */
{
  const bad = [...src.matchAll(/[{;]\s*font\s*:\s*([^;}]*\binherit\b[^;}]*)/g)]
    .map(m => m[1].trim()).filter(v => v !== 'inherit');
  ok(bad.length === 0, 'no invalid font shorthand mixed with inherit', bad.slice(0, 3).join(' | '));
}

/* An iOS Home Screen launch shows the drawn launch
   image, then the HTML splash. They read as two different screens when the
   app starts below an opaque status bar (content shifts down), when the drawn
   tile does not match .ads-mark, or when the splash animates in again over an
   image that already shows it. Keep all three aligned. */
{
  const translucent = /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"\/>/.test(src);
  const headerInset = /\.header\s*\{[^}]*padding:\s*calc\(8px \+ env\(safe-area-inset-top/.test(src);
  ok(translucent && headerInset,
    'Home Screen app starts under the status bar and the header clears it',
    !translucent ? 'black-translucent status-bar meta missing' : 'header lacks safe-area-inset-top padding');
  const cssRadius = (src.match(/\.ads-mark\s*\{[^}]*border-radius:\s*(\d+)px/) || [])[1];
  const drawnRadius = (src.match(/tx=cx-42,r=(\d+);/) || [])[1];
  const still = /\.ads-standalone \.ads-mark,\s*\.ads-standalone \.ads-title,\s*\.ads-standalone \.ads-sub\s*\{\s*animation:\s*none;?\s*\}/.test(src)
    && /navigator\.standalone===true\)document\.documentElement\.classList\.add\('ads-standalone'\)/.test(src);
  ok(cssRadius && cssRadius === drawnRadius && still,
    'iOS launch image and HTML splash match without a second entrance',
    `splash tile ${cssRadius || '?'}px, launch image ${drawnRadius || '?'}px, Home Screen entrance ${still ? 'suppressed' : 'animates again'}`);
}

/* Build 20260930.1. The map opened and reset to a fixed zoom, so New Zealand was cut off on
   phones, iPad portrait and Citrix-sized panes and small on large monitors. Opening and Reset
   now fit the islands to the pane, with the same padding. */
{
  const ctor = /new maplibregl\.Map\(\{[\s\S]*?\}\);/.exec(src)?.[0] || '';
  ok(/\.\.\.home,/.test(ctor) && !/zoom:\s*4\.7/.test(ctor)
     && /bounds: NZ_HOME_BOUNDS, fitBoundsOptions: \{ padding: homePadding\(/.test(src)
     && /this\.map\.fitBounds\(NZ_HOME_BOUNDS, \{ padding: homePadding\(canvas\.clientWidth, canvas\.clientHeight\), linear: true/.test(src)
     && /const canvas = this\.map\.getContainer\(\);/.test(src),
    'map opens and resets to New Zealand fitted to the pane, with the same padding');
}
// The stacked (phone and iPad portrait) map card takes the cards' inset, so it is not wider.
ok(/@media \(max-width: 980px\) \{[^@]*?body:not\(\[data-board\]\) \.workspace:not\(\.ad-map-expanded\) > \.map \{ margin-inline: var\(--sp-3\); \}/.test(src),
  'stacked map card has the same side inset as the form cards');
// A ⌄ character sits below the text line and rotates about the wrong centre; chevrons are drawn.
ok(!/content:\s*['"]⌄['"]/.test(src) && !/>⌄</.test(src), 'disclosure chevrons are drawn, not ⌄ characters');

// The guidance comparison's recorded presentation differences belong to the approved PDF; after a
// guidance update they must be re-recorded (node tools/guidance-compare.mjs <pdf> --record-baseline).
{
  const baseline = JSON.parse(readText('tools/guidance-baseline.json') || '{}');
  ok(baseline.sha256 === APPROVED_GUIDANCE.sha256 && baseline.version === APPROVED_GUIDANCE.version,
    'guidance comparison baseline is recorded from the approved PDF',
    `baseline ${baseline.version || '(missing)'} ${String(baseline.sha256 || '').slice(0, 12)}, approved ${APPROVED_GUIDANCE.version} ${APPROVED_GUIDANCE.sha256.slice(0, 12)}`);
}
/* Build 20261002.1. A header Links menu holds the outside pages used across workflows: the St John
   Tasking Board (one reusable side window, never reloaded or read by AirDesk), the Tasking &
   Operating Guidelines and the Master List of Helicopter Information. Both moved, not copied. */
{
  const menu = /<div class="links-pop[^"]*" id="links-menu"[\s\S]*?<\/div><\/div>/.exec(src)?.[0] || '';
  const titles = [...menu.matchAll(/class="rs-title">([^<]+)</g)].map(m => m[1]);
  const support = /const LINKS=\[[\s\S]*?\n\];/.exec(src)?.[0] || '';
  ok(titles.join('|') === 'Tasking Board|Tasking &amp; Operating Guidelines|Master List of Helicopter Information'
     && /reportviewer\.stjohn\.org\.nz\/Reports\/eacc\/realtime\/Report\.aspx\?r=Aeromedical\+Tasking\+Dashboard/.test(menu)
     && (menu.match(/rel="noopener noreferrer"/g) || []).length === 3,
    'header Links menu lists Tasking Board, Tasking & Operating Guidelines and Master List of Helicopter Information',
    `menu: ${titles.join(', ') || '(missing)'}`);
  ok(!/Operating Guidelines/.test(support) && !/id="master-heli-info-pill"/.test(src),
    'moved links are not duplicated in Decision Support Tools or Helicopter Change Process');
  ok(/if\(board&&!board\.closed\)\{board\.focus\(\);return;\}/.test(src) && !/board\.location/.test(src),
    'Tasking Board reuses its window and is never reloaded by AirDesk');
}
ok(/NOT_OFFERED_STATUS=new Set\(\['Inactive','Expired'\]\)/.test(src) && /knownLZ\(\)\.filter\(offeredLZ\)/.test(src)
   && /operationalPriority!=='Do not use'/.test(src),
  'Closest Known LZ leaves out Inactive, Expired and "Do not use" sites');

process.exit(summary());

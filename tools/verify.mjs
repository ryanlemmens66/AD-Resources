#!/usr/bin/env node
/**
 * Runtime verification — boots the app in a DOM and asks it about itself.
 *
 *   npm run verify        (or: node tools/verify.mjs)
 *
 * WHY THIS EXISTS
 * ---------------
 * tools/check.mjs reads the file. It can prove the markup is well-formed and
 * every script parses; it cannot prove the app assembles itself. This one
 * boots it and checks that it did.
 *
 * It runs in jsdom rather than a real browser, which is a deliberate trade:
 * no Chromium download, no WebGL, runs anywhere Node runs — at the cost of
 * never being able to say anything about rendering. MapLibre does not
 * initialise here, and that is expected: the app falls back to
 * PlaceholderMapAdapter, which is the path this check exercises. Map tiles,
 * layer draw order and anything visual still need a real device.
 *
 * The most valuable thing here is negative. Two failures in the previous Air
 * Desk lineage were silent aborts partway through a long init chain — one left
 * a splash overlay covering the page and swallowing every click, the other
 * skipped an interval registration and killed 60+ self-healing callbacks for
 * the rest of the session. Both looked fine in source. Neither would survive
 * the "every subsystem is present after boot" check below.
 *
 * Exit code 0 = clean, 1 = at least one check failed.
 */
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { APP_FILE, APP_NAME, guidanceMeta, ok, fail, section, summary } from './lib.mjs';

const BOOT_CEILING_MS = 30000;
const SETTLE_MS = 13000;

// Errors that are a property of running headless, not of the app. jsdom has no
// WebGL and no Worker URL support, so MapLibre cannot start; the app is
// supposed to notice that and fall back, which is what these two lines are.
const EXPECTED_HEADLESS_ERRORS = [
  /createObjectURL is not a function/i,
  /MapLibre GL JS did not load/i,
  /Shared map manager failed to initialise/i,
  /WebGL/i,
];

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => errors.push(String(e && e.message || e)));
virtualConsole.on('error', (...args) => errors.push(args.join(' ')));

section(`Runtime verification — ${APP_NAME}`);

const dom = new JSDOM(readFileSync(APP_FILE, 'utf8'), {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost/Local/' + APP_NAME,
  virtualConsole,
});

const started = Date.now();
await new Promise(resolve => setTimeout(resolve, SETTLE_MS));

const win = dom.window;
const doc = win.document;
const A = win.AirDesk;

/* ------------------------------------------------------------------ boot -- */
ok(!!A, `app boots and exposes AirDesk (${Date.now() - started}ms)`,
  'AirDesk is undefined — an init block threw before assembling the namespace');

if (!A) {
  console.log('\nCannot continue without the AirDesk namespace.');
  if (errors.length) errors.slice(0, 6).forEach(e => console.log('        ' + e.slice(0, 200)));
  process.exit(summary() || 1);
}

ok(Date.now() - started < BOOT_CEILING_MS, 'boot completed inside the ceiling');

/* ------------------------------------------------------------ subsystems -- */
// A silent abort partway through init does not throw anything a user sees; it
// just leaves later subsystems missing. Naming them individually means the
// failure message points at where the chain stopped.
const EXPECTED = {
  '': ['primary', 'sar', 'transfer', 'map', 'system', 'services', 'data', 'ui',
    'storage', 'health', 'fleet', 'board', 'privacy', 'resources', 'rules',
    'util', 'util', 'integrations', 'runtimeConfig'],
  primary: ['sceneLocation', 'nearestResources', 'responseCalculations', 'cad',
    'hospitalCompare', 'accessGuidance', 'sceneAlerts', 'skillAndLines',
    'accessIssues', 'clinicalNotes', 'responseBreakdown', 'majorTraumaRing',
    'twelveNmOffshore'],
  sar: ['scene', 'land', 'water', 'common'],
  transfer: ['workflow', 'cad'],
  map: ['referenceLayers', 'autoBasemap', 'terrain', 'coordinate', 'context',
    'measurement', 'manager', 'layerControllers', 'core', 'layerRuntime'],
  system: ['configStatus', 'layerGroups', 'registries', 'governance', 'ready',
    'operationalReviews'],
};

for (const [ns, keys] of Object.entries(EXPECTED)) {
  const target = ns ? A[ns] : A;
  const missing = target ? [...new Set(keys)].filter(k => target[k] === undefined) : [...new Set(keys)];
  ok(missing.length === 0,
    `${ns ? 'AirDesk.' + ns : 'AirDesk'} — all ${new Set(keys).size} subsystems present`,
    target ? `missing: ${missing.join(', ')}` : `AirDesk.${ns} is undefined`);
}

ok(typeof A.health?.snapshot === 'function', 'health service exposes freshness snapshots');
if (typeof A.health?.snapshot === 'function') {
  const healthSnapshot = A.health.snapshot();
  const missingHealth = ['tracplus', 'heli', 'notes', 'maps', 'net'].filter(key => !healthSnapshot[key]);
  ok(missingHealth.length === 0, 'health snapshot covers all live subsystems', `missing: ${missingHealth.join(', ')}`);
}

/* ---------------------------------------------------------------- config -- */
// The app validates its own configuration on load — schema version, unique ids
// and titles across the document and map-layer registries, a dataVersion on
// every static layer, ISO dates on review stamps. It surfaces the result in
// System Status, which nobody reads on a clean day. This makes it fail loudly.
const cs = A.system && A.system.configStatus;
ok(!!cs, 'configuration was validated at boot');
if (cs) {
  ok(cs.valid, `configuration valid (${A.REGISTRIES?.mapLayers?.length ?? '?'} map layers, ` +
    `${A.REGISTRIES?.documents?.length ?? '?'} documents)`,
    cs.issues.join('\n'));
}

/* --------------------------------------------------------------- version -- */
const fileVersion = /AirDesk-v([\d.]+)\.html/i.exec(APP_NAME)?.[1];
ok(A.meta?.version === fileVersion,
  `APP.version agrees with the filename (${A.meta?.version})`,
  `runtime reports ${A.meta?.version}, filename says ${fileVersion}`);
ok(A.meta?.channel === 'production', `release channel is production (${A.meta?.channel})`);
const formatTail = A.internal?.heliStatusModel?.formatTail;
ok(typeof formatTail === 'function' && formatTail('ZK-ZK-XYZ') === 'ZK-XYZ' && formatTail('ZKXYZ') === 'ZK-XYZ',
  'Heli Status tail normalisation remains canonical after repeated formatting',
  `ZK-ZK-XYZ -> ${typeof formatTail === 'function' ? formatTail('ZK-ZK-XYZ') : 'formatter missing'}`);

/* -------------------------------------------------------------- services -- */
const EXPECTED_SERVICES = ['linz', 'google', 'nominatim', 'nzta', 'tracplus', 'windy'];
const catalog = A.services?.catalog || {};
const missingServices = EXPECTED_SERVICES.filter(k => !catalog[k]);
ok(missingServices.length === 0,
  `service catalog covers all ${EXPECTED_SERVICES.length} providers`,
  `missing: ${missingServices.join(', ')}`);

/* ------------------------------------------------------------- datasets -- */
// Every reference dataset is registered through validateFeatures(), which
// throws on a feature that is not a Feature or carries an unsupported
// geometry. A dataset replacement that broke the shape would abort its own
// module here rather than silently registering nothing.
const dataKeys = Object.keys(A.data || {});
ok(dataKeys.length >= 18, `${dataKeys.length} reference data modules registered`,
  `only ${dataKeys.length} — a dataset module aborted during registration`);

/* -------------------------------------------------------------- the DOM -- */
ok(doc.querySelectorAll('[role=tab], .tab').length >= 4,
  'tab bar rendered');
ok(doc.body.children.length > 10, 'app shell rendered into the body');
const guidanceTemplate = doc.getElementById('airdesk-tasking-clinical-guidance-content');
ok(guidanceTemplate?.tagName === 'TEMPLATE' && guidanceTemplate.innerHTML.length > 90000,
  'Tasking & Clinical Guidance remains populated in one inert template',
  `found ${guidanceTemplate?.innerHTML.length || 0} characters`);

// The previous lineage shipped a build where a fixed, full-viewport overlay
// stayed in the DOM after a failed init and swallowed every click, with no
// error anywhere. The app shell itself is legitimately fixed and inset:0 —
// what matters is whether anything covers the page *without containing it*.
// Containing the tab bar is the test: the shell does, an overlay does not.
const tabBar = doc.querySelector('[role=tab]');
const blockers = [...doc.querySelectorAll('body *')].filter(el => {
  const st = win.getComputedStyle(el);
  if (st.position !== 'fixed' || st.display === 'none' || st.visibility === 'hidden') return false;
  if (st.pointerEvents === 'none' || st.opacity === '0') return false;
  const fullViewport = st.inset === '0px' || (st.top === '0px' && st.left === '0px' &&
    st.right === '0px' && st.bottom === '0px');
  if (!fullViewport) return false;
  return !(tabBar && el.contains(tabBar));   // the shell contains the UI; an overlay sits on top of it
}).map(el => el.id || el.className || el.tagName);
ok(blockers.length === 0, 'nothing covers the viewport at rest',
  `blocking overlay(s): ${blockers.join(', ')} — clicks would go nowhere`);

const buildChip = doc.getElementById('build-version');
buildChip?.click();
ok(doc.getElementById('modal')?.hidden === false && doc.getElementById('modal-title')?.textContent === 'System Status',
  'System Status opens from the version chip');
const selfCheckButton = doc.querySelector('[data-system-self-check]');
ok(!!selfCheckButton, 'deployment self-check control renders in System Status');
selfCheckButton?.click();
const selfCheckItems = doc.querySelectorAll('.system-self-check-item');
ok(selfCheckItems.length === 7, 'deployment self-check returns all 7 results',
  `found ${selfCheckItems.length}`);
ok(doc.getElementById('system-self-check-results')?.textContent?.includes('No provider request was made.'),
  'deployment self-check confirms it made no provider request');
ok(doc.querySelector('.system-self-check-item.info')?.textContent?.includes('Local test environment'),
  'localhost is reported as local test information');
const datasetCheck = [...selfCheckItems].find(item => item.textContent?.includes('Embedded datasets'));
const datasetModuleCount = Number(/(\d+) reference data modules available/.exec(datasetCheck?.textContent || '')?.[1] || 0);
ok(datasetCheck?.classList.contains('pass') && datasetModuleCount >= 18,
  'embedded dataset self-check uses the canonical module registry', datasetCheck?.textContent || 'missing result');
doc.getElementById('modal-close')?.click();
ok(doc.getElementById('modal')?.hidden === true, 'System Status closes after the self-check');

doc.getElementById('primary-tg-btn')?.click();
ok(doc.getElementById('modal')?.hidden === false &&
  doc.getElementById('modal-title')?.textContent === 'Tasking & Clinical Guidance' &&
  doc.querySelectorAll('#modal-body .tg-section').length >= 60,
  'Tasking & Clinical Guidance opens from the inert source template');
const guidance = guidanceMeta();
ok(Boolean(guidance.version && guidance.documentDate) &&
  doc.querySelector('#modal-body .tg-hero')?.textContent?.includes(`Version ${guidance.version}`) &&
  doc.querySelector('#modal-body .tg-hero')?.textContent?.includes(guidance.documentDate),
  'Tasking & Clinical Guidance shows issued source metadata');
ok(doc.querySelector('#modal-body [data-tg-category="clinical"]')?.hidden === false &&
  doc.querySelector('#modal-body [data-tg-category="criteria"]')?.hidden === true,
  'Clinical Conditions is the default guidance category');
ok(doc.querySelector('#modal-body')?.textContent?.includes('4.25.1 Secondary & Tertiary Maternity Facilities') &&
  !!doc.querySelector('#modal-body table[data-tg-keep-table="true"]'),
  'Clinical Conditions retains the 4.25.1 maternity table');
const metabolicGuidance = doc.querySelector('#modal-body [data-tg-section="4.18"]')?.textContent || '';
const sepsisGuidance = doc.querySelector('#modal-body [data-tg-section="4.19"]')?.textContent || '';
const vascularGuidance = doc.querySelector('#modal-body [data-tg-section="4.21"]')?.textContent || '';
const anaphylaxisGuidance = doc.querySelector('#modal-body [data-tg-section="4.22"]')?.textContent || '';
ok(metabolicGuidance.includes('Severe Hyperkalaemia') && !sepsisGuidance.includes('Hyperkalaemia'),
  'runtime guidance keeps Metabolic thresholds out of Sepsis');
ok(vascularGuidance.includes('Undifferentiated profound shock') && !anaphylaxisGuidance.includes('Undifferentiated profound shock'),
  'runtime guidance keeps Vascular thresholds out of Anaphylaxis');
const criteriaTab = doc.querySelector('#modal-body [data-tg-category-button="criteria"]');
criteriaTab?.click();
ok(doc.querySelector('#modal-body [data-tg-category="criteria"]')?.hidden === false &&
  doc.querySelector('#modal-body [data-tg-section="3.0"]')?.textContent?.includes('Time-critical clinical condition') &&
  doc.querySelector('#modal-body [data-tg-section="4.29"]')?.textContent?.includes('Drug-assisted airway management'),
  'ANTS Criteria & Specific Skills renders the core thresholds and section 4.29');
const areasTab = doc.querySelector('#modal-body [data-tg-category-button="areas"]');
areasTab?.click();
ok(doc.querySelector('#modal-body [data-tg-category="areas"]')?.hidden === false &&
  doc.querySelector('#modal-body [data-tg-section="5.3"]')?.textContent?.includes('Cathedral Cove') &&
  doc.querySelector('#modal-body [data-tg-section="5.10"]')?.textContent?.includes('Te Anau RWAA is 35mins') &&
  doc.querySelector('#modal-body [data-tg-section="5.14"]')?.textContent?.includes('Treble Cone'),
  'Area Specific Considerations renders Cathedral Cove, Fiordland and Ski-field guidance');
const taskingTab2 = doc.querySelector('#modal-body [data-tg-category-button="tasking"]');
taskingTab2?.click();
ok(doc.querySelector('#modal-body [data-tg-category="tasking"]')?.hidden === false &&
  doc.querySelector('#modal-body [data-tg-section="11.0"]')?.textContent?.includes('40 meters by 40 meters') &&
  doc.querySelector('#modal-body [data-tg-section="6.1"]')?.textContent?.includes('Staging following the major trauma pathway') &&
  doc.querySelector('#modal-body [data-tg-section="17.9.1"]')?.textContent?.includes('HELICHANGE'),
  'Tasking, Landing & Destinations renders landing, hospital-staging and callsign guidance');
const escalationTab2 = doc.querySelector('#modal-body [data-tg-category-button="escalation"]');
escalationTab2?.click();
ok(doc.querySelector('#modal-body [data-tg-category="escalation"]')?.hidden === false &&
  doc.querySelector('#modal-body [data-tg-section="14.0"]')?.textContent?.includes('SAROP coordination guide') &&
  doc.querySelector('#modal-body [data-tg-section="19.1"]')?.textContent?.includes('RWAA Major Incident Priorities'),
  'Escalation, Coordination & Major Incidents renders the SAR guide and major-incident priorities');
const agenciesTab = doc.querySelector('#modal-body [data-tg-category-button="agencies"]');
agenciesTab?.click();
ok(doc.querySelector('#modal-body [data-tg-category="agencies"]')?.hidden === false &&
  doc.querySelector('#modal-body [data-tg-section="8.0"]')?.textContent?.includes('HOTEL callsign') &&
  doc.querySelector('#modal-body [data-tg-section="12.0"]')?.textContent?.includes('PURPLE') &&
  doc.querySelector('#modal-body')?.textContent?.includes('Kaitaia Hospital') &&
  doc.querySelector('#modal-body [data-tg-section="21.0"]')?.textContent?.includes('RESPARCC RCCNZ Tasking'),
  'Other Agencies & RCCNZ Advice renders the RRV process, response-colour table, recognised hospitals and RCCNZ workflow');
const definitionsTab2 = doc.querySelector('#modal-body [data-tg-category-button="definitions"]');
definitionsTab2?.click();
ok(doc.querySelector('#modal-body [data-tg-category="definitions"]')?.hidden === false &&
  doc.querySelector('#modal-body [data-tg-section="2.0"]')?.textContent?.includes('RAS acronym'),
  'Principles & Definitions renders the RAS radio-request guidance');
ok(doc.querySelector('#modal-body [data-tg-section="3.1.2"]')?.textContent?.includes('MARINECOM') &&
  doc.querySelector('#modal-body [data-tg-section="3.1.2"] li') &&
  doc.querySelector('#modal-body [data-tg-section="3.1"] table') &&
  !doc.querySelector('#modal-body [data-tg-section="3.1"] .tg-source-copy'),
  'ANTS 3.1-3.1.3 render as structured sections with real markup, not a raw text dump');

const searchGuidance = doc.querySelector('#modal-body [data-tg-search]');
if (searchGuidance) {
  searchGuidance.value = 'cardioversion';
  searchGuidance.dispatchEvent(new win.Event('input', { bubbles: true }));
}
ok(doc.querySelector('#modal-body [data-tg-section="4.29"]')?.hidden === false &&
  doc.querySelector('#modal-body [data-tg-section="4.29"]')?.textContent?.toLowerCase().includes('cardioversion') &&
  !doc.querySelector('#modal-body [data-tg-search-status]')?.hidden,
  'global guidance search surfaces matching sections across categories');
doc.querySelector('#modal-body [data-tg-close]')?.click();

/* ------------------------------------------------------------- console -- */
const unexpected = errors.filter(e => !EXPECTED_HEADLESS_ERRORS.some(re => re.test(e)));
ok(unexpected.length === 0,
  `no unexpected errors during boot (${errors.length - unexpected.length} known headless)`,
  unexpected.slice(0, 6).map(e => e.slice(0, 200)).join('\n'));

console.log('\n  Note: jsdom has no WebGL, so MapLibre does not initialise here and the');
console.log('  app runs its PlaceholderMapAdapter fallback. Tiles, layer rendering and');
console.log('  anything visual still need verification on a real device.');

dom.window.close();
process.exit(summary());

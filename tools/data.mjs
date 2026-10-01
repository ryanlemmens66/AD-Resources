/*
  tools/data.mjs -- export and import the app's embedded datasets.

    node tools/data.mjs list
    node tools/data.mjs export <dataset> <file.csv | file.geojson>
    node tools/data.mjs import <dataset> <file.csv | file.geojson> [--apply]
    node tools/data.mjs import aerodromes-lzs <Aerodromes & LZs workbook.xlsx> [--apply]

  Every static map dataset (LZs, Air Desk Guidance, hospitals, jetties ...) is
  a JSON block in the app, <script type="application/json" id="airdesk-data-ID">.
  Export writes it out for editing; CSV (Excel) works for point datasets such as
  aerodromes-lzs, GeoJSON for any dataset. Import validates the file, keeps each
  surviving site's id (matched by id, else by name and position), numbers new
  sites, and prints what would change. Nothing is written without --apply.

  The Aerodromes & LZs workbook (.xlsx, one sheet per region) imports directly; see
  tools/lz-workbook.mjs. Its "LZ ID" is the site's permanent id and replaces the app's id:
  a workbook row matches the current site with the same id, else the same name (nearest),
  else the site within MATCH_METRES (renamed), so the change list shows renames as renames.
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { APP_FILE, datasetSource } from './lib.mjs';
import { readLzWorkbook } from './lz-workbook.mjs';

const MOVED_METRES = 100;
const MATCH_METRES = 50;
/* The workbook's StatusList. Status is shown in the site popup; it does not hide a site. */
const LZ_STATUSES = ['Active', 'Temporary', 'Review Required', 'Inactive', 'Expired'];
/* Field rules. Enumerations come from the app where it defines them, so the
   tool cannot drift from the renderer. */
const DATE_FIELDS = new Set(['lastVerified', 'expiryDate']);
function rulesFor(dataset, src) {
  if (dataset !== 'aerodromes-lzs') return { required: ['name'], enums: {} };
  const defs = /const LZ_PRIORITY_DEFS=Object\.freeze\(\{([\s\S]*?)\n  \}\);/.exec(src)?.[1] || '';
  const priorities = [...defs.matchAll(/'([^']+)':Object\.freeze/g)].map(m => m[1]);
  if (!priorities.length) throw new Error('LZ_PRIORITY_DEFS not found in the app');
  return { required: ['name', 'region', 'siteType', 'operationalPriority', 'status'],
    enums: { operationalPriority: priorities, status: LZ_STATUSES } };
}

const [command, dataset, file, ...flags] = process.argv.slice(2);
const src = readFileSync(APP_FILE, 'utf8');
const blockIds = [...src.matchAll(/<script type="application\/json" id="airdesk-data-([^"]+)">/g)].map(m => m[1]);
const usage = () => { console.log('Usage: node tools/data.mjs list | export <dataset> <file> | import <dataset> <file> [--apply]'); process.exit(2); };
const die = message => { console.error(`\n  ${message}\n`); process.exit(1); };

if (command === 'list') {
  for (const id of blockIds) {
    const value = JSON.parse(datasetSource(src, id));
    const features = value.features || [];
    const kinds = [...new Set(features.map(f => f.geometry?.type))].join('/') || 'array';
    console.log(`  ${id.padEnd(22)} ${String(features.length || value.length).padStart(5)} ${features.length ? 'features' : 'entries '}  ${kinds}`);
  }
  process.exit(0);
}
if (!['export', 'import'].includes(command) || !dataset || !file) usage();
if (!blockIds.includes(dataset)) die(`Unknown dataset "${dataset}". Run: node tools/data.mjs list`);
const current = JSON.parse(datasetSource(src, dataset));
if (!Array.isArray(current.features)) die(`${dataset} is not a FeatureCollection; edit it as GeoJSON in the app.`);
const isCsv = /\.csv$/i.test(file);
const isWorkbook = /\.xlsx$/i.test(file);
if (isWorkbook && dataset !== 'aerodromes-lzs') die('Only aerodromes-lzs imports from a workbook (.xlsx).');
if (isWorkbook && command === 'export') die('Export writes CSV or GeoJSON; the workbook stays the maintained source.');
const isPointSet = current.features.every(f => f.geometry?.type === 'Point');
if (isCsv && !isPointSet) die(`${dataset} has lines or areas; use a .geojson file.`);
const columns = [...new Set(current.features.flatMap(f => Object.keys(f.properties || {})))];
/* CSV is text; columns that hold numbers in the app are read back as numbers. */
const numeric = new Set(columns.filter(k => current.features.some(f => typeof f.properties[k] === 'number') &&
  current.features.every(f => ['number', 'undefined'].includes(typeof f.properties[k]))));

/* ------------------------------------------------------------------ CSV -- */
const csvCell = v => /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell); if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

if (command === 'export') {
  if (isCsv) {
    const header = [...columns, 'latitude', 'longitude'];
    const lines = current.features.map(f => [...columns.map(k => String(f.properties[k] ?? '')),
      String(f.geometry.coordinates[1]), String(f.geometry.coordinates[0])].map(csvCell).join(','));
    writeFileSync(file, '﻿' + [header.join(','), ...lines].join('\r\n') + '\r\n');
  } else {
    writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  }
  console.log(`Exported ${current.features.length} ${dataset} features to ${file}`);
  process.exit(0);
}

/* --------------------------------------------------------------- import -- */
const rules = rulesFor(dataset, src);
const problems = [], warnings = [];
let incoming;
if (isWorkbook) {
  const workbook = readLzWorkbook(file);
  problems.push(...workbook.problems);
  for (const status of workbook.statusList.filter(s => !LZ_STATUSES.includes(s)))
    problems.push(`workbook StatusList has "${status}", which the import does not know; add it to LZ_STATUSES in tools/data.mjs`);
  incoming = workbook.incoming;
  const seenIds = new Set();
  for (const { line, feature } of incoming) {
    const id = feature.properties.id;
    if (!/^LZ-\d{6}$/.test(id)) problems.push(`${line} (${feature.properties.name || 'unnamed'}): LZ ID "${id}" is not LZ-000000 form`);
    else if (seenIds.has(id)) problems.push(`${line}: duplicate LZ ID "${id}"`);
    seenIds.add(id);
  }
} else if (isCsv) {
  const [header, ...rows] = parseCsv(readFileSync(file, 'utf8'));
  const names = header.map(h => h.trim());
  for (const need of [...columns.filter(c => c !== 'id'), 'latitude', 'longitude'])
    if (!names.includes(need)) problems.push(`missing column "${need}"`);
  for (const extra of names.filter(n => !columns.includes(n) && n !== 'latitude' && n !== 'longitude'))
    problems.push(`unknown column "${extra}" (the app would not show it)`);
  if (problems.length) die(`${file}: ${problems.join('; ')}`);
  incoming = rows.map((cells, i) => {
    const get = k => (cells[names.indexOf(k)] ?? '').trim();
    const properties = Object.fromEntries(columns.map(k => [k, names.includes(k) ? get(k) : '']));
    for (const k of numeric) {
      const n = Number(properties[k]);
      if (properties[k] === '' || !Number.isFinite(n)) problems.push(`line ${i + 2} (${properties.name || 'unnamed'}): ${k} "${properties[k]}" must be a number`);
      properties[k] = n;
    }
    return { line: i + 2, feature: { type: 'Feature', properties,
      geometry: { type: 'Point', coordinates: [Number(get('longitude')), Number(get('latitude'))] } } };
  });
} else {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(value.features)) die(`${file} is not a GeoJSON FeatureCollection`);
  incoming = value.features.map((feature, i) => ({ line: `feature ${i + 1}`, feature }));
}

const inNz = ([lng, lat]) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= -53 && lat <= -29 &&
  ((lng >= 165 && lng <= 179.99) || (lng >= -177 && lng <= -175.5));
const pointsOf = g => g?.type === 'Point' ? [g.coordinates] : (g?.coordinates || []).flat(3).reduce((a, v, i, all) => (i % 2 ? a : [...a, [v, all[i + 1]]]), []);
for (const { line, feature } of incoming) {
  const p = feature.properties || (feature.properties = {});
  const where = `${line} (${p.name || 'unnamed'})`;
  for (const k of rules.required) if (!String(p[k] ?? '').trim()) problems.push(`${where}: ${k} is blank`);
  for (const [k, allowed] of Object.entries(rules.enums))
    if (p[k] && !allowed.includes(p[k])) problems.push(`${where}: ${k} "${p[k]}" is not one of ${allowed.join(', ')}`);
  for (const k of DATE_FIELDS)
    if (p[k] && !/^\d{2}\/\d{2}\/\d{4}$/.test(p[k])) warnings.push(`${where}: ${k} "${p[k]}" is not DD/MM/YYYY`);
  const pts = feature.geometry?.type === 'Point' ? [feature.geometry.coordinates] : [];
  if (feature.geometry?.type === 'Point' && !inNz(pts[0])) problems.push(`${where}: coordinates are not in New Zealand`);
  if (!feature.geometry) problems.push(`${where}: no geometry`);
}

/* Ids: keep a given id; otherwise reuse the id of the unclaimed current site with
   the same name, nearest first; otherwise number a new one after the highest. */
const norm = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const firstPoint = f => pointsOf(f.geometry)[0] || [0, 0];
const metres = (a, b) => { const r = x => x * Math.PI / 180, dLat = r(b[1] - a[1]), dLng = r(b[0] - a[0]);
  return 12742000 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(dLng / 2) ** 2)); };
const byId = new Map(current.features.map(f => [f.properties.id, f]));
const claimed = new Set(incoming.map(x => x.feature.properties.id).filter(id => byId.has(id)));
if (!isWorkbook) {
  const unknownIds = incoming.map(x => x.feature.properties.id).filter(id => id && !byId.has(id));
  for (const id of unknownIds) problems.push(`id "${id}" is not in the current dataset; leave id blank for a new site`);
}
const seen = new Set();
for (const { line, feature } of incoming) {
  const id = feature.properties.id;
  if (id && seen.has(id)) problems.push(`${line}: duplicate id "${id}"`);
  if (id) seen.add(id);
}
const idPattern = /^(.*?)(\d+)$/;
const prefix = (current.features.map(f => idPattern.exec(f.properties.id)?.[1]).find(Boolean)) || `${dataset}-`;
let next = Math.max(0, ...current.features.map(f => Number(idPattern.exec(f.properties.id)?.[2] || 0))) + 1;
const added = [];
/* The current site each incoming row replaces (none for a new site). */
const matchOf = new Map();
for (const { feature } of incoming) if (byId.has(feature.properties.id)) matchOf.set(feature, byId.get(feature.properties.id));
const unclaimed = f => !claimed.has(f.properties.id);
const byDistance = feature => (a, b) => metres(firstPoint(a), firstPoint(feature)) - metres(firstPoint(b), firstPoint(feature));
for (const pass of ['name', 'position']) for (const { feature } of incoming) {
  if (matchOf.has(feature) || (!isWorkbook && feature.properties.id)) continue;
  const candidates = current.features.filter(f => unclaimed(f) && (pass === 'name'
    ? norm(f.properties.name) === norm(feature.properties.name)
    : isWorkbook && metres(firstPoint(f), firstPoint(feature)) <= MATCH_METRES)).sort(byDistance(feature));
  if (candidates.length) { matchOf.set(feature, candidates[0]); claimed.add(candidates[0].properties.id); }
}
for (const { feature } of incoming) {
  const was = matchOf.get(feature);
  if (!isWorkbook && !feature.properties.id) feature.properties.id = was ? was.properties.id : `${prefix}${next++}`;
  if (!was) added.push(feature);
}
/* id stays the first property, as everywhere else in the app */
for (const { feature } of incoming) {
  const { id, ...rest } = feature.properties;
  feature.properties = { id, ...rest };
}

if (problems.length) die(`${problems.length} problem(s) in ${file}; nothing was changed:\n    ${problems.slice(0, 40).join('\n    ')}${problems.length > 40 ? `\n    ...and ${problems.length - 40} more` : ''}`);

const after = new Map(incoming.map(x => [x.feature.properties.id, x.feature]));
const replaced = new Set([...matchOf.values()]);
const removed = current.features.filter(f => !replaced.has(f));
const renamed = [], moved = [], edited = [], idsAdopted = [];
for (const [id, f] of after) {
  const was = matchOf.get(f); if (!was) continue;
  if (was.properties.id !== id) idsAdopted.push(`${was.properties.id} -> ${id} ${f.properties.name}`);
  if (was.properties.name !== f.properties.name) renamed.push(`${id}: ${was.properties.name} -> ${f.properties.name}`);
  const d = metres(firstPoint(was), firstPoint(f));
  if (d > MOVED_METRES) moved.push(`${id} ${f.properties.name}: moved ${Math.round(d)} m`);
  const changed = Object.keys({ ...was.properties, ...f.properties }).filter(k => k !== 'name' && k !== 'id' && String(was.properties[k] ?? '') !== String(f.properties[k] ?? ''));
  if (changed.length) edited.push(`${id} ${f.properties.name}: ${changed.join(', ')}`);
}
const show = (title, list) => { console.log(`  ${title}: ${list.length}`); list.slice(0, 25).forEach(x => console.log(`      ${x}`)); if (list.length > 25) console.log(`      ...and ${list.length - 25} more`); };
console.log(`\n${dataset}: ${current.features.length} -> ${after.size} features`);
show('added', added.map(f => `${f.properties.id} ${f.properties.name}`));
show('removed', removed.map(f => `${f.properties.id} ${f.properties.name}`));
show('renamed', renamed);
show(`moved more than ${MOVED_METRES} m`, moved);
show('other fields changed', edited);
if (idsAdopted.length) show('ids taken from the workbook (same site, new permanent id)', idsAdopted);
if (warnings.length) show('check these values (not blocking)', warnings);

if (!flags.includes('--apply')) { console.log('\nDry run: nothing written. Review the changes above, then re-run with --apply.\n'); process.exit(0); }

/* keep each surviving feature's key order, so an unchanged site is an unchanged line */
const ordered = f => { const was = matchOf.get(f); if (!was) return f;
  return Object.fromEntries([...Object.keys(was), ...Object.keys(f)].filter((k, i, all) => all.indexOf(k) === i && k in f).map(k => [k, f[k]])); };
const rows = incoming.map(x => JSON.stringify(ordered(x.feature))).join(',\n');
const { features, ...top } = current;
const head = JSON.stringify(top);
const body = `${head.slice(0, -1)}${Object.keys(top).length ? ',' : ''}"features":[\n${rows}\n]}`.replaceAll('</', '<\\/');
const open = `<script type="application/json" id="airdesk-data-${dataset}">`;
const start = src.indexOf(open) + open.length, end = src.indexOf('</script>', start);
writeFileSync(APP_FILE, `${src.slice(0, start)}\n${body}\n${src.slice(end)}`);
console.log(`\nWrote ${after.size} features to ${APP_FILE}.
Next, in the same release:
  1. Set dataVersion and reviewedDate for "${dataset}" in CONFIG.mapLayers (#airdesk-core-config),
     and APP.dataVersion to the verification date.
  2. node tools/dataset-baseline.mjs   (records the new id set; review the diff first. The first
     workbook import replaces every LZ id, so the id check reports a wholesale change until then.)
  3. Record the import in CHANGELOG.md, then npm run test:all.\n`);

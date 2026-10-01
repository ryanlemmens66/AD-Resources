/*
  tools/dataset-baseline.mjs -- records the feature count and full id set of
  every protected dataset in tools/dataset-baseline.json. tools/check.mjs fails
  when ids are dropped, duplicated or renumbered wholesale. Run it only after an
  approved import, in the same release: node tools/dataset-baseline.mjs
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { APP_FILE, datasetSource } from './lib.mjs';

/* Each embedded dataset with feature ids is baselined on its own, so a loss
   from a small dataset cannot hide behind a large one. */
export const PROTECTED_DATASETS = [
  'aerodromes-lzs', 'air-desk-guidance', 'ifr-routes', 'hospitals', 'hems-bases',
  'marlborough-jetties', 'huts-campsites', 'maternity-units', 'medical-centres',
  'ambulance-locations', 'fenz-locations', 'coastguard-locations', 'slsnz-locations'
];

export function countAndIds(text) {
  const features = (text.match(/"type"\s*:\s*"Feature"/g) || []).length;
  const ids = [...text.matchAll(/"properties"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/g)].map(x => x[1]);
  return { features, ids: [...new Set(ids)].sort() };
}

/* One line per dataset: the id lists are machine-checked, not read. */
export function serialise(baseline) {
  const { datasets, ...head } = baseline;
  const rows = Object.entries(datasets).map(([id, v]) => `    ${JSON.stringify(id)}: ${JSON.stringify(v)}`);
  return `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "datasets": {\n${rows.join(',\n')}\n  }\n}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const src = readFileSync(APP_FILE, 'utf8');
  const datasets = {};
  for (const id of PROTECTED_DATASETS) {
    const text = datasetSource(src, id);
    if (text == null) throw new Error(`dataset ${id} not found in ${APP_FILE}`);
    datasets[id] = countAndIds(text);
  }
  writeFileSync(new URL('./dataset-baseline.json', import.meta.url), serialise({
    note: 'Feature counts and the full id set of every protected dataset. tools/check.mjs fails if ids are dropped, duplicated, or renumbered wholesale, and prints the added/removed diff for anything smaller. Regenerate only after an approved import: node tools/dataset-baseline.mjs',
    updated: new Date().toISOString().slice(0, 10),
    appVersion: (/version:\s*'([\d.]+)'/.exec(src) || [, 'unknown'])[1],
    datasets
  }));
  console.log(Object.entries(datasets).map(([k, v]) => `  ${k}: ${v.features} features, ${v.ids.length} ids`).join('\n'));
}

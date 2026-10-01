/**
 * Shared helpers for the audit scripts: locating the app file, reading the
 * deployment config, and printing consistent pass/fail output.
 *
 * Ported from the Clinical Hub Resources audit suite. The two apps are
 * separate codebases but share this reporting shape deliberately, so output
 * from either reads the same way.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

/**
 * The app filename carries the version (AirDesk-v<n>.<n>.html), so it is
 * discovered rather than hard-coded — otherwise every version bump would
 * also have to edit this file, and forgetting would look like a missing app
 * rather than a stale path.
 */
function findApp() {
  const matches = readdirSync(repo)
    .filter(f => /^AirDesk-v[\d.]+\.html$/i.test(f))
    .sort();
  if (matches.length === 1) return join(repo, matches[0]);
  if (matches.length === 0) {
    console.error(`Cannot find an AirDesk-v*.html file in ${repo}`);
    process.exit(2);
  }
  console.error(`Found more than one AirDesk-v*.html: ${matches.join(', ')}`);
  console.error('Exactly one build should be present — delete the superseded one.');
  process.exit(2);
}

export const APP_FILE = findApp();
export const APP_NAME = APP_FILE.slice(repo.length + 1);
export const REPO_DIR = repo;

if (!existsSync(APP_FILE)) {
  console.error(`Cannot find the app at ${APP_FILE}`);
  process.exit(2);
}

/**
 * Issued Tasking & Clinical Guidance metadata, read from the attributes of the
 * guidance template -- the single source. Checks compare against this rather
 * than repeating the version and dates, so a new PDF is recorded in one place.
 */
export function guidanceMeta() {
  const tag = /<template[^>]*id="airdesk-tasking-clinical-guidance-content"[^>]*>/i.exec(readFileSync(APP_FILE, 'utf8'))?.[0] || '';
  const attr = name => new RegExp(`${name}="([^"]+)"`, 'i').exec(tag)?.[1] || '';
  return Object.freeze({
    version: attr('data-guidance-version'), documentDate: attr('data-document-date'),
    controlDate: attr('data-document-control-date'), approvedDate: attr('data-approved-date'),
    pages: attr('data-source-pages'), sections: attr('data-source-sections'), sha256: attr('data-source-sha256')
  });
}

/**
 * Embedded datasets live in JSON blocks, <script type="application/json"
 * id="airdesk-data-ID">. Returns the text of dataset ID, or null.
 */
export function datasetSource(src, id) {
  const block = new RegExp(`<script type="application/json" id="airdesk-data-${id}">([\\s\\S]*?)<\\/script>`).exec(src);
  return block ? block[1] : null;
}

/** Raw netlify.toml text, or '' when it is absent. */
export function netlifyToml() {
  try { return readFileSync(join(repo, 'netlify.toml'), 'utf8'); } catch { return ''; }
}

/* ------------------------------------------------------------- reporting -- */
let passes = 0;
let failures = 0;
let warnings = 0;

export function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/** Record a check. `detail` is printed only on failure. */
export function ok(condition, label, detail = '') {
  if (condition) {
    passes++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}`);
    if (detail) String(detail).split('\n').forEach(l => console.log(`        ${l}`));
  }
}

/**
 * A check that reports a real condition but must not fail the build — used
 * for conditions that are deliberately non-blocking (for example an approved
 * dataset-id delta awaiting baseline refresh) rather than defects. Visible every
 * run so a non-blocking decision cannot go quiet.
 */
export function note(condition, label, detail = '') {
  if (condition) {
    passes++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}`);
  } else {
    warnings++;
    console.log(`  \x1b[33mOPEN\x1b[0m  ${label}`);
    if (detail) String(detail).split('\n').forEach(l => console.log(`        ${l}`));
  }
}

export function fail(label, detail = '') { ok(false, label, detail); }

/** Print the tally and return the exit code to use. */
export function summary() {
  console.log('');
  const openPart = warnings ? `, \x1b[33m${warnings} open decision(s)\x1b[0m` : '';
  if (failures) console.log(`\x1b[31m${failures} check(s) failed\x1b[0m, ${passes} passed${openPart}`);
  else console.log(`\x1b[32mAll ${passes} checks passed\x1b[0m${openPart}`);
  return failures ? 1 : 0;
}

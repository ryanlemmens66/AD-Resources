# AirDesk — National Air Desk Resources

A single-file operational desk tool for the Hato Hone St John National Air Desk
(New Zealand): Primary taskings, interhospital transfer, search and rescue, and
a live scene map.

> **Status:** v6.2 **Stable Production Baseline**, build `20260930.1`, released
> 30 September 2026 and signed off by the owner that day for live operational use at
> <https://airdeskresources.netlify.app/>. It is v6.1 with display fixes, the Closest
> Known LZ filter and the LZ workbook and guidance comparison tools (see CHANGELOG.md);
> the live-origin smoke test is recorded below after upload. The immediate
> rollback release is v6.1 (build `20260928.15`, signed off 2026-09-28,
> `AD-Resources-v6.1-Stable.zip`), then v6.0, both held unchanged on the owner's
> computer. Embedded
> datasets were last verified 2026-09-24 (`APP.dataVersion` `2026.09.24`); every
> content and clinical catalogue entry was reviewed by the owner on 2026-09-28.
> Owner: Ryan Lemmens.

## What's in the package

| File | Purpose |
|---|---|
| `AirDesk-v6.2.html` | The whole application: markup, styles, scripts, datasets, fonts and the bundled MapLibre GL JS. The deliverable and the source of truth. |
| `sw.js` | Offline shell worker. Caches the HTML only, so a reload during an outage still opens the datasets, reference content and response calculation. |
| `netlify.toml` | Root rewrite, NZTA same-origin proxy, cache policy, security headers and CSP. |
| `README.md` | This handbook: deployment, credentials, sign-off. |
| `ARCHITECTURE.md` | Maintainer guide: structure, design decisions, update routes, checks. |
| `CHANGELOG.md` | Release history. |
| `NOTICE.md` | Copyright status (deliberately no `LICENSE`). |
| `package.json`, `package-lock.json`, `tools/` | Locked verification tooling and the dataset import/export tool. The app itself has no dependencies and no build step. |

Exactly one `AirDesk-v*.html` should be present; the tools discover it by name.

## Deployment

Upload the complete release ZIP to Netlify with its structure intact.
`netlify.toml` returns 404 for the maintainer files (docs, `tools/`, package
files and the toml itself), so only the app, `sw.js` and the NZTA proxy are
public. If you add a maintainer file, add a matching rule.

Three parts of `netlify.toml` are load-bearing:

- **The root rewrite.** The HTML is versioned, not `index.html`, so without
  `from = "/"` the site root is a 404 while the versioned URL still works. On a
  version bump, rename the file and update both rewrites; `npm run check`
  enforces it.
- **The NZTA proxy.** The road-warnings layer tries the ArcGIS FeatureServer,
  then `/airdesk-nzta-delays.json`, then the CORS-locked Journeys URL. The
  rewrite is the only fallback that can succeed; it exists only on Netlify.
- **`Referrer-Policy: strict-origin-when-cross-origin`**, so provider-side
  website restrictions can work where configured.

The configured build command (`node tools/check.mjs`) re-checks the static suite
only when Netlify actually runs a build; a manual upload may not. The local
`npm run test:all` is the release gate. Release ZIPs, including every rollback
edition, are kept offline on the owner's computer; no repository, CI or cloud
storage is part of releasing or rolling back.

**Offline and updates.** The worker is network-first with a three-second
timeout and caches the application shell only. Live feeds, tiles and provider
responses are never cached, so stale operational data cannot appear current.
After an upload, one online reload picks up the new HTML; during a network
timeout or host failure the previously saved shell may open. The header chip and
System Status show the running version and build.

## Credentials and providers

Four client-side credentials are expected, each in one canonical place
(`npm run check` enforces locations and single-sourcing). They are visible by
design: a browser app cannot keep them secret.

- **Google Maps Platform** (`runtimeConfig.googleMapsApiKey`) is shared with
  Clinical Hub Resources, so its API restriction list is the union of both apps:
  Routes, Geocoding, Maps JavaScript (for elevation), Maps Elevation, Weather
  (AirDesk) and Address Validation (Clinical Hub). The referrer restriction
  needs both Netlify origins. Places API stays disabled.
- **LINZ Basemaps** (`runtimeConfig.linzApiKey`) and **LINZ Data Service**
  (`runtimeConfig.linzDataServiceApiKey`, Powerlines WFS) are separate keys;
  never merge them during rotation.
- **Firebase** (`#airdesk-firebase-config`, project `air-desk-resources`,
  Realtime Database in `asia-southeast1`) holds the shared board: handover,
  shift notes, Heli Status. The web key is public by design; the Security Rules
  are the control and must allow read/write under `airdesk`.
- **TracPlus** positions come through the owner's Cloudflare Worker.

Provider pricing and allowances change independently, so they are not recorded
here; check the consoles before changing quotas. The request pattern is:

| Action | Provider work |
|---|---|
| Scene search by address | Geocoding, then a road route |
| Scene by DDM/lat-long or from the map | Road route only |
| Change hospital/base or pick a live aircraft | Road route |
| Open Compare Hospitals | One route matrix |
| Open Scene Weather | Weather lookup, cached per coordinate |
| Drop an LZ pin | Elevation sampling, cached per coordinate |
| SAR scene search | Geocoding/reverse geocoding, no road route |

Routing is traffic-aware; do not change that for cost without an operational
decision. If a quota or provider fails, road times fall back to `~N min (est.)`,
and elevation, weather and compare fail inside their own panels. Address search
needs geocoding, but coordinates still work. Calls may fail from `file://` or an
unapproved origin; the supported production path is the deployed HTTPS origin.

## Routine content updates

Content changes are data edits with a checked import, never code edits.
`ARCHITECTURE.md` (*Update routes*) has the full rules.

- **LZs.** The Aerodromes & LZs workbook is the maintained source and imports
  as it is: `node tools/data.mjs import aerodromes-lzs "Aerodromes & LZs.xlsx"`.
  Each site keeps the workbook's permanent **LZ ID**, so renamed and moved sites
  stay the same site. The import is a dry run that validates every row and lists
  what would be added, removed, renamed, moved or edited; add `--apply` once it
  matches the approved change.
- **Other map data.** `node tools/data.mjs export <dataset> file.csv`, edit in
  Excel, then `node tools/data.mjs import <dataset> file.csv` (dry run, then
  `--apply`). `node tools/data.mjs list` names every dataset.
- **Tasking & Clinical Guidance.** `npm run guidance -- "<new PDF>"` lists every
  section whose wording differs from the app, and any new or missing sections. The
  listed sections are updated in the guidance template by hand, then its System
  Status entry, `APPROVED_GUIDANCE` in `tools/check.mjs` and the comparison
  baseline; the checks require all of them to agree.
- **Timings and defaults.** Change the value once in `AirDesk.rules`.

Then follow the release procedure below.

## Release procedure

1. Start from the last fully tested ZIP; never develop in the deployed copy.
2. For a new version, rename the file and update `APP.version`, package
   metadata and both Netlify rewrites. For a working build of the same version,
   increment `APP.buildId` and keep `APP.buildDate` and the header build date
   aligned. Change `APP.baseline` and the header baseline line only when a
   release is formally adopted as the stable baseline.
3. Record the change in `CHANGELOG.md`.
4. `npm ci` and `npm run test:all`; for visual or CSS changes, also run the
   visual baseline/compare workflow. Fix failures rather than weakening a check.
5. Package the project contents at the ZIP root (no `node_modules`,
   screenshots or temporary files), verify the archive, and record the app
   file's SHA-256 in the sign-off record so the single ZIP carries its own
   integrity check (`shasum -a 256 AirDesk-v6.2.html`, or `certutil -hashfile
   AirDesk-v6.2.html SHA256` on Windows).
6. Upload (*Deployment*), run the live-origin smoke test and complete the
   sign-off record (*Production sign-off*). If the smoke test fails, redeploy
   the previous ZIP (*Rollback*) and record why.
7. Tell the desk to reload once online; iPhone/iPad Home Screen users remove and
   re-add the AirDesk icon so iOS captures the new launch screen.
8. Keep the new ZIP and the previous production ZIP on the owner's computer; the
   previous one is the rollback artifact.

## Production sign-off

### A. Controls carried forward (confirmed 2026-09-24)

The production owner, **Ryan Lemmens**, confirmed these for the v6.0 freeze.
v6.1 and v6.2 change none of the keys, origins, provider APIs, Firebase paths, CSP
origins or datasets they cover, so they carry forward. Reconfirm one only if
its subject changes.

1. **Google Maps** restrictions in place; changes must keep both apps' origins
   and APIs.
2. **LINZ Basemaps and Data Service** restrictions in place; keys distinct and
   single-source.
3. **Firebase** production controls in place; the Security Rules are
   authoritative and must be reviewed if the access model changes.
4. **Operational sources** closed: SH6 Haast to Lake Moeraki closed until
   further notice; the PARAPARA 30-minute road-time adjustment permanent; Waihi
   Bowling Club the active LZ replacing Morgan Park. Future changes need an
   approved source or owner confirmation.
5. **TracPlus Worker** arrangement accepted; an endpoint change updates the
   service registry, CSP and this record together.

### B. Before upload

6. `npm run test:all` passes on a maintainer computer.
7. The operational owner confirms the embedded Tasking & Clinical Guidance
   (v2.01, 15 May 2026), hospital, LZ and pathway data are current. The checks
   prove the content is intact, not that it is clinically current.

### C. Live-origin smoke test (after upload)

8. Open the **root** production URL and confirm:
   - **Identity:** the header chip reads **v6.2**; System Status shows build
     **20260930.1** and baseline *6.2 Stable Production*. On a phone the chip
     is hidden by design; the green-dot Desk Status panel shows the build.
   - **Self-check:** System Status → Run Self-check reads *All deployment checks
     passed.* and Secure deployment shows *HTTPS is active.*
   - **Workflows:** Primary, Transfers, SAR and Resources open; one real address
     search returns a live road time (not `~N min (est.)`).
   - **Live services:** map tiles on Auto, Topo and Aerial; TracPlus aircraft
     fresh in System Status; Scene Weather; NZTA warnings; Heli Status and Shift
     Notes load, and a test note syncs to a second device (then remove it).
   - **Board View, Tasking & Clinical Guidance and CAD outputs** open and copy.
   - **Offline:** after one online load, reload with the network off; the shell,
     reference content and response calculation open. Reconnect and confirm the
     live feeds recover.
   - **iPhone/iPad Home Screen:** remove the old icon, open the URL in Safari,
     wait a few seconds, Add to Home Screen, and launch: one continuous green
     splash, header clear of the status bar, in portrait and landscape.
   - **Citrix desk:** the real session loads, Citrix mode can be chosen, and the
     map performs acceptably.

### D. Sign-off record

| Field | Value |
|---|---|
| Release | AirDesk v6.2, build `20260930.1`, Stable Production Baseline (v6.1 with display fixes) |
| Release file | `AD-Resources-v6.2-Stable.zip`, kept on the owner's computer; `AirDesk-v6.2.html` SHA-256 `b1689eccbb888a6763aab1a8be1894e0fa4c353abd452eac752133b9299a4199` |
| Production URL | <https://airdeskresources.netlify.app/> |
| A. Controls carried forward | 2026-09-24 |
| B6. Automated gate | Passed 2026-09-30 (`npm run test:all`, visual comparison reviewed) |
| B7. Content owner confirmation | Carried forward: no content changed in v6.2. Ryan Lemmens, 2026-09-28: embedded guidance, hospital, LZ, pathway and all catalogue content confirmed current; catalogue review dates recorded as 2026-09-28 |
| C8. Smoke test and real devices | v6.2: to record after upload (tester, date, devices). Also check the map opens and resets to the whole of New Zealand on the phone, iPad, desktop and Citrix desk, and that Closest Known LZ does not offer Morgan Park. (v6.1: Ryan Lemmens, 2026-09-28, every check in C8 complete.) |
| Rollback artifact | v6.1 (`AD-Resources-v6.1-Stable.zip`, build `20260928.15`), then the v6.0 ZIP, held unchanged on the owner's computer |
| Production owner sign-off | Ryan Lemmens, 2026-09-30: v6.2 signed off for live operational use. (v6.1: Ryan Lemmens, 2026-09-28.) |

### Rollback

If the smoke test or live use shows a defect that affects operations, do not
patch the live copy. Upload the v6.1 ZIP from the owner's computer to the same
Netlify site (or use Netlify's *Publish deploy* on the previous deploy), reload
every desk once online, and confirm the chip reads v6.1. Record the reason in
`CHANGELOG.md` and fix forward from the v6.2 ZIP.

## Ownership

Ryan Lemmens owns AirDesk and this documentation, and holds operational and
technical ownership, including the Netlify site, Google Cloud project, Firebase
project, both LINZ credentials and the TracPlus Worker, unless ownership is
formally handed over. If it moves to another person or team, update `GOVERNANCE`
in `#airdesk-core-config`, this README and `NOTICE.md`, the SharePoint links in
the app (for example Helicopter Info), and record the transfer as its own
release.

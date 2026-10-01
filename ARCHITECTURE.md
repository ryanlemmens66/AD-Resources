# AirDesk architecture and maintenance

The maintainer guide for the AirDesk application file, currently `AirDesk-v6.2.html`.
`README.md` covers deployment, credentials and production sign-off; `CHANGELOG.md`
the release history.

## Reading order

1. This file, then the short comment block at the top of the HTML (release
   identity and the maintenance rules).
2. `README.md`: deployment, credentials, sign-off.
3. With Node 20 or later: `npm ci`, then `npm run test:all`. Everything should
   pass before you change anything.

## The file

One HTML file of about 4.5 MB with no build step: open it and it runs. `sw.js`
beside it is an optional offline shell. Most of the weight is approved reference
data and the bundled map library, not application logic:

| Part | Approx. size |
|---|---:|
| Embedded datasets (JSON blocks) and the inert guidance template | ~2.5 MB |
| MapLibre GL JS 4.5.0 and its CSS (vendor, do not edit) | ~0.87 MB |
| Embedded fonts (DM Sans, Roboto Mono, woff2) | ~0.17 MB |
| Application stylesheet (`#airdesk-styles`) | ~0.23 MB |
| Application scripts, shell markup and embedded icons | ~0.8 MB |

Every script block has an id and owns one thing. Static datasets sit in JSON
blocks (`airdesk-data-ID`) just before the module that renders them, so data and
code are edited separately (see *Map data update routes*). Modules publish on frozen
namespaces (`AirDesk.primary.sceneLocation`, `AirDesk.map.referenceLayers`,
`AirDesk.system.configStatus`) and reach each other only through them, which is
what lets `tools/verify.mjs` name exactly which module stopped if one aborts.
Events are bound with `addEventListener`; there are no inline `on*` handlers,
no `eval` and no string `setTimeout`.

| Area | Modules |
|---|---|
| Core | `airdesk-core-config` (release identity, `AirDesk.rules`, provider endpoints, governance), `airdesk-shared-utils`, `airdesk-platform-services`, `airdesk-health` |
| Shell | `airdesk-shell-runtime` (tabs, dialogs, System Status), `airdesk-ui-feedback` (busy states, toasts, copy), `airdesk-launch` (splash) |
| Map | `airdesk-map-manager`, `airdesk-map-layer-runtime`, `airdesk-reference-layers`, `airdesk-map-ui`, `airdesk-basemap-controller`, `airdesk-terrain`, `airdesk-measurement`, `airdesk-map-context` |
| Workflows | `airdesk-primary-*`, `airdesk-transfer*`, `airdesk-sar-*`, `airdesk-reset` |
| Datasets | `airdesk-aerodromes-lzs`, `airdesk-aviation-guidance`, `airdesk-clinical-pathway-layers`, `airdesk-hospitals`, `airdesk-hems-bases`, `airdesk-maternity-medical-centres`, `airdesk-emergency-resources`, `airdesk-marlborough-jetties`, `airdesk-huts-campsites` |
| Shared state | `airdesk-shared-sync`, `airdesk-shift-notes-sync`, `airdesk-heli-status-model`, `airdesk-heli-status`, `airdesk-form-persist`, `airdesk-phi` |
| Live feeds | `airdesk-tracplus-*`, `airdesk-nzta`, `airdesk-board-weather` |
| Board View | `airdesk-board-view` |

Shared interaction: `AirDesk.ui.feedback.copy(control, text)` owns copy busy
state, retries and failure feedback; keep document generation in the owning
workflow module. Optional sections update `aria-expanded`; a user deletion
returns focus to Add, programmatic resets never move focus.

## Standing design decisions

Read before editing; each has a reason that is not visible in the code.

- **Typography.** DM Sans for UI, Roboto Mono for callsigns and tails, both
  embedded as woff2 in `#airdesk-fonts`; nothing else is loaded (`npm run check`
  enforces it). Weights are 400-800 in hundreds.
- **Tokens.** Literal values sit on one scale: type 10/11/12/13/14.5/16/18.5/22px,
  radii 6/10/14/18px plus pill and circle, `--shadow-sm/md/lg` for plain shadows.
  Add a new value only as a token. Board View type is `calc()`-scaled by
  `--bs`/`--fit`.
- **Controls.** One close button for every dialog (`.dialog .close`, `.dd-x`,
  `.oa-x`, `.tg-close`): a 32px circle with a drawn X. Selected choices are solid
  green. Icons are SVG, never text characters. Status chips are flat; only
  action buttons carry button chrome.
- **Response Plan cards.** The button row is bottom-anchored and the two cards in
  a row stretch to equal height; the divider above the buttons turns the gap into
  a footer.
- **Auto map.** Default and Reset camera is [172.8, -41.05] at zoom 4.7. On
  Auto/topolite only, island and country labels stay hidden below zoom 7 so they
  do not cover aircraft; Topo and Aerial are untouched.
- **Heli Status.** Capabilities are one synced list per slot: IFR or VFR plus
  Land/Wets/Decks × Day/Night. Legacy Dry/Wet/No Winch and Blood convert on read
  (`normalizeCaps`). Roles come from row position; Edit-mode arrows swap whole
  slots. Each base can hold up to three persisted `additional:true` rows in the
  same `state.slots[baseId]` array; never create a second collection or Firebase
  path. NRES tail memory is per desk (`airdesk-hsb-nres-tail-memory-v1`) and
  never written to Firebase. Routine edits update existing controls in place:
  replacing a select or button mid-event detaches it on iPad.
- **iOS Home Screen launch.** The status bar is black-translucent, so the app
  draws under it; `.header`, the `.app` header row, dialogs and the error banner
  add `env(safe-area-inset-top)` (zero everywhere else). `#airdesk-launch` draws
  the iOS launch image with the same tile as `#airdesk-splash`, and
  `.ads-standalone` stops the splash animating in over it. Change all three
  together or iOS shows two different screens (`npm run check` enforces it).
- **Map attribution.** MapLibre expands its compact attribution when the first
  source reports one; the map manager collapses it once at that moment.
- **Build identity.** `APP.buildId` identifies a working package in System
  Status and the self-check. It does not change storage keys, cache policy or
  the displayed version.

## Stylesheet

`#airdesk-styles` is organised by surface: status utilities, Board View, the
design system and workflows, then interaction feedback, the Citrix profile and
the launch splash. Within a surface each selector is defined once, with its
media and state refinements after it. Short rules sit on one line; longer rules
have one declaration per line.

**`!important` is reserved** for these cases, and nothing else:

- the global `[hidden] { display: none !important }`;
- overriding inline styles: those carried by embedded reference content
  (`.ref-sheet` and guidance) and the Board View notes textarea's inline
  `min-height`;
- overrides of MapLibre's own CSS (attribution control);
- the ETA field input, which suppresses the generic invalid ring inside its
  wrapper;
- shared cross-cutting states: disabled, pressed, busy, invalid, expanded map,
  Board View visibility, reduced motion and the Citrix profile;
- the readable type floor (minimum sizes for small labels in the layers,
  context-menu, terrain and emergency-resource panels).

No component rule carries `!important` outside those cases. Resolve anything
new with specificity and order. Before a visual or CSS change run
`npm run visual:baseline`, and after it `npm run visual:compare`.

The keyboard focus ring (`:is(a,button,[tabindex]):focus-visible`) sets a 10px
radius and outranks single-class component rules. Components with their own
shape restore it in a `:focus-visible` rule: pills, SAR controls and reference
buttons beside the ring, close buttons in their own group. Give any new rounded
control the same.

## Update routes

Each kind of content has one owner. Change it there, never in a downstream
renderer, formula or late override.

### Map data update routes

Every static map dataset is a JSON block in the app, `<script
type="application/json" id="airdesk-data-ID">`, one feature per line, beside the
module that renders it; the module reads it with `AirDesk.util.dataset(ID)`.
Data never lives in code, so an update never touches a renderer. List them with
`node tools/data.mjs list`.

| Dataset id | Source | Rule |
|---|---|---|
| `aerodromes-lzs` | Aerodromes & LZs workbook (.xlsx), imported directly | Replace in full; the workbook's LZ ID is the id. |
| `air-desk-guidance` | 3A Air Desk guidance plus MapIT 8C rafting evac, 8D Makara Peak evac and 8F Taranaki oil/gas points, the 12 NM limit and the 40 km road-distance trauma rings | Keep ids. Do not import the 40-minute trial rings; airstrips and Jet A1 fuel are excluded. |
| `ifr-routes` | IFR waypoints and airways | Keep ids. |
| `hospitals` | Hospital coordinates, short codes, `helipadToEDMin` | One record per hospital; the map, pickers and calculations all read it. |
| `hems-bases` | Base coordinates and callsign definitions | Keep base ids (calculations, labels and fleet logic use them). |
| `maternity-units`, `medical-centres` | Maternity and medical-centre lists | Replace in full. |
| `ambulance-locations`, `fenz-locations`, `coastguard-locations`, `slsnz-locations` | Emergency-resource packs | Replace in full. |
| `marlborough-jetties`, `huts-campsites` | Their source lists | Keep ids for retained locations. |
| `dhb-regions` | Catchment outlines for the clinical pathway layers | Update with the pathway assignments in `#airdesk-clinical-pathway-layers`; never add a parallel pathway layer. |

To update one:

1. **LZs** import straight from the Aerodromes & LZs workbook (.xlsx);
   `tools/lz-workbook.mjs` reads it. Each region sheet is named for its region,
   titled "<Region> Landing Zones", with the header row `LZ ID`, `LZ Name`,
   `Status`, `Operational Priority`, `LZ Type`, `District`, `Latitude`, `Longitude`,
   `FENZ Required`, `FENZ Notes`, `Last Verified`, `Expiry Date`, `Known Hazards`,
   `LZ Notes`; the Control and `_Lists` sheets are ignored apart from `_Lists`'
   StatusList. The sheet name is the site's region. `LZ ID` (LZ-000000 form) is
   the permanent id: a row matches the current site with that id, else the same
   name (nearest), else the site within 50 m (renamed), so renames and moves show
   as such. Excel dates become DD/MM/YYYY, Windows line breaks plain ones, and
   coordinates keep 8 decimal places. The first workbook import replaces every
   earlier `lz-N` id; nothing in the app or on the desk stores LZ ids.
   **Other point datasets**: `node tools/data.mjs export <dataset> file.csv`, edit in
   Excel; datasets with lines or areas use GeoJSON.
2. `node tools/data.mjs import aerodromes-lzs "Aerodromes & LZs.xlsx"` (or
   `import <dataset> file.csv`) is a dry run. It rejects blank required fields,
   unknown priorities (taken from the app's own definitions) or statuses (the
   workbook's StatusList: Active, Temporary, Review Required, Inactive, Expired),
   malformed or duplicate LZ IDs, text in number columns and coordinates outside
   New Zealand, and lists what would be added, removed, renamed, moved or edited.
   In a CSV, rows with a blank `id` keep the id of the existing site with the same
   name, nearest first; new sites are numbered after the highest id. Status is
   shown in the site popup only; every LZ is drawn and offered by Closest Known LZ
   whatever its status or priority.
3. When the list matches the approved change, re-run with `--apply`.
4. Set the dataset's `dataVersion` and `reviewedDate` in `CONFIG.mapLayers` and
   `APP.dataVersion` to the verification date, run `node tools/dataset-baseline.mjs`,
   record the import in `CHANGELOG.md`, and run `npm run test:all`.

`tools/dataset-baseline.json` protects 4,947 ids across the 13 datasets with
feature ids, each baselined on its own so a loss from a small dataset cannot
hide behind a large one. The check fails on duplicate ids or when fewer than 90%
of baseline ids survive, and lists smaller differences as an open decision
until the baseline is regenerated. Regenerate only after an approved import,
never just to make a check pass.

Four LZ fields are near-empty by history (`expiryDate`, `lastVerified`,
`hazards`, `fenzNotes`); sites added from here carry them. Do not backfill
placeholders. Dates are DD/MM/YYYY; the import lists any other form for review.
TracPlus and NZTA are provider integrations, not dataset imports: changing their
endpoints belongs in `#airdesk-core-config` and may need a CSP or Netlify proxy
change.

### Operational timing and default updates

`AirDesk.rules` in `#airdesk-core-config` is the single source for aviation
(km-to-NM, cruise speed, takeoff delays and the bases they apply to), road
(fallback speed, cushion), response (scene defaults, delays, clinical intercept,
trauma ring) and aircraft (speed thresholds, feed freshness) values. Primary,
IHT, SAR and live-aircraft fallbacks all read them. Hospital-specific
`helipadToEDMin` lives only in the `hospitals` dataset. Change the owning value
once, run the full suite, and compare representative Primary, IHT and SAR
results against the approved source.

### Tasking & Clinical Guidance

The approved National Air Desk Tasking & Operating Guidelines PDF is the
authority. Its wording lives in one inert template,
`#airdesk-tasking-clinical-guidance-content`, never in executable JavaScript;
the renderer provides navigation, search and presentation only. For a new PDF:

1. `npm run guidance -- "Tasking Guidelines V2.xx.pdf"` compares the PDF with the
   embedded wording section by section (`tools/guidance-compare.mjs`, reading the
   PDF with pdfjs-dist). It reports whether the PDF is the approved one, every
   section whose words differ (app only / PDF only), sections it cannot find
   (renumbered, retitled or removed) and numbered PDF headings the app does not
   carry. It changes nothing. Presentation differences for the approved PDF (labels
   the app adds, "For example" shown as an Example box, extraction artefacts) are
   recorded in `tools/guidance-baseline.json` and subtracted, so the approved PDF
   reports no differences and a new one reports only what changed. For each listed
   section, read the PDF page and change the template to match, preserving issued
   numbering and wording (including the source's own duplicate section 4.14 and its
   typos). Re-run until only intended differences remain.
2. Update the template attributes (`data-guidance-version`, document, control
   and approval dates, `data-source-pages`, `data-source-sections`,
   `data-source-sha256` of the new PDF) and each category's section/page map.
   No two categories may claim the same section.
3. Update the `tasking-guidelines` entry in `#airdesk-core-config` (version
   label, and the document date as `reviewedDate`) so System Status reports it.
4. Record the new issue once, in `APPROVED_GUIDANCE` at the top of the guidance
   checks in `tools/check.mjs`. The check requires the template and the
   catalogue entry to match it; the runtime and browser checks read the version
   and date from the template, so nothing else repeats them.
5. Update any other owning module the PDF changes (SAR, hospitals, CAD
   reference, timing rules) in the same release.
6. Re-record the comparison baseline from the new approved PDF:
   `node tools/guidance-compare.mjs "<new PDF>" --record-baseline` (it accepts only
   the PDF whose SHA-256 is pinned in the template; `tools/check.mjs` fails until the
   baseline matches `APPROVED_GUIDANCE`). Then `npm run test:all` and review the
   guidance screens at desktop, iPad and phone width.

## The app validates itself

- `validateConfiguration(CONFIG)` runs at boot: schema version, unique registry
  ids and titles, a `dataVersion` on every static layer, ISO review dates. The
  result is on `AirDesk.system.configStatus` and in System Status.
- `validateFeatures()` throws on a malformed dataset replacement, so the module
  aborts instead of silently registering nothing.
- `OPERATIONAL_REVIEWS` raise a System Status warning once their review date
  passes (the Waitematā STEMI diversion from 4 February 2027).
- `AirDesk.health` tracks feed state and last-confirmed times behind the header
  chip; TracPlus turns Stale after three minutes without a successful poll.
- The System Status self-check reads loaded state only and makes no provider
  request.

## Checks

```bash
npm ci               # locked test dependencies (Node 20+)
npm run check        # static: parsing, markup, config, CSP, keys, datasets, docs
npm run verify       # boots the app in jsdom and asks it about itself
npm test             # check + verify + workflow-check + unit-check
npm run browser      # Chromium at phone, desktop, Citrix and iPad sizes, with Axe
npm run test:all     # npm test + browser: the release gate
npm run visual:baseline && npm run visual:compare   # around visual/CSS changes
```

| Suite | Proves | Cannot see |
|---|---|---|
| `check.mjs` | Scripts parse and dataset blocks are valid JSON, each used by one module; comment and tag balance; no duplicate ids, dead named functions or debug leftovers; version, build date and baseline agree across file, header, chip and docs; Netlify rewrites and private paths; CSP covers every fetched origin; credentials single-source; guidance template, catalogue entry and source map match the approved issue; dataset ids retained | Whether modules run |
| `verify.mjs` | Every subsystem present after boot, configuration valid, 6 providers catalogued, reference data registered, self-check, guidance rendering | Rendering: jsdom has no WebGL, so the map runs its placeholder adapter |
| `workflow-check.mjs` | Forms, calculations, validation, copy recovery, resets and CAD output in a simulated DOM | Live services |
| `unit-check.mjs` | Offline worker, weather states, Auto label policy, reference-layer visibility (including default-on layers switched off) and aircraft advisories against mocks; every dataset round-trips through `tools/data.mjs` unchanged; the LZ workbook import (ids, renames, statuses, dates, line breaks, refusals) | Real outages and tiles |
| `browser-check.mjs` | Real Chromium layout, dialogs, Heli Status boards, serious/critical Axe findings at four sizes | Live providers, real devices, Citrix itself |
| `visual-check.mjs` | 54 screenshots in total (18 screens × desktop, iPad and phone), pixel-compared before and after | States it does not open |

`check` and `verify` are split deliberately: a `throw` at the top of any module
leaves the syntax valid, so `check` stays green while `verify` names the missing
subsystem. Two console errors during `verify` (`createObjectURL is not a
function`, `MapLibre GL JS did not load`) are the placeholder fallback working
and are allowlisted. Checks printed **OPEN** are non-blocking review items.

## Editing traps

- Edit the owning module or stylesheet surface in place. Never append a patch
  script, a CSS override layer or a duplicate dataset.
- `AirDesk.services.catalog` and the CSP `connect-src` in `netlify.toml` move
  together (`check` enforces it).
- A version bump renames the file and updates both rewrites in `netlify.toml`
  and `APP.version`; `check` enforces all three.
- The 68 names in `legacyPaths` are compatibility aliases for old bookmarks and
  snippets. Nothing in the app uses them; do not remove them without checking
  for outside consumers.
- Empty `catch {}` blocks in map, clipboard and URL-parsing paths are
  deliberate: failure there is harmless and has no operator action.
- `textContent` is preferred; treat any new `innerHTML` as a review point and
  keep `rel="noopener"` on new-tab links.
- The map modules wait for the map with bounded retries rather than one ready
  event. Consolidating them needs real-device map testing, because no automated
  suite can see WebGL layers.

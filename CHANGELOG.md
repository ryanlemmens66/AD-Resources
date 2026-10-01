# Release history

Full per-build notes for v5.0–v6.1 are preserved in the earlier release ZIPs
(`AD-Resources-v6.1-Reviewed.zip` and before), kept on the owner's computer.

## v6.2, 2026-09-30 — Stable Production Baseline (build 20260930.1)

Signed off by the owner on 2026-09-30 for live operational use. v6.1 with display
fixes; v6.1 (build 20260928.15) is the rollback release. No dataset, clinical rule, calculation, CAD wording,
provider key, Firebase path, storage key or CSP origin changed; `APP.dataVersion`
remains `2026.09.24`.

- **Map home view.** Opening and Reset used a fixed centre and zoom (4.7), so the
  islands were cut off on phones, iPad portrait and Citrix-sized panes and small on
  large monitors. Both now fit the North, South and Stewart Islands to the map pane
  (`NZ_HOME_BOUNDS`, `homePadding`), clear of the toolbar and status pills, and
  Reset returns to exactly the opening view. Measured: New Zealand whole on every
  size from 360 px phones to 1920 px monitors, filling 78-92% of the pane height.
- **Map card width on phones and iPad portrait.** It sat 12 px wider than the form
  cards on each side; it now takes their inset. Board View and the expanded map
  keep the full width.
- **Chevrons.** The Tasking & Clinical Guidance *Source details* chevron and the HR /
  RR Tap Calculator chevron were ⌄ characters, which sat below the text line and
  jumped when turned. Both are drawn, as the base and hospital pickers already were.
- **Checks.** Static checks for the fitted home view, the map card inset and drawn
  chevrons; a browser check that the phone map card lines up with the form cards.
  All fail on v6.1. `npm run test:all` passes (123 static,
  43 runtime, 66 workflow, 60 unit and 201 browser checks); the visual comparison
  changed only the Tasking & Clinical Guidance header, System Status (build number)
  and the phone map screen.
- **Closest Known LZ** leaves out sites that are Inactive or Expired, or whose
  priority is "Do not use", and offers the next nearest instead. They stay on the
  map, with their status in the popup. Checked against the real LZ pack (Morgan Park,
  Inactive, is no longer offered at its own location; it was before).
- **Guidance comparison.** `npm run guidance -- "<PDF>"` (new
  `tools/guidance-compare.mjs`, with pdfjs-dist as a development dependency) compares
  a Tasking & Operating Guidelines PDF with the embedded wording section by section.
  The approved V2.01 PDF reports no differences across all 96 sections (its
  presentation differences are recorded in `tools/guidance-baseline.json`); a copy
  with two words changed in 4.3 reported exactly that section.
- **LZ workbook.** `tools/data.mjs` imports the Aerodromes & LZs workbook (.xlsx)
  directly (new `tools/lz-workbook.mjs`, no dependencies). The workbook's permanent
  LZ ID becomes the site id, sites renamed in place are matched by position, the
  workbook's statuses (Temporary, Review Required, Expired) are accepted, and Excel
  dates and line breaks are normalised. Tools only: the app is unchanged. Seven new
  unit checks. A dry run of the 30 September workbook matched all 748 sites
  and reported 2 additions, 2 renames and 4 edits; it was not applied.
- **Version.** `AirDesk-v6.2.html`, `APP.version` 6.2, baseline *6.2 Stable
  Production*, package 6.2.0, both Netlify rewrites, and a *What's new* note for 6.2.

## v6.1, 2026-09-28 — Stable Production Baseline (build 20260928.15)

Signed off by the owner on 2026-09-28 for official live use at
<https://airdeskresources.netlify.app/>; v6.0 is the rollback release. No
dataset content, clinical rule, calculation, CAD wording, provider key, Firebase
path, storage key or CSP origin changed from v6.0 except as listed below;
`APP.dataVersion` remains `2026.09.24`.

**Operation**

- Map layers: *Hospitals* and *Air Desk Guidance* start on and now stay off when
  switched off (until switched on or the next reload). The layer restore no
  longer stops part-way through a pass, which the old always-on hook had masked.
- Transfers and SAR fit their points on a small map pane (SAR previously fell
  back to the scene alone); the map renders at up to 2x on phones (was 1.5x).
- Fixed the iOS Home Screen launch showing two different screens.
- Build identity in System Status and Desk Status; SAR and Clinical Advice copy
  recovery; IHT/SAR closer-aircraft advisories; FENZ preview; road-time override
  and CAD destination ordering; Auto island-label policy; "What's new" note.

**Presentation**

- One close button, one segmented selection style, flat status chips, a single
  type/radius/shadow scale, embedded DM Sans and Roboto Mono, and a launch
  splash; equal-height Response Plan cards and aligned calculation rows.
- Slim one-row phone header; card-header actions share the title line when
  they fit; Board View title stays on one line on phones; the Heli Status OOS
  reason menu fits "Mechanical"; the form fades under the tab bar on desktop
  and iPad; keyboard focus keeps each control's shape.
- The *Overdue Aircraft* pill pulses as designed (its animation never ran);
  paused on hover and focus, off for reduced motion and in Citrix mode.

**Code and maintenance**

- Stylesheet rebuilt into one definition per component with no legacy
  overrides: rules 1,942 → 1,529, declarations 7,195 → 6,366, media blocks
  65 → 55, `!important` 298 → 96 (all in the categories in ARCHITECTURE.md).
  Dead rules, dead script branches, patch modules, the retired Map Layers panel
  and version history in comments removed.
- Map data moved out of code into JSON data blocks; `tools/data.mjs` exports and
  imports them with validation, id retention and a reviewable diff. The id
  baseline protects 4,947 ids across 13 datasets.
- The approved guideline issue is recorded once for the checks; documentation
  consolidated into README, ARCHITECTURE and this file; the small mocked suites
  merged into `tools/unit-check.mjs`.

**Verification and sign-off**

- `npm run test:all`, the 54-screen visual comparison, and a computed-style
  comparison of every element across 930 recorded states (19 viewports, forced
  hover, focus and active) show only the changes above. Every tab, dialog and
  workflow at 19 screen sizes raises no script error.
- Owner sign-off: content and clinical catalogue entries reviewed 2026-09-28,
  real-device checks complete. Ownership is Ryan Lemmens's unless formally
  handed over; release and rollback ZIPs are kept on the owner's computer.

## v6.0, 2026-09-24 — Stable Production Baseline

Promoted the audited v5.56 candidate. Applied the three operational-data changes
confirmed by the owner (SH6 Haast–Lake Moeraki closure, permanent PARAPARA
adjustment, Waihi Bowling Club replacing Morgan Park) and advanced
`APP.dataVersion` to `2026.09.24`. Recorded the Google, LINZ, Firebase and
TracPlus production attestations.

## v5 series, 2026-09-09 to 2026-09-24

- **v5.48–v5.56:** production audits and handover reconciliation; teal
  scene-to-hospital route; full Axe sweep; phone layout for the guidance dialog;
  dead DOC live-API code removed.
- **v5.30–v5.47:** Tasking & Clinical Guidance rebuilt against the approved
  v2.01 PDF in one inert template, grouped into operator-facing categories,
  including Area Specific Considerations; approved MapIT operational points
  imported; dataset-id retention baseline added. Heli Status gained additional
  aircraft, in-place editing for iPad and priority arrows.
- **v5.22–v5.29:** H-in-ring brand mark; scaling calculation cards; tab labels
  that never wrap; maintainer files blocked from public delivery; documentation
  restructured.
- **v5.12–v5.21:** stylesheet clean-up (always-overridden declarations, dead
  rules and provably unneeded `!important` removed with screenshot proof); map
  toolbar grouped and resized; Shift Notes drag handle; Split-view overflow
  fixes.
- **v5.8–v5.11:** winch recorded as Land/Wets/Decks by Day and Night with type
  colours; DM Sans as the single UI face; full code audit fixes.
- **v5.0–v5.7:** production promotion of v4.7.3; offline shell worker; Chromium
  and Axe checks; deployment self-check and TracPlus stale detection; clinical
  guidance moved into an inert template.

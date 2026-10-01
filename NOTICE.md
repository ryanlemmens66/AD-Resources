# Notice — copyright and use

**© Ryan Lemmens. All rights reserved.**

Ryan Lemmens owns this work and its documentation. It was built for the Hato
Hone St John National Air Desk and contains St John's operational rules,
clinical pathways and dispatch geometry; if ownership is handed over in future
(for example to Hato Hone St John), the transfer is recorded in this notice and
the README as its own release.

**No licence is granted.** This package has no `LICENSE` file, and the
absence of one is not an oversight. Under copyright, work with no licence is the
*most* restrictive state, not the most open: no one has permission to use, copy,
modify or redistribute it. Distribution of the package does not grant a licence
to reuse, modify or redistribute the work outside the authority under which it
is supplied.

If you want to use any part of this, ask the owner first. Only the owner can
grant a licence.

## Third-party components

The deliverable embeds and calls on work owned by others. None of it is covered
by the statement above, and each carries its own terms:

- **MapLibre GL JS 4.5.0** — bundled inline, BSD-3-Clause.
- **DM Sans** (© 2014 The DM Sans Project Authors) and **Roboto Mono** (© 2015
  The Roboto Mono Project Authors) — embedded as woff2 subsets from Fontsource,
  SIL Open Font License 1.1.
- **LINZ Basemaps and LINZ Data Service** — map tiles and the live Powerlines
  WFS layer. Land Information New Zealand licensing and attribution terms apply,
  and required in-app attribution must not be removed.
- **Google Maps Platform** — Routes, Geocoding, Maps JavaScript, Elevation and
  Weather, under the Google Maps Platform Terms of Service.
- **Firebase** — Realtime Database, under the Google Cloud terms.
- **OpenStreetMap / Nominatim** — geocoding fallback only. ODbL, and Nominatim's
  usage policy applies to how often it may be called.
- **Department of Conservation source data** used by the embedded static huts
  and campsites dataset, **NZTA Waka Kotahi** highway and journey data, and
  **Windy** weather embeds — each under its own terms and attribution
  requirements. AirDesk does not currently call the DOC API at runtime.
- **TracPlus** — live aircraft positions, via the operator's own agreement,
  proxied through a Cloudflare Worker.

Operational datasets — landing zones, aviation guidance, clinical pathway
boundaries, hospital and resource locations — derive from approved St John and
third-party sources and follow those sources' terms, not this notice.

## Related status

Ryan Lemmens is the owner and holds operational and technical ownership unless
it is formally handed over. AirDesk v6.1 (build 20260928.15) was frozen and
signed off by the owner on 2026-09-28 as the Stable Production Baseline for
official live use, with v6.0 (frozen 2026-09-24) kept on the owner's computer
as the immediate rollback release. Provider and account controls and the
TracPlus Worker arrangement were confirmed on 2026-09-24 and carry forward.
AirDesk v6.2 (build 20260930.1, 30 September 2026) is v6.1 with display fixes and
is the current release, signed off by the owner on 2026-09-30 for live
operational use, with v6.1 as its rollback; the sign-off is recorded in README.md.
Content review, live-origin and real-device verification are recorded in the
README sign-off record.

See `README.md` for deployment, credentials and the production acceptance record.

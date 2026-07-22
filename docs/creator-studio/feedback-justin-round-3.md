# Creator Studio — Justin feedback (round 3)

Captured 2026-07-16, spanning **Dashboard / Models / Earnings / Analytics / Settings** (round 2:
[feedback-justin-round-2.md](feedback-justin-round-2.md)). Status: `[ ]` todo · `[x]` done · **🔧** build ·
**🟢** needs a decision · **⏭** deferred / later · **🚧** blocked.

---

## Dashboard
- [x] **D1 — Cash card labels + order.** "Cash ready" → **"Cash settled"**; pending hint → **"Pending settlement"**; **Cash pending now precedes Cash settled**.
- [x] **D2 — "View earnings" link.** Added a **"View earnings →"** link above the earnings stat cards (mirrors "View analytics →").

## Models
- [x] **M1 — Real pager.** Windowed numbered pager: first «, prev ‹, ±2 page window with ellipses, next ›, last ». Jump to any page.
- [x] **M2 — Controls layout.** Bulk-edit button moved onto the controls line (right); model count moved to its own line below.
- [x] **M3 — Filter popover.** Fees dropdown → a **filter popover** with **Status** (default *Active (hide drafts)*), **Base model** (from the creator's actual base models), **Has early/paid access**, and **Licensing fee** sections. Server filters + drafts-hidden default in `models.ts`.
- [x] **M4 — Bulk-edit "select all".** In bulk mode, **"Select all N"** selects every version matching the current filters across all pages (`matchingVersionIds` from the server) + a Clear.
- [x] **M5 — Version-row badges.** Version name now followed by a **status badge** (green Published / dim Draft) + a **base-model badge**, inline on one line (was a separate subline).
- [x] **EdgeMedia component** (per follow-up) — reusable `$lib/components/EdgeMedia.svelte` (CF url + NSFW blur + image/video); the analytics thumbnail grid uses it instead of a raw `<img>`.

## Earnings
- [x] **E1 — Surface licensing fees.** Added an **"Earned by source" cards row** (License fees / Tips / Compensation / Access / Cosmetic, buzz-summed) so sources are legible, not just currency.
- [x] **E2 — Cash panel contrast.** Green panel now uses **white values + light-green labels** (was gray-on-green).
- [x] **E3 — Month selector.** ✅ Reworked into a **month-primary** model — earnings + every analytics tab use two month pickers (Month + Compare); the 7/30/90-day presets are gone (`parseMonthRange`/`resolveCompareMonth`).
- [x] **E4 — Chart source filter.** Trend chart is now **per-source** with **toggle chips** (server series switched to per-source, buzz-only).
- [x] **E5 — Per-model earnings.** ✅ Owner-stamping shipped; `/analytics/models` per-model table + `/analytics/models/[modelId]` per-version drill-down (`getModelEarnings`/`getModelPerformance`).

## Analytics
- [x] **A1 — Synced tooltip.** The crosshair now **drives each chart's tooltip** at the hovered index (via `createSyncedCrosshair`'s new `syncTooltip`), so one hover shows the value on every chart.
- [x] **A2 — Top-images thumbnails.** Replaced the ID table with a **thumbnail grid** (CF url + reaction overlay, NSFW-blurred; `topImages` enriched with `url`/`nsfwLevel` from Postgres).

## Settings
- [~] **S1 — Fee defaults for v1?** **Decided: OUT for v1** (2026-07-22, per Briant) — not doing default fees that seed new versions. (A static per-type suggested-fee *reference* shipped instead — see round-1 2.3.)
- [ ] **S2 — Per-ecosystem fee rules. ⏭** "Always charge X for my Anima LoRAs / Pony LoRAs" — per-base-model/ecosystem default **rules**. Net-new system; explicitly a **later** follow-up (achievable today via bulk-edit + M3/M4 filters in the meantime).

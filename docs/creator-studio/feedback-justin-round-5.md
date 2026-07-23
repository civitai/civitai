# Creator Studio — round-5 feedback / task checklist (2026-07-22)

From the Justin + Briant walkthrough (`Downloads/transcript (2).md`, §2 "Creator Studio review").
Refs like `T:364` cite transcript line numbers. Owner is Briant unless noted.

Tags: **[todo]** build · **[bug]** fix · **[polish]** styling · **[verify]** confirm behavior ·
**[global]** applies across pages · **[question]** needs a decision (see Open Questions).

---

## Global / cross-cutting (recurring themes)

- [ ] **[global] [polish]** **Consistent card + text colors across all pages** — the earnings,
  base-models, and audience pages use lighter cards with lower text contrast than the **dashboard**.
  Standardize on the **dashboard** card colors everywhere, then re-review text color for contrast. Goal:
  all cards and all text look the same across every page. (`T:600–624`, `T:837–838`, `T:956–959`)
- [ ] **[global] [polish]** **Buttons: white text, not blue** — buttons rendering blue text (likely the
  ShadCN default button) should use white text. Verify whether it's the ShadCN default or needs custom
  CSS, then fix globally. (`T:416–435`, `T:498–509`)
- [ ] **[global] [polish]** **Pointer cursor on clickable elements** — any clickable element (e.g.
  "select all", per-page selector) should show `cursor: pointer` unless disabled. (`T:510–516`)
- [ ] **[global] [todo]** **Page-size selector on every paginated page** — every page with pagination
  needs a page-size selector (see specific pages below). (`T:807–810`, `T:856–866`)
- [x] **[global] [polish]** **Replace `NativeSelect` with the styled `Select` component** — done. Swept all
  remaining `NativeSelect` usages onto bits-ui `Select`: the Licensing filter popover (model-type, base-model),
  Licensing per-page, the bulk-edit-bar images select + per-row fee-images select (form fields — added a hidden
  `name="images"` input so the POST still submits), the shared `PageSizeSelect`, and the layout
  "Simulate membership" moderator toggle. No `NativeSelect` remains in the app.
- [ ] **[global] [todo]** **Adopt `<BuzzAmount>` for buzz displays** — new `$lib/components/BuzzAmount.svelte`
  renders a buzz amount with the ⚡ sized in `em` + tucked against the number (currency-symbol style), reusable
  in any font-size context. Sweep the remaining buzz displays onto it: **earnings** source cards + buzz→$ table +
  monthly-performance cells, and the **analytics/models/base-models** currency columns (buzz family only — those
  cells use `formatAmount`, which also handles cash, so adopt selectively). Dashboard already uses it.

## Dashboard

- [ ] **[polish]** **Buzz-earned card legend on one line** — the "blue / green / yellow — last 30 days"
  legend currently wraps to two lines; get it onto one line (abbreviate/condense as needed). Very close
  already. (`T:364–378`)
- [ ] **[todo]** **Top-earning-model card — flip the layout** — swap the two text elements: put the
  **buzz earned** as the big top text (where the other cards' numbers go) and the **model name** as the
  smaller subtext below it. Line-clamp on the name already added. (`T:379–403`)
- [ ] **[polish] [low]** **Clarify card timeframe labeling** — Justin read the cash/top-earning cards as
  all-time; they're actually **last-30-day** activity (there's no month picker on the dashboard). Make
  the 30-day scope clear on the cards so they aren't mistaken for all-time. (`T:346–363`)

## Licensing page

- [ ] **[polish]** **Consistent filter styling** — the filter elements have different rounding /
  dimensions / background colors. Make them all consistent. (`T:405–415`)
- [ ] **[polish]** **Consistent top-right buttons** — export/import (and others): make casing
  consistent (all **title case**, incl. "Bulk Edit Fees") and text white (not blue). (`T:416–435`)
- [ ] **[bug] [polish]** **Bulk-edit-fees bar: inconsistent input/button heights** — when the bulk-edit
  bar appears, its buttons and inputs have mismatched heights; align them. Also fix the blue-text button
  there → white. (`T:490–509`)
- [ ] **[polish]** **Per-page dropdown text white** — the per-page selection reads dark-on-dark; make
  the text inside it white. (`T:517–522`)
- [ ] **[verify]** **Base-model filter scope** — confirm whether the base-model selector in the filters
  dropdown lists only the base models this **creator's** models use, or is meant to be the **full**
  platform list. If it's supposed to be full, we're missing entries. (`T:528–552`)
- [x] **[done — verify]** **Filters no longer lost on Bulk Edit** — the bug where filters were dropped
  when clicking bulk edit is fixed; confirmed working in the walkthrough. (`T:525–526`)
- [x] **[done — verify]** **Import confirmation + error display** — import shows a confirmation and
  surfaces errors. Working. (`T:438–447`)
- **[resolved — no]** **Chips vs radios for single-select** — leave as radios; radios more clearly
  signal single-select. (`T:555–568`)

## Earnings page

- [ ] **[polish]** **Sources card text → light** — switch the text on the Sources card to a light color
  so it's readable. (`T:594–596`)
- [ ] **[verify]** **Buzz → $ conversion shows all history** — the conversion table at the bottom shows
  only one month; confirm it displays **all** conversion history, not just the latest month (test with
  Alex's account, which should have more history). (`T:626–641`)
- [ ] **[polish]** **Bar-chart mode: previous-period line on top** — in bar-chart mode the
  previous-period line appears to render behind the bars; draw it on top of the bar values. (`T:643–652`)
- [ ] **[todo]** **Persist split/combined toggle** — tie the split↔combined buzz toggle to local
  storage so it's remembered. (`T:675–682`)
- [x] **[done — verify]** **Direct compare + month-by-month default** — the 730-day default was removed
  in favor of month-by-month; current month's line stops at the last day with data. Good. (`T:570–583`)
- **[resolved — no]** **Tips source** — may be removed later if tipping is dropped, but keep for now
  (historical data persists). (`T:587–593`)

## Analytics — overview / navigation

- [ ] **[bug]** **Earnings → Analytics link should target Model Analytics** — the link at the bottom of
  the earnings page currently lands on the analytics overview; point it at the **model analytics** page/tab.
  (`T:658–670`)
- [ ] **[todo]** **Remember period settings across tabs** — the period selection (current + comparison
  month) lives in the URL query string and isn't carried tab-to-tab. Move it to a **global store** so the
  selected period persists across analytics tabs. (`T:671–701`)
- [x] **[done — verify]** **Overview content** — reads as a creator's level of performance across what
  they care about. Good as-is. (`T:704–707`)

## Analytics — Models list (`/analytics/models`)

- [ ] **[todo]** **Make model rows obviously clickable** — the model link (to the per-version
  sub-analytics page) doesn't look clickable. Add a clear affordance — right chevron, possibly turn the
  first cell into a badge/clickable card. Design TBD, but make it more obvious. (`T:724–745`)
- [ ] **[todo]** **Remove the "model ID + View" jumper** — pointless as-is (just jumps to a model);
  remove it. (Model/version comparison is deferred — see Open Questions.) (`T:763–806`)
- [ ] **[todo]** **Add page-size selector** — this page has none. (`T:807–810`)

## Analytics — Model detail (`/analytics/models/[id]`)

- [ ] **[todo]** **Default to versions with data** — by default only chart versions that actually have
  generation/download data, to avoid a pile of flat lines. (`T:774–784`)
- [ ] **[todo]** **Drop the comparison-month selector** — this page doesn't do previous-month
  comparison (comparing versions makes it confusing), so remove the comparison-month picker. (`T:785–805`)
- [ ] **[todo]** **Show historical/previous data by color** — mirror the base-models page's approach of
  distinguishing historical data by color on this page. (`T:813–824`)

## Analytics — Base models page

- [ ] **[polish]** **Card title color consistency** — one card's title is white and an adjacent card's
  isn't; make them consistent. (`T:837–838`)
- [ ] **[polish]** **Compact layout tune-up** — keep the compact "one line on the left, value on the
  right" layout so the two parts don't read as separate things. (`T:840–846`)
- [x] **[done — verify]** **Civitai-wide vs your base models** — the "Civitai-wide base model usage"
  chart is platform-wide (not scoped to the creator's models); "your base models" is the creator's.
  Confirmed intent. (`T:827–836`)

## Analytics — Engagement tab

- [ ] **[todo]** **Add page-size selector** — has a pager but no page-size selector. (`T:856–858`)
- **[resolved — later]** **Month-by-month comparison** — currently raw totals only; adding
  month-over-month comparison is fine to defer post-launch. (`T:849–855`)

## Analytics — Images/Videos → consolidate into "Content"

- [ ] **[todo]** **Consolidate Images + Videos into a single "Content" page with tabs** — the pages are
  nearly identical; make one Content page with tabs (Images, Videos) — a segmented control per Justin.
  (`T:874–933`)
- [ ] **[todo]** **Content page: month selector only (no comparison month)** — there's no good way to
  compare against the previous month given how the data is displayed, so only a single month selector.
  (`T:924–929`)
- [ ] **[todo]** **Default page size 15 with "show more"** — analytics images/content should show 15 by
  default with the ability to load more. (`T:859–866`)
- [ ] **[question]** **Future content types (comics, 3D models)** — plan for adding these; scout whether
  they fit the current form easily. Audio is out for now (no user audio posting). At minimum a "coming
  soon" tab so they don't feel ignored. (`T:874–933`)

## Analytics — Audience tab

- [~] **[todo]** **Add over-time charts to match header cards** — followers-over-time + **reactions-received-
  over-time** now render side-by-side (reactions series already came from `getContentAnalytics`). **Comments-
  over-time is NOT done**: comments have no fast period-scoped source (`getAllTimeTotals` is all-time only, from
  the `image_metrics_user` rollup) — a dated chart needs a new source (Postgres `CommentV2` by date, or a
  ClickHouse rollup). "Per-month graph" (longer monthly trend vs the current daily-in-month) also deferred.
  (`T:940–954`)
- [ ] **[polish]** **Card color matches dashboard** — the audience cards' color differs from the
  dashboard stat cards; align (covered by the global card-color item). (`T:956–959`)

## Settings

- [x] **[done — verify]** **Suggested-fee-by-model-type rules** — settings shows suggested fees by model
  type (e.g. checkpoints 1, image LoRAs 1 per 10 images). This is the licensing view/rules Justin
  expected. (`T:960–968`)

---

## Open questions (resolve before / during build)

1. **Base-model filter scope (Licensing)** — creator's-own base models only, or full platform list? If
   full, entries are missing. (`T:528–552`)
2. **Buzz → $ conversion history** — is it actually limited to one month, or just filtered to one? Must
   show all history. (`T:626–641`)
3. **Model/version comparison** — deferred for V1 (cross-model version selection is messy). Confirm it
   stays out of scope. (`T:791–806`)
4. **Future content types** — do comics / 3D models fit the current images/videos data form, or do they
   need bespoke stats? Decide the V1 treatment (real stats vs "coming soon" tab). (`T:874–933`)

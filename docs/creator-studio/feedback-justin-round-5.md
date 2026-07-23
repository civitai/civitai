# Creator Studio — round-5 feedback / task checklist (2026-07-22)

From the Justin + Briant walkthrough (`Downloads/transcript (2).md`, §2 "Creator Studio review").
Refs like `T:364` cite transcript line numbers. Owner is Briant unless noted.

Tags: **[todo]** build · **[bug]** fix · **[polish]** styling · **[verify]** confirm behavior ·
**[global]** applies across pages · **[question]** needs a decision (see Open Questions).

---

## Public landing page (unauthenticated + SEO)

- [x] **[todo]** **Public marketing landing page for non-authed users** — done. The root `/` is now a public,
  SSR landing page (hero + feature cards for licensing fees / analytics / Creator Program payouts + CTAs). The
  dashboard moved to `/dashboard`. All authed routes live in a SvelteKit **`(app)` route group** (URLs
  unchanged) whose layout owns the sidebar shell + requires a user; the landing sits outside the group under a
  bare root layout, so logged-out visitors get marketing chrome only and gated pages keep a non-null user type.
  - **Public route** — `hooks.server.ts` `OPTIONAL_AUTH_PATHS` lets `/` through logged-out (attaching a user
    when present); every other route stays gated. Signed-in visitors to `/` are redirected to `/dashboard`.
  - **SEO** — real `<title>` + meta description, `robots: index,follow`, canonical, Open Graph + Twitter tags,
    and JSON-LD (`WebApplication`). Removed the global `noindex` from `app.html` (authed pages stay private
    behind the guard, so they aren't crawlable regardless). SSR gives crawlers full HTML — chose SSR over
    prerender so the same `/` can redirect signed-in users server-side (no client flash).
  - CTAs point at `/dashboard`, which trips the guard's login redirect and returns the visitor after sign-in.
  - _Note: dev server needs a restart to pick up the `hooks.server.ts` change (hooks don't hot-reload)._

---

## Global / cross-cutting (recurring themes)

- [x] **[global] [polish]** **Consistent card + text colors across all pages** — the earnings,
  base-models, and audience pages use lighter cards with lower text contrast than the **dashboard**.
  Standardize on the **dashboard** card colors everywhere, then re-review text color for contrast. Goal:
  all cards and all text look the same across every page. (`T:600–624`, `T:837–838`, `T:956–959`)
- [x] **[global] [polish]** **Buttons: white text, not blue** — buttons rendering blue text (likely the
  ShadCN default button) should use white text. Verify whether it's the ShadCN default or needs custom
  CSS, then fix globally. (`T:416–435`, `T:498–509`)
- [x] **[global] [polish]** **Pointer cursor on clickable elements** — any clickable element (e.g.
  "select all", per-page selector) should show `cursor: pointer` unless disabled. (`T:510–516`)
- [x] **[global] [todo]** **Page-size selector on every paginated page** — every page with pagination
  needs a page-size selector (see specific pages below). (`T:807–810`, `T:856–866`)
- [x] **[global] [polish]** **Replace `NativeSelect` with the styled `Select` component** — done. Swept all
  remaining `NativeSelect` usages onto bits-ui `Select`: the Licensing filter popover (model-type, base-model),
  Licensing per-page, the bulk-edit-bar images select + per-row fee-images select (form fields — added a hidden
  `name="images"` input so the POST still submits), the shared `PageSizeSelect`, and the layout
  "Simulate membership" moderator toggle. No `NativeSelect` remains in the app.
- [x] **[global] [todo]** **Currency display component** — done. Consolidated into a single
  `$lib/components/CurrencyDisplay.svelte` (replaced the separate `BuzzAmount`/`Amount` pair): renders buzz/bank
  with the ⚡ sized in `em` + tucked against the number (currency-symbol style), and cash as a plain `$` string;
  `currency` is optional (omit it for a generic summed buzz total). Swept every buzz display onto it — dashboard,
  **earnings** source cards + by-source table + monthly cells + buzz→$ banked column, and the **analytics
  models/base-models/model-detail** currency columns.

## Dashboard

- [x] **[polish]** **Buzz-earned card legend on one line** — the "blue / green / yellow — last 30 days"
  legend currently wraps to two lines; get it onto one line (abbreviate/condense as needed). Very close
  already. (`T:364–378`)
- [x] **[todo]** **Top-earning-model card — flip the layout** — swap the two text elements: put the
  **buzz earned** as the big top text (where the other cards' numbers go) and the **model name** as the
  smaller subtext below it. Line-clamp on the name already added. (`T:379–403`)
- [x] **[polish] [low]** **Clarify card timeframe labeling** — Justin read the cash/top-earning cards as
  all-time; they're actually **last-30-day** activity (there's no month picker on the dashboard). Make
  the 30-day scope clear on the cards so they aren't mistaken for all-time. (`T:346–363`)

## Licensing page

- [x] **[todo]** **Early Access vs. permanent sales must be visually distinct** — done. From creator feedback
  (alexds9, Discord 2026-07-23): if the UI doesn't clearly show the difference between **Early Access** and
  **permanent sales**, it will confuse users on release, and _"every point of confusion will be weaponized"_.
  - **Distinct badges** in the version list: **Permanent** (blue — "sold indefinitely, no end date") vs
    **Early access** (green — "timed window, becomes free when it ends"). Previously *both* rendered the same
    "Early access" chip — and permanent versions may have shown **no badge at all**, since `hasEarlyAccess` is
    derived from `earlyAccessEndsAt !== null` and permanent is intentionally duration-0/no-end-date. The badge
    now keys off `earlyAccessConfig.permanent` directly, so it's correct either way.
- [x] **[todo]** **Access allowance indicator (how many already set)** — done. The two limits work
  *differently*, so the indicator states each honestly:
  - **Permanent** — a **count** cap by Creator-Program **tier** (`bronze 3 / silver 10 / gold unlimited`,
    0 without a tier): shows `X of Y set`, amber at the cap, plus remaining capacity on the "Make permanent"
    checkbox so the cap isn't a save-time surprise.
  - **Early access** — score-gated **two** ways: `X of Y active` (concurrent count) **and** `up to N days`.
    **The count cap was missing entirely from creator-studio** — it only mirrored
    `EARLY_ACCESS_CONFIG.scoreTimeFrameUnlock` (days) and not `scoreQuantityUnlock`
    (40k→1, 65k→2, 90k→4, 125k→6, 200k→8, 250k→20). Added `EARLY_ACCESS_QUANTITY_UNLOCK` +
    `earlyAccessQuantityForScore()` and a `countActiveEarlyAccessVersions()` server counter.
  - _Note: the main app's `/api/v1/model-versions/early-access` remains the enforcement source of truth for the
    early-access quantity cap; creator-studio surfaces it so creators aren't surprised by a rejection._
- [x] **[polish]** **Consistent filter styling** — the filter elements have different rounding /
  dimensions / background colors. Make them all consistent. (`T:405–415`)
- [x] **[polish]** **Consistent top-right buttons** — export/import (and others): make casing
  consistent (all **title case**, incl. "Bulk Edit Fees") and text white (not blue). (`T:416–435`)
- [x] **[bug] [polish]** **Bulk-edit-fees bar: inconsistent input/button heights** — when the bulk-edit
  bar appears, its buttons and inputs have mismatched heights; align them. Also fix the blue-text button
  there → white. (`T:490–509`)
- [x] **[polish]** **Per-page dropdown text white** — the per-page selection reads dark-on-dark; make
  the text inside it white. (`T:517–522`)
- [x] **[resolved — verify]** **Base-model filter scope** — confirmed: **creator's-own** by design. The
  base-model (and model-type) filter options come from a distinct query scoped to `m.userId = userId`
  (`lib/server/models.ts`), so the dropdown only lists base models the creator actually has — no dead
  options that would match zero rows. Not the full platform list. (`T:528–552`)
- [x] **[done — verify]** **Filters no longer lost on Bulk Edit** — the bug where filters were dropped
  when clicking bulk edit is fixed; confirmed working in the walkthrough. (`T:525–526`)
- [x] **[done — verify]** **Import confirmation + error display** — import shows a confirmation and
  surfaces errors. Working. (`T:438–447`)
- **[resolved — no]** **Chips vs radios for single-select** — leave as radios; radios more clearly
  signal single-select. (`T:555–568`)

## Earnings page

- [x] **[polish]** **Sources card text → light** — switch the text on the Sources card to a light color
  so it's readable. (`T:594–596`)
- [x] **[verify]** **Buzz → $ conversion shows all history** — the conversion table at the bottom shows
  only one month; confirm it displays **all** conversion history, not just the latest month (test with
  Alex's account, which should have more history). (`T:626–641`)
- [x] **[polish]** **Bar-chart mode: previous-period line on top** — in bar-chart mode the
  previous-period line appears to render behind the bars; draw it on top of the bar values. (`T:643–652`)
- [x] **[todo]** **Persist split/combined toggle** — tie the split↔combined buzz toggle to local
  storage so it's remembered. (`T:675–682`)
- [x] **[done — verify]** **Direct compare + month-by-month default** — the 730-day default was removed
  in favor of month-by-month; current month's line stops at the last day with data. Good. (`T:570–583`)
- **[resolved — no]** **Tips source** — may be removed later if tipping is dropped, but keep for now
  (historical data persists). (`T:587–593`)

## Analytics — overview / navigation

- [x] **[bug]** **Earnings → Analytics link should target Model Analytics** — the link at the bottom of
  the earnings page currently lands on the analytics overview; point it at the **model analytics** page/tab.
  (`T:658–670`)
- [x] **[todo]** **Remember period settings across tabs** — the period selection (current + comparison
  month) lives in the URL query string and isn't carried tab-to-tab. Move it to a **global store** so the
  selected period persists across analytics tabs. (`T:671–701`)
- [x] **[done — verify]** **Overview content** — reads as a creator's level of performance across what
  they care about. Good as-is. (`T:704–707`)

## Analytics — Models list (`/analytics/models`)

- [x] **[todo]** **Make model rows obviously clickable** — the model link (to the per-version
  sub-analytics page) doesn't look clickable. Add a clear affordance — right chevron, possibly turn the
  first cell into a badge/clickable card. Design TBD, but make it more obvious. (`T:724–745`)
- [x] **[todo]** **Remove the "model ID + View" jumper** — pointless as-is (just jumps to a model);
  remove it. (Model/version comparison is deferred — see Open Questions.) (`T:763–806`)
- [x] **[todo]** **Add page-size selector** — this page has none. (`T:807–810`)

## Analytics — Model detail (`/analytics/models/[id]`)

- [x] **[todo]** **Default to versions with data** — by default only chart versions that actually have
  generation/download data, to avoid a pile of flat lines. (`T:774–784`)
- [x] **[resolved — reversed]** **Comparison on model detail** — original ask was to drop the
  comparison-month picker; instead (later decision) we **kept comparison** as a version-comparison overlay:
  pick versions, overlay one metric (generations/downloads), and render the previous period as a dashed,
  offset-color line (mirrors the base-models page). (`T:785–805`)
- [x] **[todo]** **Show historical/previous data by color** — mirror the base-models page's approach of
  distinguishing historical data by color on this page. (`T:813–824`)

## Analytics — Base models page

- [x] **[polish]** **Card title color consistency** — one card's title is white and an adjacent card's
  isn't; make them consistent. (`T:837–838`)
- [x] **[polish]** **Compact layout tune-up** — keep the compact "one line on the left, value on the
  right" layout so the two parts don't read as separate things. (`T:840–846`)
- [x] **[done — verify]** **Civitai-wide vs your base models** — the "Civitai-wide base model usage"
  chart is platform-wide (not scoped to the creator's models); "your base models" is the creator's.
  Confirmed intent. (`T:827–836`)

## Analytics — Engagement tab

- [x] **[todo]** **Add page-size selector** — has a pager but no page-size selector. (`T:856–858`)
- **[resolved — later]** **Month-by-month comparison** — currently raw totals only; adding
  month-over-month comparison is fine to defer post-launch. (`T:849–855`)

## Analytics — Images/Videos → consolidate into "Content"

- [x] **[todo]** **Consolidate Images + Videos into a single "Content" page with tabs** — done. New
  `/analytics/content` with a segmented control (Images / Videos); the old `/analytics/images` +
  `/analytics/videos` routes are removed and the nav is a single **Content** entry. One `getTopMedia` fetch
  serves both tabs (it already returns both, split by `type`). Tab list is a small array so a new content type
  slots in with one entry. (`T:874–933`)
- [x] **[todo]** **Content page: month selector only (no comparison month)** — `AnalyticsHeader` is rendered
  with `showCompare={false}`, so only the month picker shows. (`T:924–929`)
- [x] **[todo]** **Content page pagination** — shared `Pagination` component (count on the left, per-page +
  page selector on the right, its own row) now used by the Content grid **and** the models / engagement /
  base-models tables. Page nav pushes to the URL (`?page=`); page size is the shared `analyticsPageSize`
  store; count auto-pluralizes the noun. On Content, tab + page both live in the URL (linkable, survive
  reload; switching tab resets to page 1); rendered top and bottom. Client-side paging (all rows already
  loaded) — supersedes the original "15 + show more" teaser. (`T:859–866`)
- [ ] **[blocked — no data]** **Future content types (comics, 3D models) — real stats** — decision
  (2026-07-23) was **real stats**, but there is **no comics/3D data to show yet**: no `ComicProject`/`Model3D`
  Prisma models, and the `reactions` ClickHouse table has zero comic/3D rows (only Image/Comment/Article/
  Bounty/Q&A types). `comicProject`/`model3d` exist only in a forward-looking *reportable-entity* enum. Since
  the Content analytics are reaction-based, real-stats tabs would be permanently empty. **Blocked until the
  content type ships with data** — then add a `TABS` entry + a data source (the page is built to take it).
  **Decision (2026-07-23): leave off until data exists** — no placeholder tabs; revisit when comics/3D ship
  with real metrics. (`T:874–933`)

## Analytics — Audience tab

- [~] **[todo]** **Add over-time charts to match header cards** — followers-over-time + **reactions-received-
  over-time** render side-by-side. **Comments-over-time is DEFERRED** — and investigating it (2026-07-23)
  surfaced a deeper problem worth fixing first:
  - **The comments metric itself is wrong (image-only).** The all-time number comes from `image_metrics_user`,
    which counts comments on the creator's **images only**. But comments span Model / Post / Article / Comment
    (reply) / Review / Bounty too — and platform-wide **Model comments are the largest bucket** (~31k/30d vs
    ~28k image). So for a model creator the current "comments" number undercounts badly.
  - **Root cause:** `reactions` carries a denormalized `ownerId` (so "reactions received" is a clean, fast,
    all-types query), but `comments` has **no owner column** — only `type` + `entityId` + commenter `userId`.
    A correct "comments received" would need per-entity-type owner resolution (a fragile multi-join), which is
    why the rollup punted to images-only.
  - **Proper fix:** denormalize an **`ownerId` onto comment events at ingest** (mirror `reactions.ownerId`).
    Then "comments received" = `comments WHERE ownerId = uid` across all types — correct _and_ fast — and it
    fixes the all-time number too. This is a tracking-pipeline change + backfill; batch it with the owner-keyed
    rollup (A1), not this UI task. Until then, the surfaced all-time comments number is **image-only** (should
    be labeled as such if kept). "Per-month graph" (longer monthly trend) also deferred. (`T:940–954`)
- [x] **[polish]** **Card color matches dashboard** — the audience cards' color differs from the
  dashboard stat cards; align (covered by the global card-color item). (`T:956–959`)

## Settings

- [x] **[done — verify]** **Suggested-fee-by-model-type rules** — settings shows suggested fees by model
  type (e.g. checkpoints 1, image LoRAs 1 per 10 images). This is the licensing view/rules Justin
  expected. (`T:960–968`)

---

## Open questions (resolve before / during build)

1. **Base-model filter scope (Licensing)** — ✅ **resolved: creator's-own** (by design; filter is scoped to
   `m.userId`). Not the full platform list. (`T:528–552`)
2. **Buzz → $ conversion history** — ✅ **resolved: shows all history**. The `getBuzzDollarRatio` query has no
   LIMIT (all months since 2025-03, `ORDER BY month DESC`); the one-month observation was just a sparse test
   account. (`T:626–641`)
3. **Model/version comparison** — deferred for V1 (cross-model version selection is messy). Confirm it
   stays out of scope. (`T:791–806`)
4. **Future content types** — ✅ **resolved: real stats** (2026-07-23). Comics/3D get real metric tabs on the
   Content page (not "coming soon"); audio out. Implementation scoped as a todo above. (`T:874–933`)

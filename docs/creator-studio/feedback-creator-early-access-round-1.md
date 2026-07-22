# Creator Studio — early-access creator feedback (round 1)

Feedback from a creator given early access to the Creator Program (381 models / 782 versions). Their guiding
principle, quoted: *"making it informative and easy to use, while minimizing clicks whenever possible."*

Status legend: ✅ done · 🟢 easy · 🟡 medium · 🔴 large · 💬 product decision needed

Effort tiers reflect the current codebase (verified 2026-07-17): the Chart wrapper already supports bars; there is
**no** fee-suggestion/reference-price code yet; top-images was `LIMIT 10`; usage tables are `modelVersionId`-keyed.

## 1. Dashboard

- [x] **1.1 — Differentiate fields with color/icons** ✅ — every dashboard tile now has a colored tabler icon so
      the eye can find a metric fast.
- [x] **1.2 — Show % vs last month / 3-mo average** ✅ — delta chips (`DeltaChip.svelte`) on every activity tile +
      Buzz earned, showing % vs the previous 30 days (green up / red down / "new"). Built on the shared
      `previousRange` mechanism reused by 3.1 / 4.2.

## 2. Licensing (was "Models")

- [x] **2.1 — Rename (it only handles license fees)** ✅ — nav + heading + dashboard card now say "Licensing"
      (route stays `/models`).
- [x] **2.2 — Easier bulk control of license fees** ✅ — CSV round-trip: **Export CSV** (filtered to the current
      view) → edit the single per-image `fee` column in Excel/Sheets → **Import CSV** with a dry-run preview
      (before→after diff + skipped rows with reasons) before anything is written. Alongside the existing bulk
      multi-select + base-model/type filters + page size. (Chose the spreadsheet download over an in-browser grid —
      more powerful for the 381-model creator, no fragile client state.)
- [x] **2.3 — Recommended fee reference + spreadsheet** ✅ — static per-type **suggested fee** (Checkpoint 1 ⚡/img,
      LoRA-scale 1 ⚡/10 img) shown in the fee editor + bulk bar (one-click apply) and as a read-only `recommendedFee`
      column in the export CSV. A descriptive *crowd-median* was prototyped then dropped — it anchored fees upward
      (real median ≈ 3 ⚡/img, higher than desired). The full edit-in-place grid was superseded by the CSV (2.2).

## 3. Earnings

- [x] **3.1 — Chart needs a prior-period reference** ✅ — the trend now collapses the *selected* sources into a
      single "this period" line plus a dashed "previous period" line summing the same selection, aligned by
      calendar correspondence. (Released-model markers not done — separate item.)
- [ ] **3.2 — "The more I look at Earnings, the more confusing it becomes"** 💬 — vague; the concrete asks below
      (3.3–3.5) plus 3.1 are the actionable parts. Revisit overall IA after those land.
- [x] **3.3 — Option to see Green + Yellow Buzz combined** ✅ — the "By source" table has a Split↔**Combined** toggle;
      Combined collapses every buzz currency into one **Total Buzz** column. Split stays the default (B8).
- [x] **3.4 — Monthly performance table (this month vs others)** ✅ — last-12-months table on `/earnings`
      (`getMonthlyEarnings`, `GROUP BY month` on owner-keyed `buzzTransactions`), currencies split, current month
      highlighted, each cell showing a % delta vs the same currency the month before. Independent of the range
      selector. (A combined Yellow+Green column still waits on 3.3.)
- [~] **3.5 — Bars instead of / in addition to the smooth line** — added then **removed**. Per-source bars conflict
      with an in-chart period comparison (the prior period can't be a per-source bar too, and grouped bars +
      selection got muddled). Resolved in favor of the 3.1 comparison line instead (creator's call).

## 4. Analytics

> **Restructured into tabs** (2026-07-17): `/analytics` is now a shared layout (tab nav + one range selector) over
> sub-routes — **Overview · Images · Videos · Models · Base models · Audience** — each with its own loader, so a URL
> change only refetches the active tab. The per-version drill-down moved to `/analytics/models/[modelId]`.

- [x] **4.1 — Totals: color/icons** ✅ — same treatment as the dashboard tiles.
- [x] **4.2 — Daily graph needs comparison/reference** ✅ — every analytics trend chart now overlays a dashed
      "previous period" line, and the totals tiles carry the same delta chips as the dashboard.
- [x] **4.3 — Expand top images to 50/100** ✅ — server returns top 50; grid shows 12 with a "Show all 50" toggle.
- [ ] **4.4 — Compare specific selected models** 🔴 — selection + comparison view; new build.
- [x] **4.5 — Within-model analytics across its versions** ✅ — drill-down route `/analytics/model/[modelId]`
      (`getModelVersionAnalytics`, ownership-checked): generations / downloads / buzz per version over the selected
      range (same 7d/30d + month selector as the rest), with **% deltas vs the previous period** on each metric.
      A model-id input jumps to another model; reached by clicking a model in the per-model performance table.
- [x] **4.6 — Compare base models (creator-specific)** ✅ — `/analytics/base-models` tab (`getBaseModelPerformance`):
      the creator's generations / downloads / buzz grouped by base model, with % deltas + model counts. The
      **Civitai-wide** base-model trend (platform usage) is now shipped too ✅ — a top-N platform trend chart with a
      comparison-month overlay + localStorage base-model toggles (`getBaseModelTrends`, joins `civitai_pg.ModelVersion`).
      Caveats + ecosystem-rollup follow-up captured in `base-model-analytics-notes.md`.

## 5. Generic

- [ ] **5 — Customizable/rearrangeable panels (drag-drop layout)** 🔴 — largest; layout persistence + DnD. Consider
      only limited, easy-win customization if any.

## Suggested order

1. ✅ **Easy batch** (1.1, 4.1, 2.1, 3.5, 4.3) — done.
2. ✅ **Period-over-period comparison** (1.2 + 3.1 + 4.2) + **3.4 monthly table** — done.
3. 💬 **3.3 combined-buzz toggle** — pending a product yes/no (quick once decided; also adds a combined column to
   the 3.4 table).
4. 🔴 **Bulk licensing spreadsheet** (2.2 / 2.3) — the 381-model creator's core burden; highest-value large item.
5. 🔴 Analytics deep-dives (4.4 / 4.5 / 4.6) and 5 as capacity allows.

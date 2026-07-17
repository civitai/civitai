# Creator Studio — early-access creator feedback (round 1)

Feedback from a creator given early access to the Creator Program (381 models / 782 versions). Their guiding
principle, quoted: *"making it informative and easy to use, while minimizing clicks whenever possible."*

Status legend: ✅ done · 🟢 easy · 🟡 medium · 🔴 large · 💬 product decision needed

Effort tiers reflect the current codebase (verified 2026-07-17): the Chart wrapper already supports bars; there is
**no** fee-suggestion/reference-price code yet; top-images was `LIMIT 10`; usage tables are `modelVersionId`-keyed.

## 1. Dashboard

- [x] **1.1 — Differentiate fields with color/icons** ✅ — every dashboard tile now has a colored tabler icon so
      the eye can find a metric fast.
- [ ] **1.2 — Show % vs last month / 3-mo average** 🟡 — raw numbers aren't meaningful without a reference. Needs a
      shifted-window query per metric + a delta chip. **Shared with 3.1 / 4.2 — build the comparison once, reuse.**
      This is the single most-repeated ask across the feedback.

## 2. Licensing (was "Models")

- [x] **2.1 — Rename (it only handles license fees)** ✅ — nav + heading + dashboard card now say "Licensing"
      (route stays `/models`).
- [ ] **2.2 — Easier bulk control of license fees** 🔴 — the core pain for a 381-model creator. A bulk mode exists
      (Option C multi-select), but they want a spreadsheet-style table. Real build.
- [ ] **2.3 — Spreadsheet table (base model · type · Civitai reference price · your price) + recommended default**
      🔴 (table) / 🟢 (static reference) — the full edit-in-place table is large. A *static* per-type suggested
      default (LoRA 0.1 / checkpoint 1) as a reference column is small, but **none exists in the repo yet**; a
      *data-driven* "average fee across Civitai" is 🟡 (cross-creator query).

## 3. Earnings

- [ ] **3.1 — Chart needs references (released models / prior-month overlay / 3-mo avg)** 🟡 — same comparison
      infra as 1.2 / 4.2.
- [ ] **3.2 — "The more I look at Earnings, the more confusing it becomes"** 💬 — vague; the concrete asks below
      (3.3–3.5) plus 3.1 are the actionable parts. Revisit overall IA after those land.
- [ ] **3.3 — Option to see Green + Yellow Buzz combined** 🟢💬 — trivial to sum (both convert to cash), but it
      revisits the deliberate "never merge currencies" decision (B8). Plan: add an **optional combined toggle**, not
      a replacement. Needs a quick product yes/no.
- [ ] **3.4 — Monthly performance table (this month vs others)** 🟡 — `GROUP BY month` on the owner-keyed
      `buzzTransactions`; the month-selector infra already landed (E3). Should combine Yellow+Green per 3.3.
- [x] **3.5 — Bars instead of / in addition to the smooth line** ✅ — Bars/Line toggle added, defaults to bars
      (stacked by source), matching the Buzz Dashboard they referenced.

## 4. Analytics

- [x] **4.1 — Totals: color/icons** ✅ — same treatment as the dashboard tiles.
- [ ] **4.2 — Daily graph needs comparison/reference** 🟡 — same comparison infra as 1.2 / 3.1.
- [x] **4.3 — Expand top images to 50/100** ✅ — server returns top 50; grid shows 12 with a "Show all 50" toggle.
- [ ] **4.4 — Compare specific selected models** 🔴 — selection + comparison view; new build.
- [ ] **4.5 — Within-model analytics across its versions** 🔴 — per-model drill-down comparing version performance.
      Data exists per `modelVersionId` (usage tables), so it's feasible but a new view.
- [ ] **4.6 — Compare base models (creator-specific + Civitai-wide)** 🔴 — aggregate the creator's usage/earnings
      grouped by base model, plus a platform-wide trend. High value for "which base models to invest in," but large.

## 5. Generic

- [ ] **5 — Customizable/rearrangeable panels (drag-drop layout)** 🔴 — largest; layout persistence + DnD. Consider
      only limited, easy-win customization if any.

## Suggested order

1. ✅ **Easy batch** (1.1, 4.1, 2.1, 3.5, 4.3) — done.
2. 💬 **3.3 combined-buzz toggle** — pending a product yes/no (quick once decided).
3. 🟡 **Period-over-period comparison** (1.2 + 3.1 + 4.2) — one mechanism, three payoffs; the feedback's biggest
   theme. Then **3.4 monthly table** on top of it.
4. 🔴 **Bulk licensing spreadsheet** (2.2 / 2.3) — the 381-model creator's core burden; highest-value large item.
5. 🔴 Analytics deep-dives (4.4 / 4.5 / 4.6) and 5 as capacity allows.

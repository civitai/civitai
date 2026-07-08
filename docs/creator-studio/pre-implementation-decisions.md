# Creator Studio — pre-implementation decision checklist

> Consolidates every **open** question from the plan + page specs into one decision list, grouped by owner.
> Source docs: [creator-studio-plan.md](../creator-studio-plan.md) (esp. [§9](../creator-studio-plan.md#9-decisions--open-questions)),
> [README §cross-cutting](README.md#cross-cutting-decisions-needed-answer-once--they-recur-across-pages), and the seven page specs.
>
> **Purpose:** unblock the build. Phase 1 (app shell) has **no** dependency on anything below and is already
> being scaffolded. The items here gate the *feature* pages. Each row says **who owns it** and **what it blocks**.

Legend: 🔴 hard blocker (a page can't be built correctly without it) · 🟠 shapes scope but has a safe default · 🟢 eng/design can just decide.

---

## A. Backend / data — Koen (highest leverage)

| # | Decision | Blocks | Sev | Recommended default if unanswered |
|---|---|---|---|---|
| A1 | **Owner-keyed earnings rollup MV** — a `(ownerUserId, date, source)` materialized view off `orchestration.resourceCompensations`, plus a `modelVersion → ownerUserId` dictionary in ClickHouse. Every earnings table is keyed by `modelVersionId`, never the creator's `userId`. ([plan §7.6 gap #1](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)) | `/` dashboard, `/earnings`, `/earnings/analytics` (all "my models" scoping + top-earners) | 🔴 | Ship v1 with app-side `WHERE modelVersionId IN (…)` fallback; **cap** per-creator version count and hide "top-earning models" until the MV lands. Don't let prolific creators balloon the query. |
| A2 | **Fractional `licensingFee` migration** — `ModelVersion.licensingFee` is `Int` today; needs `numeric`/decimal at 0.01 precision, settled at the daily payout boundary in `deliver-creator-compensation.ts`. Manual migration (repo doesn't run `prisma migrate deploy`). ([plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db)) | `/models`, `/licensing` (fee amount input can't accept fractional until this lands) | 🔴 | none — schema change must precede the fee editor. Write the SQL now, surface for manual apply. |
| A3 | **Fee `active` flag** — add `active`/`enabled` on the version's licensing fee so a lapsed member's fee auto-pauses (value kept, application gated) and the mini endpoint (`.../model-versions/mini/[id].ts`) checks active membership on hit. ([plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db)) | `/models`, `/licensing` (the `Active`/`Paused`/`Off` badge), `/settings` | 🔴 | none — the "Paused" state in every spec depends on it. |
| A4 | **Indefinite-sale representation** — a main-app field/flag for "available for sale indefinitely, no time/quantity cap" that bypasses `scoreTimeFrameUnlock`/`scoreQuantityUnlock` for eligible members. ([plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db)) | `/models` sell-indefinitely control | 🔴 | Gate the control behind a feature flag; ship `/models` without it in v1 if the backend slips (it's a distinct action from fee-setting). |
| A5 | **Access/cosmetic-sale earnings MV (gap #2)** — a per-`toAccountId` daily buzz-earnings-by-type rollup; those earnings are buzz *transactions*, not in `resourceCompensations`. Only needed if v1 shows those sources. ([plan §7.6 gap #2](../creator-studio-plan.md#76-clickhouse-analytics--materialized-views)) | `/earnings` (access-sale + cosmetic-sale cards), `/` | 🟠 | Ship comp/license/tip only in v1; show access/cosmetic cards as "coming soon". Tie to B3. |

---

## B. Product / business — Justin

| # | Decision | Blocks | Sev | Recommended default if unanswered |
|---|---|---|---|---|
| B1 | **Member gate: subscription `tier` vs full CP membership — and is it feature-specific?** Justin said fee = `tier`; HackMD said CP members; indefinite-sale was scoped to CP. Likely: **fee = `tier`, indefinite-sale = CP membership (score ≥40k)**. ([plan §9 "to confirm"](../creator-studio-plan.md#to-confirm-surfaced-in-review)) | Gating on `/models`, `/licensing`, `/settings`; **all** `/join` CTA copy ("subscribe to a plan" vs "join the Creator Program") | 🔴 | Build gating as **feature-specific** (fee→tier, indefinite→CP) behind one `membership.ts` resolver so flipping either is a one-line change. |
| B2 | **Indefinite-sale mechanics** — one-time purchase at a creator-set price? How does it relate to early-access pricing (replaces / stacks / separate)? ([models.md open Qs](models.md#open-questions)) | `/models` sell-indefinitely UX (depends on A4) | 🔴 | Blocked on spec — don't build the control until defined; A4 is the schema half. |
| B3 | **v1 earnings sources** — comp/license/tip only, or also access-sale + cosmetic-sale (needs A5)? ([earnings.md](earnings.md#open-questions)) | `/earnings`, `/` scope | 🟠 | comp/license/tip in v1; access/cosmetic fast-follow. |
| B4 | **"Basic analytics" metric list** — lock it (proposed: generations-over-time, downloads-over-time, top-models table, a few stat tiles) so it doesn't balloon. ([analytics.md](analytics.md#open-questions)) | `/earnings/analytics` scope | 🟠 | Ship the four proposed; richer analytics post-v1. |
| B5 | **Fee auto-pause → notify the creator?** A silent pause = lost income = support tickets. In-app / email in v1? ([plan §9 Q5](../creator-studio-plan.md#questions-for-justin--review-pass-2026-07-02)) | v1 notification scope (may add work outside this app) | 🟠 | No notification in v1; surface the paused state prominently in-Studio. Revisit if support load appears. |
| B6 | **Max licensing fee** — floor is 0.01 buzz/image (confirmed). Is the cap still `MAX_LICENSING_FEE=100` with fractional pricing? ([plan §9 Q7](../creator-studio-plan.md#questions-for-justin--review-pass-2026-07-02)) | fee input validation bounds | 🟢 | Keep 100 cap unless told otherwise; trivial to change. |
| B7 | **Publish/schedule + bulk fee editor — v1 or fast-follow?** Both flagged "2nd priority"/"may trail". ([models.md](models.md), [licensing.md](licensing.md)) | `/models` publish, `/licensing` bulk | 🟠 | Per-version fee first; publish/schedule and bulk trail into fast-follow if time-boxed. |
| B8 | **Studio discoverability** — nav link from the main app for everyone / only users with models / launch announcement? Shapes the non-member + `/join` experience. ([plan §9 Q8](../creator-studio-plan.md#questions-for-justin--review-pass-2026-07-02)) | main-app entry point (outside this app), `/join` framing | 🟢 | Not a v1-build blocker for the app itself; needed before launch. |
| B9 | **Currency display** — buzz-only in v1, or USD equivalents for cash earnings? ([plan §9 Q10](../creator-studio-plan.md#questions-for-justin--review-pass-2026-07-02)) | `/`, `/earnings` number formatting | 🟢 | Buzz-only in v1. |
| B10 | **Default fee suggestions** — confirm values (LoRA ~0.1, base ~1 buzz/image) and which model types get one. ([settings.md](settings.md), [plan §9 Q11](../creator-studio-plan.md#questions-for-justin--review-pass-2026-07-02)) | `getDefaultFeeSuggestions`, `/settings`, `/licensing` "apply default" | 🟢 | Use the proposed values as config; easy to tune. |
| B11 | **Cutover creator comms / grandfathering** — when 25% comp retires (~1wk after v1), the creator-facing story + any transition. ([plan §9 Q6](../creator-studio-plan.md#questions-for-justin--review-pass-2026-07-02)) | Post-v1 cutover track, not this app's v1 | 🟢 | Out of v1 scope; flag for the cutover track. |

---

## C. Eng / design — decide amongst ourselves (no external dependency)

| # | Decision | Blocks | Sev | Recommendation |
|---|---|---|---|---|
| C1 | **Svelte charting library** — no chart primitive in `@civitai/ui`; Chart.js is React-only. Pick one (LayerChart / LayerCake / d3-based) and decide if it lands **in `@civitai/ui`** (shared) or app-local. | `/earnings/analytics`, `/earnings` charts, `/` sparkline | 🔴 | **Decide week 1.** Lean LayerChart (built on LayerCake, shadcn-svelte's charting companion, Tailwind-friendly). Add it **into `@civitai/ui`** as a shared `chart` primitive so both charted pages and the dashboard sparkline share it. |
| C2 | **`/licensing`: separate page vs a mode/tab of `/models`** — docs say "resolve before building." Same rows, same field, same write. ([licensing.md fork](licensing.md#️-open-fork--separate-page-or-a-mode-of-models)) | `/licensing` shape + nav | 🟠 | **Option B — `?mode=bulk` on `/models`.** Same route + shared row component; zero divergence; discoverable where creators already are. Keep the `/licensing` nav slot only if design wants a distinct entry. |
| C3 | **Date-range control** — the docs assume no calendar primitive. ⚠️ **Stale:** `@civitai/ui` now ships `calendar`, `date-picker`, **and** `range-calendar` (+ `pagination`). | `/earnings/analytics`, `/earnings` | 🟢 | Ship **presets (7/30/90d)** for v1 for speed; the `range-calendar` primitive is available if/when we want a custom range. No new dependency needed. |
| C4 | **Pagination — offset vs cursor** for creators with many versions (Justin: "not sure yet"). ([models.md](models.md#routing--url-state)) | `/models`, `/licensing` table | 🟢 | Offset for v1 (simpler, URL-addressable via the `pagination` primitive); revisit if a creator's version count makes it slow. |
| C5 | **Dashboard vs /earnings vs /analytics boundary** — keep the same numbers from appearing (and drifting) in three places. ([README #5](README.md#cross-cutting-decisions-needed-answer-once--they-recur-across-pages)) | `/`, `/earnings`, `/earnings/analytics` content split | 🟢 | Dashboard = at-a-glance totals + entry points; `/earnings` = by-source breakdown + cash; `/analytics` = usage that drives fees. One shared ClickHouse read module so numbers can't drift. |
| C6 | **CP cash + withdrawal home** — dashboard vs `/earnings` vs `/settings` (pick one entry point). ([README #4](README.md#cross-cutting-decisions-needed-answer-once--they-recur-across-pages)) | `/`, `/earnings`, `/settings` | 🟢 | `/earnings` owns the cash panel + Withdraw link-out; dashboard/settings only link to it. |

---

## What is NOT blocked (build now)

Phase 1 app shell — **zero** dependency on the above:

- Scaffold `apps/creator-studio` (SvelteKit spoke) — **in progress**.
- Auth spoke gate: any authenticated user (`createSpokeGuard`, `require: (u) => !!u`).
- `@civitai/ui` sidebar + mobile sheet nav, driven by one app-local `nav.ts` (with `memberOnly`).
- Membership resolver stub (`membership.ts`) — feature-specific by construction so B1 is a one-line flip.
- Dashboard skeleton (cards + skeletons; real ClickHouse reads wait on A1).
- `/join`, `/models`, `/earnings`, `/earnings/analytics`, `/licensing`, `/settings` route stubs.

## Suggested sequencing

1. **Now:** Phase 1 shell (no blockers).
2. **This week (parallel):** get **A1** (rollup timeline) + **B1** (gate definition) answered — they gate the most pages. Decide **C1** (charting) + **C2** (`/licensing` shape) internally.
3. **Then:** land **A2/A3** migrations → build `/models` fee editor. **A4/B2** → sell-indefinitely. **A5/B3** → full earnings sources.

---

### Docs that need a fix (found while reviewing)

- The **"no calendar primitive"** warning in [analytics.md](analytics.md) / [earnings.md](earnings.md) / [README #3](README.md) is **stale** — `@civitai/ui` now has `calendar` + `date-picker` + `range-calendar` + `pagination`. Only the **chart** primitive is genuinely missing. Update those notes when convenient.
</content>
</invoke>

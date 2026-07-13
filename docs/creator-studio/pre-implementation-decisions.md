# Creator Studio — decisions (reconciled)

> **Status: mostly DECIDED (2026-07-09; `/models` scope round folded in 2026-07-10 → B12–B13).** This was the
> open-question checklist; the answers are now locked in
> [questions-justin-product.md](questions-justin-product.md) (B1–B11),
> [questions-justin-models-scope.md](questions-justin-models-scope.md) (B12–B13), and
> [questions-koen-backend.md](questions-koen-backend.md) (A1–A5) — **those are the source of truth**. This doc is
> reconciled to match them so it no longer drifts. IDs (A#/B#/C#) map to the question docs.
>
> Source specs: [creator-studio-plan.md](../creator-studio-plan.md), the seven page specs. Where the plan/page
> specs still describe an old assumption (e.g. the tier-vs-CP fee split), **this doc + the question docs win** —
> flagged inline below.

Legend: ✅ decided · 🔧 needs a build/schema change · 🟢 eng/design call still open.

---

## A. Backend / data — Koen

| # | Item | Decision (2026-07-09) | State |
|---|---|---|---|
| A1 | Owner-keyed earnings rollup | **Build it.** CH **dictionary** `modelVersionId → ownerUserId` fed by **CDC/ClickPipe** from prod Postgres (reuse the Buzz-DB ClickPipe pattern); queries resolve owner via `dictGet(...)` (O(1), no join). Then an **AggregatingMergeTree** MV on `(ownerUserId, date, source)`. Schedule before v1 if feasible; app-side `WHERE modelVersionId IN (…)` stays as the small-creator / pre-launch fallback. Full spec: [owner-rollup-handoff.md](owner-rollup-handoff.md). | ✅🔧 |
| A2 | Fractional `licensingFee` | **No concern** — `Int → numeric` at 0.01 precision; settle sub-buzz at the **daily payout boundary** (not per-txn) in `deliver-creator-compensation.ts`. Manual migration. Koen flags anything assuming integer buzz; drafter of the settlement change TBD with Briant. | ✅🔧 |
| A3 | Fee pause on lapse | **Resolve at the USER level** (creator's active-membership status), **not** a per-`ModelVersion` flag — avoid mass row updates. **Read-time, no batch job.** Touch points: charge = mini endpoint `model-versions/mini/[id].ts` (add `hasActiveMembership(userId)`, pattern at `creator-program.service.ts:400-409`); honest display = `ModelVersionDetails.tsx:1418` + `ResourceItemContent.tsx:232` (version-keyed cache — resolve pause client-side or bust on membership change). Search index doesn't carry `licensingFee`. | ✅🔧 |
| A4 | Indefinite-sale representation | **Reuse early access, uncapped in time** — extend `earlyAccessConfig` to a no-time-limit mode rather than a new field. (Matches B2.) Koen scopes the backend with Briant. **Write path now exists:** the access-config REST endpoint `POST /api/v1/model-versions/early-access` (built for B12) is where the uncapped mode plugs in — it extends the same schema/service, so the remaining work is the representation (nullable `timeframe`/`indefinite` flag + skip the max-days cap & `earlyAccessEndsAt`), not new plumbing. | ✅🔧 |
| A5 | Access/cosmetic-sale earnings MV | **In v1.** These are buzz txns paid **directly to the creator** (`toAccountId`) → a per-`toAccountId` daily buzz-earnings-by-type MV, **no owner-join**. Catch: access + cosmetic sales ride the generic "purchase" type today → need a **distinct type/flag** to isolate them. Koen confirms feasibility/effort; pair with Briant on the type/flag. | ✅🔧 |

---

## B. Product / business — Justin

| # | Item | Decision (2026-07-09) | State |
|---|---|---|---|
| B1 | Member gate | **Full Creator Program membership is the single bar for ALL member-only actions** (fee-set *and* sell-indefinitely) — **not** the feature-specific tier/CP split. Rationale: tier-only lets a brand-new bronze account fee-gate other people's models; CP requires creator score, keeping a quality bar. **Build fix applied** — `membership.ts` now gates both `can*` helpers on `isCreatorProgramMember` (resolved from the `onboarding` CreatorProgram flag). | ✅🔧 |
| B2 | Indefinite-sale mechanics | **= early access with no time limit** — reuse the existing EA system (charge to download and/or generate), just uncapped. Not a new purchase mechanic. See A4. | ✅ |
| B3 | v1 earnings sources | **Show all sources in v1**, incl. access-sale + cosmetic-sale (needs A5 + the distinct txn type/flag). Comp + licenses can share a chart with a source filter. | ✅🔧 |
| B4 | Analytics scope | **Two dashboard sections.** **(a) Model:** the proposed metrics **plus** weekly granularity, generations **split by buzz color**, earnings **WoW** delta, per-model earnings (last 1–2 wk), and a **cost-to-generate reference** (avg buzz/image by base-model + type). **(b) NEW Content/Creator section** (all keyed to the creator's `userId`, no owner-join): reactions received over time, followers/new-followers, images & posts published, profile views, top-content-by-reactions table, and all-time stat tiles. Trend charts hit raw event tables; clean build = new owner-keyed daily SummingMergeTree MVs. | ✅🔧 |
| B5 | Fee auto-pause → notify | **Notify — email + in-app.** In-app: "you have models that lost their licensing fee." Email: top models that lost the fee, capped at **10** + "and N more." | ✅🔧 |
| B6 | Max licensing fee | **Keep the 100 buzz/image cap.** | ✅ |
| B7 | Bulk fee editor | **Bulk fee editing is v1**, not fast-follow — it's the point of the tool. Bulk ops get a confirm-before-continue; audit log nice-to-have; no undo. | ✅ |
| B8 | Currency display | **Show earnings in the currency they were received** (buzz for nearly everyone; cash for the ~1 cash earner). **No conversion/rate.** | ✅ |
| B9 | Default fee suggestions | **No default fee** — off unless a creator turns one on. When they do, seed the input: **LoRA ~0.1**, **base/checkpoint ~1** buzz/image; nothing for other types. | ✅ |
| B10 | Studio discoverability | **Main-app user-dropdown** nav item + on-site **launch announcement** + a Buzz-dashboard notice. | ✅ |
| B11 | Cutover comms | **Straight cutover, no grandfathering.** Accrued comp up to the cutoff is settled (not clawed back); no new comp after. Comms: Creator Economy Update article [32087](https://civitai.com/articles/32087/creator-economy-update-2026-you-set-the-price-now). | ✅ |
| B12 | Access-config editor scope | **Full parity (2026-07-10).** The studio's early/paid-access editor exposes **all** `earlyAccessConfig` fields (duration, download/generation price, free trials, free-generation, donation goal), in a per-version **drawer**, open to **any owner** (early access isn't member-gated). **Built + merged** — the write goes through a narrow main-app REST endpoint `POST /api/v1/model-versions/early-access` (studio forwards the shared `.civitai.com` session cookie; ownership + all guards + side effects stay in the main app's service; per-user EA limits in the route). Source: [questions-justin-models-scope.md](questions-justin-models-scope.md) Q1. | ✅🔧 |
| B13 | Publish / schedule in v1 | **OPEN — awaiting Justin (2026-07-10).** Publishing or scheduling a version from the studio is a management convenience (2nd-priority to fees); B7 locked bulk *fees* for v1 but never called this. Recommended default: **fast-follow** unless the studio must be a complete management hub at launch. Source: [questions-justin-models-scope.md](questions-justin-models-scope.md) Q2. | 🟢 |

---

## C. Eng / design — still ours to decide

| # | Item | Recommendation | State |
|---|---|---|---|
| C1 | Svelte charting library | Lean **LayerChart** (LayerCake-based, shadcn-svelte's charting companion), added **into `@civitai/ui`** as a shared `chart` primitive. Now higher-stakes given B4's expanded analytics. **Decide before `/analytics`.** | 🟢 |
| C2 | `/licensing`: page vs mode of `/models` | **`?mode=bulk` on `/models`** — same rows/field/write, one shared row component. B7 makes bulk **v1**, so this surface ships in v1 either way. | 🟢 |
| C3 | Date-range control | Ship **presets (7/30/90d)**; `@civitai/ui` has `calendar`/`date-picker`/`range-calendar` if we want custom ranges. B4 adds a **weekly-granularity** toggle. | 🟢 |
| C4 | Pagination — offset vs cursor | **Offset** for v1 (URL-addressable via the `pagination` primitive); revisit if version counts make it slow. | 🟢 |
| C5 | Dashboard vs /earnings vs /analytics boundary | Dashboard = at-a-glance totals + entry points; `/earnings` = by-source breakdown + cash; `/analytics` = the two B4 sections. One shared ClickHouse read module so numbers can't drift. | 🟢 |
| C6 | CP cash + withdrawal home | `/earnings` owns the cash panel + Withdraw link-out; dashboard/settings only link to it. | 🟢 |

---

## Status & sequencing

**Done:** Phase 1 shell (scaffold, auth spoke gate, nav, membership resolver, dashboard skeleton, route stubs) —
committed. Access is temporarily **moderator-gated** (base-layout redirect) during development. **B1 build fix
applied** (CP-membership gate). **`/models` shipped:** licensing-fee editing (single + bulk + apply-default),
fee status/pause display, non-commercial guard, URL-driven search/filter/sort/pagination, and the **early/paid-access
editor** (B12) writing through the merged main-app REST endpoint.

**Backend (Koen) — needed for the feature pages, roughly in build order:**

1. **A2 + A3** → unblock the `/models` fee editor (fractional fee + user-level pause).
2. **A4** → sell-indefinitely (early-access-uncapped).
3. **A1** (owner rollup) + **A5** (per-`toAccountId` sales MV + distinct txn type) → dashboard / `/earnings` / `/analytics`.

**Eng/design (ours):** lock **C1** (charting) before `/analytics`; **C2** confirmed (`?mode=bulk`).

**Buildable now without waiting:** `/models` **read side** — the creator's models + versions (kysely reads,
re-activating `db.ts`), the grouped table, access/publish/fee **display**, and CP-gated controls rendered
disabled. The fractional **input** waits on A2; the **write** on A2/A3 + the monetization module.

---

### Plan/spec drift to reconcile (this doc + the question docs win)

- **B1** — the plan §9 / models.md / licensing.md still describe a **tier-based or feature-specific** fee gate.
  It's now a **single CP-membership bar**. Update those when next touched.
- **B4** — analytics.md scopes a smaller "basic" set; the real v1 is the **two-section** dashboard above.
- **B7** — plan §8 / licensing.md call bulk editing "fast-follow"; it's **v1**.
- **B12** — models.md lists "access-config depth" as an Open question; it's now **resolved: full parity**, built +
  merged. Drop it from that spec's Open questions when next touched.
- **"No calendar primitive"** warning in analytics.md / earnings.md / README is stale — `@civitai/ui` now has
  `calendar` + `date-picker` + `range-calendar` + `pagination`. Only a **chart** primitive is genuinely missing.
</content>

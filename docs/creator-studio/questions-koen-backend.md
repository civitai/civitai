# Creator Studio — backend / data questions (Koen)

> **How to answer:** reply inline under each **Answer:** line (or drop an `@koen:` comment). No need to touch
> anything else. Full context + recommended fallbacks live in
> [pre-implementation-decisions.md §A](pre-implementation-decisions.md#a-backend--data--koen-highest-leverage);
> the IDs below (A1–A5) map back to it.
>
> **TL;DR:** the Studio shell (auth, nav, dashboard) is up. To build the feature pages I need a few backend
> pieces. The single most important is **A1** (owner-keyed rollup). For everything, I mostly need a **rough
> timeline / which land before v1** so I can sequence the work.
>
> **@justin (2026-07-09):** direction below. A1 has a design already worked out — see the handoff doc linked in
> the answer.

---

## A1 — Owner-keyed earnings rollup ⭐ (blocks the most)

**The problem.** Every ClickHouse earnings/usage aggregate is keyed by `modelVersionId`, never the creator's
`userId` (the `userId` columns that exist — `daily_user_resource`, `userModelDownloads` — are the
generator/downloader, not the creator). So "creator X's earnings/usage" has no direct key.

**What we need.** An MV aggregating `(ownerUserId, date, source) → sum(amount)` off
`orchestration.resourceCompensations`, plus a `modelVersion → ownerUserId` dictionary in ClickHouse.

**What it blocks.** Dashboard totals + "top-earning models", all of `/earnings`, and the per-model table on
`/analytics`. Our fallback without it is app-side `WHERE modelVersionId IN (…)`, which balloons for prolific
creators — so we'd ship with top-earners hidden and a version-count cap until it lands.

**Questions:**
- Can this be scheduled **before v1**? If not, is the `IN (…)` fallback acceptable for launch?
- Any existing MV/dictionary that already gets us part-way?
- Want to pair on the schema for the MV + dictionary?

**Answer / direction (Justin):** Yes, build it — the design is already worked out. Stream `modelVersionId →
ownerUserId` into ClickHouse as a **dictionary** (not a joined table): key = `modelVersionId`, attribute =
`ownerUserId`, fed by **CDC/ClickPipe** from prod Postgres (CH can't reach the Bastion-gated DB directly; we
already run ClickPipes against the Buzz DB, so reuse that pattern). Queries/MVs resolve the owner via
`dictGet('mv_owner_dict','ownerUserId', modelVersionId)` — O(1), no join. Then an **AggregatingMergeTree MV**
keyed on `(ownerUserId, date, source)` off the buzz-earning rows. Schedule before v1 if feasible; the
`IN (…)` per-owner version-ID query stays as the small-creator / pre-launch fallback.

Full build spec (dictionary + MV + CDC mirrors + confirm-before-building checklist + the query-time fallback):
**[owner-rollup-handoff.md](owner-rollup-handoff.md)**. Happy to have you pair on / adjust the schema.

---

## A2 — Fractional licensing fee migration

`ModelVersion.licensingFee` is `Int` today (`MAX_LICENSING_FEE=100`). Justin confirmed fees as small as
**0.01 buzz/image**, so we need **decimal at 0.01 precision**, with sub-buzz amounts settled at the **daily
payout boundary** (not floored per transaction) in `deliver-creator-compensation.ts`. Migration is applied
manually (repo does not run `prisma migrate deploy`).

**What it blocks.** The fee amount input on `/models` + `/licensing` (can't accept fractional until this lands).

**Questions:**
- Any concern moving `licensingFee` `Int → numeric`? Anything downstream that assumes integer buzz?
- Do you want to own the `deliver-creator-compensation.ts` daily-boundary settlement change, or should I draft it?

**Answer / direction (Justin):** **No concern** — move `licensingFee` `Int → numeric` at 0.01 precision.
Settle sub-buzz amounts at the daily payout boundary (not floored per-transaction) in
`deliver-creator-compensation.ts`. Migration applied manually per repo convention. Koen: flag anything downstream
that assumes integer buzz; otherwise sort out who drafts the daily-boundary change with Briant.

---

## A3 — Licensing-fee `active` flag

A member's fee must **auto-pause** when they have no active membership — the set **value is kept**, only
whether it *applies* changes. The mini endpoint (`.../model-versions/mini/[id].ts`, where the fee is resolved)
checks active membership on hit; the flag also drives whether the fee shows on the model card. Same kind of
gate as the pre-cutover "not-yet-payable" flag for the launch window.

**What it blocks.** The `Active` / `Paused` / `Off` fee states across `/models`, `/licensing`, `/settings`.

**Questions:**
- Add an `active`/`enabled` flag on the version's licensing fee — column on `ModelVersion`, or fold into an
  existing config blob? Any preference?
- Is the "auto-pause on lapse" evaluated at read time (mini endpoint) only, or do we also need a batch job?

**Answer / direction (Justin):** Resolve it at the **user level** (the creator's active-membership status), **not**
as a per-`ModelVersion` flag — we don't want to update thousands of rows just to toggle fees on/off when
membership lapses/renews. Evaluate at **read time**; no batch job.

Touch points (audited on this branch):
- **Charging = one place:** the mini endpoint `src/pages/api/v1/model-versions/mini/[id].ts` — this is the only
  path that actually charges. It already loads the model's owner (`modelUserId`, joins `User`), so just add an
  active-membership check. Reuse the pattern in `creator-program.service.ts:400-409` (`CustomerSubscription`
  where `status='active' AND currentPeriodEnd > now`) — ideally extract it to a shared `hasActiveMembership(userId)`.
- **Honest display = two more places:** the model-page block `ModelVersionDetails.tsx:1418` **and** the
  generation-panel badge `ResourceItemContent.tsx:232` (fed by the version-keyed `resource-data.redis.ts` cache,
  1h TTL, no user join). If the pause is only resolved in the mini endpoint, these will still advertise a fee
  that won't be charged — resolve the display-pause client-side from the creator's membership, or the gen-panel
  cache needs busting on membership change. Search index does **not** carry `licensingFee`, so it's not a risk site.

---

## A4 — "Sell access indefinitely" representation

A main-app field/flag for "available for sale indefinitely, no time/quantity cap" that bypasses
`scoreTimeFrameUnlock` / `scoreQuantityUnlock` for eligible members. Pairs with a product call to Justin on the
exact mechanics (B2).

**What it blocks.** The sell-indefinitely control on `/models`.

**Questions:**
- Extend `earlyAccessConfig`, or a dedicated field on the version?
- Once Justin defines the mechanics (one-time purchase at a creator-set price? relation to early-access
  pricing?), can you scope the backend side with me?

**Answer / direction (Justin):** **Reuse the early-access system** and allow **unlimited time** — that's the
most convenient path and it's exactly what B2 defines ("indefinite sale" = early access with no time limit). So
extend `earlyAccessConfig` to support an uncapped/no-time-limit mode rather than adding a separate field. Koen:
scope the backend with Briant on that basis.

---

## A5 — Access / cosmetic-sale earnings MV (only if in v1)

Access-sale + cosmetic-sale earnings are buzz **transactions**, not in `resourceCompensations`, so they need a
separate per-`toAccountId` daily buzz-earnings-by-type rollup (`buzz.transactions_daily_stats` is platform-wide,
no account dimension). **Only needed if v1 shows those sources** — that's a product call to Justin (B3), so this
may defer.

**What it blocks.** The access-sale + cosmetic-sale cards on `/earnings` (and their slice of the dashboard).

**Questions:**
- If Justin wants these in v1 — is a per-`toAccountId` daily buzz-earnings-by-type MV feasible on your side?
- Rough effort vs. deferring to fast-follow?

**Answer / direction (Justin):** **v1 — yes, show these sources** in the earnings tab (per B3). These are buzz
transactions paid **directly to the creator** (`toAccountId`), so a per-`toAccountId` daily
buzz-earnings-by-type MV should work straight off the buzz transactions — no owner-join needed. The catch: access
+ cosmetic sales currently ride the generic "purchase" type, so we need a **distinct type/flag to identify these
sales specifically** for the rollup. Koen: is the per-`toAccountId` MV feasible, and what's the effort? Pair with
Briant on the type/flag.

---

### Anything I'm missing?

If there's a data source or constraint I've got wrong (or an easier path than the above), flag it here:

**Notes:**

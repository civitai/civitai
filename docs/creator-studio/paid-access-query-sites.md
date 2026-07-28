# Paid-access query sites — canonical sweep (main)

Every site that reads or writes early-access / paid-access state, categorized by how it migrates onto
`PaidAccess`. Derived against `main` (2026-07-25). This is the work-list for the read-flip + dual-write; a
missed gate read is a paywall hole.

**Primitives** (`packages/civitai-buzz/src/paid-access.ts`):
- **`getPaidAccess(entityType, entityIds)`** — cached, batched *decorate* accessor. For reads that already
  have a bounded set of ids and just need "is it gated / access state / terms".
- **`paidAccessActiveSql(alias, entityType)`** — raw-SQL `EXISTS` predicate. For queries that *filter / sort /
  count / scan* rows by access state (the multi-row ones).
- Gate rule: **active ⇔ `endsAt IS NULL OR endsAt > now()`.** `endsAt IS NULL` = permanent. No `kind`, no
  `termsVersion`. Bundle semantics.

## Load-bearing architectural fact (shapes the dual-write)

For `ModelVersion`, application code almost never writes `earlyAccessEndsAt` / `earlyAccessPermanent` /
`availability` directly — it writes **`earlyAccessConfig`** (Prisma) and the DB trigger
`early_access_trigger.sql` *derives* the other three (AFTER UPDATE, same transaction). Comics use the same
pattern. The only direct writers of the derived columns are the two raw-SQL expiry paths.

→ **Dual-write approach:** a service helper `syncPaidAccessFromModelVersion(id)` that reads the *current*
(post-trigger) `earlyAccessEndsAt` / `earlyAccessPermanent` / `earlyAccessConfig` + `Model.userId` and upserts
(gated) or deletes (not gated) the `PaidAccess` row. Called after every writer below. This mirrors the derived
columns exactly, so `PaidAccess` == old columns throughout Phase 1 — no need to replicate trigger math in 13
places, and no new trigger.

---

## Bucket 1 — WRITE (dual-write via `syncPaidAccessFromModelVersion` / comic equivalent)

| file:line | what it does | writer |
| --- | --- | --- |
| `model-version.service.ts:1096-1124` `publishModelVersionsWithEarlyAccess` | primary EA-activation on publish (+creates donation goal) | Prisma + raw publishedAt bump |
| `model-version.service.ts:466-477` `upsertModelVersion` **create** | writes config on new version | Prisma |
| `model-version.service.ts:591` `upsertModelVersion` **update** | writes config | Prisma |
| `model-version.service.ts:733-737` `updateModelVersionEarlyAccessConfig` | narrow config write (REST + studio entry) | Prisma |
| `process-ending-early-access.ts:14-28` | expiry job — ends EA (raw) | **raw SQL** — close PaidAccess in the same scan |
| `donation-goal.service.ts:158-170` | goal completion ends EA early (raw) | **raw SQL** — close PaidAccess row |
| `early-access.ts:69` (REST) / `model-version.controller.ts:373-404` (tRPC) | delegate to the service writers | covered by service hook |
| `process-scheduled-publishing.ts:231-248` / `model.service.ts:2387` | call `publishModelVersionsWithEarlyAccess` | covered by publish hook |
| `comics.router.ts:4778-4781` `publishChapter` / `:4866-4871` unpublish / `:5058-5070` `updateChapterEarlyAccess` | comic EA writes | Prisma → comic sync |

**DB triggers (writers — reconcile, don't fight):** `early_access_trigger.sql` (derives the 3 model columns),
`comic_chapter_early_access_trigger.sql`, `model_availability_trigger.sql:7` (publish → Public except
EarlyAccess). Left in place during Phase 1; dropped in Phase 2.

## Bucket 2 — READ · DECORATE → `getPaidAccess` (+ `terms` where priced)

Money-critical first: `file.service.ts:206-232` (**download paywall**), `generation.service.ts:1185-1206,
1316-1325` (**generation gating**), `resource-data.redis.ts:35,60-72` (gen-gate cache),
`mini/[id].ts:118-155` (public API), `model.controller.ts:335-348` (version-page gate),
`model-version.service.ts:1767-1827` (**purchase eligibility**).

Others: `model-version.controller.ts:117,287-570`; `model-version.service.ts:842,2662`;
`model.service.ts:1569-1572,2899-2909`; `donation-goals-cache.ts:133-136`; `comics.router.ts:1921-1968`;
clients `model-version.utils.ts:58-96`, `ModelVersionDetails.tsx:282-294`,
`ModelVersionEarlyAccessPurchase.tsx:31-136`, `ModelVersionList.tsx:135`, `ResourceSelectCard.tsx:370`,
`FormFooter.tsx:1207`, `ModelVersionDonationGoals.tsx:52-54`, `comic-chapter.utils.ts:35-43`,
`comics/[id]/[[...slug]].tsx`, `comics/project/[id]/index.tsx`, `ComicExportButton.tsx:252-259`. (~24 total)

## Bucket 3 — READ · PREDICATE → `paidAccessActiveSql` (the "multi-query" raw-SQL ones)

Only four, all cap-count / scan:
| file:line | what it does |
| --- | --- |
| `model-version.service.ts:265-274` `getUserEarlyAccessModelVersions` | count active EA versions per user (max-concurrent cap) |
| `comics.router.ts:616-623` `getUserEarlyAccessChapters` | same cap-count, chapters |
| `process-ending-early-access.ts:26` | expiry scan `WHERE earlyAccessEndsAt <= NOW()` (also B1) |
| `donation-goal.service.ts:157` | guard before the raw expiry write |

(No general feed `where earlyAccessEndsAt:{gt}` exclusions exist — feed gating is via `availability` /
`hasEntityAccess`, so these cap-counts + the expiry scan are the only predicate consumers.)

## Bucket 4 — `availability = 'EarlyAccess'` gate-reads (drop the condition, source gated-ness from PaidAccess)

`mini/[id].ts:135`, `resource-data.redis.ts:35`, `common.service.ts:136-139` (**`hasEntityAccess` central
gate** — keep the permission check, source gated-ness from `getPaidAccess`), `comics.router.ts:1923,1944`.
Publish-side `availability` sets are Bucket 1. (Enum-value removal is Phase 2 + a separate dated ticket:
event-engine + Meili.)

## Bucket 5 — PRICE / TERMS readers → `terms` (not the gate)

`model-version.service.ts:1818-1826` (**purchase-price validation**, money-critical), `mini/[id].ts:136,146-155`
(`freeGeneration`/trial), `generation.service.ts:1191-1193,1321`, `creator-shop.service.ts:728-740`
(`getEarlyAccessModelPrices`), clients `ModelVersionEarlyAccessPurchase.tsx`, `ModelVersionDetails.tsx`,
`model-version.controller.ts:373-404` (write-side validation), comics `buzzPrice` sites
(`comics/[id]/[[...slug]].tsx`, `ChapterSettingsModal.tsx`, `comics/project/[id]/index.tsx`),
`model.notifications.ts:242` (meta). (~11)

## Bucket 6 — already permanent-aware (VERIFY `endsAt IS NULL` = permanent preserves them)

`file.service.ts:231`, `mini/[id].ts:134`, `resource-data.redis.ts:35`, `model-version.service.ts:1799`,
`model.service.ts:1571`, `model.controller.ts:339`, `model-version.utils.ts:69`. Under the new rule a permanent
grant is `endsAt IS NULL`, so `getPaidAccess`/`paidAccessActiveSql` subsume all six — but re-verify each,
because today `earlyAccessEndsAt` is NULL for permanent *and* for "no EA", disambiguated only by
`earlyAccessPermanent`/`availability`.

## Money-critical (fix/verify first)

`file.service.ts` (download paywall) · `generation.service.ts` + `resource-data.redis.ts` (generation gating +
its cache) · `mini/[id].ts` (public API + trial) · `model-version.service.ts:1767-1827` (purchase
eligibility + price) · `model.controller.ts:335-348` (page gate) · `common.service.ts:136-139`
(`hasEntityAccess`) · the raw expiry writers · `early_access_trigger.sql`.

**Totals:** B1 13 + 3 triggers · B2 ~24 · B3 4 · B4 ~5 · B5 ~11 · B6 7.

---

## Phase 1 read-flip status (implemented)

**Flipped to PaidAccess (all ModelVersion gate/access/money decisions):**
- `file.service.ts` download paywall → `getPaidAccess` + `isPaidAccessActive`.
- `resource-data.redis.ts` gen-gate `earlyAccessConfig` CASE → `paidAccessActiveSql('mv','ModelVersion')`
  (both `generation.service.ts` consumers ride this — no change needed there).
- `mini/[id].ts` `checkPermission` EA clause + `earlyAccessEndsAt` deadline → `LEFT JOIN "PaidAccess"`.
- `model-version.service.ts`: `earlyAccessPurchase` eligibility (row + `isPaidAccessActive`, subsumes the
  expired-window throw); delete guard (856) & merge guard (2674) → timed-only `endsAt > now`;
  `getUserEarlyAccessModelVersions` cap-count → raw `EXISTS` on `endsAt > now()` (permanent excluded, as before).
- `common.service.ts` `hasEntityAccess` → `isOpenAccess()` factors an active PaidAccess row so a version
  stays gated once the `EarlyAccess` enum value is retired.
- `model.controller.ts` version-page gate (`paidAccessGated`/`earlyAccessDeadline`) → `getPaidAccess`.
- `model.service.ts` `getModelVersionsMicro` (`isEarlyAccess`) and `updateModelEarlyAccessDeadline`
  (active timed row → model `earlyAccessDeadline`).
- `donation-goals-cache.ts` public EA-goal visibility → live timed deadline from `getPaidAccess`.

**Deferred to Phase 2 / later stage (intentionally NOT flipped):**
- **Display passthroughs** that forward `earlyAccessEndsAt`/`earlyAccessConfig` to clients unchanged
  (`model-version.controller.ts:118/287/570`, the `*.selector.ts` fragments, `generation.schema.ts`
  type). No access decision; flips with the client work when the columns are dropped.
- **Writer-path denormalization** reading the trigger-derived column right after publish
  (`process-scheduled-publishing.ts` bulk `earlyAccessDeadline` UPDATE, the raw expiry writers in
  `process-ending-early-access.ts` / `donation-goal.service.ts`). These drive the columns; the sync hook
  mirrors PaidAccess after.
- **Terms/price readers** on the still-present `earlyAccessConfig` JSON (`creator-shop.service.ts`
  `getEarlyAccessModelPrices`, `mini/[id].ts` `freeTrialLimit`) — the JSON survives Phase 1.
- **Comics** (`comics.router.ts` EA paths) — comics migrate onto PaidAccess in stage 5; no ComicChapter
  rows exist yet, so their reads stay on legacy columns.

---

## Phase 2 column-drop coverage — audited 2026-07-26

Three parallel auditors swept `src/` + `packages/` for every reference to the columns Phase 2 drops
(`ModelVersion.earlyAccessEndsAt`, `earlyAccessPermanent`, `earlyAccessConfig`, the EA trigger; the
`availability='EarlyAccess'` enum value is a separate dated ticket). **No paywall/gate read was missed** —
every access/money decision is flipped. Findings:

**Cleaned up now (dead selects left by the Phase-1 flip — removed so they don't break the drop):**
- `file.service.ts` — dropped the unused `earlyAccessEndsAt`/`earlyAccessConfig`/`earlyAccessPermanent` select.
- `model-version.service.ts:542` — dropped the unused `earlyAccessEndsAt` select (kept `earlyAccessConfig`, still read).

**Must flip in Phase 2 — LIVE references not previously catalogued (would throw at the drop):**
- `src/pages/api/v1/model-versions/[id].ts` — the **public v1 API** used to select `earlyAccessEndsAt`
  and `earlyAccessConfig` into the `ModelVersionApiReturn` contract. **RESOLVED (2026-07-28): dropped, not
  reconstructed** — the public API should not surface paid-access gate details and has no active consumers
  of these fields. (See the cutover doc's "Resolved decisions".) Superseded this note's earlier "reconstruct
  ... not just delete" guidance.
- `src/server/jobs/process-scheduled-publishing.ts:46` — `hasEarlyAccess` is computed from
  `earlyAccessConfig->>'timeframe' > 0` in the publish job (fires before the row exists). Phase 2: derive from
  terms / the post-publish PaidAccess row.
- `src/server/notifications/model.notifications.ts:242` — `early-access-complete` query probes
  `earlyAccessConfig->>'originalTimeframe'`. **`originalTimeframe` has NO Phase-2 home** (only
  `originalPublishedAt→initialPublishedAt` is planned) — needs an explicit design call: source "just left
  early access" from a PaidAccess transition, or preserve `originalTimeframe` somewhere.

**Must flip in Phase 2 — already-catalogued deferred categories (confirmed complete):**
- **Terms readers** on `earlyAccessConfig` → `PaidAccess.terms`: `creator-shop.service.ts`
  `getEarlyAccessModelPrices`; `mini/[id].ts` `freeTrialLimit`/`freeGeneration`; `resource-data.redis.ts`
  emits the blob into the gen cache; `generation.service.ts:1191,1193,1321` read it off that cache row; the
  purchase-price reads in `earlyAccessPurchase`; client display (`ModelVersionDetails`,
  `ModelVersionEarlyAccessPurchase`, `model-version.utils.ts`, `FormFooter`).
- **Display passthroughs**: `model-version.controller.ts:118/287/570`, `model.controller.ts:419`,
  `*.selector.ts` fragments (`generation.selector.ts:12` appears dead — verify/remove), `generation.schema.ts`.
- **Write paths** (dual-write source, stop writing in Phase 2): the upsert / `updateModelVersionEarlyAccessConfig`
  / `publishModelVersionsWithEarlyAccess` blob writes; `ModelVersionUpsertForm` payload.
- **`originalPublishedAt`** blob writes (`model-version.service.ts:1105`, `process-ending-early-access.ts:20`,
  `donation-goal.service.ts:164`) — superseded by the `initialPublishedAt` anchor + write-once trigger (no code
  *reads* `originalPublishedAt` from the blob). **`donationGoalId`** back-link → forward FK.

**Phase 2 SYNC-REWRITE dependency (flagged):** `syncPaidAccessFromModelVersion` reads the trigger-derived
`availability`/`earlyAccessEndsAt`/`earlyAccessPermanent`. When the trigger + columns drop, it must be rewritten
to compute `endsAt` from `initialPublishedAt` + terms. `buildModelVersionTerms` already reads only the blob.

**Enum-retirement ticket (separate, dated):** `model.service.ts:1011` visibility filter and
`model_availability_trigger.sql`'s `availability != 'EarlyAccess'` guard reference the enum value.

**Tests** referencing the columns (update at the drop, non-blocking): the `__tests__` fixtures in
`donation-goal.service.test.ts`, `file-download-lookup.test.ts`, `model-version.*.test.ts`,
`model-version-public-donation-goals-cache.test.ts`, `generation-resource-projection.test.ts`.

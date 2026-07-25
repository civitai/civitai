# PaidAccess — implementation & rollout

Companion to [paid-access-schema.md](paid-access-schema.md) (the shapes) and
[paid-access-query-sites.md](paid-access-query-sites.md) (the read sweep). This doc is the **buildable plan**:
the release order, the module/signature contracts, the literal migration SQL, and the UI plan for both surfaces
(matching the mockup). Written after the 2026-07-24 completeness review, which found the backend plan ready but
the frontend and sequencing unwritten.

UI target: the two-surface mockup (main-app inline form + Creator Studio drawer). It reflects **bundle
semantics** — "Price for access" is the download bundle (grants generation too); "Generation-only price" is the
optional cheaper tier.

---

## 1. Rollout & sequencing (the release order)

**Product-owner constraint:** the **main-app** change *and its onsite UI* are built in the parent worktree
`/work/civitai` and **released first**. The **creator-studio spoke** (this worktree,
`c:\work\civitai-creator-studio`, branch `creator-studio-implementation`) follows **after** that release is
live. The destructive column drop comes **last**, after the spoke has caught up.

Both apps read the **same database** and build `@civitai/*` **from source at their deployed commit** (no npm
publish — `@civitai/buzz` is `workspace:*`). So the coupling is the **shared DB during dual-write**, not a
package version. This ordering is safe because Part 1 keeps the old columns dual-maintained, and the spoke reads
those old columns until it's converted.

| Phase | Worktree / release | Steps | Safe because |
| --- | --- | --- | --- |
| **A — main app, ships first** | `/work/civitai` | Slice 0 (anchor) → Part 1 (table + backfill + dual-write + main-app read sweep incl. the 11 `availability` gate-reads) → Part 1.5 (flip `@civitai/buzz` helper) → **onsite UI** → deploy + soak | old columns stay dual-written; spoke (old code) keeps reading them correctly |
| **B — spoke, ships after A is live** | `c:\work\civitai-creator-studio` | pick up regenerated Kysely types → convert the 4 spoke reads to `PaidAccess` (query-sites §E) → spoke drawer UI → deploy + soak | table + dual-write already live from Phase A |
| **C — main app, ships after B is live** | `/work/civitai` | **Part 2**: stop dual-write, stop writing `availability='EarlyAccess'`, drop columns, drop triggers, retarget expiry job | nothing reads the old columns anymore |

> **Hard gate (the trap):** **Part 2 is a main-app change but is NOT part of the "main app first" release.** It
> is Phase C — it must not deploy until the spoke (Phase B) is updated *and* live. Dropping
> `earlyAccessConfig`/`earlyAccessEndsAt`/`earlyAccessPermanent` while the spoke still reads them breaks the
> spoke instantly (`models.ts:10`, `monetization/early-access.ts:98/114`), and removes them from the shared
> Kysely types so the spoke won't even typecheck.

Notes:

- **The spoke does NOT ride the Part-1.5 helper flip.** It has its own inline `paidAccessFilter` and count
  queries and never imports `paidAccessSql`/`isPaidAccessActive`. Phase B converts those by hand (query-sites
  §E) — don't assume flipping the helper carries the spoke along.
- **No `@civitai/buzz` version bump for the spoke** — it doesn't import the paid-access helpers; adding a "bump
  the buzz version" step would be wasted.
- Comics `PaidAccess` migration and the `Availability.EarlyAccess` **enum-value** drop remain separate, dated
  tickets (the latter crosses into event-engine + Meilisearch → coordinated deploy + reindex).

### Checklist (start-Monday order)

**Phase A (main app, `/work/civitai`):**

1. [ ] Slice 0 SQL (§3): `initialPublishedAt` on `ModelVersion` + `ComicChapter`, backfill, expiry job stops rewriting `publishedAt`.
2. [ ] Part 1 SQL (§3): `PaidAccess` table + enum + indexes (incl. the partial index); backfill currently-gated rows.
3. [ ] Access resolver module (§2): `@civitai/buzz` pure fns + `src/server/services/paid-access.service.ts` (`getPaidAccess`, `resolveAccess`).
4. [ ] Dual-write across every writer incl. the two raw-SQL writers (schema §Part 1.3).
5. [ ] Main-app read sweep + the 11 `availability` gate-reads (query-sites §A, §C); legacy cache busts.
6. [ ] Part 1.5: reimplement `@civitai/buzz/src/paid-access.ts` against `PaidAccess`; rewrite its tests.
7. [ ] Caps loader/query (§4) — the "X of Y used" count, server-computed.
8. [ ] Onsite UI redesign (§5) — `ModelVersionUpsertForm`.
9. [ ] Deploy + soak; **verify prod behaves identically**.

**Phase B (spoke, this worktree):** 10. [ ] Kysely types include `PaidAccess`. 11. [ ] Convert the 4 spoke reads (§E). 12. [ ] Drawer UI (§6). 13. [ ] Deploy + soak.

**Phase C (main app):** 14. [ ] Part 2 drops (schema §Part 2) — **only after Phase B is live**.

---

## 2. Backend module map + signatures

Split by infra dependency: **pure functions** (no redis/DB) are shared in `@civitai/buzz`; the **cached
accessor** uses main-app redis and lives in `src/`.

### `packages/civitai-buzz/src/paid-access.ts` (shared, pure) — reimplemented in Part 1.5

```typescript
type PaidAccessRow = { entityType: 'ModelVersion' | 'ComicChapter'; entityId: number; ownerId: number;
  endsAt: Date | null; terms: unknown };

// active ⇔ no window or window still open
export const isPaidAccessActive = (row: Pick<PaidAccessRow,'endsAt'>, now = new Date()): boolean =>
  row.endsAt == null || row.endsAt > now;

// SQL predicate for filter/sort/count — an EXISTS against PaidAccess, joined on the entity alias
export const paidAccessActiveSql = (alias: string, entityType: string) =>
  `EXISTS (SELECT 1 FROM "PaidAccess" pa WHERE pa."entityType" = '${entityType}' AND pa."entityId" = ${alias}.id
           AND (pa."endsAt" IS NULL OR pa."endsAt" > now()))`;

// entityType-dispatched terms parser (no termsVersion; zod is the contract)
export const parseTerms = (entityType: string, raw: unknown): ModelVersionTerms | ComicChapterTerms => …;
export const effectivePrice = (grant: Grant): number => grant.price; // promotions deferred
```

Every current caller passes `{earlyAccessEndsAt, permanent}`; the input type change is its own mini-sweep —
update callers to pass a `PaidAccessRow` (from `getPaidAccess`).

### `src/server/services/paid-access.service.ts` (main app, cached) — new in Part 1

```typescript
// batch, cached (createCachedObject, cache-helpers.ts), keyed "entityType:entityId" — cache the ROW, derive live
export function getPaidAccess(keys: { entityType: EntityType; entityId: number }[]): Promise<Map<string, PaidAccessRow>>;

// join the config side (PaidAccess) with the purchase side (EntityAccess) for a user
export function resolveAccess(input: {
  entityType: EntityType; entityId: number; userId?: number;
}): Promise<{ gated: boolean; hasDownload: boolean; hasGeneration: boolean; terms: PaidAccessTerms | null }>;
```

Cache invalidation: bust on config change / threshold-fires / removal / entity-delete (never on time passing).
Every `PaidAccess` **write** also busts the legacy keys (`bustMvCache`, `RESOURCE_DATA`, `dataForModelsCache`)
throughout Part 1.

The **spoke** uses the pure `paidAccessActiveSql` in its Kysely `EXISTS`/counts; it does **not** call
`getPaidAccess` (its own redis/decorate path).

---

## 3. Literal migration SQL (hand-applied — preview → staging → prod)

Illustrative; adjust column casing to the live schema. **Migrations here are applied by hand**, so these are
the actual statements to run, not `prisma migrate deploy`.

```sql
-- ===== Slice 0 — the anchor (ships first, no table) =====
ALTER TABLE "ModelVersion" ADD COLUMN "initialPublishedAt" timestamptz;
ALTER TABLE "ComicChapter" ADD COLUMN "initialPublishedAt" timestamptz;

UPDATE "ModelVersion" SET "initialPublishedAt" =
  COALESCE(("earlyAccessConfig"->>'originalPublishedAt')::timestamptz, "publishedAt")
  WHERE "initialPublishedAt" IS NULL AND "publishedAt" IS NOT NULL;
UPDATE "ComicChapter" SET "initialPublishedAt" = "publishedAt"
  WHERE "initialPublishedAt" IS NULL AND "publishedAt" IS NOT NULL;
-- + retarget process-ending-early-access.ts to stop rewriting publishedAt (code, not SQL)

-- ===== Part 1 — table + indexes =====
CREATE TYPE "PaidAccessEntityType" AS ENUM ('ModelVersion', 'ComicChapter');

CREATE TABLE "PaidAccess" (
  "entityType" "PaidAccessEntityType" NOT NULL,
  "entityId"   integer NOT NULL,
  "ownerId"    integer NOT NULL,
  "endsAt"     timestamptz,             -- NULL ⟺ permanent
  "terms"      jsonb    NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("entityType", "entityId")
);
CREATE INDEX "PaidAccess_owner_type_endsAt_idx" ON "PaidAccess" ("ownerId", "entityType", "endsAt");
CREATE INDEX "PaidAccess_permanent_cap_idx"     ON "PaidAccess" ("ownerId", "entityType") WHERE "endsAt" IS NULL; -- partial (Prisma can't express)

-- ===== Part 1 — backfill CURRENTLY-GATED model versions only (re-measure permanent at run time) =====
INSERT INTO "PaidAccess" ("entityType","entityId","ownerId","endsAt","terms")
SELECT 'ModelVersion', mv.id, m."userId",
  CASE WHEN mv."earlyAccessPermanent" THEN NULL ELSE mv."earlyAccessEndsAt" END,   -- permanent → NULL
  jsonb_strip_nulls(jsonb_build_object(
    'download',   CASE WHEN (mv."earlyAccessConfig"->>'chargeForDownload')::boolean
                       THEN jsonb_build_object('price', (mv."earlyAccessConfig"->>'downloadPrice')::int) END,
    'generation', CASE WHEN (mv."earlyAccessConfig"->>'chargeForGeneration')::boolean
                       THEN jsonb_strip_nulls(jsonb_build_object(
                              'price',      (mv."earlyAccessConfig"->>'generationPrice')::int,
                              'trialLimit', (mv."earlyAccessConfig"->>'generationTrialLimit')::int)) END,
    'freeGeneration', NULLIF((mv."earlyAccessConfig"->>'freeGeneration')::boolean, false)  -- preserve the rare case
  ))
FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId"
WHERE mv."availability" = 'EarlyAccess'
  AND (mv."earlyAccessEndsAt" > now() OR mv."earlyAccessPermanent" = true);
-- Then: run §7 terms zod validation over the inserted rows; report/clamp dirty legacy prices (see §7 Open).
```

Part 2 drops (schema §Part 2) are separate hand-run SQL, **Phase C only**.

---

## 4. Caps / limits data (the "X of Y used" readout)

The mockup shows two allowance readouts; today the main-app form computes caps **client-side** from
`currentUser.meta` and has **no live "used" count** — which also causes displayed-vs-enforced drift. Build one
server-computed source:

- **Main app** — a tRPC query `modelVersion.getPaidAccessAllowance` returning, computed server-side with the
  same enforcement helpers the write path uses (`getHighestTierSubscription`, `PERMANENT_ACCESS_LIMIT_BY_TIER`,
  the score unlock):

  ```typescript
  { permanentUsed: number; permanentCap: number | null;   // gold = null (∞)
    earlyAccessUsed: number; earlyAccessCap: number; maxEarlyAccessDays: number }
  ```

  `permanentUsed` = count of the owner's `PaidAccess WHERE endsAt IS NULL` (the partial index); `earlyAccessUsed`
  = active timed count. Displayed == enforced because both read the same server helper.
- **Spoke** — already loads this (`+page.server.ts:114-120`: `permanentUsed/permanentCap`,
  `earlyAccessUsed/earlyAccessCap`, `maxEarlyAccessDays`); just retarget its count queries to `PaidAccess`
  (§E) and render the two readouts (pure presentation).

---

## 5. Frontend — main app (`ModelVersionUpsertForm`, Mantine)

Redesign the early-access block (`ModelVersionUpsertForm.tsx` ~641-1004) to the mockup's **main-app** surface.

**Binding — do NOT reshape the form value.** During Part 1 the backend dual-writes, so the form **keeps
binding to `earlyAccessConfig`** (`modelVersionEarlyAccessConfigSchema`). The redesign is **pure presentation** —
same submitted blob, new layout. Reshaping to a `terms` value would break dual-write.

**Layout (replaces master-switch + permanent-toggle + per-capability cards):**

1. **Mode selector** — two cards **Early Access (timed)** / **Paid Access (permanent)**, replacing the nested
   permanent `Switch`. Maps to `earlyAccessConfig.permanent` (+ the `timeframe:0` convention). Off state
   (not selling) is the existing "I want to charge for access" gate.
2. **Duration** — the existing `SegmentedControl` of score-unlocked days; timed mode only.
3. **Pricing card (always visible; drop the two `chargeFor*` `InputSwitch`es):**
   - **"Price for access"** (required) → `downloadPrice`, and the client sets **`chargeForDownload = true`**
     whenever it's set. Copy: "unlocks download + generation."
   - **"Generation-only price"** (optional, **`0` = free**, placeholder = access price). One field's value
     synthesizes the old flags — no `chargeForGeneration`/`freeGeneration` checkboxes:
     - **`0`** → `freeGeneration = true` (generation free/ungated — the "pay to download, generate free" case);
     - **`> 0` (≥ 50)** → `chargeForGeneration = true`, `generationPrice = N` (the cheaper generation-only tier);
     - **blank** → neither → generation gated by the download bundle.
   - **"Free preview generations"** → `generationTrialLimit`; shown only when a paid generation tier exists
     (`> 0`), since trials meter that tier.
4. **Donation goal** (timed only) — `donationGoalEnabled` + amount + the "meeting the goal ends early access"
   warning. The in-form **progress bar** needs a read the upsert form doesn't do today (goal progress lives in
   `ModelVersionDonationGoals.tsx`) — fetch it or show amount-only in v1.
5. **Limits** — the two readouts from §4.

**Edge cases the mockup doesn't show:**

- **Generation-only resource** (`modelDownloadEnabled === false`, handled today at ~705): there is no download
  to sell — "Price for access" maps to `generationPrice`/`chargeForGeneration`, and the download tier is hidden.
- **`freeGeneration`**: no separate control — a creator makes generation free by entering **`0`** in the
  generation-only price (above). The capability is preserved; the field just doubles as the free toggle. Confirm
  in §7.
- **No proration copy** — the "upgrade for the difference" line is deferred with proration; don't show it.
- **Naming**: UI labels "Early Access" / "Paid Access"; the bound fields stay `earlyAccess*`.

---

## 6. Frontend — creator studio (the `Sheet` drawer, `@civitai/ui` + Tailwind)

Redesign the drawer (`+page.svelte` ~943-1087) to the mockup's **Creator Studio** surface. **The drawer still
POSTs to the main app's REST endpoint** (`?/setEarlyAccess` → `/api/v1/model-versions/early-access`), so the
payload must keep the `earlyAccessConfig` blob shape — same checkbox→field synthesis as §5.

1. **Mode selector** — two cards Early Access / Paid Access, replacing the "Make permanent" `Checkbox` (maps to
   `ea.permanent` + `timeframe:0`).
2. **Duration** — keep the `NumberInput` (days), timed only.
3. **Pricing** — always-visible "Price for access" (`downloadPrice`) + "Generation-only price" (`0` = free) +
   "Free preview generations"; drop the "Charge to download / generate" and "Allow free generation" checkboxes.
   Synthesize `chargeForDownload`/`chargeForGeneration`/`freeGeneration` on submit exactly as §5 (`0` →
   `freeGeneration`, `> 0` → the tier, blank → bundle).
4. **Donation goal** — checkbox + warning copy + amount + progress readout (the spoke loader must fetch goal
   progress — new read).
5. **Limits** — the two readouts from the loader it already has (§4), retargeted to `PaidAccess`.
6. **Footer** — keep `Save early access` / `Turn off early access`.

Payload contract: the endpoint parses `updateEarlyAccessConfigSchema`, so the synthesized blob must satisfy it
(`chargeForDownload`, `downloadPrice`, `chargeForGeneration`, `generationPrice`, `generationTrialLimit`,
`permanent`, `timeframe`, `donationGoal*`, `freeGeneration`).

---

## 7. Open decisions (need a call before/while coding)

- **`freeGeneration`** — **DECIDED: no separate control; expressed as generation-only price = `0`** (§5). The
  capability stays available (a creator selling downloads sets generation to 0 for free generation), with one
  fewer checkbox. Validation allows `0` as a special case alongside the `≥ 50` floor.
- **Dirty legacy prices at backfill** — **DECIDED: report + fix.** The backfill's §7 validation pass emits a
  report of sub-floor prices / `download < generation` rows for manual correction before cutover; it does **not**
  silently clamp (never move money without a human).
- **In-form donation progress** (main app) — **DECIDED: fetch if easy, else amount-only.** If a per-version
  goal-progress read already exists (it powers `ModelVersionDonationGoals.tsx`), wire it into the upsert form for
  the progress bar; otherwise ship amount-only in v1 and add progress later. Not a blocker either way.
- **Naming** — "Early Access / Paid Access" UI over `earlyAccess*` fields is settled; a full field rename is a
  later, separate change.

# Permanent pay-for-access — implementation spec (CU `868ke4949`) + EA-editable (`868ke4944`)

**Status: spec only — NOT yet implemented.** This is the execution-ready design for gating a model version behind
payment **indefinitely** by extending the existing early-access (EA) system. Based on a full read-only map of both
repos (refs below). **Main-app code lands in `C:\work\civitai` and deploys BEFORE the migration runs** (per Briant);
then we merge into this worktree.

> **Why this isn't "just a migration."** EA's end date `ModelVersion.earlyAccessEndsAt` is computed by a **Postgres
> trigger** from `publishedAt + config.timeframe`. Today **`earlyAccessEndsAt IS NULL` is exactly how the system
> encodes "EA is over / content is public/free."** So making EA "have no end date" the naive way reads as *expired /
> free* at every paywall. Permanent therefore needs an explicit **"EA active but never expires"** signal, a trigger
> change, and a patch at each enforcement site. No single migration does this safely on its own.

---

## 1. Design decision (needs Briant's ✔ before coding)

**Recommended:** add an explicit boolean **`ModelVersion.earlyAccessPermanent`** column *and* a `permanent: boolean` in
the `earlyAccessConfig` JSON.

- The **column** keeps the SQL enforcement sites (trigger, generation-permission SQL, redis resource query) clean —
  they can test `earlyAccessPermanent` directly instead of probing JSON.
- The **config flag** keeps the write/validation path and the spoke form symmetric with the other EA terms.
- `earlyAccessEndsAt` stays **NULL** for permanent versions (so the auto-expiry job never touches them — it already
  filters `earlyAccessEndsAt <= NOW()`), and `availability` stays **`EarlyAccess`**.

Alternatives considered: a **sentinel `timeframe` (e.g. `-1`)** avoids a schema change but overloads a field whose
`0` already means "off" and forces every SQL site to special-case a magic number — rejected for clarity. A **pure
JSON flag** (no column) works but makes the trigger + raw-SQL sites parse JSON — acceptable fallback if we want zero
new columns.

`@briant:*` confirm: explicit `earlyAccessPermanent` column (recommended) vs JSON-only flag?

## 2. Migration (runs AFTER the code deploy)

1. **(if column)** `ALTER TABLE "ModelVersion" ADD COLUMN "earlyAccessPermanent" boolean NOT NULL DEFAULT false;`
   (nullable-safe; default false = no behavior change for existing rows).
2. **Rewrite the trigger** `packages/civitai-db-schema/prisma/programmability/early_access_trigger.sql`
   (`early_access_ends_at()`, fires `AFTER INSERT OR UPDATE OF "earlyAccessConfig","publishedAt"`):
   - **New permanent branch** (highest precedence): when the config marks permanent (`(config->>'permanent')::bool`
     or the `earlyAccessPermanent` column) AND `publishedAt IS NOT NULL` → set `availability = 'EarlyAccess'`,
     `earlyAccessEndsAt = NULL`.
   - Keep the existing finite branch (`timeframe > 0` → `publishedAt + timeframe days`, `EarlyAccess`).
   - Keep the else branch (`timeframe = 0`, not permanent → `NULL`, `Public`).
3. No data backfill needed (default false / no permanent rows exist yet).

Per CLAUDE.md: **write the SQL, commit it, surface it for manual apply — never auto-run `prisma migrate deploy`.**

## 3. Main-app code changes (`C:\work\civitai`) — deploy first

**A. Write endpoint** `src/pages/api/v1/model-versions/early-access.ts` (POST, ~L20-76):
- Accept `permanent` (via the extended schema).
- When `permanent`: **(a)** gate on **`hasValidCreatorMembership(userId)`** (`creator-program.service.ts:261-265`) →
  403 if not a paid CP member (EA today has no membership gate; permanent is member-only per Justin). **(b)** **skip
  the day-cap** check at L41-46 (permanent has no finite day count). Quantity cap (L48-56) — decide whether permanent
  counts against `getMaxEarlyAccessModels` (recommend: yes, it still occupies an EA slot).

**B. Schema** `src/server/schema/model-version.schema.ts` `modelVersionEarlyAccessConfigSchema` (L364-376): add
`permanent: z.boolean().optional().default(false)`. Relax the "timeframe must be positive" expectation so
`permanent` + `timeframe: 0` is valid.

**C. Service** `updateModelVersionEarlyAccessConfig` `src/server/services/model-version.service.ts` (L692-755):
- Persist `permanent` into config (and the column, if added).
- `assertEarlyAccessChargeConfig` (L325-339): still require a charge (download or generation) when permanent — a
  permanent gate with no charge is meaningless.
- `mergeEarlyAccessConfigUpdate` (L344-384): add the **finite⇄permanent transition rule**. Today L367 blocks
  *increasing* `timeframe` on a published version. Decide: allow finite→permanent (extends the gate — arguably
  should be allowed for the owner) and permanent→finite/off (shortens — allowed). This is a policy call.
  `@briant/@justin:*` confirm which transitions are allowed post-publish.

**D. Paywall enforcement sites — each currently treats NULL/past `earlyAccessEndsAt` as "free/public"; each needs
`… || isPermanent`** (test the column/flag). This is the risky set — money enforcement:
- Purchase guard `model-version.service.ts:1708` (`!earlyAccessEndsAt` → "not enabled") & `:1722`
  (`earlyAccessEndsAt < now` → "public").
- Download paywall `file.service.ts:228-229` (`inEarlyAccess = deadline && now < deadline`) + enforce `:268-274`.
- Model page / download button `model.controller.ts:287-297`.
- Generation permission SQL `src/pages/api/v1/model-versions/mini/[id].ts:134-136`.
- Generation-config exposure (redis) `src/server/redis/resource-data.redis.ts:34` (CASE drops config when
  `earlyAccessEndsAt < NOW()`).
- Concurrent-EA counter / delete guards `model-version.service.ts:266,794,2571`; model rollup
  `model.service.ts:1467,2795-2801`; client display `model-version.utils.ts:67`.

**E. Auto-expiry job** `src/server/jobs/process-ending-early-access.ts:14-28` — already safe (NULL end date is
excluded by `<= NOW()`), *provided* permanent uses NULL end date. Add a comment; no logic change.

## 4. EA "editable anytime" (`868ke4944`) — same merge-guard, do together

The typo-forces-delete-and-reupload pain is `mergeEarlyAccessConfigUpdate` (`model-version.service.ts:344-384`)
being too strict post-publish. Fix in the same PR: **allow editing price/charge terms anytime** while a version is in
EA (or permanent), keeping only the guards that protect buyers (don't retroactively worsen a purchased deal — audit
which of the L360-380 guards are buyer-protection vs. incidental). This is main-app-only; the spoke already forwards
edits.

## 5. Spoke changes (`apps/creator-studio`) — after the main-app contract is live

- `src/lib/monetization/early-access.ts` `EarlyAccessConfig` type (L33-43): add `permanent?: boolean`.
- `src/lib/server/monetization/early-access.ts` `earlyAccessFormSchema` (L28-45): add `permanent` (coerced
  checkbox); **relax the `.positive()` timeframe requirement (L30)** so `permanent` + `timeframe:0` validates.
- `src/routes/models/+page.server.ts` `setEarlyAccess` action (L121-151): the L131-135 "timeframe ≤ 0 = turn off"
  branch must NOT fire when `permanent` is set — forward the config instead.
- EA editor UI (`models/+page.svelte` sheet): add a **"Make permanent (no end date)"** checkbox that hides the
  duration field and drives `permanent`. Gate the option on CP membership + surface the member-only requirement.
- Wire format: send `{ ...config, permanent: true, timeframe: 0 }` to `/api/v1/model-versions/early-access`.

## 6. Deploy order (Briant's constraint)

1. Land + deploy the **main-app** code (schema/endpoint/service/enforcement, trigger file committed) to prod, with
   `earlyAccessPermanent` defaulting false so nothing changes for existing rows.
2. **Apply the migration** (column + trigger rewrite) manually.
3. Merge the shared-schema + spoke changes into this worktree and ship the Studio UI.

## 7. Open decisions (blockers for coding)

- **[design]** explicit `earlyAccessPermanent` column vs JSON-only flag (§1).
- **[policy]** allowed post-publish transitions finite⇄permanent⇄off (§3C).
- **[policy]** does a permanent version count against the max-EA-models quantity cap (§3A)?
- **[gate]** permanent = **Creator-Program-member-only** confirmed (matches `868ke4949`); EA stays open to all.
- **[scope]** "EA editable anytime" (§4) — confirm which merge guards are buyer-protection (keep) vs. removable.

## References (read-only map, 2026-07-20)
Trigger `packages/civitai-db-schema/prisma/programmability/early_access_trigger.sql`; schema
`prisma/schema.prisma` ModelVersion L1006-1028 (`earlyAccessEndsAt` L1023, `earlyAccessConfig` L1024,
`availability` L1021); EA config zod `src/server/schema/model-version.schema.ts:364-390`; write endpoint
`src/pages/api/v1/model-versions/early-access.ts:20-76`; service `model-version.service.ts:692-755` +
`mergeEarlyAccessConfigUpdate:344-384`; membership `creator-program.service.ts:261-265`; caps
`early-access-helpers.ts:43-85`, `constants.ts:1701-1731`; expiry job `process-ending-early-access.ts:14-28`.
Spoke: `apps/creator-studio/src/lib/{,server/}monetization/early-access.ts`, `routes/models/+page.server.ts:121-151`.

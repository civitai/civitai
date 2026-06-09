# Moderator App — Minimal Package Extraction Plan

**Status:** plan · **Date:** 2026-06-04
**Companion to:** [`moderator-app-package-boundary.md`](./moderator-app-package-boundary.md) — that doc's *package recommendations* (`@civitai/moderator-server`, `@civitai/shared-schema`, `@civitai/ui-common`) are **superseded by this doc**. Its analysis of what stays app-local / proxied remains valid.

## Premise (the only test)

The moderator app runs **its own routers against the shared DB**. So a file must become a **package** *only* when duplicating it would corrupt shared data — i.e. it's a **hand-authored contract governing a column both apps read or write**. Everything else is app-local (copy), stays in main (proxy), or is vendor-copied. This is demand-driven, not purity-driven: `src/shared/` is the main app's *client/server* boundary and is irrelevant to cross-app packaging.

## What goes into the package

Derived from a full sweep of every domain-vocabulary import across the 22 in-scope pages + the app-local (isolated) services, then closure- and forcing-checked. **Two extraction modes** feed the package:

- **Whole-file move** — the file *is* the shared unit. Pure `git mv` (R100). Most rows below.
- **Member-level extraction** — a small, pure, shared member is buried in an app-coupled file. Carve *that member* into the package and leave a **re-export at its old location**; the coupled file keeps working for its other consumers untouched. A content edit, not a rename — so no R100 for the source file. Used for `CacheTTL` (and `ReportEntity`, which also folds into `enums`).

### Whole-file moves

| File | Bucket · why it belongs here | `~/` import closure |
|---|---|---|
| `src/server/common/enums.ts` (450 lines) | **Contract.** Non-Prisma domain enums keying shared columns: `BlocklistType` (`Blocklist`), `NotificationCategory` (`Notification`), `NsfwLevel`, `BlockedReason`, `TagSort`, report/scan status. **Also absorbs `ReportEntity`** (Q1 — see member extractions). | **none** (0 imports) |
| `src/server/common/moderation-helpers.ts` (88 lines) | **Contract.** `unpublishReasons` codes written by moderator, read/displayed by main. Mis-filed under `server/common/`. | **none** (pure) |
| `src/shared/constants/mime-types.ts` (72 lines) | **Contract.** `MIME_TYPES`/`MEDIA_TYPE` map file-ext ↔ `MediaType`; both apps categorize uploaded files (csam/training) into shared columns. | `@civitai/db-schema/enums` |
| `src/shared/constants/basemodel.constants.ts` (V2 ecosystem schema) | **Vocabulary.** Shared base-model / ecosystem identity — generation config both apps must agree on. | `./lazy`, `./type-guards`, `@civitai/db-schema/enums` |
| `src/utils/type-guards.ts` | **Pure leaf dep** of basemodel. **174 consumers** app-wide → strong single-source argument. *(Generic, not strictly "domain" — could relocate to a future `@civitai/utils`.)* | **none** (pure) |
| `src/shared/utils/lazy.ts` | **Pure leaf dep** of basemodel. | **none** (pure) |

### Member-level extractions (carve + re-export)

| Member | From (stays, re-exports) | Into | Why |
|---|---|---|---|
| `ReportEntity` enum | `src/shared/utils/report-helpers.ts` (the file is *only* this enum → becomes a shim) | `enums.ts` | **Contract.** Keys the shared `Report` table — same class as `BlocklistType`. Consolidating into the canonical enums file (Q1). |
| `CacheTTL` const | `src/server/common/constants.ts` (1,734 ln; env- + feature-flag-service-coupled — can't whole-file move) | a small `cache.ts` (or `enums.ts`) | Pure TTL numbers (constants.ts:1454, 0 deps), used by the moderator's blocklist/cache code. **Extract the member, not the file** (Q3). |

### Conditional — only if the moderator app filters feeds by browsing level (Q2)

| File | Status |
|---|---|
| `src/shared/constants/browsingLevel.constants.ts` | The drift-unsafe contract is the **`NsfwLevel` enum** (already in `enums.ts`). This file is the *derived label/flag layer*; the moderator pages use only `browsingLevels` + `getBrowsingLevelLabel` (display labels). **If no browsing-level filtering → copy the label slice** (cosmetic drift only), don't package. ⚠ verify: do the image review-queue functions lifted from `image.service` filter by browsing-level *flags*? If yes, this + `flags` come back as a contract. |
| `src/shared/utils/flags.ts` | In the package **only** as `browsing-level`'s dep. If `browsing-level` is copied/dropped, `flags` drops too — unless the moderator app does its own bit-ops on `nsfwLevel`. |

After the move the package's only external edge is the **downward** dep `@civitai/domain → @civitai/db-schema` (`MediaType`/`ModelType`, used by `mime-types` + `basemodel`) — the allowed direction onto the contract leaf, exactly like `@civitai/db → @civitai/db-schema`. No `~/` imports, no sibling-infra deps.

### Sweep results — candidates rejected (the discriminating part)
The sweep deliberately **excluded** look-alikes, proving the rule isn't "extract anything pure":
- `scanner-label-highlight-terms.ts` — pure, but it's **scanner-audit UI display config used only by moderator pages** → single consumer → `apps/moderator/`, not a package.
- `object-helpers.ts` — generic lodash wrapper used by an app-local service → **copy**; no shared-data contract.
- `client-utils/cf-images-utils.ts` — couples to `useCurrentUser` + a provider → **app-local**.
- `server/common/constants.ts` (minus `CacheTTL`) — the rest is env- + feature-flag-service-coupled → **stays in main**; only the `CacheTTL` member is carved out (above).

> `src/shared/constants/base-model.constants.ts` (legacy, distinct from the V2 file) has the identical `type-guards`-only closure and can ride along if still live.
>
> **Scope note:** this sweep covers *direct* page + isolated-service imports. A few more domain constants may surface *transitively* when the coupled UI components get ported — closure-check each at port time, per "Growing the package later."

### Explicitly NOT forced (and why)
- `server/schema/*.schema.ts` (zod) — tRPC **input** contracts bound to a router; the moderator app authors its own. Only the *enums* they reference are shared (covered above). **App-local.**
- Moderator routers / controllers / services / pages / trpc client / providers / hooks — **one consumer → `apps/moderator/`**, not packages.
- `errorHandling`, `pagination-helpers`, `notification.service` slices — no DB contract → **copy**.
- `image.service` / `post.service`-entangled writes — **stay in main, proxy** (see boundary doc §4).

## The package: `@civitai/domain`

A new hand-authored contract package, peer to `@civitai/db-schema`. (Alternative considered: add a subpath to `@civitai/db-schema` — rejected to keep that package a *purely generated* artifact. Open decision #1 below.)

```
packages/civitai-domain/
├── package.json            # depends on @civitai/db-schema
├── tsconfig.json
└── src/
    ├── index.ts                # barrel re-export
    ├── enums.ts                # ← src/server/common/enums.ts  (+ ReportEntity merged in)
    ├── moderation-helpers.ts   # ← src/server/common/moderation-helpers.ts
    ├── flags.ts                # ← src/shared/utils/flags.ts
    ├── browsing-level.ts       # ← src/shared/constants/browsingLevel.constants.ts
    ├── mime-types.ts           # ← src/shared/constants/mime-types.ts
    ├── basemodel.constants.ts  # ← src/shared/constants/basemodel.constants.ts
    ├── type-guards.ts          # ← src/utils/type-guards.ts
    ├── lazy.ts                 # ← src/shared/utils/lazy.ts
    └── cache.ts                # ← CacheTTL carved from src/server/common/constants.ts
```
**8 whole-file moves** (enums, moderation-helpers, flags, browsing-level, mime-types, basemodel.constants, type-guards, lazy) + **2 member extractions** (`ReportEntity` → `enums.ts`; `CacheTTL` → `cache.ts`). `browsing-level` + `flags` are confirmed forced: the lifted `image.service` queries `getImageModerationCounts` (uses `sfwBrowsingLevelsFlag`) and `getImageRatingRequests` (uses `Flags.arrayToInstance`) both decode/write the `nsfwLevel` bitfield server-side.

---

## Move procedure — preserving git history

This repo's established discipline (see [handoff](./monorepo-bootstrap-handoff.md) "Things to be careful about"): **git rename detection has a 50% similarity threshold, so a move + edit in one commit can lose `--follow` history.** The two extraction modes handle this differently:
- **Whole-file moves** → `git mv` as a **pure rename (R100) in its own commit (Commit 1)**; all edits to them land in Commit 2. Build is intentionally broken between the two — same as the original bootstrap commit.
- **Member extractions** (`ReportEntity`, `CacheTTL`) → not renames at all; they're content edits to a file that *stays*. They happen entirely in Commit 2. (History doesn't follow a copied member; acceptable for a 14-line enum and an 8-line const.)

### Commit 1 — pure whole-file moves (R100, zero content change)
```bash
mkdir -p packages/civitai-domain/src
git mv src/server/common/enums.ts                      packages/civitai-domain/src/enums.ts
git mv src/server/common/moderation-helpers.ts         packages/civitai-domain/src/moderation-helpers.ts
git mv src/shared/utils/flags.ts                       packages/civitai-domain/src/flags.ts
git mv src/shared/constants/browsingLevel.constants.ts packages/civitai-domain/src/browsing-level.ts
git mv src/shared/constants/mime-types.ts              packages/civitai-domain/src/mime-types.ts
git mv src/shared/constants/basemodel.constants.ts     packages/civitai-domain/src/basemodel.constants.ts
git mv src/utils/type-guards.ts                        packages/civitai-domain/src/type-guards.ts
git mv src/shared/utils/lazy.ts                        packages/civitai-domain/src/lazy.ts
git commit -m "refactor(domain): move shared domain contracts into @civitai/domain (pure rename)"
```
Verify before moving on: `git diff --cached -M --stat` shows **R100** for all eight; no content bytes changed. (At this point ~832 call sites of the moved files don't resolve — expected, fixed in Commit 2 by the shims. `report-helpers.ts` and `constants.ts` are untouched here — they're member-extracted in Commit 2.)

### Commit 2 — post-move changes (scaffolding + shims + import rewrites + member extractions)
Everything below is the **"additional changes required after the move."**

---

## Additional changes required after the move

### A. Edits to the moved files
Only **three** of the eight moved files change — `enums`, `moderation-helpers`, `flags`, `type-guards`, `lazy` are import-free and move untouched. A package may not import `~/`, so the consumers rewrite to intra-package relative paths (and to the contract leaf for Prisma enums):

- `packages/civitai-domain/src/{enums,moderation-helpers,flags,type-guards,lazy}.ts` — **no change** (all import-free).
- `packages/civitai-domain/src/mime-types.ts`:
  ```diff
  - import { MediaType } from '~/shared/utils/prisma/enums';
  + import { MediaType } from '@civitai/db-schema/enums';
  ```
- `packages/civitai-domain/src/browsing-level.ts`:
  ```diff
  - import { NsfwLevel } from '~/server/common/enums';
  - import { Flags } from '~/shared/utils/flags';
  + import { NsfwLevel } from './enums';
  + import { Flags } from './flags';
  ```
- `packages/civitai-domain/src/basemodel.constants.ts`:
  ```diff
  - import { ModelType, type MediaType } from '~/shared/utils/prisma/enums';
  - import { lazy } from '~/shared/utils/lazy';
  - import { isDefined } from '~/utils/type-guards';
  + import { ModelType, type MediaType } from '@civitai/db-schema/enums';
  + import { lazy } from './lazy';
  + import { isDefined } from './type-guards';
  ```
  (Confirm exact named imports against each file; the modules above are their only `~/` imports.)

### A2. Member extractions (carve + re-export)
Neither is a `git mv`; both are content edits in Commit 2.

**`ReportEntity` → `enums.ts`.** `src/shared/utils/report-helpers.ts` is *only* this enum, so:
1. Append the `ReportEntity` enum verbatim to `packages/civitai-domain/src/enums.ts`.
2. Replace `src/shared/utils/report-helpers.ts`'s body with a shim (see §B). Its 30 consumers keep importing `~/shared/utils/report-helpers` unchanged.

**`CacheTTL` → `cache.ts`.** `src/server/common/constants.ts` can't whole-file move (env + feature-flag-service coupled), so carve the member:
1. Create `packages/civitai-domain/src/cache.ts` with the `CacheTTL` const (constants.ts:1454–1463, zero deps).
2. In `constants.ts`, replace the `export const CacheTTL = {…}` block with a re-export:
   ```ts
   export { CacheTTL } from '@civitai/domain/cache';
   ```
   Every `import { CacheTTL } from '~/server/common/constants'` site keeps working; the rest of `constants.ts` is untouched.

### B. New shim files at the original paths (so the ~862 call sites never change)
One shim per moved file, mirroring the existing `src/shared/utils/prisma/enums.ts` pattern exactly:
```ts
// src/server/common/enums.ts  (350 consumers)
// Re-export shim: moved to @civitai/domain. Existing call sites import unchanged.
export * from '@civitai/domain/enums';
```
```ts
// src/shared/utils/report-helpers.ts  (30 consumers) — ReportEntity now lives in enums
export { ReportEntity } from '@civitai/domain/enums';
```
```ts
// src/server/common/moderation-helpers.ts  (11 consumers)
export * from '@civitai/domain/moderation-helpers';
```
```ts
// src/shared/constants/mime-types.ts  (34 consumers)
export * from '@civitai/domain/mime-types';
```
```ts
// src/shared/utils/flags.ts  (53 consumers)
export * from '@civitai/domain/flags';
```
```ts
// src/shared/constants/browsingLevel.constants.ts  (120 consumers)
export * from '@civitai/domain/browsing-level';
```
```ts
// src/shared/constants/basemodel.constants.ts  (85 consumers)
export * from '@civitai/domain/basemodel.constants';
```
```ts
// src/utils/type-guards.ts  (174 consumers)
export * from '@civitai/domain/type-guards';
```
```ts
// src/shared/utils/lazy.ts  (5 consumers)
export * from '@civitai/domain/lazy';
```
> Note: `src/server/common/constants.ts` imports `./enums` (relative) — it resolves to the shim and keeps working. Same for any in-package consumer using `@civitai/db-schema/enums` directly.

### C. New package barrel
```ts
// packages/civitai-domain/src/index.ts
export * from './enums';           // includes ReportEntity (merged)
export * from './moderation-helpers';
export * from './flags';
export * from './browsing-level';
export * from './mime-types';
export * from './basemodel.constants';
export * from './type-guards';
export * from './lazy';
export * from './cache';
```
> The shims import **subpaths** (`@civitai/domain/enums`, …), not this barrel, so a name collision between two `export *`d modules can't break them — but `pnpm run typecheck` will flag any collision in the barrel itself; resolve with an explicit named re-export if it occurs.

### D. New package scaffolding (mirror `@civitai/db-schema`)
```jsonc
// packages/civitai-domain/package.json
{ "name": "@civitai/domain", "version": "0.0.0", "private": true,
  "main": "./src/index.ts", "types": "./src/index.ts",
  "dependencies": { "@civitai/db-schema": "workspace:*" } }
```
`packages/civitai-domain/tsconfig.json` — copy from an existing `packages/civitai-*/tsconfig.json`. (The `@civitai/db-schema` tsconfig path already exists at the root, so basemodel's `@civitai/db-schema/enums` import resolves for typecheck.)

### E. Workspace / build wiring (edits to existing config)
1. **Root `tsconfig.json`** — add to `paths` (mirror the db-schema entries):
   ```jsonc
   "@civitai/domain":   ["../packages/civitai-domain/src/index"],
   "@civitai/domain/*": ["../packages/civitai-domain/src/*"],
   ```
2. **`next.config.mjs`** — `transpilePackages` is an explicit list (lines 106–113); add `'@civitai/domain'`.
3. **Root `package.json`** — add `"@civitai/domain": "workspace:*"` to dependencies (mirror how the other `@civitai/*` packages are declared so the main app resolves the workspace package).
4. `pnpm-workspace.yaml` already globs `packages/*` → **no change**.
5. Run `pnpm install` to link the workspace package.

### F. Verification
```bash
# History survived the move (must trace through the R100 rename):
git log --follow --oneline -- packages/civitai-domain/src/enums.ts
# Types resolve across all ~911 preserved call sites (862 via shims + 49 CacheTTL via the constants re-export):
pnpm run typecheck
```
Spot-check one consumer of each path still compiles: `blocklist.service` → `BlocklistType` **and** `CacheTTL`; any `nsfwLevel` decoder → `browsing-level`/`flags`; a report consumer → `ReportEntity` (now via `enums`); a generation page → `basemodel.constants`; any `isDefined` consumer → `type-guards`.

---

## Growing the package later

`@civitai/domain` is the home for any future hand-authored contract that proves both (a) needed by a second app and (b) drift-unsafe or shared vocabulary, with a clean closure. Each addition uses the **identical Commit-1 (pure `git mv`) / Commit-2 (shim + relative-import rewrite)** procedure above. Likely near-term candidates as more pages port: the legacy `base-model.constants.ts` (same `type-guards`-only closure, if still live), and other generation-config constants once their own closures are verified pure. Do **not** batch-move on suspicion — run the closure check first, exactly as done here. Use a whole-file move when the file *is* the shared unit, or a member extraction (carve + re-export) when only one member is shared.

## Part 2 — Server-side shared surface (service-closure traces)

The §1 sweep covered *direct* page + service imports. This part traces the **full transitive closure of the services behind the 22 pages** — page → tRPC procedure → router → controller → service → everything it pulls in — across four domains (image-moderation; reports/strikes/blocklists/tags; scanner-audit/CSAM; training/models/generation). That's where the cross-app surface actually lives.

### Structural finding (the 80/20)

The moderator server is **~80% cleanly separable** — read queues, simple-writes, Redis config, orchestrator calls — and **~20% entangled** in feed/marketplace machinery. Critically, the clean 80% is **moderator-specific (one consumer)** → it belongs **in `apps/moderator/`, not a package**. The genuinely *shared* surface is narrow. Three patterns recur in every domain:

1. **Extract-clean-slice.** The moderator functions are buried inside giant entangled services but are themselves clean. e.g. CSAM imports `bulkAddBlockedImages` (a ~20-line ClickHouse insert) from the 7,982-line `image.service`; `toggleCannotPublish` / `getTrainingModelsForModerators` are clean slices of `model.service`; `getResources` / ecosystem-config are clean slices of `generation.service`; the image review-queues are clean slices of `image.service`. **Refactor these out into small modules → they move with the moderator app (app-local), not a package.**
2. **A consistent PROXY boundary.** Every domain hits the same wall: `post.service` (feed cache-bust, `updatePostNsfwLevel`), search-index sync, `games/new-order.service` (image-rating game state), `nsfwLevels.service` (article/comic recompute), `rewards`, `buzz.service`, `upsertModel` + EventEngine. These do **not** move — the moderator app calls the main app's tRPC for them.
3. **A thin shared infra/contract surface** both apps need identically (below).

### Classified shared surface — forcing function applied

| Surface | Trace evidence | Verdict |
|---|---|---|
| **Orchestrator client** `server/services/orchestrator/client.ts` (+ `get-orchestrator-token`, `http/orchestrator/*`) | 13 lines: `@civitai/client` + `env/server`. Used by scanner-content, csam, training. Highest cross-domain recurrence. | **NEW infra package `@civitai/orchestrator`** — tiny, clean closure, genuinely shared. The one clear new package. |
| **Persisted JSON-column shapes** — `ModelMeta`(`Model.meta`), `UserMeta`(`User.meta`), `scanContentBody`(`ScannerContentSnapshot.content`), CSAM report payload, `BlocklistDTO` | One app writes the blob, the other reads it → drift = corruption. | **Domain-tier contracts → fold into `@civitai/domain`** (per "Growing the package later"), each after a closure-check / possible schema-file split. |
| **Cross-cutting writes to shared tables** — `moderator.service.trackModActivity` (`ModActivity`), `notification.service.createNotification` (`Notification`, category already shared), `auth/session-invalidation` (shared session cache) | Both apps must write these identically or audit/notify/mute behavior diverges. | **Extract clean slice → shared module** (small; `@civitai/orchestrator`-style) *or* copy. Judgment; the contract part (categories/keys) is already in `@civitai/domain`. |
| **Server utils** — `pagination-helpers` (284 ln; pulls `base.schema`+`qs`+`dayjs`+`env`), `errorHandling` (292 ln; pulls logging+stacktrace) | Recur 4/4 domains. Behavioral consistency, **not** corruption. | **COPY** into the app (or a later `@civitai/server-utils` if a 3rd app appears). Not forced. |
| **Selectors** `server/selectors/*.selector.ts` | Import only `@prisma/client` + sibling selectors — clean cluster. But each app consumes its **own** query results. | **COPY.** Drift ≠ corruption; no forcing function. |
| **tRPC input schemas** `server/schema/*.schema.ts` (the non-persisted parts) + `base.schema` | Per-router validation; each app authors its own. `base.schema` closure now covered by `@civitai/domain`+db-schema. | **COPY** (app-local). Only the persisted-shape rows above are contracts. |
| **S3 / file helpers** `utils/s3-utils`, `file-utils` (CSAM NCMEC archival) | Env-coupled (`S3_*`); generic. | **COPY** (or fold into infra if reused). `http/ncmec/*` is **moderator-only → app-local** (single consumer). |
| **Feed/marketplace services** | post/search-index/new-order/nsfwLevels/rewards/buzz/upsertModel | **PROXY** — stays in main, moderator calls its tRPC. |

### Deliberately NOT doing
The traces tempt a pile of per-domain packages (`@civitai/moderation-enums`, `@civitai/image-moderation-schema`, `@civitai/model-moderator-service`, `@civitai/generation-config-service`, `@civitai/moderator-infra`, …). **Rejected** — same reason as the earlier `moderator-server` proposal: those are one-consumer (moderator-only) → they're `apps/moderator/` code, not packages. The shared surface that crosses *both* apps reduces to: **`@civitai/domain`** (8 whole-file moves + 2 member extractions, plus the persisted-shape contracts as they're closure-checked) and **one new `@civitai/orchestrator`** infra package — everything else is copy, proxy, or app-local extract-clean-slice.

## Open decisions

@dev: two forks before execution:
1. **Package vs. db-schema subpath.** New `@civitai/domain` (recommended — keeps `@civitai/db-schema` purely generated), or fold these hand-authored enums/constants into `@civitai/db-schema` as a subpath (one fewer package, but mixes generated + hand-authored)?
2. **Whole-file `enums.ts` vs. slice.** Move the whole 450-line file (recommended — it's import-free, the shim makes it transparent, and the main app keeps one source of truth), or carve out only the moderator-referenced enums (smaller package surface, but now *two* files define domain enums)?

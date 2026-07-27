# Moderator App — Package Boundary (deep dive)

**Status:** analysis / proposal · **Date:** 2026-06-04
> **Superseded in part:** the *package recommendations* below (`@civitai/moderator-server`, `@civitai/shared-schema`, `@civitai/ui-common`) are replaced by [`moderator-app-package-extraction-plan.md`](./moderator-app-package-extraction-plan.md), which narrows the forced extraction to a single `@civitai/domain` contract package. The app-local / proxy / stays-in-main analysis here is still valid.
**Supersedes:** [`moderator-app-shared-modules.md`](./moderator-app-shared-modules.md) — that doc predates the current architecture (it assumed **git submodules** and a `civitai-schema-common` package, both rejected in the [handoff](./monorepo-bootstrap-handoff.md)). This doc reconciles the moderator analysis with the **5 pnpm `@civitai/*` base packages + `@civitai/db-schema` contract layer** that actually shipped.

## Scope (confirmed)

- **Pages:** the **content-moderation** subset (~22), *not* the commerce/admin pages under `/moderator` (cosmetic-store, rewards, challenges, paddle, cash-management, auctions, contests, code-gifts, home-blocks stay in the main app for now).
- **Backend topology:** the moderator app runs **its own tRPC routers against the shared DB** (`@civitai/db`). It is **not** a thin proxy. This is the decision that makes the server-side import-closure analysis the hard part of this work.

In-scope pages: `images`, `images/to-ingest`, `image-tags`, `image-rating-review`, `downleveled-review`, `ingestion-error-review`, `articles`, `models/index`, `comics-review`, `reports`, `tags`, `blocklists`, `auditor`, `strikes`, `scanner-audit/{index,[mode]/index,[mode]/[label]}`, `training-models`, `review/training-data/{index,[versionId]}`, `csam/{index,[userId]}`, `generation`, `generation-config`, `generation-restrictions`.

---

## 1. The governing rule (why imports are the whole game)

A package may import **only external npm deps and other packages** (`@civitai/*`). It may **never** import app code (`~/…`). So for *every* file we propose sharing, the question is not "is this moderator-ish?" but:

> **Is the file's entire transitive `~/…` import closure also moveable?** If one leaf reaches into a zustand store, the tRPC client, a provider, or `image.service`, the whole candidate is blocked until that leaf is dealt with.

Everything below is organized around that closure test.

## 2. Layering (what already exists vs. what we'd add)

```
┌─ apps/moderator           NEW app. Own Next.js, own tRPC client, own env, own
│                           session/feature-flags glue, thin re-export pages.
│
│  …composes downward into…
│
├─ @civitai/moderator-server   NEW (domain tier). Isolated moderator services +
│                              moderator routers/controllers/selectors. Owns the
│                              "own routers, shared DB" surface.
├─ @civitai/shared-schema      NEW (contract tier). zod input contracts + the
│                              server/common enums & constants the schemas need.
├─ @civitai/ui-common          NEW (optional, deferrable). Generic UI primitives.
│                              Vendor-copy first; promote when drift hurts.
│
│  …all of the above may use the EXISTING layers…
│
├─ @civitai/{db,redis,clickhouse,axiom,telemetry}   EXIST. Infra-only base pkgs.
└─ @civitai/db-schema (contract)                     EXISTS. Prisma client, enums,
                                                     models. Already absorbs the
                                                     biggest Tier-A item.
```

> The new `@civitai/moderator-server`, `@civitai/shared-schema`, and `@civitai/ui-common` are **domain/feature packages**, a *higher tier* than the base infra packages. Per the handoff, base packages stay infra-only and independent; higher-level packages **may** compose multiple base packages. These do not violate the [base-package rules](../C:/Users/bkdie/.claude/projects/c--Work-model-share-monorepo-bootstrap/memory/monorepo-bootstrap-base-package-rules.md) because they are not base packages.

## 3. Already solved by the completed migration ✅

These were the heaviest items in the old analysis. They no longer need work:

| Item | Old verdict | Reality now |
|---|---|---|
| `~/shared/utils/prisma/enums` (21 pages) | "move to schema-common" | **Already a re-export shim → `@civitai/db-schema/enums`.** Both apps import the same enums today. |
| Prisma client / models | "schema-common" | `@civitai/db-schema`, done. |
| Postgres / Redis / ClickHouse access | submodule | `@civitai/{db,redis,clickhouse}` factories, done. The moderator app calls `createPrismaClients()` etc. exactly as the guide describes. |
| `@civitai/*` tsconfig paths + `transpilePackages` | — | Wired. A new `apps/moderator` is picked up by the `apps/*` workspace glob automatically. |

So Tier A from the old doc collapses to **just the zod schemas + a handful of `server/common` enums/constants** (see §5).

---

## 4. Server side — the hard part ("own routers, shared DB")

Verified by reading the service import headers directly. The moderator features split cleanly into an **isolated periphery** and an **entangled core**.

### 4a. Isolated services — extract as-is into `@civitai/moderator-server` ✅

These have **zero or trivial** service-to-service coupling (verified):

| Service | Lines | Service-to-service imports | Verdict |
|---|---|---|---|
| `moderator.service` (audit log) | 80 | none | **clean** — only `dbWrite` |
| `blocklist.service` | 125 | none | **clean** — db + redis + constants |
| `scanner-content.service` | 380 | `orchestrator/client` only | **clean** |
| `scanner-review.service` | 591 | `scanner-content` only | **clean** — db + clickhouse + scanner-review.schema + enums |
| `training.service` | 923 | `orchestrator/client` only | **clean** |
| `strike.service` | 776 | `notification.service`, `user.service` | **near-clean** — see note |

`strike.service` pulls `notification.service` (itself dependency-free) and a **narrow slice** of `user.service` (`getById`/`updateUserById`). Move `notification.service` alongside it; for `user.service`, extract just the functions strike needs into a small `moderator-server/user-ops.ts` rather than dragging the whole (auth/session/preferences-heavy) file.

These six are the backbone of the moderator app's own routers. They query `@civitai/db` / `@civitai/clickhouse` and the orchestrator client — **all available to a package.**

### 4b. The entangled core — `image.service` is the hub ⚠️

`image.service.ts` (7,982 lines) imports **14 sibling services**:

```
post.service (↔ bidirectional)  report.service  tag.service  notification.service
cosmetic.service  nsfwLevels.service  image-flag.service  games/new-order.service
moderator.service  tagsOnImageNew.service  feature-flags.service  storage-resolver
orchestrator/orchestrator.service  orchestrator/(via others)
```

And the moderation-relevant services that *look* peripheral actually reach back into it:

- `report.service` → imports `image.service`, `post.service`, `tag.service`, …
- `csam.service` → imports `image.service`, `file.service`
- `generation.service` → imports `image.service`, `model.service`, `model-version.service`, …

So **pulling `image.service` (or anything that imports it) whole = importing the main app's content graph** (feed cache invalidation via `post.service`, NSFW re-queue, cosmetics, games). That cannot live in a package.

### 4c. The resolution: split **read queues** from **cross-graph writes**

The moderator pages' server needs decompose into two very different shapes:

**(i) Read queues — own them.** The review surfaces are essentially SQL:
`getImageModerationReviewQueue`, `getImageRatingRequests`, `getDownleveledImages`, `getIngestionErrorImages`, scanner queues, reports list, strikes standings/history, CSAM report paging, training queue, flagged-models list.
Most are *defined inside* `image.service`/`report.service` today, but they only need `dbRead` + selectors + enums. **Lift these query functions out** into `@civitai/moderator-server/queries/*` that import `@civitai/db` + `@civitai/db-schema` only. This is mechanical extraction, not a redesign — the SQL doesn't change.

**(ii) Cross-graph write actions — do not own the whole service.** A handful of mutations genuinely touch the main app's graph:
`moderateImages` → `post.service.bustCachesForPosts` (feed cache); `updateImageNsfwLevel` → `nsfwLevels.service` (comic re-queue); report-status changes → multiple services.
For these, pick per-action (cheap → expensive):
- **Cache-bust via Redis only.** `bustCachesForPosts` ultimately just invalidates Redis keys. If the moderator write does the DB mutation and then invalidates the **same `@civitai/redis` keys** (expose the key builders via a subpath, the way the guide already does for `REDIS_KEYS`), no `post.service` import is needed. Preferred where the side-effect is "invalidate cache X."
- **Proxy the action to the main app's tRPC** for the few writes whose side-effects are real orchestration (comic re-queue, notification fan-out, games/new-order). The moderator router calls one main-app procedure; main app owns the graph. Accept the network hop for these low-frequency moderator clicks.

> **Bottom line:** "own routers, shared DB" is achievable for **reads and the isolated services**, and for **writes** it's a per-action choice between *replicate-the-cache-bust* (Redis keys, in-package) and *proxy-the-orchestration* (one tRPC call to main). Nothing forces `image.service`/`post.service`/`model.service`/`generation.service` into a package — and nothing should.

### 4d. Server modules that stay in the main app (blockers)

`image.service`, `post.service`, `model.service`, `model-version.service`, `generation/generation.service` — all are deeply cross-linked into feed/marketplace/orchestration. **Leave in place.** The moderator app reaches their *effects* through (i) lifted read queries against shared DB or (ii) the proxy procedures above. `generation.tsx`'s `getResources`/ecosystem-config slice is the one worth extracting separately (`generation-config.service`) since it's read-mostly.

---

## 5. Contract tier — `@civitai/shared-schema`

The zod `~/server/schema/*.schema.ts` files are the input contracts both apps' routers validate against. Closure check (verified):

| Schema | `~/` imports beyond already-shared enums | Extractable? |
|---|---|---|
| `scanner-review.schema` | none (just shared enums) | ✅ trivially |
| `strike.schema` | `base.schema` | ✅ with `base.schema` |
| `report.schema` | `server/common/{constants,enums}`, `base.schema`, `report-helpers` | ✅ once common moves |
| `image.schema` | **`~/components/ImageGeneration/.../resource-select.types`, `~/components/Search/parsers/base`** | ⚠️ **dirty** — a schema importing component types is a layering smell. Untangle first (move those two leaf types out of `components/`), or keep `image.schema` app-side and have the moderator router define a narrower local input schema. |

To unblock the clean ones, `@civitai/shared-schema` must also carry the **stable, enum-shaped** parts of:
- `~/server/common/enums` (used by 10 pages — `NsfwLevel`, `BlockedReason`, `BlocklistType`, `ImageScanType`, …)
- `~/server/common/constants` — **but** this file imports `~/env/client`, so split out the pure constant tables from the env-coupled ones; only the pure tables move.
- `~/server/common/moderation-helpers.unpublishReasons` — pure lookup table, move it.
- `~/server/schema/base.schema`, `~/shared/utils/report-helpers` (pure `ReportEntity` enum).

`@civitai/shared-schema` depends only on `@civitai/db-schema` (for enums) + `zod`. Clean.

---

## 6. Client side — the import-closure verdicts

### 6a. Generic UI primitives (`@civitai/ui-common`, or vendor-copy)

**CLEAN — extract as-is** (only Mantine/external + sibling-clean deps):
`NextLink`, `PageLoader`, `LegacyActionIcon`, `NoContent`, `PopConfirm`, `ButtonTooltip`, `ContentClamp`, `DescriptionTable` (+ `InfoPopover`), `TwCard`, `EndOfFeed`, `InViewLoader`, `ImageHash`, `MasonryProvider`, `MasonryContainer`, `ScrollArea`, `AppLayout/Page` (type helper).

**EXTRACT WITH A SMALL DEP** (move one leaf too):
- `BackButton` → move `store/ClientHistoryStore` (app-agnostic zustand).
- `Meta` → refactor to take `canIndex`/`deIndex` as props instead of reading `useAppContext`, then clean.
- `MasonryColumns` → inject/move `Ads/AdUnitRenderable` (couples to ad store) — or pass the ad slot as a prop.
- `RenderHtml` → move `TypographyStylesWrapper` + the consent context + `profanity-simple`.

**COUPLED — leave app-side / reimplement** (reach into tRPC, auth, generation, dialog, cosmetics):
`EdgeMedia`/`EdgeVideo` (media infra), `ImageMeta` (generation store + trpc + tracking), `ImageGuard2` (auth + dialog + browsing-level), `VotableTags` (trpc voting + auth), `UserAvatar` (trpc + cosmetics selectors), `AppLayout/NotFound` (trpc data-fetch).

> **Recommendation:** ship `@civitai/ui-common` with the CLEAN set, **vendor-copy** the COUPLED ones into the moderator app and let them re-bind to the moderator app's own trpc/auth (they're a small set). Promote to a real package only when visual drift becomes painful — exactly the old doc's "option 3," still correct.

### 6b. Moderator-specific components (`@civitai/moderator-ui` / inside the app)

**READY — clean closure, move now:** `Moderator/ScannerAuditLayout`, `Moderator/ScannerPolicySidebar`, `Moderator/scannerLabelPolicies`, `Moderation/RuleDefinitionPopover`, `Csam/CsamProvider`, `Csam/useCsamImageSelect.store`, `store/select.store`, `hooks/useCheckProfanity` (pure — only `libs/profanity-simple`), `Image/PromptHighlight` **+ `utils/metadata/audit`** (self-contained: static word-lists + string helpers, **not** the blocker the old doc feared).

**NEEDS-DEPS / LIGHT REFACTOR:** `Moderation/GenerationStatusCard` (move generation-schema *types*), `Moderation/ModerationNav` (take feature flags as props), `Csam/CsamImageSelection` (needs MasonryColumns), `Moderation/ImpersonateButton` (account context → props).

**BLOCKED on the dialog system** (see §6c): `FlaggedModelsList`, `Csam/CsamDetailsForm`, `Profile/UserBanModal`, `useReportCsamImages`.

### 6c. The one real cross-cutting blocker: the Dialog system

`FlaggedModelsList`, `CsamDetailsForm`, `UserBanModal`, and `useReportCsamImages` all couple to `Dialog/dialogStore` + `useDialogContext()` + the app's `dialog-registry`/routed-dialog machinery. **This is the single highest-leverage refactor** — fixing it unblocks four moderator components at once.

Minimal refactor (medium, a few hours):
1. Move `dialogStore` (pure zustand) + base dialog types into a shared package.
2. Make `useDialogContext()`-style components accept `{opened, onClose, …}` as **props** rather than requiring the app provider.
3. The moderator app stands up its **own** lightweight `DialogProvider` (no routed-dialog/registry coupling).
4. Split `useReportCsamImages` so the **mutation** (trpc) is the hook and the **modal/notification side-effects** move to the caller.

### 6d. Utils / hooks / providers — corrections to the old read

Verified closures, with two corrections to the sub-analyses:

- **PURE — share freely:** `string-helpers`, `number-helpers`, `type-guards`, `normalize-text`, `file-utils`, `lazy`, `qs`, `date-helpers` (→ pure `shared/utils/dayjs`), all `shared/constants/*`, `moderator.util`, `report-helpers`, `AspectRatio`, `libs/form/useForm`. `login-helpers` rides along with `qs`.
- **`utils/notifications` is SHAREABLE** (correcting one sub-analysis that flagged it "coupled"): its only deps are `@mantine/notifications` + `@tabler/icons-react` — **external**, allowed in a package. Used by 30 pages; put it in `@civitai/ui-common`.
- **PER-APP, not shared** (each app authors its own — these are *glue*, not shared code): `utils/trpc` (binds to `~/server/routers` AppRouter — the moderator app has its **own** router type), `types/router`, `env/client`, `server/utils/server-side-helpers` (binds to `appRouter` + `getServerAuthSession` + feature-flags), `useCurrentUser` (binds to `CivitaiSessionProvider`), `FeatureFlagsProvider`, `BrowsingLevelProvider`. The moderator app re-creates thin versions against its own session — cheap, and intentionally *not* shared so the two apps' auth surfaces stay independent.
- **`cf-images-utils`:** refactor to take `isModerator` as an arg (drops the `useCurrentUser` import), then it's pure.

---

## 7. Phased plan

**Phase 0 — prerequisites in the main app (in place, no new app yet)**
- Extract `@civitai/shared-schema`: pure `server/common` enums/constants tables, `moderation-helpers.unpublishReasons`, `base.schema`, and the clean moderator schemas (`scanner-review`, `strike`, `report`). Leave `image.schema` until its component-type leak is untangled.
- **Dialog-system decouple** (§6c) — props-based dialogs + portable `dialogStore`. Highest leverage.
- Lift the **read-queue** functions out of `image.service`/`report.service` into a query module that imports `@civitai/db` only (§4c-i).

**Phase 1 — `@civitai/moderator-server`**
- Move the 6 isolated services (§4a) + the lifted read queries + the moderator routers/controllers/selectors.
- Decide per cross-graph write: Redis-key cache-bust vs. proxy-to-main (§4c-ii).

**Phase 2 — `@civitai/ui-common`** (CLEAN set + `notifications`) and **`@civitai/moderator-ui`** (the READY moderator components).

**Phase 3 — stand up `apps/moderator`**
- `createPrismaClients()` / `createRedisClients()` / `createClickhouseClient()` per the migration guide.
- Own tRPC client + session/feature-flags glue. Vendor-copy the COUPLED UI primitives.
- Port the **7 Easy** pages first (to-ingest, rating-review, downleveled, ingestion-error, comics-review, strikes, training-data/index) as proof-of-concept.

**Phase 4 — Medium pages**, then **Phase 5 — Hard pages** (`images`, `auditor`, `scanner-audit/[mode]/[label]`, `generation-restrictions`) once their specific couplings (PromptHighlight ✅ already cleared, profanity ✅ cleared, scanner-content ✅ clean, `UserGenerationsDrawer`) are addressed. (`generation` ✅ removed — the page no longer exists.)

---

## 8. Decisions needed

@dev: a few forks I couldn't resolve from the code — flag your call inline:

1. **Cross-graph writes:** default to *Redis-key cache-bust in-package* where the side-effect is pure cache invalidation, and *proxy-to-main* only for true orchestration (comic re-queue, notifications, games/new-order)? Or proxy **all** moderator writes for simplicity at v1 and optimize later?
2. **`image.schema` leak:** untangle the two `components/*` type imports now (small but touches main-app files), or have the moderator router define a local narrow input schema and defer the untangle?
3. **CSAM on the satellite at all?** It's the most sensitive surface and `csam.service` reaches `image.service`. Confirm it moves vs. stays in main app for audit-trail reasons.
4. **`@civitai/ui-common` now or vendor-copy first?** Recommendation is vendor-copy the CLEAN set into the moderator app and only formalize the package once a second consumer exists — avoids a big main-app rewrite during the initial split.

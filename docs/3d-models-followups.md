# 3D Models — Phase 2 Follow-ups (profile feed + moderation)

## M1 — Profile-page 3D Models tab

### Current state (research findings)

- The profile shell is `src/components/Profile/ProfileLayout2.tsx`. It wraps each `/user/[username]/*` page and renders `<ProfileNavigation />` as the subNav.
- `ProfileNavigation.tsx:38-86` is a single static map of `opts` keyed by `'[username]'`, `models`, `posts`, `images`, `videos`, `articles`, `comics`, `collections`. There is **no registry** — adding a tab means adding a key to that object.
- Each tab page in `src/pages/user/[username]/*.tsx` (e.g. `models.tsx`, `posts.tsx`, `articles.tsx`) follows the same pattern:
  - `getServerSideProps` via `createServerSideProps({ useSSG: true, ... })`, with optional feature-flag redirect (`articles.tsx:28-34` redirects to `/user/[username]` when `!features.articles`).
  - SSG prefetches `userProfile.get` + `userProfile.overview`.
  - Page reads `currentUser` + `query.username`, derives `selfView` via `postgresSlugify(currentUser.username) === postgresSlugify(username)`.
  - Renders an optional `FeedContentToggle` (published/draft) **only for self-view**, then a `MasonryContainer` with the relevant `*Infinite` component.
  - Default export wraps `Page(..., { getLayout: UserProfileLayout })` so the `ProfileLayout2` shell + nav are inherited.
- Counts are surfaced by `trpc.userProfile.overview` → `getUserContentOverviewHandler` → `getUserContentOverview` in `src/server/services/user-profile.service.ts:28-62` → Redis composite cache `userContentOverviewCache` (`src/server/redis/caches.ts:896-1066`).
  - `UserContentOverview` type (`caches.ts:896-908`) hard-codes the keys: `modelCount`, `imageCount`, `videoCount`, `postCount`, `articleCount`, `bountyCount`, `bountyEntryCount`, `collectionCount`, `comicCount`, `hasReceivedReviews`. **No `model3dCount` field.**
  - There are three variants (all / sfw / public) each materialized via per-table cache factories at `caches.ts:503-520`, each backed by a single counting query.
- `trpc.model3d.getInfinite` already accepts `username`, `userId`, and `includeDrafts` (`src/server/schema/model3d.schema.ts:54-64`). The service (`model3d.service.ts:192-259`) gates non-mod / non-owner reads correctly — `allowDrafts` is keyed on `userId === user.id`, so the profile page should pass `userId: profileUser.id` (or `username`) **and** `includeDrafts` for self-view.
  - Caveat: `model3d.service.ts:210-219` returns an empty list for non-mods unless `user` is signed in **and** (no `userId` filter, OR `userId === user.id`, OR `username` is set). Passing `username` is the safe path — that branch is allowed for any signed-in user. Without a session, anonymous viewers also get an empty list. **This means the new tab will be empty for logged-out visitors until the `model3dFeed` flag opens past mod-only,** which matches the launch plan.
- `Model3DCard.tsx` (`/home/luis_rojas/Work/civitai/src/components/Cards/Model3DCard.tsx`) is the existing card; consumes `inferRouterOutputs<AppRouter>['model3d']['getInfinite']['items'][number]`. Already in use by `/3d-models/index.tsx`.
- `ProfileLayout2.tsx:48-79` builds a per-subpage `deIndex` map (`subpageCounts`) used for SEO no-index decisions. It will need a `'3d-models'` entry once we add the route.
- `model3dFeed` flag is mod-only at launch (`feature-flags.service.ts:203`). Profile tab gating mirrors `articles.tsx:28-34` — redirect to `/user/[username]` when off.

### File touch list

- `src/components/Profile/ProfileNavigation.tsx` — add `'3d-models'` entry to `opts`, gate `disabled` on `features.model3dFeed`.
- `src/pages/user/[username]/3d-models.tsx` — **new file**, mirrors `articles.tsx` structure.
- `src/components/Profile/ProfileLayout2.tsx` — extend `subpageCounts` map at `:66-75` so the SEO no-index logic understands `'3d-models'`.
- `src/server/redis/caches.ts` — add `userModel3DCount{,Sfw,Public}Cache` factories (mirror of `userPostCountCache` at `:570-613`), add `model3dCount` to `UserContentOverview` type at `:896-908`, plumb through `mergeOverviewResults` + all three `getUserContentOverview*` functions + `userContentOverviewCache.refresh` (`:1068-1100ish`).
- `src/server/services/user-profile.service.ts` — no change (it just forwards the cache result).
- `src/components/Profile/ProfileSidebar.tsx` / `ProfileSectionsSettingsInput.tsx` — **optional**: check whether they enumerate content types for the "configure sections" UI; only touch if user-visible.
- `src/server/redis/cache-invalidation.ts` or equivalent — wire `userContentOverviewCache.refresh(userId)` on Model3D publish/unpublish/delete (search for where `Model.publish` triggers `userModelCountCache.refresh`).

### Phased steps

**Phase 1 — Backend count plumbing (~2-3 h)**

1. In `src/server/redis/caches.ts`, add three new `createUserContentCountCache` instances for `model3dCount`, `model3dCount:sfw`, `model3dCount:public` keyed off `"Model3D"`. Query template:
   ```sql
   SELECT "userId" as id, COUNT(*)::INT as "model3dCount"
   FROM "Model3D"
   WHERE "userId" IN (...)
     AND "status" = 'Published'
     AND "deletedAt" IS NULL
     AND availability != 'Private'
     -- sfw/public variants: AND ("nsfwLevel" & ${flag}) != 0
   GROUP BY "userId"
   ```
2. Extend `UserContentOverview` type with `model3dCount: number`.
3. Update `mergeOverviewResults`, all three `getUserContentOverview*` aggregator functions, and the `userContentOverviewCache.refresh` block to include the new caches.
4. Wire `userContentOverviewCache.refresh(userId)` into `publishModel3D` / `unpublishModel3D` / `deleteModel3D` in `src/server/services/model3d.service.ts` (look at how `model.service.ts` does this for `Model.publish`).
5. **Verify** SSR prefetch (`ssg?.userProfile.overview.prefetch`) returns the new field without changes — it should, since the procedure returns the cache shape as-is.

**Phase 2 — Profile tab page (~2 h)**

6. Create `src/pages/user/[username]/3d-models.tsx`. Use `articles.tsx` as the template:
   - `getServerSideProps`: `if (!features?.model3dFeed) return { redirect: { destination: '/user/${username}', permanent: false } };` + banned-user redirect + SSG prefetch `userProfile.get` and `userProfile.overview`.
   - Use `useCurrentUser()` + `postgresSlugify` to derive `selfView`. Compute `isMod = currentUser?.isModerator`.
   - State: `[section, setSection] = useState<'published' | 'draft'>(selfView ? ... : 'published')`. Show `FeedContentToggle` only when `selfView || isMod`.
   - Render `trpc.model3d.getInfinite.useInfiniteQuery({ limit: 50, username, includeDrafts: section === 'draft' && (selfView || isMod) })`.
   - Use the same Masonry + `Model3DCard` + `InViewLoader` pattern from `/pages/3d-models/index.tsx`. (Consider extracting that block into `src/components/Model3D/Infinite/Model3DsInfinite.tsx` for reuse between the global feed and the profile tab — see Risks.)
   - Empty state: reuse `<NoContent />`; if `selfView`, add a CTA linking to `/3d-models/create` (or the wizard route — confirm with `Model3DGenerationForm.tsx` location).
   - Default export `Page(UserModel3DsPage, { getLayout: UserProfileLayout })`.

**Phase 3 — Navigation entry (~30 min)**

7. In `ProfileNavigation.tsx`, add to `opts`:
   ```ts
   '3d-models': {
     url: `${baseUrl}/3d-models`,
     icon: (props) => <IconCube {...props} />,
     count: userOverview?.model3dCount ?? 0,
     disabled: !features.model3dFeed || !!user?.bannedAt,
   },
   ```
   `IconCube` is already used (e.g. `Model3DCard.tsx:2`). Confirm import.
8. In `ProfileLayout2.tsx:66-74`, add `'3d-models': overview?.model3dCount` to `subpageCounts` so SEO de-index keeps working for empty 3D tabs.
9. Confirm `activePath = router.pathname.split('/').pop()` (`ProfileNavigation.tsx:35`) resolves to `'3d-models'` for `/user/[username]/3d-models`. Yes — `split('/').pop()` on that route returns the literal `'3d-models'`. The `opts` key must therefore be the literal string `'3d-models'` (hyphenated, not camelCase).

**Phase 4 — Polish (~1 h)**

10. If the moderator wants to see a creator's drafts even when they're not the owner, broaden the gate: in `UserModel3DsPage`, allow `selfView || isMod` for the draft toggle, **but** the service's `allowDrafts` check (`model3d.service.ts:230`) only honors `includeDrafts` when `userId === user.id`. Either (a) extend the service to also honor `includeDrafts` when `user.isModerator`, or (b) pass `statuses: [Draft, Published, Unpublished]` for mods (the service allows any `statuses` for `isModerator`). Option (b) is simpler.
11. Add `/user/[username]/3d-models` to any sitemap or canonical-URL helpers (grep for the existing `/user/[username]/models` reference in `src/pages/sitemap*` if it exists).

### Risks / open questions

- **R1**: `Model3DsInfinite` duplication. The masonry block in `pages/3d-models/index.tsx:42-94` would be re-implemented in the profile page. Cleaner: extract a `Model3DsInfinite` component (mirror of `ModelsInfinite`) that takes filter props. Adds ~30 min of refactor but avoids drift. Recommend doing this in Phase 2.
- **R2**: Anonymous viewers will see zero 3D models because the service short-circuits non-signed-in non-mod requests (`model3d.service.ts:210-218`). This is consistent with launch gating but means the profile tab badge count may show `model3dCount > 0` while the tab itself is empty for anon viewers. Decide whether to:
  - hide the tab entirely for anon viewers (`disabled: !features.model3dFeed || !currentUser`), or
  - relax the service gate now that the public feed is on its own flag-gated route. **Recommend**: only hide the count badge when anon, but keep the tab clickable so the empty state explains the gate.
- **R3**: Banned-user gate in service is `userId && userId !== user.id && !username` — passing `username` bypasses this for any signed-in user. If profile owner is banned but `username` is passed, the service will still return their content. The page-level redirect at `/user/[username]/3d-models` should mirror `models.tsx:36-39` (redirect when `user?.bannedAt`).
- **R4**: `model3dCount` cache invalidation must run on publish/unpublish/delete/upsert (when status changes). Grep `userModelCountCache.refresh` to find the existing pattern in `model.service.ts` and mirror it.
- **R5**: `availability` column exists on Model3D (`schema.full.prisma:5810`) defaulting to `Public`. Private Model3Ds (if/when that's enabled) should be excluded from the count — query mirrors the Model pattern.
- **Open Q**: should there be a "Private" segment for Model3D drafts (per `models.tsx:67-69, 192`)? Defer to Phase 3; the entity has `availability` but no current product flow sets it to `Private`.

---

## M2 — Moderation integration

### Current state (research findings)

- **Report enum + schema is wired**: `ReportEntity.Model3D` + `Model3DReview` exist (`src/shared/utils/report-helpers.ts:15-16`); `reportTypeNameMap` and `reportTypeConnectionMap` cover both (`src/server/services/report.service.ts:123-124, 141-142`); the `Report` table has `model3d` / `model3dReview` relations (`prisma/schema.full.prisma:1334-1335, 5884-5926`).
- **But `report.create` will fail for Model3D** until: (a) `report.controller.ts` `getReports` select gets a `model3d` + `model3dReview` block, and (b) the `ReportModal` adds `ReportEntity.Model3D` to each form's `availableFor`. The detail page already has a TODO at `pages/3d-models/[id]/[[...slug]].tsx:255-269` blocking the report button on this.
- **Two parallel report paths exist**:
  - Centralized: `trpc.report.create` → `createReportHandler` → `createReport` in `report.service.ts:150-303`. This goes through the moderator queue (`trpc.report.getAll` → `getReportsHandler` in `report.controller.ts:100-271`).
  - Direct: `trpc.model3d.reports.createForModel` → `createModel3DReport` in `model3d-report.service.ts:42-77`. Writes to the same `Report` table but bypasses `report.service.createReport`'s tag-vote / NSFW-action side effects.
  - **Recommendation**: route all UI through `trpc.report.create` so NSFW / TOS / CSAM side-effects fire correctly. Keep the direct procedures for programmatic / SDK callers (or deprecate them).
- **`getReportsHandler` does not select model3d join data** (see `report.controller.ts:113-245`). The moderator queue page (`src/pages/moderator/reports.tsx`) iterates `Object.values(ReportEntity)` for the segmented control (`reports.tsx:226`), so the `Model3D` / `Model3DReview` tabs **already render** but produce empty results — the `where` filter `{ type: { isNot: null } }` at `report.service.ts:319-321` works (because the relation exists), but the row data needed by `getReportLink` (`reports.tsx:442-464`) and `ReportDrawer` is missing.
- **`getReportLink`** at `reports.tsx:442-464` has no case for `report.model3d` / `report.model3dReview`. Without it, the "Open reported item" button at `reports.tsx:131-141` will have an undefined href.
- **Model3D content actioning**:
  - `trpc.model3d.unpublish` exists (`model3d.router.ts:111`) — non-destructive, status → Unpublished.
  - `trpc.model3d.delete` exists (`model3d.router.ts:115`) — soft delete (status → Deleted, sets `deletedAt`, `deletedBy`).
  - **No** `setNsfwLevel`, `setTosViolation`, `setPoi`, `setMinor`, `lockedProperties` mutation endpoint. `Model3D.nsfwLevel` is derived from the thumbnail Image's `nsfwLevel` via a batch job (per the plan; see `model3d.service.ts:82-106` selects but no setter). For Model — for comparison — moderators flip these via `model.toggleCannotPublish` / `model.toggleCannotPromote` / report-action side effects. Model3D has no equivalents.
  - `lockedProperties: string[]` exists on Model3D (`schema.full.prisma:5809`) and the upsert service strips locked props for non-mods (`model3d.service.ts:286-291`). Mods can therefore set `tosViolation` / `nsfw` / `nsfwLevel` via `trpc.model3d.upsert` already — but there's no convenient UI surface and it's not idempotent against `lockedProperties`.
- **Strike system**: `EntityType.Model3D` exists in the enum (`schema.full.prisma:3639`), and `UserStrike.entityType` is `EntityType?` (`schema.full.prisma:5544`) — so strikes can already reference Model3D with no schema change. `createStrike` in `strike.service.ts:470-525` just passes `entityType` through; no per-type switch. **Strikes work out of the box once a UI calls `trpc.strike.create` with `entityType: 'Model3D'` and an `entityId`.**
- **Appeals**: `Appeal.entityType` is also the same `EntityType` enum. **However**, `createEntityAppealHandler` in `src/server/controllers/report.controller.ts:286-318` has a hard-coded switch:
  ```ts
  case EntityType.Image:
    ...
  default:
    throw throwDbCustomError('Entity type not supported for appeals');
  ```
  So **appeals only work for Image today** despite the schema supporting more. Adding Model3D to that switch is trivial (lookup ownership via `model3d.findUnique`).
- **`mod-actions` skill** (`.claude/skills/mod-actions/`): no references to `model3d` / `Model3D` anywhere in the skill scripts. The closest analog is `content.mjs` which exposes `models query / flagged-models / restore / toggleCannotPublish`. There is no Model3D module yet.
- **No `/moderator/model3ds` page exists**. The existing flow assumes the report queue + the thumbnail-image affordance (`Model3DModAction.tsx`) are sufficient.
- **`Model3DModAction.tsx`** only surfaces an "unpublish" action. No "delete", "set NSFW", "set TOS violation", or "issue strike" affordance.

### File touch list

- `src/server/controllers/report.controller.ts` — extend the `select` block in `getReportsHandler` (`:104-246`) with `model3d` + `model3dReview` joins; extend the `items.map` projection (`:249-265`) to surface them.
- `src/pages/moderator/reports.tsx` — extend `getReportLink` (`:442-464`) with `model3d` (returns `/3d-models/${report.model3d.id}`) and `model3dReview` (returns `/3d-models/${report.model3dReview.model3dId}/reviews`).
- `src/components/Modals/ReportModal.tsx` — add `ReportEntity.Model3D` to `availableFor` arrays for `TOSViolation`, `AdminAttention`, `Spam` (mirror the Article / Post entries at `:53-60, 67-79, 86-99, 117-131`). For NSFW reports, add `ReportEntity.Model3D` to the `ArticleNsfwForm` group (`:53-60`) since Model3D NSFW is content-level, not tag-level like Image.
- `src/components/Modals/ReportModal.tsx` — extend `onSuccess` switch (`:196-234`) with a `ReportEntity.Model3D` branch that invalidates `trpc.model3d.getById` + `trpc.model3d.getInfinite`.
- `src/pages/3d-models/[id]/[[...slug]].tsx` — replace the TODO block at `:255-269` with `openReportModal({ entityType: ReportEntity.Model3D, entityId: model3d.id })`.
- `src/components/Modals/ReportModal.tsx` — handle `entityType === ReportEntity.Model3D` for the `useVoteForTags` call site (`:172`) — Model3D has tags via `TagsOnModel3D`, but there's no current vote pipeline. Pass `undefined` or guard the call.
- `src/server/services/report.service.ts` — extend the `createReport` switch (`:194-269`) with Model3D side effects: NSFW report → set `nsfw: true`; TOS report → no engagement table (skip); CSAM report → log only (3D doesn't have an `ingestion` column).
- `src/server/services/model3d.service.ts` — **new** moderator setters: `setModel3DNsfwLevel({ id, nsfwLevel })`, `toggleModel3DTosViolation({ id })`, `toggleModel3DPoi({ id })`, `toggleModel3DMinor({ id })`, plus invalidation of `userContentOverviewCache.refresh(model3d.userId)` on status changes.
- `src/server/routers/model3d.router.ts` — wire the new mod-only mutations under a `moderation` sub-router (mirror of `reviews`/`reports` style) using `moderatorProcedure`.
- `src/components/Model3D/Moderation/Model3DModAction.tsx` — extend to surface "unpublish", "delete", "toggle TOS", "set NSFW level" — or build a sibling `Model3DModMenu` for the detail page.
- `src/server/controllers/report.controller.ts` — extend `createEntityAppealHandler` switch (`:296-305`) with a `case EntityType.Model3D` branch (ownership lookup via `dbRead.model3D.findUnique`).
- `.claude/skills/mod-actions/content.mjs` — add `model3ds`, `model3d-restore`, `model3d-unpublish`, `model3d-toggle-tos` commands; OR add a new `.claude/skills/mod-actions/model3ds.mjs` script. Update `SKILL.md`'s file table at `:32-43`.

### Phased steps

**Phase 1 — Report queue surface (~2 h)**

1. In `report.controller.ts:113-246`, add `model3d` and `model3dReview` to the `select` block:
   ```ts
   model3d: {
     select: {
       model3d: { select: {
         id: true, name: true, nsfw: true, tosViolation: true,
         thumbnailImage: { select: { id: true, url: true, name: true } },
         user: { select: simpleUserSelect },
       }},
     },
   },
   model3dReview: {
     select: {
       model3dReview: { select: {
         id: true, model3dId: true, rating: true, nsfw: true, tosViolation: true,
         user: { select: simpleUserSelect },
       }},
     },
   },
   ```
2. Extend the `items.map` projection at `:249-265` with `model3d: item.model3d?.model3d, model3dReview: item.model3dReview?.model3dReview`.
3. In `pages/moderator/reports.tsx`, extend `getReportLink` (`:442-464`) and confirm the `Model3D` / `Model3DReview` segmented-control tabs render correctly.
4. Smoke-test: file a report against an existing Model3D via `trpc.model3d.reports.createForModel`, then load `/moderator/reports` and switch the segmented control to `Model3d` (case-sensitivity check — `upperFirst('model3d')` is `'Model3d'`, fine).

**Phase 2 — Centralized report flow (~1.5 h)**

5. In `ReportModal.tsx`, add `ReportEntity.Model3D` to:
   - NSFW form: probably reuse `ArticleNsfwForm` (`:49-61`) since Model3D doesn't have per-tag NSFW votes.
   - TOSViolation, AdminAttention, Spam: add to existing arrays (`:67-79, 86-99, 117-131`).
6. Guard the `useVoteForTags` call (`:172`) so it's a no-op for `ReportEntity.Model3D` (Model3D has tags but no rating-request pipeline yet).
7. Extend the `onSuccess` switch (`:196-234`) with a Model3D case that invalidates `model3d.getById` and `model3d.getInfinite`.
8. Replace the TODO block in `pages/3d-models/[id]/[[...slug]].tsx:255-269` with `openReportModal({ entityType: ReportEntity.Model3D, entityId: model3d.id })`.
9. In `report.service.ts:194-269`, add Model3D NSFW / TOS side effects (mirror `case ReportEntity.Post: tx.post.update({ where: { id }, data: { nsfw: true }})` at `:251-253`).
10. **Deprecate or document**: `trpc.model3d.reports.createForModel` is now redundant with `trpc.report.create`. Either remove it (after auditing callers) or document it as the "SDK-only" path. Recommend keeping for now, but updating UI callers to use `trpc.report.create`.

**Phase 3 — Content actioning endpoints (~2 h)**

11. In `src/server/schema/model3d.schema.ts`, add: `setModel3DNsfwLevelSchema`, `toggleModel3DFlagSchema` (`{ id, field: 'tosViolation' | 'poi' | 'minor' | 'nsfw' }`).
12. In `src/server/services/model3d.service.ts`, implement:
    ```ts
    setModel3DNsfwLevel({ id, nsfwLevel, user }) // mod-only; also locks `nsfwLevel` in lockedProperties
    toggleModel3DFlag({ id, field, user })       // mod-only; flips the boolean, locks the field
    ```
    Both refresh the user content overview cache and queue search-index updates if/when 3D models hit Meilisearch.
13. In `src/server/routers/model3d.router.ts`, add a `moderation` sub-router:
    ```ts
    moderation: router({
      setNsfwLevel: moderatorProcedure.input(setModel3DNsfwLevelSchema).mutation(...),
      toggleFlag: moderatorProcedure.input(toggleModel3DFlagSchema).mutation(...),
    })
    ```
    (Not flag-gated — mods always have access.)
14. Extend `Model3DModAction.tsx` with a dropdown menu offering: Unpublish, Delete, Toggle NSFW, Toggle TOSViolation, Set NSFW Level, Open in moderator view. OR build a dedicated `<Model3DModBar />` for the detail page that surfaces these only for `currentUser?.isModerator`.

**Phase 4 — Strikes + appeals (~1 h)**

15. Strikes already work for `EntityType.Model3D` since the schema and service are entity-type-agnostic. Verify by calling `trpc.strike.create` with `entityType: 'Model3D', entityId: <model3dId>` via the `mod-actions` skill once Phase 3 lands. No code change.
16. **Appeals**: in `src/server/controllers/report.controller.ts:296-305`, add:
    ```ts
    case EntityType.Model3D:
      const m3d = await dbRead.model3D.findUnique({
        where: { id: input.entityId },
        select: { userId: true },
      });
      if (!m3d) throw throwNotFoundError('3D model not found');
      if (m3d.userId !== userId) throw throwAuthorizationError();
      break;
    ```
17. Surface "Appeal" CTA on the Model3D detail page for unpublished/deleted-by-mod states (mirror the Image appeal flow — find via `grep -rn 'createEntityAppeal\|appealable' src/components/Image/`).

**Phase 5 — Skill integration (~1.5 h)**

18. Add a new file `.claude/skills/mod-actions/model3ds.mjs` (mirror `content.mjs` layout) with commands:
    - `list` → `trpc.model3d.getInfinite` (mod sees all statuses)
    - `get <id>` → `trpc.model3d.getById`
    - `unpublish <id>` / `delete <id>` / `restore <id>` (need to add a `restoreModel3D` endpoint too — flip status from Unpublished back to Published; trivial parallel to unpublish)
    - `set-nsfw-level <id> --level <n>` / `toggle-tos <id>` / `toggle-poi <id>` (new mod endpoints from Phase 3)
    - `files <id>` → `trpc.model3d.getFiles`
19. Update `.claude/skills/mod-actions/SKILL.md`'s file table (`:33-43`) and add a usage block.

**Phase 6 — (Optional) Dedicated moderator page (~3 h)**

20. Add `src/pages/moderator/model3ds.tsx` that lists Model3Ds by status, mirroring `src/pages/moderator/models/[id]/*` patterns if the team wants a one-stop console. **Defer** unless mods explicitly ask — the report queue + thumbnail affordance + detail-page mod bar from Phase 3 should cover most needs.

### Gaps that need new endpoints (with proposed signatures)

| Procedure | Signature | Purpose |
|---|---|---|
| `trpc.model3d.moderation.setNsfwLevel` | `({ id: number, nsfwLevel: number, lock?: boolean }) → Model3D` | Mod override of thumbnail-derived level; sets `lockedProperties += 'nsfwLevel'` when `lock`. |
| `trpc.model3d.moderation.toggleFlag` | `({ id: number, field: 'tosViolation' \| 'poi' \| 'minor' \| 'nsfw' \| 'unlisted' }) → Model3D` | Single endpoint per boolean; locks the field. |
| `trpc.model3d.moderation.restore` | `({ id: number }) → Model3D` | Mod-only un-delete (status: Deleted → Unpublished, clear `deletedAt`). |
| `trpc.report.createAppeal` switch case | `{ entityType: 'Model3D', entityId }` | Extend `createEntityAppealHandler` switch. |

### Risks / open questions

- **R6**: Two report paths (centralized `report.create` vs `model3d.reports.createForModel`) silently diverge. Centralized hits the moderator queue and runs NSFW/TOS side-effects; the direct path doesn't. Recommend Phase 2 step 10 either deprecates or hard-syncs them.
- **R7**: `getReports` `where: { [type]: { isNot: null } }` (`report.service.ts:319-321`) relies on the Prisma relation name matching the enum value. Confirmed: `Report.model3d` and `Report.model3dReview` exist (`schema.full.prisma:1334-1335`) and the enum values `model3d` / `model3dReview` (`report-helpers.ts:15-16`) match — so the `getAll` query will not need a special case.
- **R8**: `Model3D.nsfwLevel` is derived from the thumbnail's `nsfwLevel` via a batch job. If a mod overrides via `setNsfwLevel`, the next batch run will clobber it unless we honor `lockedProperties.includes('nsfwLevel')` in `updateModel3DNsfwLevels`. Confirm and add the guard in that batch job (search `updateModel3DNsfwLevels`).
- **R9**: `ReportModal.tsx`'s `useVoteForTags` is typed `entityType: 'image' | 'model'` (`:172`) — `ReportEntity.Model3D` will need either a cast/guard or an extension of `useVoteForTags`. Cheapest path: guard the call when `entityType === ReportEntity.Model3D`.
- **R10**: The `mod-actions` skill scripts auth as a moderator API key. The new `model3d` endpoints are mod-gated; verify Bearer-token tRPC calls hit `moderatorProcedure` correctly (the session shape for API-key auth must populate `ctx.user.isModerator`). Should be fine — `content.mjs` already calls `moderator.models.*` the same way.
- **R11**: NCMEC/CSAM flow: `csam.mjs` calls expect Image-shaped payloads. If a Model3D is CSAM, the thumbnail Image likely already gets reported via the existing image-CSAM path. Confirm with mods whether Model3D needs its own NCMEC path or if "report the thumbnail Image + delete the Model3D" is sufficient. Recommend the latter for v1.
- **R12**: `report.service.ts:194` NSFW side-effect for Model — `addTagVotes({ type, id, tags, ... })` — has a switch on `type` keyed to image/model. For Model3D we'd need either to add it to `addTagVotes` or skip tag-level reporting until we wire it. Skip in v1.
- **Open Q**: Should there be a "Hidden" status (between Unpublished and Deleted) for mod-forced takedowns vs creator-initiated unpublish? Today `Unpublished` is shared. Consider an audit log entry (`StrikeReason.ManualModAction` strike attached to entity) rather than a new status.
- **Open Q**: For appeals UI on Model3D detail page, model the flow off whichever image-appeal component exists. Need to grep more if scoping appeals beyond Phase 4 step 16.

---

## Effort estimate

- **M1**: **S–M** (~5-7 h) — backend count plumbing 2-3 h, profile tab page + nav 2-3 h, polish 1 h.
- **M2**: **M–L** (~10-13 h) — report queue 2 h, centralized report flow 1.5 h, mod content endpoints + UI 2-3 h, appeals + strikes 1 h, mod-actions skill 1.5 h, optional moderator page +3 h.
- **Total wall-clock**: **~15-20 hours** (without the optional dedicated moderator page); add ~3 h if Phase 6 is in scope.

---

## Recommended order

1. **M2 Phase 1** (extend `getReports` select + `getReportLink`) — unblocks the existing TODO at `pages/3d-models/[id]/[[...slug]].tsx:257`, very low risk, immediately useful to mods.
2. **M2 Phase 2** (wire `trpc.report.create` for Model3D via `ReportModal`) — finishes the report loop end-to-end.
3. **M1 Phase 1** (backend `model3dCount` cache) — required before the tab badge is meaningful and unblocks the profile tab.
4. **M1 Phases 2-4** (profile tab page + nav + polish).
5. **M2 Phase 3** (mod content endpoints + UI) — adds real action affordances beyond unpublish.
6. **M2 Phase 4** (appeals switch + strikes verification).
7. **M2 Phase 5** (`mod-actions` skill commands) — last because it leans on Phase 3's endpoints.
8. **M2 Phase 6** (dedicated `/moderator/model3ds` page) — only if mods request it after Phase 5 lands.

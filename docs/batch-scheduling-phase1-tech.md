# Batch post scheduling — Phase 1 technical plan (batch composer)

Companion to [`batch-scheduling-plan.md`](batch-scheduling-plan.md) (master plan) and
[`batch-scheduling-ux.md`](batch-scheduling-ux.md) (UX plan). ClickUp 868mcqb8t.
Audited against `main` @ `dbdcc1bcc6` on 2026-10-06. Decisions follow the scope's recommendations:
go-live-day cap, 30-minute per-user gap, flag with members first, 20-image UI limit untouched, daily
rewards accepted.

## 0. Phase 0 status: sortAt on reschedule is already fixed on main

- `src/server/services/post.service.ts` `updatePost` captures `publishedAtWritten` from the anti-bump
  `UPDATE ... RETURNING` and calls `afterPostPublish`, which runs `queueImageSearchIndexUpdate` for all of
  the post's images. The doc comment on `afterPostPublish` names the stale `sortAt/publishedAtUnix`
  failure explicitly.
- Commits on `main`: `820f4ecedc` (2026-06-18) "re-index images when post publishedAt is (re)written"
  and `b5f8f4047d` (2026-06-29) "reindex images when publishedAt changes so feed sort isn't stale".
- Go-live half: `src/server/jobs/process-scheduled-publishing.ts` reindexes newly live posts' images
  post-commit (the images search-index pull filter rejects future-dated posts, so the sweep is the hook
  that lands the final `sortAt = GREATEST(p.publishedAt, i.scannedAt, i.createdAt)`).
- Tests: `src/server/services/__tests__/after-posts-publish.test.ts`,
  `src/server/jobs/__tests__/process-scheduled-publishing.rewards.test.ts`.

Residual: the ClickUp bug ticket (868k68g0z) is still `pending review`; it needs a prod verification
query (count scheduled posts rescheduled in the last 14 days whose images have `sortAt < publishedAt`,
expect 0) and then closing against the two commits above. The only remaining risk is the
`REWARD_SWEEP_LIMIT` cliff (section 7), which jitter addresses.

## 1. Architecture decision

**Server-side `post.scheduleBatch`, called per chunk of complete posts, preceded by one
`post.validateBatchSchedule` query that checks the whole batch up front.** Uploads to S3 stay
client-side and happen before any post exists.

Why not a client-orchestrated loop over `post.create` / `post.addImage` / `post.update`:
- `post.create` carries `rateLimit(postRateLimits, undefined, { sharedKey: 'post:create' })`
  (`post.router.ts`), which counts at creation. 200 creates in one sitting trips every tier; the loop
  fails halfway with 20–150 posts already made. The go-live-day cap cannot be expressed in that
  middleware.
- Cap and gap would be validated per call against a moving target; no way to reject the whole batch
  before writing.
- 600+ round trips for 200 images.

Why not fully atomic / one call for everything:
- `addPostImage` (`post.service.ts`) fetches EXIF when meta is absent, enqueues ingestion inside
  `createImage`, runs `createImageResources`, and busts caches. The `no-io-in-transaction` guard forbids
  wrapping this in one transaction, and `createPostWithImagesHandler` documents the same conclusion.
- 200 images × (createImage + createImageResources + cache busting) in a single request risks the HTTP
  timeout. Chunk per call instead.

Why not a 200-image "staging" post later split into N posts:
- Moving `Image.postId` bypasses `addPostImage`'s `(postId,url)` idempotency guard, requires
  re-indexing `index`, recomputing `nsfwLevel` per post, re-busting `images-user` /
  `images-modelVersion` / post caches, and the sweep/anti-bump logic assumes images are created under
  their final post. Nothing is gained because S3 upload does not need a post id.

Unit of work: one `scheduleBatch` call creates up to `POST_BATCH_CHUNK_POSTS` (10) posts, each fully
populated and scheduled before the next starts. On failure at post k inside a chunk: posts before k
stay (complete and valid), post k is deleted via `deletePost` (same compensation as
`createPostWithImagesHandler`), and the response reports `{ created: [...], failedAt: k, message }`.
The client stops and shows what was created. Every call re-validates its own slice against the DB so
a race with a concurrent reschedule cannot breach the cap.

Guarantee the UI can state truthfully: "every post either exists complete and scheduled, or does not
exist".

## 2. Data flow

Client (`/posts/batch` page, new `src/components/Post/Batch/*`):
1. Drop files → `useMediaUpload` under a `MediaUploadSettingsProvider settings={{ maxItems:
   POST_BATCH_MAX_IMAGES }}` and a `FileUploadProvider`. `preprocessFile` parses meta client-side,
   `auditMetaData` flags blocked meta, S3 upload via `/api/v1/image-upload/multipart`. `onComplete`
   yields `{ status, url (S3 key), index, metadata: {width,height,hash}, meta, type, mimeType }` with
   **no post id**. Store these in a new zustand store `useBatchComposerStore` as `UploadedMedia[]`.
2. User sets grouping (1 image per post default, or N per post ≤ `POST_IMAGE_LIMIT`), shared metadata
   (model version from query params or picker, tools, techniques, tags ≤ `POST_TAG_LIMIT`, title
   template), and the schedule mode. The pure generator (section 4) produces `Date[]`, one per post,
   with jitter.
3. Preview: `trpc.post.validateBatchSchedule.useQuery({ publishedAts, postCount })` returns
   `{ ok, issues[], dailyLimit, perDay: {day, existing, incoming}[] }`. Issues render inline. Submit is
   disabled until `ok`.
4. Submit: client sends `scheduleBatch` per chunk of 10 posts sequentially, with a progress bar;
   `created` post ids accumulate; on completion link to the planner (Phase 2) or the "Scheduled" view
   of the user's posts.

Server (`scheduleBatchHandler` in `post.controller.ts`):
1. Zod: `scheduleBatchSchema` (section 8).
2. Context load (one query each): the user's daily limit via new `getDailyPostLimit(user)`
   (extracted from `post.schema.ts` `dailyPostTiers` / `MEMBER_DAILY_POST_MULTIPLIER` / `hasReputation`
   / `isPaidMember`); existing `publishedAt` for `Post WHERE userId = ? AND publishedAt >=
   start_of_today_utc`.
3. `validateBatchSchedule(...)` pure function; `throwBadRequestError` with all issues if any.
4. If `modelVersionId`: `canViewModelVersion` once up front so the batch fails before any write.
5. For each post group, sequentially:
   - `createPostHandler({ input: { modelVersionId, title, tags }, ctx })` — reused verbatim (no
     `publishedAt` yet, so no inline reward).
   - `addPostImage({ ...media, postId, index, user })` per image — reused verbatim. Client-parsed
     `meta` is sent, so the server EXIF fallback is skipped. `createImageResources` inherits
     `Post.modelVersionId` as a `detected:false` resource (`docs/features/image-resources.md`), so **no
     extra call pre-fills the promoted model version**.
   - `addImageTools` and `addImageTechniques` (`image.service.ts`) — one call per post; skip when empty.
   - `updatePostHandler({ input: { id, publishedAt }, ctx })` — reused verbatim: anti-bump guard,
     `afterPostPublish` reindex, tracking with the `scheduled` tag, `imagePostedToModelReward`.
6. Return `{ created: { postId, publishedAt }[], failedAt?, message? }`.

No existing service needs a new parameter. New server code: the schema, the pure validator, the
context query, the controller handler, and two router entries.

## 3. Cap and gap enforcement

One pure function so client preview and server agree:

```ts
// src/utils/post-batch-schedule.ts
validateBatchSchedule({
  now, publishedAts, existingPublishedAts, dailyLimit,
  minGapMinutes = POST_BATCH_MIN_GAP_MINUTES,     // 30
  minLeadMinutes = POST_MINIMUM_SCHEDULE_MINUTES, // 10
  maxMonths = POST_MAXIMUM_SCHEDULE_MONTHS,           // 3
}): { ok: boolean; issues: ScheduleIssue[]; perDay: PerDay[] }
```

Rules (UTC days, matching the sweep's `startOfUtcDay` and the reward's daily dedup):
- Window: every date in `[now + minLead, now + 3 months]`. `SchedulePostModal.tsx` hard-codes `3`
  today and should import the new constant.
- Jitter guard: no date with `getUTCMinutes() === 0` (the generator never emits one; the validator
  rejects, so hand-edited dates are covered).
- Gap: sort `[...existing, ...incoming]`; adjacent difference ≥ 30 min.
- Cap: for each UTC day D, `existing in D + incoming in D ≤ dailyLimit`.
- Batch shape: `1 ≤ posts ≤ POST_BATCH_MAX_POSTS`, `1 ≤ images/post ≤ POST_IMAGE_LIMIT`, total images
  ≤ `POST_BATCH_MAX_IMAGES`.

The one DB query, on `dbWrite` (a post created by the previous chunk seconds ago must be visible):

```sql
SELECT "publishedAt" FROM "Post" WHERE "userId" = $1 AND "publishedAt" >= $startOfTodayUtc
```

`Post` has indexes only on `publishedAt`, `modelVersionId`, `model3dId`. Bounding by
`publishedAt >= today` keeps the scan to today's live posts plus all pending posts (13k site-wide), so
it is cheap without a `(userId, publishedAt)` index. The planner (Phase 2) reads wider ranges and will
want that index; see the master plan.

Rate limiting: `scheduleBatch` must not use `rateLimit(postRateLimits)`. Use
`isFlagProtected('batchPostScheduling')` plus a batch-level `rateLimit({ limit: 30, period:
CacheTTL.hour })` as an abuse brake. Moderators skip the cap (not the window/gap). Known gap (R3): batch
posts do not increment the `post:create` Redis bucket.

## 4. Schedule generation

File: `packages/civitai-shared/src/post-scheduling.ts`, exported as `@civitai/shared/post-scheduling`
(pure TypeScript, no app imports; the window constants move here too and `src/server/common/constants.ts`
re-exports them). It lives in the shared package rather than `src/utils` because the planner element
and the Creator Studio server import the same generators, validator and scope rule
(see [`batch-scheduling-planner-element.md`](batch-scheduling-planner-element.md) §1). Tests:
`packages/civitai-shared/src/__tests__/post-scheduling.test.ts` (run with `pnpm run test:packages:run`).

```ts
export type Rng = () => number; // [0,1)
export function generateEverySchedule({ start, everyMinutes, count, rng }): Date[]
export function generateSpreadSchedule({ from, to, count, rng }): Date[]
export function applyJitter(date: Date, rng: Rng): Date   // +0..9 min; +1 more if minute lands on :00
export function validateBatchSchedule(...)                 // section 3
export function getDailyPostLimit(user: Pick<SessionUser,'tier'|'meta'>): number
```

Generator constraints so jitter cannot break the gap: `everyMinutes ≥ 60` (UI minimum 1h) and `spread`
requires `(to - from) / (count - 1) ≥ 40` min; otherwise the generator returns an issue instead of
dates. Base dates are computed in the user's local time and converted to UTC; cap days are UTC.

Tests (deterministic `rng` fixtures, `vi.useFakeTimers`):
- `every`: n dates, monotonic, spacing in `[every, every+9]`, none at :00, first ≥ start.
- `spread`: first = from(+jitter), last ≤ to, spacing within tolerance.
- `applyJitter`: never :00 across all 60 base minutes × fixed rng values.
- `validate`: each rule has a pass and a fail case; UTC boundary case (23:55 vs 00:05); existing
  pending post at T and incoming at T+29 fails, T+30 passes.
- `getDailyPostLimit`: tier × member combinations equal `postRateLimits`' numbers (drift test).

## 5. Feature flag

In `src/server/services/feature-flags.service.ts`:

```ts
batchPostScheduling: {
  availability: ['mod'],
  fliptKey: 'batch-post-scheduling',
  displayName: 'Batch post scheduling',
},
```

`['mod']` is the Flipt-down fallback; Flipt is authoritative when the key exists. Rollout: create the
Flipt flag with a rule for the `isMember == "true"` segment (`buildFliptContext` exports `tier` and
`isMember`), then widen to 100%. Members-first therefore needs no code change.

Reads: server `isFlagProtected('batchPostScheduling')` on both procedures; client
`useFeatureFlags().batchPostScheduling` gates the model-page button, and the page renders `<NotFound />`
when off (`createServerSideProps` already computes `features`, so it can also `notFound` server-side).

## 6. Entry points

- **Model page, owner only**: `src/components/Model/ModelVersions/ModelVersionDetails.tsx`. The existing
  `/posts/create?modelId&modelVersionId` link is inside the reviewer's `UserResourceReviewComposite`
  card, not an owner control. Add "Promote this model" in the owner block, linking to
  `/posts/batch?modelId=…&modelVersionId=…`, rendered when `features.batchPostScheduling && isOwner &&
  !deleted`.
- **General page**: `src/pages/posts/batch.tsx`, mirroring `src/pages/posts/create.tsx`:
  `createServerSideProps` with login redirect, `postEditQuerySchema.parse(router.query)` for
  `modelId`/`modelVersionId`, the same `trpc.model.getVersions` select when only `modelId` is present,
  muted-user block. Uses the new batch store, not `PostEditProvider`.
- Pre-filling the model version on every image: pass `modelVersionId` to `createPostHandler`;
  `createImageResources` inherits it as a resource. Posts also surface under the version's gallery via
  `Post.modelVersionId`.

## 7. Load considerations

- **Scan/ingestion burst**: 200 images arrive at upload time regardless of scheduling. Accept, per
  scope. `POST_BATCH_MAX_IMAGES` bounds the burst per batch; the hourly batch rate limit bounds repeats.
- **Reward sweep clustering**: jitter guarantees no batch post lands on :00. The 5,000/min cliff stays
  ~90× above today's peak. Do not change `REWARD_SWEEP_LIMIT`.
- **Feeds**: 30-minute gap plus the daily cap, in the validator. Nothing else.
- **DB**: per chunk, ~10 posts × (createPost + N addPostImage + tools + techniques + updatePost).
  Sequential, not parallel.
- **Daily rewards from spread schedules**: accepted (scope decision 6).

## 8. Files to create / modify, tests, migration

Create:
- `packages/civitai-shared/src/post-scheduling.ts` (+ `package.json` export) — window constants,
  generators, jitter, validator, `getPostScheduleScope`, `getPostScheduleError`. `getDailyPostLimit`
  stays in the main app (`post.schema.ts`) because it reads session-user tiers.
- `packages/civitai-shared/src/__tests__/post-scheduling.test.ts`.
- `src/server/controllers/__tests__/post.controller.schedule-batch.test.ts` — whole-batch rejection
  writes nothing; mid-chunk failure deletes post k and reports `created` for `<k`; tools/techniques
  calls per post; `updatePostHandler` called with each date; moderator cap skip. Mock with
  `importOriginal` spreads as in `post.controller.schedule.test.ts`.
- `src/components/Post/Batch/BatchComposer.tsx`, `batch-composer.store.ts`, `BatchSchedulePreview.tsx`,
  plus the UX plan's `ScheduleBuilder`, `BatchReviewTable`, `BatchProgressModal`, `TitleTemplateInput`.
- `src/components/Post/Batch/BatchComposer.browser.test.tsx` — preview dates have no :00 minute;
  submit disabled while `validate` reports issues; chunked submission reports created count.
- `src/pages/posts/batch.tsx` (no tests under `src/pages`).
- `docs/features/batch-post-scheduling.md` + index row in `docs/features/README.md`.

Modify:
- `src/server/common/constants.ts` — `POST_MAXIMUM_SCHEDULE_MONTHS = 3`, `POST_BATCH_MIN_GAP_MINUTES = 30`,
  `POST_BATCH_MAX_POSTS`, `POST_BATCH_MAX_IMAGES`, `POST_BATCH_CHUNK_POSTS = 10` next to
  `POST_IMAGE_LIMIT`.
- `src/server/schema/post.schema.ts` — `scheduleBatchSchema`, `validateBatchScheduleSchema`; export
  `getDailyPostLimit` or move the tier helpers so the util can import without pulling zod schemas.
- `src/server/controllers/post.controller.ts` — `scheduleBatchHandler`, `validateBatchScheduleHandler`,
  shared `loadBatchScheduleContext(userId)`.
- `src/server/routers/post.router.ts` — `scheduleBatch: guardedProcedure.use(isFlagProtected(...))
  .use(rateLimit({limit:30, period:CacheTTL.hour}))`, `validateBatchSchedule: protectedProcedure
  .use(isFlagProtected(...)).query(...)`; both `.meta({ requiredScope: TokenScope.MediaWrite })`.
- `src/server/services/feature-flags.service.ts` — flag declaration.
- `src/components/Post/EditV2/SchedulePostModal.tsx` — use `POST_MAXIMUM_SCHEDULE_MONTHS`.
- `src/components/Model/ModelVersions/ModelVersionDetails.tsx` — owner "Promote this model" button.

Lint-rules: `pnpm run test:lint-rules` (new module-scope constants; `no-io-in-transaction` — the handler
must not open a transaction around service calls).

Migration: **none**.

## 9. Sequencing (all PRs based on `main`, each mergeable and flag-dark)

1. **PR A — `@civitai/shared/post-scheduling` + constants** (~350 LOC incl. tests). Also moves the
   first pass's `post-reschedule.ts` rules and tests into the module. No user-visible change.
2. **PR B — server procedures + flag** (~450 LOC). Flag at `['mod']`; procedures behind
   `isFlagProtected`. Controller tests. Dark for non-mods.
3. **PR C — composer page** (~900 LOC). `/posts/batch` renders `NotFound` without the flag; component
   tests.
4. **PR D — model page entry point + docs** (~120 LOC).
5. Rollout (no PR): create the Flipt flag, rule for `isMember`, dogfood as mod, then widen.

Rough total: 1.5–2 weeks for one engineer, matching the scope.

## 10. Risks and open technical questions

- **R1 — Request duration per chunk.** 10 posts × up to 20 images of `addPostImage` could approach a
  30–60 s request. Start with `POST_BATCH_CHUNK_POSTS = 10` but cap images per call at 60; measure
  `addPostImage` p95 in dev and tune the constant.
- **R2 — Orphaned S3 objects.** Uploads happen before any post exists; abandoning the composer leaves
  keys with no `Image` row. Accept for Phase 1; confirm with infra whether the upload bucket has a
  lifecycle rule for unreferenced keys.
- **R3 — Two cap counters.** Normal creates count in Redis (`post:create`); batch posts count in the DB
  by go-live day. Batch-then-manual on the same day can exceed the tier by up to the tier size. Accept
  in Phase 1; optionally record attempts for posts going live today in a follow-up.
- **R4 — Flag default and Flipt context.** Members-first relies on the Flipt `isMember` attribute.
  Verify the flag evaluates for a member in dev before PR C review; fallback is a static
  `['mod','member']` availability.
- **R5 — Timezone edges.** Users pick local times; the cap is per UTC day. The preview must label counts
  by UTC day or users will not understand a cap refusal. Show both local time and the UTC day grouping.
- **R6 — Phase 0 ticket identity.** 868k68g0z is not referenced in git; 868k2d05k (a wider bug cluster,
  complete) is, and the fix is on main. Verify in prod and close 868k68g0z before Phase 1 starts.

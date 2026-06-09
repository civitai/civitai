# Post publishedAt bump prevention

## Problem

A user can bump their posts to the top of the feed by:

1. Unpublishing the post's parent Model/Version (which nulls `Post.publishedAt`
   and stashes the original date as `metadata.prevPublishedAt`).
2. Opening the post directly and picking a new `publishedAt` (future date, or
   "now").
3. Waiting for the new date to pass — the post resurfaces as if freshly
   published.

Symptom signature: a post with `publishedAt` set to a future date AND
`metadata.prevPublishedAt` set to a past date, with the parent MV/Model
still in `Unpublished` status. The cron flip won't catch it. Without
intervention the post will surface on the future date carrying a
publishedAt that predates its real first publish.

The current production occurrence is small (single-digit rows when this
spec was written, verified via DB query against the op3-style filter),
but the loophole is open until both the backend and the UI enforce the
invariant.

## Complete map of write sites

All code paths that touch `Post.publishedAt` (excluding the migration / admin
sweeps), classified by whether they preserve the bump-prevention invariant.

### Unpublish writes (null Post.publishedAt or remove from feed)

| # | Path | File | Stash? | Notes |
|---|---|---|---|---|
| U1 | `unpublishModelVersionById` | `mv.service.ts:1122` | ✅ stashes `unpublishedAt, unpublishedBy, prevPublishedAt` | Reason lives on parent MV.meta, not Post |
| U2 | `unpublishModelById` | `model.service.ts:2288` | ✅ same 3 keys | Reason on parent Model.meta |
| U3 | OD / violation unpublish-all | `user.service.ts:1442` | ✅ same 3 keys | Reason on parent MV.meta |
| U4 | `publishPrivateModel(publishVersions: false)` | `model.service.ts:3742` | ❌ **no stash** | Nulls `Post.publishedAt` via Prisma `updateMany`. Loophole — see L2 below |
| U5 | `updatePost` with `data.publishedAt = null` | `post.service.ts:801` (Prisma path) | n/a | Gated by zod `z.date().optional()` — null is not a valid input via tRPC, so unreachable from the client. Still a latent risk if internal code constructs the payload directly |

### Re-publish writes (set Post.publishedAt)

| # | Path | File | Restores via CASE? | Strips stash? |
|---|---|---|---|---|
| R1 | `publishModelVersionById` post fanout | `mv.service.ts:1016` | ✅ | ✅ |
| R2 | `publishModelById` post fanout | `model.service.ts:2156` | ✅ | ✅ |
| R3 | Scheduled-publish cron | `jobs/process-scheduled-publishing.ts:180` | ✅ | ✅ |
| R4 | `updatePost` raw SQL guard | `post.service.ts:816` | ❌ | ❌ — **L1 (this doc's primary fix)** |
| R5 | `publishPrivateModel(publishVersions: true)` | `model.service.ts:3747` | ❌ | ❌ — **L2** |
| R6 | `republish-orphaned-drafts` admin sweep | `temp/republish-orphaned-drafts.ts:145` | n/a (drafts only) | ✅ |

### Loopholes

- **L1 — `updatePost`** (this doc's main fix). Owner unpublishes via model
  page, then opens the post directly and picks a new date → fresh bump.
- **L2 — `publishPrivateModel`** flip path.
  - With `publishVersions: false`: nulls `Post.publishedAt` without stashing
    the original date. After this, the original date is lost — even an
    honest re-publish via R1/R2 can't restore it.
  - With `publishVersions: true`: writes `now` directly with the anti-bump
    guard, but does not consult `metadata.prevPublishedAt`. If a Post had a
    prior stash (e.g. previously unpublished, then sent through a private
    cycle), the stash is ignored and the post bumps to `now`.
- **L3 (latent) — `updatePost` with `null`**. zod schema currently forbids,
  but any internal caller bypassing zod could write a null directly through
  the Prisma `tx.post.update` block in `post.service.ts:801` without going
  through the raw SQL guard. Hardening: peel-off should treat `null`
  explicitly (unpublish-via-edit), route through the raw SQL with stash,
  same as a Date write.

### Proposed fixes per loophole

- **L1** — addressed by §1 of this doc (rewrite raw SQL to use the CASE
  pattern, strip stash).
- **L2a** (`publishPrivateModel` false): mirror the unpublish pattern —
  stash `unpublishedAt / unpublishedBy / prevPublishedAt` (and the proposed
  `unpublishedReason / customMessage`) before nulling. Reason key value
  could be a new enum like `'made-private'` to differentiate from violation.
- **L2b** (`publishPrivateModel` true): replace the raw `SET publishedAt =
  ${now}` block with the same CASE pattern as R1/R2 — honor the stash if
  present, strip it on success.
- **L3** — extend `updatePost`'s peel-off to also catch `null`, route
  through the raw SQL block. The raw SQL becomes the single chokepoint for
  every `Post.publishedAt` write.

## Existing invariants (what's already correct)

| Path | File | Behavior |
|---|---|---|
| MV republish | `src/server/services/model-version.service.ts:1016` | `Post.publishedAt = COALESCE(prevPublishedAt::ts, ${publishedAt})`, strips stash |
| Model republish | `src/server/services/model.service.ts:2156` | same CASE pattern |
| Scheduled-publish cron | `src/server/jobs/process-scheduled-publishing.ts:180` | same CASE pattern |
| MV unpublish | `src/server/services/model-version.service.ts:1122` | stashes once, `WHERE publishedAt IS NOT NULL` |
| Model unpublish | `src/server/services/model.service.ts:2288` | stashes once, same guard |
| User unpublish-all | `src/server/services/user.service.ts:1442` | stashes once |

Anti-bump guards on Model/Version `publishedAt` themselves landed in commits
`dcad72ef` (model) and `e78788dc4` (article). Post is the remaining gap.

## Root cause

`updatePost` (`src/server/services/post.service.ts:816-829`) writes
`Post.publishedAt` directly via raw SQL with only an anti-bump guard on the
column:

```sql
UPDATE "Post" SET "publishedAt" = ${publishedAt}
WHERE id = ${id} AND ("publishedAt" IS NULL OR "publishedAt" > NOW())
```

It does not consult `metadata.prevPublishedAt`, and does not strip the stash.
The guard allows the NULL→future transition that the unpublish flow creates,
so the bump succeeds and the stash is left orphaned.

## Decision

**`Post.publishedAt` is write-once after first publish.** Re-publishing a
previously-published post always restores the original date and strips the
stash. The user cannot pick a new date for a post that was already public.

This matches how the Model/Version republish paths already treat the attached
Post rows; we're just enforcing it through the direct edit path too.

## Changes

### 1. Backend: `updatePost` write-once enforcement

`src/server/services/post.service.ts:816` — rewrite the raw UPDATE to mirror
the MV/Model republish CASE:

```sql
UPDATE "Post"
SET
  "publishedAt" = CASE
    WHEN "metadata"->>'prevPublishedAt' IS NOT NULL
    THEN ("metadata"->>'prevPublishedAt')::timestamptz
    ELSE ${publishedAt}
  END,
  "metadata" = COALESCE("metadata", '{}'::jsonb)
               - 'unpublishedAt' - 'unpublishedBy' - 'prevPublishedAt'
WHERE id = ${id}
  AND ("publishedAt" IS NULL OR "publishedAt" > NOW())
```

Reflect the actually-written value back onto `updated.publishedAt` so the
controller's `wasPublished` check still fires correctly when the stash forced
a different timestamp than the submitted one.

### 2. Backend: surface unpublish context to the edit view

The Post edit selector currently returns `publishedAt` but not the
unpublish-stash keys. The UI needs four facts to render the restore-only
state with proper context:

| Field | Purpose | Source today |
|---|---|---|
| `wasPublished: boolean` | drives "restore-only" UI gating | derived: `metadata.prevPublishedAt IS NOT NULL` |
| `unpublishedAt: Date \| null` | "Unpublished on …" copy | `Post.metadata.unpublishedAt` |
| `unpublishedReason: string \| null` | "… because (no-files / violation / …)" | **NOT on Post today — on parent MV.meta / Model.meta** |
| `unpublishedBy: number \| null` | distinguish self vs mod (compare to `post.userId`) | `Post.metadata.unpublishedBy` |
| `customMessage: string \| null` | mod-supplied detail | **NOT on Post today — on parent MV.meta / Model.meta** |

Two of these (`unpublishedReason`, `customMessage`) only exist on the parent
MV/Model meta — they were never mirrored to the Post during unpublish writes.

Decision: **mirror them onto `Post.metadata`** at unpublish time, rather than
making the Post edit selector JOIN through to its parent. Self-contained
metadata on the Post, no join dependency for a hot UI render path, and
strip-on-republish becomes a single op on a single row.

Concretely:

- `src/server/services/model-version.service.ts:1122-1134` (unpublishMv post
  fanout) — extend the `jsonb_build_object` to also write
  `unpublishedReason` and `customMessage` when present.
- `src/server/services/model.service.ts:2288-2300` (unpublishModel post
  fanout) — same.
- `src/server/services/user.service.ts:1442` (user unpublish-all) — same.
- All three corresponding republish paths
  (`model-version.service.ts:1024`, `model.service.ts:2163`,
  `process-scheduled-publishing.ts:188`) — extend the metadata strip to
  also remove `unpublishedReason` and `customMessage`.
- `src/server/services/post.service.ts` — `updatePost` strip (from §1) and
  the new edit selector also need to strip / surface these keys.

Post-edit selector / tRPC return shape: add the five derived fields above.
Computed server-side so we don't leak raw metadata layout to the client.

Files to touch:

- `src/server/selectors/post.selector.ts` (or wherever the edit selector
  lives — confirm path during implementation)
- `src/server/services/post.service.ts` — `getPostEditDetail` / equivalent
- `src/server/schema/post.schema.ts` if a schema needs widening

@dev:* migration question: existing unpublished posts in the wild don't
have `unpublishedReason` / `customMessage` on Post.metadata (only on parent).
Three options:
1. Backfill once via SQL from parent MV/Model into Post.metadata.
2. Render UI with "Reason unknown" when missing — accept a transition window.
3. Read-through fallback in the selector: if Post.metadata.unpublishedReason
   is null, fall back to the parent's meta. Drop the fallback after backfill.

Lean toward (1) — single sweep, then steady-state is self-contained.

### 3. Frontend: lock the schedule UI when `wasPublished`, surface reason

`src/components/Post/EditV2/PostEditSidebar.tsx:185` (`handleScheduleClick`)
and `:269` (Publish/Schedule split-button group) — when `post.wasPublished`:

- Hide / disable the "Schedule" entry in the split button.
- Change the Publish button copy from `Publish` → `Restore` (or similar).
- Replace the hidden-post helper text (`:242-253`) with an info alert that
  explains the state and shows context from §2 fields:

  > This post was unpublished on **{unpublishedAt}**
  > {byMod ? `by a moderator` : `by you`}
  > {unpublishedReason ? `because of: {humanReason}.` : ``}
  > {customMessage ? `Note: {customMessage}` : ``}
  >
  > Republishing restores the post to its original publish date
  > ({prevPublishedAt}). You can't pick a new date.

  Where `byMod` is `unpublishedBy !== post.userId`, and `humanReason` maps
  the raw enum value (`no-files`, `no-posts`, `violation`, etc.) to a
  user-friendly string via a small lookup in the component file.

- Skip opening `SchedulePostModal` from the keyboard / programmatic paths.

`src/components/Post/EditV2/SchedulePostModal.tsx` — if anything still
reaches it, render an explanatory disabled state instead of the date picker.

Mod-unpublished violations probably warrant a stricter UX — see §3a.

### 3a. Frontend: mod-unpublished posts

When `unpublishedBy !== post.userId` AND `unpublishedReason` indicates
violation (e.g. `'violation'`, anything in a mod-action reason set —
confirm enum during implementation), the user should NOT see a Restore
button at all. The post is in a moderation-hold state; surfacing a Restore
button would let the violator re-publish moderated content.

In that case:

- Render the info alert (with reason + customMessage) but no Publish /
  Restore / Schedule buttons.
- Add a "Contact support" link or equivalent.

@dev:* confirm with the moderation team which unpublishedReason values
warrant the locked state vs. which are user-restorable. Most likely the
self-triggered reasons (`no-files`, `no-posts`, `no-versions`) are
restorable and the mod-triggered ones (`violation`, anything with a
`customMessage`) are not.

### 4. Data cleanup: orphan stash rows

For posts in the `publishedAt > NOW() AND prevPublishedAt IS NOT NULL` band
(small handful — count fresh against prod before deploy):

The migration script `src/pages/api/admin/temp/clamp-publishedat-bumps.ts`
was already updated to **skip** these rows in Op 3 (so we don't accidentally
publish them by clamping). That's the correct call for the migration's
single-shot pass.

Drop the dangling stash with a one-line SQL hand-fix after PR-1 deploys:

```sql
UPDATE "Post"
SET metadata = metadata - 'prevPublishedAt'
                       - 'unpublishedAt'
                       - 'unpublishedBy'
WHERE id = <orphan_post_id>;
```

After this strip, the post keeps its (user-chosen) future date but is no
longer carrying a misleading prevPublishedAt. Once the backend fix (§1) is
live, no new orphans can be created — so this is a one-shot.

Reason for hand-fix over a script Op: cost/value. The Op + matching
rollback + STASH namespace + payload field = ~80 lines for a single-digit
row count. A direct SQL hand-fix is the smaller, lower-risk move.

### 5. Tests

- `src/server/services/post.service.test.ts` (or create) — cover:
  - Fresh draft → set future date → date persists.
  - Was-unpublished post (stash present) → updatePost with any new date →
    `publishedAt` restored to `prevPublishedAt`, stash stripped.
  - Already-public post → updatePost with new date → guard blocks, no-op.
  - Scheduled future post (no stash) → reschedule allowed.
- E2E (Playwright, `tests/`): publish post → unpublish parent model → reopen
  post editor → confirm Schedule button is hidden, Publish restores the
  original date.

### 6. Telemetry

Add a single `logToAxiom` call inside the new `updatePost` CASE branch when
the guard rewrites the submitted date (i.e. `prevPublishedAt` was present and
overrode the user's pick). One line per fire, tagged
`name: 'post-publish-bump-blocked'`, with `{ postId, userId, submittedAt,
restoredAt }`. We want to see whether this is one user repeatedly trying or
spread across many — informs whether we need a UI-side warning before they
click Publish.

## Risk / rollback

- §1 backend fix is the only path-affecting change. Rollback = revert the
  raw SQL block. The schema isn't changing.
- §2 selector widening is additive. Rollback = drop the new field.
- §3 frontend changes gate on the new field. If the backend rollback ships
  without the frontend, the field is just missing — UI falls back to
  current behavior. No breakage.
- §4 orphan cleanup is stash-reversible via the existing rollback action on
  the clamp endpoint.

## Open questions

~~@dev:* should the frontend distinguish "you were unpublished by a mod"
(`metadata.unpublishedReason` present) from "you unpublished yourself"? The
restore-only flow probably should not apply when a mod unpublished for
violations — that's a moderation action, not a user-driven schedule change.~~
**Addressed in §3a — mod-unpublished posts get the info alert but no
Restore button, pending enum confirmation.**

@dev:* what about the create-post flow vs. edit-post flow? If a user has a
deleted-then-recreated post on the same MV, do we expect any stash carry-over?
I don't think so (new Post row, new metadata) but worth a sanity check.

@dev:* do we want a one-shot moderator override? If a mod legitimately wants
to reschedule a previously-published post, the current proposal makes that
impossible without DB surgery. Could add a `force?: boolean` on the input
gated on `user.isModerator`.

## Sequencing

1. Land §1 (backend `updatePost` fix, L1) — closes the primary loophole.
2. Land §4 (one-shot orphan strip via the clamp endpoint) at the same
   deploy or shortly after.
3. Land L2a + L2b fixes in `publishPrivateModel` — same deploy as §1 if
   possible. Lower blast radius (privileged action) but the same invariant.
4. Land L3 hardening in `updatePost` peel-off — small follow-up.
5. Land §2 + §3 (selector widening + UI lock) together — UX cleanup, not
   urgent.
6. Land §5 + §6 (tests + telemetry) alongside or right after §1.

§1 + L2 together close every Post.publishedAt write path. §3 is the visible
UX improvement so users don't try-and-fail to reschedule.

## Decisions (locked)

- **Single PR**, not three. Whole fix lands together.
- **No manual post unpublish from UI.** Posts only get unpublished via parent
  model/version unpublish. → Drop L3 (zod stays strict, no unpublish branch
  in `updatePost`).
- **Read-through selector for reason**, not mirror onto Post.metadata. JOIN
  through MV (fallback Model) to read `meta.unpublishedReason` +
  `customMessage`. → Drop the backfill endpoint, drop the 3-writer mirror
  changes, drop the 4-republish strip extensions.
- **No `'made-private'` reason / no L2a stash.** No user-facing Public→Private
  path exists; mod-only `updateAvailability` doesn't touch `publishedAt`.
  `publishPrivateModel(publishVersions:false)` keeps current behavior
  (Prisma null-write, no stash). L2a out of scope.
- **L2b in scope.** `publishPrivateModel(publishVersions:true)` swap to
  CASE pattern — keeps the invariant if a stash already exists from a prior
  unpublish.

Final write-site changes for the PR:

| Loophole | File | Change |
|---|---|---|
| L1 | `post.service.ts:816` | Raw SQL → CASE on `prevPublishedAt`, strip 3 keys (`unpublishedAt`, `unpublishedBy`, `prevPublishedAt`) on republish |
| L2b | `model.service.ts:3747` | Raw `SET publishedAt = ${now}` → CASE + same strip |
| Orphan | `clamp-publishedat-bumps.ts` | Op 5 strip + rollback symmetry |
| Selector | post edit selector | Add `wasPublished`, `unpublishedAt`, `unpublishedBy`, `unpublishedReason`, `customMessage` (last two via JOIN) |
| UI | `PostEditSidebar.tsx` | Restore-only state when `wasPublished` |

## Implementation plan

Three PRs, sequenced so the security-relevant work lands first and the UX
work can be reviewed independently. All branched off `main`, no cross-PR
rebasing.

### PR-1 — Close every backend Post.publishedAt write site (L1 + L2 + L3 + orphan strip)

Branch: `fix/post-publish-bump-prevention`

Scope: backend only. No selector/UI changes. No metadata mirroring yet. Goal
is to make every write site enforce the invariant and clean the one orphan
row. Independently shippable.

#### File 1: `src/server/services/post.service.ts`

- `updatePost` (line 785): expand peel-off to also catch explicit `null`
  (L3 hardening). New signature for the local `publishedAt` variable: a
  small tagged value indicating publish / unpublish / leave-alone, so the
  raw SQL block knows which branch to run.

  Sketch:

  ```ts
  type PublishedAtOp =
    | { kind: 'publish'; date: Date }
    | { kind: 'unpublish' }
    | { kind: 'noop' };

  const publishedAtOp: PublishedAtOp =
    data.publishedAt instanceof Date
      ? { kind: 'publish', date: data.publishedAt }
      : data.publishedAt === null
        ? { kind: 'unpublish' }
        : { kind: 'noop' };

  const restData =
    publishedAtOp.kind === 'noop' ? data : { ...data, publishedAt: undefined };
  ```

- Line 816 raw SQL: replace with a `switch` on `publishedAtOp.kind`:

  ```ts
  let writeCount = 0;
  if (publishedAtOp.kind === 'publish') {
    writeCount = await tx.$executeRaw`
      UPDATE "Post"
      SET
        "publishedAt" = CASE
          WHEN "metadata"->>'prevPublishedAt' IS NOT NULL
          THEN ("metadata"->>'prevPublishedAt')::timestamptz
          ELSE ${publishedAtOp.date}
        END,
        "metadata" = COALESCE("metadata", '{}'::jsonb)
                     - 'unpublishedAt' - 'unpublishedBy' - 'prevPublishedAt'
                     - 'unpublishedReason' - 'customMessage'
      WHERE id = ${id}
        AND ("publishedAt" IS NULL OR "publishedAt" > NOW())
    `;
    if (writeCount > 0) {
      // Read back — CASE may have written prevPublishedAt instead of submitted date
      const row = await tx.post.findUnique({
        where: { id },
        select: { publishedAt: true },
      });
      if (row) updated.publishedAt = row.publishedAt;
    }
  } else if (publishedAtOp.kind === 'unpublish') {
    writeCount = await tx.$executeRaw`
      UPDATE "Post"
      SET
        "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object(
          'unpublishedAt', ${new Date().toISOString()},
          'unpublishedBy', ${user.id},
          'prevPublishedAt', "publishedAt"
        ),
        "publishedAt" = NULL
      WHERE id = ${id}
        AND "publishedAt" IS NOT NULL
    `;
    if (writeCount > 0) updated.publishedAt = null;
  }
  ```

- zod: relax `publishedAt: z.date().optional()` → `z.date().nullable().optional()`
  in `src/server/schema/post.schema.ts:59,68` so the unpublish path is
  reachable through tRPC. **Confirm with mod team** whether direct
  user-driven unpublish-from-edit is desired — if not, drop the L3 unpublish
  branch and keep the schema strict (still gain L3 defense-in-depth: any
  internal caller bypassing zod is no longer a free bump).

#### File 2: `src/server/services/model.service.ts`

- `publishPrivateModel` (line 3709), `publishVersions: true` branch (line
  3746-3753): swap the raw `SET publishedAt = ${now}` for the CASE pattern
  used in R1/R2:

  ```ts
  await tx.$executeRaw`
    UPDATE "Post"
    SET
      "publishedAt" = CASE
        WHEN "metadata"->>'prevPublishedAt' IS NOT NULL
        THEN ("metadata"->>'prevPublishedAt')::timestamptz
        ELSE ${now}
      END,
      "metadata" = COALESCE("metadata", '{}'::jsonb)
                   - 'unpublishedAt' - 'unpublishedBy' - 'prevPublishedAt'
                   - 'unpublishedReason' - 'customMessage'
    WHERE "modelVersionId" IN (${Prisma.join(versionIds, ',')})
      AND ("publishedAt" IS NULL OR "publishedAt" > NOW())
  `;
  ```

- Same function, `publishVersions: false` branch (line 3737-3744): the
  Prisma `updateMany` that writes `publishedAt: null` must stash first.
  Replace with a single raw block that mirrors the unpublish writers:

  ```ts
  const unpublishedAt = new Date().toISOString();
  await tx.$executeRaw`
    UPDATE "Post"
    SET
      "availability" = ${Availability.Public}::"Availability",
      "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object(
        'unpublishedAt', ${unpublishedAt},
        'unpublishedBy', ${user.id /* TODO confirm caller passes user */},
        'prevPublishedAt', "publishedAt",
        'unpublishedReason', 'made-private'
      ),
      "publishedAt" = NULL
    WHERE "modelVersionId" IN (${Prisma.join(versionIds, ',')})
      AND "publishedAt" IS NOT NULL
  `;
  // Also bump availability for posts that weren't previously published
  await tx.post.updateMany({
    where: { modelVersionId: { in: versionIds }, publishedAt: null },
    data: { availability: Availability.Public },
  });
  ```

  `publishPrivateModel` doesn't currently take a `user` parameter — confirm
  the caller chain (router → handler → service) and thread `user.id` through,
  or fall back to the model's `userId` if the action is self-service.

- New enum value: extend the unpublish reason union (search for
  `ModelMeta['unpublishedReason']` typing — likely in `src/server/schema/`)
  to include `'made-private'`. Used only on Post.metadata, not Model/MV.

#### File 3: `src/pages/api/admin/temp/clamp-publishedat-bumps.ts`

- Op 3 snapshot already gated on `publishedAt <= NOW()` from the earlier
  fix this session — scheduled-future posts are skipped by the migration.
- Orphan rows (the small set in the `publishedAt > NOW() AND
  prevPublishedAt IS NOT NULL` band) are intentionally **not** handled by
  this script — see §4 for the hand-fix SQL and rationale.

#### Test plan (PR-1)

- Unit (Vitest, new file `src/server/services/post.service.test.ts`):
  - Fresh draft → publish with date → date persists, no stash, no metadata change.
  - Was-unpublished (stash present, publishedAt NULL) → updatePost with any future date → publishedAt restored to prevPublishedAt, all 5 stash keys stripped.
  - Already public (publishedAt ≤ NOW) → updatePost with new date → write blocked, returned post unchanged.
  - Scheduled future (publishedAt > NOW, no stash) → reschedule allowed, new date persists.
  - `data.publishedAt === null` → publishedAt set to NULL, stash written (when previously published).
- Unit (`publishPrivateModel`):
  - Private → Public with `publishVersions: true` and post has stash → restored to prevPublishedAt, stash stripped.
  - Private → Public with `publishVersions: false` → publishedAt nulled, stash written with `reason: 'made-private'`.
  - Cycle Public → Private → Public twice → second Public restores original date, no bump.
- Migration script: dry-run + apply against a copy of preview DB. Verify
  Op 3 still skips scheduled-future posts (the `publishedAt <= NOW()`
  filter). Verify rollback restores the stashed columns.

#### Deploy steps (PR-1)

1. Merge PR.
2. Run migration in preview: `?action=apply&dryRun=true` → verify counts.
3. Apply in preview: `?action=apply&dryRun=false`.
4. Run the §4 hand-fix SQL against each orphan post ID. Verify the
   stash keys are gone and `publishedAt` is unchanged.
5. Smoke-test L1: in preview, unpublish a test model, open attached post,
   try to schedule new date → confirm date restored to original, not the
   submitted one.
6. Repeat steps 2-4 in production.
7. Smoke-test L1 in production with a throwaway model.

### PR-2 — Selector + UX (L1 follow-up, §2/§3/§3a)

Branch: `feat/post-edit-restore-only-ux`

Scope: schema mirror + selector widening + UI lock + reason surface. Depends
on PR-1 being merged (so the metadata invariants hold).

#### Step 1: Backfill `unpublishedReason` + `customMessage` onto existing Post rows

One-shot SQL bolted onto a new debug endpoint
`src/pages/api/admin/temp/backfill-post-unpublish-reason.ts` (pattern from
`temp/republish-orphaned-drafts.ts`). For every Post with
`metadata.unpublishedAt` set but `metadata.unpublishedReason` absent, read
the reason+customMessage from the parent MV.meta (fall back to Model.meta)
and write onto Post.metadata.

```sql
WITH src AS (
  SELECT
    p.id AS post_id,
    COALESCE(mv.meta->>'unpublishedReason', m.meta->>'unpublishedReason') AS reason,
    COALESCE(mv.meta->>'customMessage', m.meta->>'customMessage') AS msg
  FROM "Post" p
  JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
  JOIN "Model" m ON m.id = mv."modelId"
  WHERE p.metadata->>'unpublishedAt' IS NOT NULL
    AND p.metadata->>'unpublishedReason' IS NULL
)
UPDATE "Post" p
SET metadata = COALESCE(p.metadata, '{}'::jsonb) || jsonb_strip_nulls(
  jsonb_build_object('unpublishedReason', src.reason, 'customMessage', src.msg)
)
FROM src
WHERE p.id = src.post_id;
```

`jsonb_strip_nulls` ensures we don't write `"unpublishedReason": null` when
the parent doesn't have one (e.g. self-unpublish).

@dev:* if a post has multiple parent unpublish events (model-level then
version-level), the COALESCE order matters. Picking MV-level first because
that's the more granular action. Reasonable?

#### Step 2: Extend unpublish writers to mirror reason+customMessage

- `src/server/services/model-version.service.ts:1122` (mv unpublish post fanout):
  add `'unpublishedReason'` and `'customMessage'` to the `jsonb_build_object`,
  drawn from the same `meta`/`reason`/`customMessage` already on the function input.
- `src/server/services/model.service.ts:2288` (model unpublish post fanout): same.
- `src/server/services/user.service.ts:1442` (OD/violation): hard-code
  `'unpublishedReason'` value matching the OD reason enum.
- `src/server/services/post.service.ts:816` (updatePost) + the new
  unpublish branch from PR-1's L3: strip the new keys on republish; on
  L3 unpublish, optionally write a `'unpublishedReason': 'self'`.
- `src/server/jobs/process-scheduled-publishing.ts:188`: extend strip list.
- `src/pages/api/admin/temp/republish-orphaned-drafts.ts:145`: same.

#### Step 3: Widen the post-edit selector

`src/server/services/post.service.ts` — find `getPostEditDetail` or
equivalent, add to the select. New fields on the tRPC return shape:

```ts
type PostEditDetailExtras = {
  wasPublished: boolean;          // metadata.prevPublishedAt IS NOT NULL
  unpublishedAt: Date | null;     // metadata.unpublishedAt
  unpublishedBy: number | null;   // metadata.unpublishedBy
  unpublishedReason: string | null;
  customMessage: string | null;
};
```

Computed server-side from `metadata`. Do not leak the raw `metadata` blob.
Update `src/server/schema/post.schema.ts` output schema to match.

#### Step 4: Frontend UI

- `src/components/Post/EditV2/PostEditSidebar.tsx`:
  - At top of component: derive `wasPublished`, `byMod`, `isViolationLock`
    from new fields.
  - Replace the `!post.publishedAt` branch (line 242-253) with conditional
    rendering:
    - `wasPublished && isViolationLock` → mod-lock info alert, no buttons.
    - `wasPublished && !isViolationLock` → restore info alert, "Restore"
      button (single button, no Schedule split).
    - `!wasPublished` → existing hidden/draft UI.
  - `handleScheduleClick` (line 185) → noop when `wasPublished`; ideally
    not reachable since Schedule button is hidden.
- `src/components/Post/EditV2/SchedulePostModal.tsx`: if reached when
  `wasPublished`, render a disabled state with the explainer text.
- New small util for reason-enum → human-readable string in a colocated
  file (`src/components/Post/EditV2/unpublishReason.ts`).

#### Test plan (PR-2)

- Backfill: SQL `EXPLAIN ANALYZE` on a preview-DB copy, verify row count
  matches expected (count posts with `unpublishedAt` and no
  `unpublishedReason`).
- E2E (Playwright): publish post → unpublish parent model with a reason →
  reopen post edit → assert info alert shows reason, Schedule button
  absent, Restore button restores the original date.
- E2E (mod path): mod unpublishes with violation reason → owner opens post
  → assert no Restore button visible.

#### Deploy steps (PR-2)

1. Merge PR.
2. Run backfill in preview: `?token=...&dryRun=true` → verify count.
3. Apply in preview: `?token=...&dryRun=false`.
4. UI smoke test in preview.
5. Repeat 2-4 in production.
6. Remove the temp endpoint after a week (separate cleanup commit).

### PR-3 — Telemetry (§6)

Branch: `obs/post-publish-bump-blocked`

Scope: single Axiom log line in `updatePost` when the CASE rewrote the
submitted date (i.e. user tried to bump but was prevented). One-line
change, low review burden, optional but useful for detecting attempted abuse.

Defer until PR-1 has been in production at least one week — gives a clean
baseline for whether this fires at all.

## Migration / DB notes

- All write changes are JSONB-only. No schema migrations, no `prisma/migrations/` files.
- Two manual SQL applies:
  - PR-1 deploy step 3 (clamp-publishedat-bumps Op 5 — runs as part of the
    existing migration endpoint).
  - PR-2 deploy step 3 (backfill-post-unpublish-reason endpoint).
- Both endpoints are reversible via the existing `?action=rollback` /
  `?token=...` patterns. Document the rollback action in the ticket.

## ClickUp ticket structure (proposed)

- **Parent ticket**: "Prevent post.publishedAt bump via unpublish/republish loophole"
  - Sub-task 1: PR-1 backend fixes + Op5 orphan strip
  - Sub-task 2: PR-2 selector + UX + reason backfill
  - Sub-task 3: PR-3 telemetry follow-up
  - Attach this doc as the spec.

@dev:* anything in here you want split differently before I file the ticket?

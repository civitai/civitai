import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, uniqueToken } from './preview-trpc';

/**
 * Mutation smoke: a normal (free) user self-seeds a Post and reports it, fully
 * API-driven via tRPC so the flow is isolated per run by a unique token (no
 * collision on the shared dev DB across concurrent previews, no flaky UI modal).
 *
 * Runs as `tester` (free member that PASSES the preview gate). Both mutations are
 * guardedProcedures; the ci-smoke `tester` fixture is seeded with onboarding=15 so
 * it clears `guardedProcedure`.
 *
 * Verified input shapes (against the worktree's schema files):
 *  - post.create (src/server/routers/post.router.ts:105 .input(postCreateSchema);
 *    src/server/schema/post.schema.ts:53 postCreateSchema) — guarded mutation, all
 *    fields optional: { title: z.string().trim().nullish(), detail: z.string().nullish() }.
 *    Returns the new post; createPostHandler (post.controller.ts:124) returns the
 *    post object, so `.id` is a number.
 *  - report.create (src/server/routers/report.router.ts:27 .input(createReportInputSchema);
 *    src/server/schema/report.schema.ts:104 createReportInputSchema) — guarded mutation,
 *    a discriminatedUnion('reason') over baseSchema { type: z.enum(ReportEntity);
 *    id: z.number(); details } extended per reason.
 *      * ReportEntity for a Post = 'post' (lowercase) — src/shared/utils/report-helpers.ts:8.
 *      * reason TOSViolation = 'TOSViolation' — src/shared/utils/prisma/enums.ts:333.
 *      * reportTOSViolationSchema (report.schema.ts:68) sets
 *        details: reportTosViolationDetailsSchema, which REQUIRES `violation: z.string()`
 *        (report.schema.ts:24). So `details: {}` would FAIL zod for a TOS report — we
 *        pass `details: { violation: <token> }`. (`comment` is optional.)
 *    createReportHandler (report.controller.ts:60) returns `result` (truthy on success).
 */

test.describe('tester self-seeds a post and reports it (mutation flow)', () => {
  test.use({ storageState: storageStatePath('tester') });

  test('post.create then report.create round-trips', async ({ page }) => {
    // Warm the request context against the preview origin so page.request shares
    // the auth cookie + a real navigated origin (the helper stamps Origin/Referer,
    // but navigating once is the safe baseline).
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const token = uniqueToken('report');

    // 1. Self-seed a Post carrying the unique token in its free-text fields.
    const post = await trpcMutation<{ id: number } | null>(page.request, 'post.create', {
      title: token,
      detail: token,
    });
    expect(typeof post?.id, 'post.create should return a numeric post id').toBe('number');

    // 2. Report that exact post for a TOS violation.
    // NOTE: ReportEntity.Post is the lowercase string 'post' (report-helpers.ts:8),
    // NOT 'Post'. reason 'TOSViolation' requires details.violation (a string), so we
    // supply the token there — `details: {}` alone would fail zod for this reason.
    const report = await trpcMutation(page.request, 'report.create', {
      type: 'post',
      id: post!.id,
      reason: 'TOSViolation',
      details: { violation: token },
    });

    // createReportHandler returns the created report row (truthy) on success; the
    // tRPC helper already throws on any tRPC-level error, so reaching here means the
    // report was accepted.
    expect(report, 'report.create should resolve to a truthy result').toBeTruthy();
  });

  // A UI report-affordance check was dropped: the report action lives behind an
  // entity action menu (not a top-level button), so a DOM-presence assertion on
  // /images is fragile. The API-driven flow above already proves report.create.
});

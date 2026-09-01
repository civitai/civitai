import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, uniqueToken } from './preview-trpc';

/**
 * Mutation smoke: the core ENGAGEMENT write path — reactions + comments — which is
 * by far the highest-frequency user mutation on the platform and is otherwise
 * untested by the preview suite. A PR that broke `reaction.toggle` or
 * `commentv2.upsert` passes every other preview spec today; this closes that gap.
 *
 * Fully API-driven via tRPC so the flow is isolated per run by a unique token (no
 * collision on the shared dev DB across concurrent previews, no flaky UI menu) —
 * same self-seed-then-act pattern as preview-report.spec.ts.
 *
 * Runs as `tester` (free member that PASSES the preview gate). post.create,
 * reaction.toggle and commentv2.upsert are all guardedProcedures; the ci-smoke
 * `tester` fixture is seeded with onboarding=15 so it clears guardedProcedure.
 *
 * Verified input/return shapes (against origin/main schema + controller files):
 *  - post.create (post.router.ts .input(postCreateSchema)) — returns the new post,
 *    `.id` is a number (see preview-report.spec.ts).
 *  - reaction.toggle (reaction.router.ts:9 guardedProcedure .input(toggleReactionSchema))
 *    — toggleReactionSchema (reaction.schema.ts:37): { entityId: number;
 *    entityType: enum(reactableEntities incl. 'post'); reaction: enum(ReviewReactions) }.
 *    ReviewReactions.Like = 'Like' (enums.ts:355). The mutation is AWAITED and
 *    RESOLVES TO THE HANDLER RESULT: `.mutation(toggleReactionHandler)`
 *    (reaction.router.ts:15) returns toggleReaction()'s discriminator, one of
 *    'created' | 'removed' | 'noop' (reaction.service.ts:25,30 → controller :286).
 *    This post is self-seeded in this same test and `tester` has never reacted to
 *    it, so getReaction finds nothing and the create branch runs — the value is
 *    deterministically 'created', which is what we pin.
 *
 *    🔴 It used to resolve to null, and this spec used to assert that. `ee376ea7d8`
 *    (2026-03) made the router fire-and-forget for latency; #4516 / `1e810875c8`
 *    reverted that because detaching the write from the request lifecycle dropped
 *    reactions on pod drain. `src/server/routers/__tests__/reaction.router.awaited.test.ts`
 *    is the unit-level contract test for the restored shape — keep the two in step.
 *  - commentv2.upsert (commentv2.router.ts:62 guardedProcedure .input(upsertCommentv2Schema))
 *    — upsertCommentv2Schema (commentv2.schema.ts) extends commentConnectorSchema
 *    ({ entityId: number; entityType: enum incl. 'post' }) with a non-empty sanitized
 *    `content` (allowed tags incl. 'p'). The isOwnerOrModerator middleware skips its
 *    ownership check when `id` is absent (`!!id` is false for a new comment), so a
 *    fresh comment is allowed. upsertCommentV2Handler returns the created comment via
 *    commentV2Select → `.id` (number) + `.content` (sanitized HTML carrying the token).
 *  - commentv2.delete (commentv2.router.ts:68 protectedProcedure .input(getByIdSchema))
 *    — { id: number }; owner may delete (isOwnerOrModerator). Used for cleanup.
 */

test.describe('tester self-seeds a post, reacts to it, and comments on it (mutation flow)', () => {
  test.use({ storageState: storageStatePath('tester') });

  test('reaction.toggle and commentv2.upsert round-trip on a self-seeded post', async ({
    page,
  }) => {
    // Warm the request context against the preview origin so page.request shares the
    // auth cookie + a real navigated origin (the helper stamps Origin/Referer, but
    // navigating once is the safe baseline — mirrors preview-report.spec.ts).
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const token = uniqueToken('engagement');

    // 1. Self-seed a Post carrying the unique token, to react to and comment on.
    const post = await trpcMutation<{ id: number } | null>(page.request, 'post.create', {
      title: token,
      detail: token,
    });
    expect(typeof post?.id, 'post.create should return a numeric post id').toBe('number');

    // 2. React to that exact post. reaction.toggle is awaited and resolves to the
    // handler's result, so this asserts the WRITE happened, not merely that the call
    // was accepted: a first Like on a post nobody has reacted to takes the create
    // branch and resolves to 'created'. A broken auth/rate-limit/dispatch path would
    // surface as an HTTP/tRPC error before we get here.
    const reaction = await trpcMutation<'created' | 'removed' | 'noop'>(
      page.request,
      'reaction.toggle',
      { entityId: post!.id, entityType: 'post', reaction: 'Like' }
    );
    // Pinned to the exact discriminator rather than a truthiness check: 'noop' and
    // 'removed' are also non-null, and both would mean the reaction did NOT get
    // created — the regression this spec exists to catch.
    expect(reaction, 'reaction.toggle should create the reaction and say so').toBe('created');

    // 3. Comment on that exact post. upsert returns the created comment row, so we
    // assert it came back with a numeric id and that our token survived sanitization
    // into its content (proves the write actually persisted, not just 200-OK'd).
    const comment = await trpcMutation<{ id: number; content: string } | null>(
      page.request,
      'commentv2.upsert',
      {
        entityType: 'post',
        entityId: post!.id,
        content: `<p>${token}</p>`,
      }
    );
    expect(typeof comment?.id, 'commentv2.upsert should return a numeric comment id').toBe(
      'number'
    );
    expect(comment?.content, 'the seeded token should survive into the stored comment').toContain(
      token
    );

    // 4. Clean up our own comment so repeated preview runs don't accrete rows on the
    // shared dev clone. Best-effort: a delete failure must not fail the engagement
    // assertions above, which are the point of this spec.
    try {
      await trpcMutation(page.request, 'commentv2.delete', { id: comment!.id });
    } catch {
      // The reaction + comment writes already passed; leftover-row cleanup is
      // non-critical and intentionally swallowed.
    }
  });
});

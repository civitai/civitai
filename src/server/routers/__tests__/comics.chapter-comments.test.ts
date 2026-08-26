import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Comic chapter comments are `CommentV2` rows created inline in the router rather than through
 * `upsertComment`, so they inherit none of the comment guards by construction — the thread key is
 * (project, chapter position) rather than a single entity id, which is why they were written here.
 *
 * These assert the SOURCE TEXT, which is weak: it pins that the call sites exist, not that they work,
 * and reformatting the lines breaks it. The precedent is `comment.dedupe-key.test.ts`, which does the
 * same for the same reason — the procedure cannot be mounted in a unit test without a large mock, and
 * a text assertion is the difference between a named failure and none at all.
 */
const router = () => readFileSync('src/server/routers/comics.router.ts', 'utf8');

describe('comic chapter comments', () => {
  it('filters ToS-flagged comments out of the chapter thread for non-moderators', () => {
    // The only v2 read outside commentsv2.service.ts, and it filtered `hidden` alone.
    expect(router()).toContain(`{ hidden: false, tosViolation: false }`);
  });

  it('runs the content guard every other comment surface has, before the thread upsert', () => {
    expect(router()).toContain(
      'await throwOnBlockedCommentContent(input.content, { isModerator: ctx.user.isModerator })'
    );
  });

  it('is guarded and rate limited, so a muted account cannot comment here', () => {
    // The client hides the box for a muted user, which is presentation, not a gate.
    expect(router()).toContain('createChapterComment: comicGuardedProcedure');
    expect(router()).toContain('.use(rateLimit(commentRateLimits))');
  });
});

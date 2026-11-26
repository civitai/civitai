import { describe, expect, it, vi } from 'vitest';

/**
 * The account page's Comments rows read the `COMMENT_V3_RATE_LIMIT_KEY` bucket
 * (usage-limits.service.test.ts). Every procedure enforcing the comment limits must count into
 * that bucket, or a 429 fires while the rows show the allowance untouched.
 */

const h = vi.hoisted(() => ({ calls: [] as Array<{ limits: unknown; options: unknown }> }));

vi.mock('~/server/middleware.trpc', async (importOriginal) => {
  const { middleware } = await import('~/server/trpc');
  return {
    ...(await importOriginal<object>()),
    rateLimit: (limits: unknown, _condition: unknown, options: unknown) => {
      h.calls.push({ limits, options });
      return middleware(({ next }) => next());
    },
  };
});

import '../commentv3.router';
import { COMMENT_V3_RATE_LIMIT_KEY, commentRateLimits } from '~/server/schema/commentv3.schema';

describe('comment limits share one bucket', () => {
  it('commentv3 create and update count into the bucket the Comments rows read', () => {
    const commentLimited = h.calls.filter((c) => c.limits === commentRateLimits);
    expect(commentLimited).toHaveLength(2);
    for (const call of commentLimited)
      expect(call.options).toEqual({ sharedKey: COMMENT_V3_RATE_LIMIT_KEY });
  });
});

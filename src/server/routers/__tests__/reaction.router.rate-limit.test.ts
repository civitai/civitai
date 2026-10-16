import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReactionControllerMod from '~/server/controllers/reaction.controller';

/**
 * The site's `reaction.toggle` is the OTHER half of the shared reaction quota: it must keep
 * handing the limiter `reactionRateLimits` with NO `sharedKey`, so its redis key stays the
 * path-derived `reaction:toggle` that `blocks.setReactionFromApp` shares by name. If this
 * procedure ever gains a `sharedKey` of its own, the app wrapper silently gets a separate
 * quota — this test is what notices. The key derivation itself is pinned against the real
 * middleware in `src/server/__tests__/block-reaction.rate-limit-key.test.ts`.
 */

const h = vi.hoisted(() => ({
  toggle: vi.fn(),
  runs: [] as Array<{ path: string; limits: unknown; options: unknown }>,
}));

vi.mock('~/server/controllers/reaction.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactionControllerMod>()),
  toggleReactionHandler: (...a: unknown[]) => h.toggle(...a),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return {
    rateLimit: (limits: unknown, _condition: unknown, options: unknown) =>
      middleware(({ path, next }) => {
        h.runs.push({ path, limits, options });
        return next();
      }),
  };
});

import { reactionRouter } from '../reaction.router';
import { reactionRateLimits } from '~/server/schema/reaction.schema';
import { TokenScope } from '~/shared/constants/token-scope.constants';

beforeEach(() => {
  vi.clearAllMocks();
  h.runs.length = 0;
  h.toggle.mockResolvedValue('created');
});

describe('reaction.toggle — the site half of the shared reaction quota', () => {
  it('charges reactionRateLimits under its PATH-derived key (no sharedKey)', async () => {
    const caller = reactionRouter.createCaller({
      acceptableOrigin: true,
      user: { id: 42, isModerator: false, onboarding: 0xffff, muted: false },
      apiKeyId: null,
      tokenScope: TokenScope.Full,
      req: { headers: {} },
      res: { setHeader: () => undefined },
      cache: { edgeTTL: 0 },
      features: {},
    } as never);
    await caller.toggle({ entityType: 'image', entityId: 1, reaction: 'Heart' });
    expect(h.toggle).toHaveBeenCalledTimes(1);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].limits).toBe(reactionRateLimits);
    expect(h.runs[0].options).toBeUndefined();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReactionControllerMod from '~/server/controllers/reaction.controller';

const h = vi.hoisted(() => ({
  toggle: vi.fn(),
  runs: [] as Array<{ path: string; limits: unknown; options: unknown }>,
}));

vi.mock('~/server/controllers/reaction.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactionControllerMod>()),
  toggleReactionHandler: (...a: unknown[]) => h.toggle(...a),
}));
vi.mock('~/server/middleware.trpc', async (importOriginal) => {
  const { middleware } = await import('~/server/trpc');
  return {
    ...(await importOriginal<object>()),
    rateLimit: (limits: unknown, _condition: unknown, options: unknown) =>
      middleware(({ path, next }) => {
        h.runs.push({ path, limits, options });
        return next();
      }),
  };
});

import { appRouter } from '../index';
import { reactionRateLimits } from '~/server/schema/reaction.schema';
import { SITE_REACTION_RATE_LIMIT_KEY } from '~/shared/constants/block-reaction.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

beforeEach(() => {
  vi.clearAllMocks();
  h.runs.length = 0;
  h.toggle.mockResolvedValue('created');
});

describe('comment.toggleReaction — comment v1 reactions', () => {
  const caller = () =>
    appRouter.createCaller({
      acceptableOrigin: true,
      user: { id: 42, isModerator: false, onboarding: 0xffff, muted: false },
      apiKeyId: null,
      tokenScope: TokenScope.Full,
      req: { headers: {} },
      res: { setHeader: () => undefined },
      cache: { edgeTTL: 0 },
      features: {},
    } as never);

  it('draws on the site reaction quota, like reaction.toggle', async () => {
    await caller().comment.toggleReaction({ id: 3, reaction: 'Like' });

    const run = h.runs.find((r) => r.path === 'comment.toggleReaction');
    expect(run?.limits).toBe(reactionRateLimits);
    expect(run?.options).toEqual({ sharedKey: SITE_REACTION_RATE_LIMIT_KEY });
  });

  it('goes through the shared handler as commentOld, so the toggle guard covers it', async () => {
    await caller().comment.toggleReaction({ id: 3, reaction: 'Like' });

    expect(h.toggle).toHaveBeenCalledTimes(1);
    expect(h.toggle.mock.calls[0][0]).toMatchObject({
      input: { entityType: 'commentOld', entityId: 3, reaction: 'Like' },
    });
  });
});

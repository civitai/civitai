import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as ReactionController from '~/server/controllers/reaction.controller';

/**
 * `reaction.toggle` must AWAIT and RETURN the handler. A prior "fire-and-forget" wiring
 * (call the handler, return void) detached the toggle write from the request — the mutation
 * resolved to `undefined` (a null payload over superjson) and the write could be dropped on
 * pod drain, so a reaction did not survive a refresh. See civitai#868kyuk3w.
 */

const { toggleReactionHandler } = vi.hoisted(() => ({
  toggleReactionHandler: vi.fn(async () => 'created' as const),
}));

vi.mock('~/server/controllers/reaction.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactionController>()),
  toggleReactionHandler,
}));

import { reactionRouter } from '../reaction.router';

const user = {
  id: 5,
  isModerator: false,
  tier: 'free',
  username: 'reactor',
  onboarding: 0x1f,
  muted: false,
};

function caller() {
  return reactionRouter.createCaller({
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  } as never);
}

const input = { entityType: 'image', entityId: 1, reaction: 'Like' } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reaction.toggle — awaited, not fire-and-forget', () => {
  it('returns the handler result rather than undefined', async () => {
    const result = await caller().toggle(input);

    // The regression returned `undefined` here (the reported null payload).
    expect(result).toBe('created');
    expect(toggleReactionHandler).toHaveBeenCalledTimes(1);
    const arg = toggleReactionHandler.mock.calls[0]?.[0] as { input?: typeof input };
    expect(arg?.input).toMatchObject({ entityType: 'image', entityId: 1, reaction: 'Like' });
  });

  it('propagates a handler rejection instead of swallowing it', async () => {
    toggleReactionHandler.mockRejectedValueOnce(new Error('write failed'));

    // Detaching the handler made a failed write invisible to the caller; awaiting surfaces it.
    await expect(caller().toggle(input)).rejects.toThrow('write failed');
  });
});

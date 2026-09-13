import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as UserService from '~/server/services/user.service';

/**
 * `user.removeAllContent` threads the ACTING MODERATOR into the wipe.
 *
 * 🔴 THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. Deleting
 * `actorUserId: ctx.user.id` from the router's call to `removeAllContent` left
 * the whole suite green: the service-level tests call `removeAllContent`
 * directly, so nothing exercised the one line where the actor is picked up. The
 * consequence of that mutant shipping is quiet and permanent — every
 * moderator-ordered wipe would write its App Storage purge audit row with
 * `actorUserId: null`, i.e. indistinguishable from the secret-authed webhook
 * caller, and the audit trail would lose the actor it exists to record.
 *
 * Driven through the REAL router with `createCaller`, so the assertion is about
 * what the service actually receives rather than about how the procedure is
 * written.
 */

const { mockRemoveAllContent } = vi.hoisted(() => ({
  mockRemoveAllContent: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  removeAllContent: mockRemoveAllContent,
}));

import { userRouter } from '~/server/routers/user.router';

const MOD_ID = 9;
const TARGET_ID = 42;

const caller = (user: unknown) =>
  userRouter.createCaller({
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { userActivity: vi.fn() },
  } as never);

const moderator = {
  id: MOD_ID,
  isModerator: true,
  tier: 'free',
  username: 'mod',
  muted: false,
  onboarding: 0xff,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRemoveAllContent.mockResolvedValue(undefined);
});

describe('user.removeAllContent — actor attribution', () => {
  it('passes the acting moderator id through to the wipe', async () => {
    await caller(moderator).removeAllContent({ id: TARGET_ID });

    expect(mockRemoveAllContent).toHaveBeenCalledTimes(1);
    const arg = mockRemoveAllContent.mock.calls[0][0] as {
      id: number;
      actorUserId?: number | null;
    };
    expect(arg.id).toBe(TARGET_ID);
    // The whole point: the ACTOR, not just the target. `ctx.user.id`, never
    // client input — the input schema carries only `id`.
    expect(arg.actorUserId).toBe(MOD_ID);
  });

  it('takes the actor from the SESSION, not from anything the caller can send', async () => {
    // A caller who tries to name a different actor must not be able to: the
    // procedure's input is `getByIdSchema` and the actor is read from ctx.
    await caller(moderator).removeAllContent({
      id: TARGET_ID,
      actorUserId: 1234,
    } as never);

    const arg = mockRemoveAllContent.mock.calls[0][0] as { actorUserId?: number | null };
    expect(arg.actorUserId).toBe(MOD_ID);
  });

  it('is not reachable by a non-moderator (FORBIDDEN), and wipes nothing', async () => {
    await expect(
      caller({ ...moderator, id: 1, isModerator: false }).removeAllContent({ id: TARGET_ID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockRemoveAllContent).not.toHaveBeenCalled();
  });
});

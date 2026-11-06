import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CrucibleService from '~/server/services/crucible.service';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Event tags decide what a shared, shared-cached homepage block shows, and they are not meant to
// be visible outside moderation. Swap either procedure to protectedProcedure and any signed-in user
// could read them, or put their own crucible on the homepage.

const { getFeatureFlagsMock, getTagsMock, setTagsMock } = vi.hoisted(() => ({
  getFeatureFlagsMock: vi.fn(),
  getTagsMock: vi.fn(async () => ['halloween']),
  setTagsMock: vi.fn(async () => ['halloween']),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: getFeatureFlagsMock,
}));

vi.mock('~/server/services/crucible.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleService>()),
  getCrucibleEventTags: getTagsMock,
  setCrucibleEventTags: setTagsMock,
}));

const { crucibleRouter } = await import('~/server/routers/crucible.router');

const caller = (user?: { id: number; isModerator: boolean }) =>
  crucibleRouter.createCaller({
    user,
    ip: '1.2.3.4',
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    features: { crucible: true },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  getFeatureFlagsMock.mockReturnValue({ crucible: true });
});

describe('crucible event tags are moderator-only', () => {
  it.each([
    ['signed out', undefined],
    ['a signed-in non-moderator', { id: 7, isModerator: false }],
  ])('refuses %s, for reading and for writing', async (_, user) => {
    await expect(caller(user).getEventTags({ id: 1 })).rejects.toMatchObject({
      code: expect.stringMatching(/^(UNAUTHORIZED|FORBIDDEN)$/),
    });
    await expect(
      caller(user).setEventTags({ id: 1, eventTags: ['halloween'] })
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(UNAUTHORIZED|FORBIDDEN)$/) });
    expect(getTagsMock).not.toHaveBeenCalled();
    expect(setTagsMock).not.toHaveBeenCalled();
  });

  // Positive control: the refusals above must come from the role, not from a broken harness.
  it('lets a moderator read and write them', async () => {
    const mod = caller({ id: 1, isModerator: true });

    await expect(mod.getEventTags({ id: 1 })).resolves.toEqual(['halloween']);
    await expect(mod.setEventTags({ id: 1, eventTags: ['Halloween'] })).resolves.toEqual([
      'halloween',
    ]);
    expect(setTagsMock).toHaveBeenCalledWith({ id: 1, eventTags: ['halloween'] });
  });
});

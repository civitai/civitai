import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';
import type * as AccountRestriction from '~/server/services/account-restriction.service';
import type * as ApiKeyService from '~/server/services/api-key.service';
import type * as DbLag from '~/server/db/db-lag-helpers';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `apiKey.add` and the moderator-only `ModeratorFeedbackRead` bit: a moderator can mint a key
 * carrying it, nobody else can, and the other opt-in bits stay unmintable on a personal key.
 */

const mocks = vi.hoisted(() => ({
  mintApiKey: vi.fn(),
  assertAccountNotRestricted: vi.fn(),
  preventReplicationLag: vi.fn(),
}));

vi.mock('~/server/services/api-key.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyService>()),
  mintApiKey: mocks.mintApiKey,
}));
vi.mock('~/server/services/account-restriction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountRestriction>()),
  assertAccountNotRestricted: mocks.assertAccountNotRestricted,
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLag>()),
  preventReplicationLag: mocks.preventReplicationLag,
}));

const { apiKeyRouter } = await import('~/server/routers/apiKey.router');

const FEED = 1 << 30; // ModeratorFeedbackRead
const FULL = 33554431;

const base = {
  onboarding: OnboardingSteps.Buzz,
  emailVerified: new Date('2026-01-01'),
  bannedAt: null,
  muted: false,
};
const moderator = { id: 6006, isModerator: true, ...base };
const developer = { id: 1001, isModerator: false, ...base };

const add = (user: typeof moderator, tokenScope: number) =>
  apiKeyRouter
    .createCaller({
      user,
      acceptableOrigin: true,
      apiKeyId: null,
      tokenScope: TokenScope.Full,
      features: {},
      track: { action: vi.fn(async () => undefined) },
      ip: '127.0.0.1',
      cache: {},
      req: undefined,
      res: undefined,
    } as never)
    .add({ name: 'feed reader', tokenScope });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mintApiKey.mockResolvedValue('minted-key');
  mocks.assertAccountNotRestricted.mockResolvedValue(undefined);
  mocks.preventReplicationLag.mockResolvedValue(undefined);
});

describe('apiKey.add with the moderator feed scope', () => {
  it('the literal matches the enum', () => {
    expect(TokenScope.ModeratorFeedbackRead).toBe(FEED);
    expect(TokenScope.Full).toBe(FULL);
  });

  it.each([
    ['alone', FEED],
    ['with UserRead', 1 | FEED],
  ])('mints it for a moderator (%s)', async (_label, scope) => {
    await expect(add(moderator, scope)).resolves.toBe('minted-key');
    expect(mocks.mintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ userId: moderator.id, tokenScope: scope }),
      expect.anything()
    );
  });

  it.each([
    ['alone', FEED],
    ['with UserRead', 1 | FEED],
  ])('refuses it for a non-moderator (%s), before minting', async (_label, scope) => {
    await expect(add(developer, scope)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only moderators can create a key with that scope.',
    });
    expect(mocks.mintApiKey).not.toHaveBeenCalled();
  });

  it('still mints an ordinary key for a non-moderator', async () => {
    await expect(add(developer, FULL)).resolves.toBe('minted-key');
  });

  it.each([
    ['AppBlocksSubmit', 1 << 25],
    ['WorkerRegister', 1 << 29],
  ])(
    'refuses the OAuth-only opt-in %s on a personal key, even for a moderator',
    async (_l, bit) => {
      await expect(add(moderator, 1 | bit)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mocks.mintApiKey).not.toHaveBeenCalled();
    }
  );
});

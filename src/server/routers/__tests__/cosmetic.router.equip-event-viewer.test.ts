import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CosmeticService from '~/server/services/cosmetic.service';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

/**
 * Placing an event decoration before launch is open to its flag audience, which every moderator is
 * in. As for the feeds' hat gates, a moderator counts only on a session or a full-access personal
 * key (eventViewerOf): on a scoped or OAuth token the placement gate sees a plain user.
 */
vi.mock('~/server/services/cosmetic.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticService>()),
  equipCosmeticToEntity: vi.fn(async () => ({ count: 1 })),
}));

const { cosmeticRouter } = await import('~/server/routers/cosmetic.router');
const { createCallerFactory } = await import('~/server/trpc');
const { equipCosmeticToEntity } = await import('~/server/services/cosmetic.service');

const MODERATOR = {
  id: 7,
  isModerator: true,
  onboarding: OnboardingSteps.Buzz,
  emailVerified: new Date('2026-01-01'),
  bannedAt: null,
  muted: false,
};

const callerWith = (credential: Record<string, unknown>) =>
  createCallerFactory(cosmeticRouter)({
    user: MODERATOR,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    ...credential,
    features: {},
    track: { action: vi.fn(async () => undefined) },
    ip: '127.0.0.1',
    cache: {},
    req: undefined,
    res: undefined,
  } as never);

const scopedKey = {
  apiKeyId: 9,
  apiKeyType: ApiKeyType.User,
  subject: { type: 'apiKey', id: 9 },
  tokenScope: TokenScope.CollectionsWrite,
};

beforeEach(() => vi.clearAllMocks());

describe('cosmetic.equipContentDecoration', () => {
  it.each([
    ['a session', {}, true],
    ['a scoped token', scopedKey, false],
  ])('places as a moderator only on a session (%s)', async (_label, credential, isModerator) => {
    await callerWith(credential).equipContentDecoration({
      cosmeticId: 1,
      equippedToId: 501,
      equippedToType: 'Image',
      claimKey: 'k',
    });
    expect(equipCosmeticToEntity).toHaveBeenCalledWith(
      expect.objectContaining({ userId: MODERATOR.id, isModerator })
    );
  });
});

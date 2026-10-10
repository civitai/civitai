import { describe, expect, it, vi } from 'vitest';
import type * as CosmeticService from '~/server/services/cosmetic.service';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

vi.mock('~/server/services/cosmetic.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticService>()),
  unequipCosmetic: vi.fn(async () => ({ count: 1 })),
}));

const { cosmeticRouter } = await import('~/server/routers/cosmetic.router');
const { createCallerFactory } = await import('~/server/trpc');
const { unequipCosmetic } = await import('~/server/services/cosmetic.service');

const USER = {
  id: 7,
  onboarding: OnboardingSteps.Buzz,
  emailVerified: new Date('2026-01-01'),
  bannedAt: null,
  muted: false,
};

const caller = createCallerFactory(cosmeticRouter)({
  user: USER,
  acceptableOrigin: true,
  tokenScope: TokenScope.Full,
  features: {},
  track: { action: vi.fn(async () => undefined) },
  ip: '127.0.0.1',
  cache: {},
  req: undefined,
  res: undefined,
} as never);

// Feeds do not carry an event decoration's claimKey, so the owner's "Remove" sends none.
describe('cosmetic.unequipCosmetic', () => {
  it('accepts a request without a claim key and scopes it to the caller', async () => {
    await caller.unequipCosmetic({ cosmeticId: 1, equippedToId: 501, equippedToType: 'Image' });
    expect(unequipCosmetic).toHaveBeenCalledWith({
      cosmeticId: 1,
      equippedToId: 501,
      equippedToType: 'Image',
      userId: USER.id,
    });
  });
});

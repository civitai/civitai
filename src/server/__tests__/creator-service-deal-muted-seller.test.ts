import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as AccountStanding from '~/server/services/account-standing.service';
import type * as DealService from '~/server/services/creator-service-deal.service';

const service = vi.hoisted(() => ({ acceptServiceDeal: vi.fn() }));
vi.mock('~/server/services/creator-service-deal.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DealService>()),
  ...service,
}));
const standing = vi.hoisted(() => ({ isAccountMuted: vi.fn() }));
vi.mock('~/server/services/account-standing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountStanding>()),
  ...standing,
}));

const { createCallerFactory } = await import('~/server/trpc');
const { creatorServiceDealRouter } = await import('~/server/routers/creator-service-deal.router');
const createCaller = createCallerFactory(creatorServiceDealRouter);

const SELLER = { id: 6, onboarding: 15, emailVerified: new Date('2026-01-01T00:00:00Z'), meta: {} };

const ctxFor = (user: Record<string, unknown>) =>
  ({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { trpcFlagGuardPerRequest: true, creatorServices: true },
    track: {},
    ip: '127.0.0.1',
    cache: {},
    req: undefined,
    res: undefined,
  } as never);

beforeEach(() => {
  service.acceptServiceDeal.mockReset();
  service.acceptServiceDeal.mockResolvedValue(true);
  standing.isAccountMuted.mockReset();
});

describe('accepting a deal as a muted seller', () => {
  it('refuses a seller whose stored standing is muted, even on an older unmuted session', async () => {
    standing.isAccountMuted.mockResolvedValue(true);
    await expect(createCaller(ctxFor(SELLER)).accept({ id: 1 })).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' })
    );
    expect(standing.isAccountMuted).toHaveBeenCalledWith(SELLER.id, false);
    expect(service.acceptServiceDeal).not.toHaveBeenCalled();
  });

  it('lets an unmuted seller accept', async () => {
    standing.isAccountMuted.mockResolvedValue(false);
    await createCaller(ctxFor(SELLER)).accept({ id: 1 });
    expect(service.acceptServiceDeal).toHaveBeenCalledWith({ dealId: 1, userId: SELLER.id });
  });
});

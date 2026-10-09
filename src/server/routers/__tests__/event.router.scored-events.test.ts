import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Who may call the scored-event routes. getMyCosmeticScores reads the caller's own scores and must
 * require a signed-in user; the standings and per-cosmetic scores are public.
 */

const { service } = vi.hoisted(() => ({
  service: {
    getEventStandings: vi.fn(async () => ({ teams: [] })),
    getMyEventCosmeticScores: vi.fn(async () => ({ points: 0, cosmetics: [] })),
    getEventCosmeticScores: vi.fn(async () => ({})),
  },
}));

vi.mock('~/server/services/event.service', () => service);

const { eventRouter } = await import('~/server/routers/event.router');

function callerFor(user: { id: number } | undefined) {
  return eventRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

beforeEach(() => vi.clearAllMocks());

describe('scored-event route access', () => {
  it('refuses getMyCosmeticScores to a signed-out caller without reading anything', async () => {
    await expect(
      callerFor(undefined).getMyCosmeticScores({ event: 'birthday2026' })
    ).rejects.toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }));
    expect(service.getMyEventCosmeticScores).not.toHaveBeenCalled();
  });

  it('serves getMyCosmeticScores for the signed-in caller only', async () => {
    await callerFor({ id: 7 }).getMyCosmeticScores({ event: 'birthday2026' });
    expect(service.getMyEventCosmeticScores).toHaveBeenCalledWith({
      userId: 7,
      event: 'birthday2026',
    });
  });

  it('serves standings and per-cosmetic scores to a signed-out caller', async () => {
    await callerFor(undefined).getStandings({ event: 'birthday2026' });
    await callerFor(undefined).getCosmeticScores({ event: 'birthday2026', cosmetics: [] });
    expect(service.getEventStandings).toHaveBeenCalledTimes(1);
    expect(service.getEventCosmeticScores).toHaveBeenCalledTimes(1);
  });

  it('caps a per-cosmetic batch at 100 keys', async () => {
    const cosmetics = Array.from({ length: 101 }, (_, i) => ({
      userId: 1,
      cosmeticId: i + 1,
      claimKey: 'claimed',
    }));
    await expect(
      callerFor(undefined).getCosmeticScores({ event: 'birthday2026', cosmetics })
    ).rejects.toThrow();
    expect(service.getEventCosmeticScores).not.toHaveBeenCalled();
  });
});

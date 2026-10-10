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
    getViewerEventAccess: vi.fn(async () => 'open'),
    getMyEventHats: vi.fn(async () => []),
    getPlaceableEventContent: vi.fn(async () => []),
    getEventHatCatalog: vi.fn(async () => []),
  },
}));

vi.mock('~/server/services/event.service', () => service);
const watch = vi.hoisted(() => ({ markEventPointsWatched: vi.fn(async () => ({ marked: 0 })) }));
vi.mock('~/server/events/points/watch.service', () => watch);

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
  // The preview's ids are accepted only from a caller the preview lets in, so the caller must reach
  // the check: signed in, as themself; signed out, as nobody.
  it('hands watchPoints the caller, or nobody when signed out', async () => {
    await callerFor({ id: 7 }).watchPoints({ event: 'birthday2026', topics: ['teams'] });
    await callerFor(undefined).watchPoints({ event: 'birthday2026', topics: ['teams'] });
    const calls = watch.markEventPointsWatched.mock.calls as unknown as [object, unknown][];
    expect(calls.map(([, viewer]) => viewer)).toEqual([{ id: 7 }, undefined]);
    for (const [input] of calls)
      expect(input).toMatchObject({ event: 'birthday2026', topics: ['teams'] });
  });

  it('refuses getMyCosmeticScores to a signed-out caller without reading anything', async () => {
    await expect(
      callerFor(undefined).getMyCosmeticScores({ event: 'birthday2026' })
    ).rejects.toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }));
    expect(service.getMyEventCosmeticScores).not.toHaveBeenCalled();
  });

  it('serves getMyCosmeticScores for the signed-in caller only', async () => {
    await callerFor({ id: 7 }).getMyCosmeticScores({ event: 'birthday2026' });
    expect(service.getMyEventCosmeticScores).toHaveBeenCalledWith({
      user: { id: 7 },
      event: 'birthday2026',
    });
  });

  // Both read the caller's own hats and posts, so a signed-out call must never reach the service.
  it('refuses getMyHats and getPlaceableContent to a signed-out caller', async () => {
    const anon = callerFor(undefined);
    await expect(anon.getMyHats({ event: 'birthday2026' })).rejects.toThrow(
      expect.objectContaining({ code: 'UNAUTHORIZED' })
    );
    await expect(anon.getPlaceableContent({ event: 'birthday2026' })).rejects.toThrow(
      expect.objectContaining({ code: 'UNAUTHORIZED' })
    );
    expect(service.getMyEventHats).not.toHaveBeenCalled();
    expect(service.getPlaceableEventContent).not.toHaveBeenCalled();
  });

  it('reads getMyHats and getPlaceableContent as the signed-in caller', async () => {
    await callerFor({ id: 7 }).getMyHats({ event: 'birthday2026' });
    await callerFor({ id: 7 }).getPlaceableContent({ event: 'birthday2026' });
    expect(service.getMyEventHats).toHaveBeenCalledWith({ user: { id: 7 }, event: 'birthday2026' });
    expect(service.getPlaceableEventContent).toHaveBeenCalledWith({
      user: { id: 7 },
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

  // The catalogue shows a visitor what joining gets them, so it is public, behind the page's gate.
  it('serves getHatCatalog to a signed-out caller as the anonymous viewer', async () => {
    await callerFor(undefined).getHatCatalog({ event: 'birthday2026' });
    expect(service.getEventHatCatalog).toHaveBeenCalledTimes(1);
    expect(service.getEventHatCatalog).toHaveBeenCalledWith({
      event: 'birthday2026',
      viewer: undefined,
    });
  });

  // The service's read gate decides on this viewer; a flagged tester must reach it as themselves.
  it('reads getHatCatalog as the signed-in caller', async () => {
    await callerFor({ id: 7 }).getHatCatalog({ event: 'birthday2026' });
    expect(service.getEventHatCatalog).toHaveBeenCalledWith({
      event: 'birthday2026',
      viewer: { id: 7 },
    });
  });

  it('refuses getHatCatalog for an event the viewer cannot read', async () => {
    service.getViewerEventAccess.mockResolvedValueOnce('closed');
    await expect(callerFor(undefined).getHatCatalog({ event: 'birthday2026' })).rejects.toThrow(
      "That event doesn't exist"
    );
    expect(service.getEventHatCatalog).not.toHaveBeenCalled();
  });
});

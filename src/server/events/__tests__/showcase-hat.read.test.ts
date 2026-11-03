import { beforeEach, describe, expect, it, vi } from 'vitest';

// The showcase hat rides on reads every viewer shares (user.getCreator is edge-cached), so it shows
// only while the event is open to everyone, and turning the event's flag off takes it down.

const access = vi.hoisted(() => ({ getEventAccess: vi.fn() }));
vi.mock('~/server/events/event-access', () => access);
vi.mock('~/server/events/load-events', () => ({
  loadEvents: vi.fn(async () => [{ name: 'birthday2026' }]),
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  createCachedObject: () => ({
    fetch: vi.fn(async () => ({ 1: { userId: 1, cosmeticId: 5 } })),
    refresh: vi.fn(),
  }),
}));
vi.mock('~/server/redis/caches', () => ({
  cosmeticCache: {
    fetch: vi.fn(async () => ({
      5: { data: { event: 'birthday2026', type: 'hat', url: 'hat.png' } },
    })),
  },
}));
vi.mock('~/server/services/creator-shop-withheld', () => ({
  getWithheldCosmeticIds: vi.fn(async () => new Set()),
}));

const { getShowcaseHatsForUsers } = await import('~/server/events/showcase-hat');

const DURING = new Date('2026-11-15T00:00:00.000Z');

beforeEach(() => vi.clearAllMocks());

describe('getShowcaseHatsForUsers', () => {
  it('draws the hat while the event is open to everyone', async () => {
    access.getEventAccess.mockResolvedValue('open');

    expect(await getShowcaseHatsForUsers([1], DURING)).toEqual({
      1: expect.objectContaining({ cosmeticId: 5, url: 'hat.png' }),
    });
  });

  it('draws nothing once the flag is off, inside the event dates', async () => {
    access.getEventAccess.mockResolvedValue('closed');

    expect(await getShowcaseHatsForUsers([1], DURING)).toEqual({});
  });

  it('asks as a signed-out viewer, so one answer holds for every viewer', async () => {
    access.getEventAccess.mockResolvedValue('open');

    await getShowcaseHatsForUsers([1], DURING);

    expect(access.getEventAccess).toHaveBeenCalledWith({ name: 'birthday2026' }, null, DURING);
  });
});

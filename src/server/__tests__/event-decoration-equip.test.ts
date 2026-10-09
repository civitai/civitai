import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_STARTS_AT,
} from '~/shared/constants/birthday2026.constants';

const db = dbMock.dbWrite;
const entityCache = () => ({ refresh: vi.fn(), fetch: vi.fn().mockResolvedValue({}) });
const caches = vi.hoisted(() => ({
  frame: {} as Record<
    string,
    { refresh: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn> }
  >,
  event: {} as Record<
    string,
    { refresh: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn> }
  >,
}));

vi.mock('~/server/redis/caches', () => ({
  cosmeticCache: { refresh: vi.fn(), fetch: vi.fn() },
  cosmeticEntityCaches: caches.frame,
  eventDecorationEntityCaches: caches.event,
  refreshOwnedStickerCache: vi.fn(),
  userCosmeticCache: { refresh: vi.fn() },
  userOwnedStickerCache: { refresh: vi.fn() },
}));
vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn() },
  articlesSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/image.service', () => ({ queueImageSearchIndexUpdate: vi.fn() }));

const { equipCosmeticToEntity, getEventDecorationsForEntity } = await import(
  '~/server/services/cosmetic.service'
);

const OWNER = 7;
const IMAGE = 501;
const DURING = new Date(BIRTHDAY_2026_STARTS_AT.getTime() + 24 * 60 * 60 * 1000);

const HAT = { type: 'hat', event: BIRTHDAY_2026_EVENT, url: 'hat.png', team: 'Blue' };
const FRAME = { cssFrame: 'linear-gradient(red, blue)' };

const hatRow = (data: unknown = null) => ({
  obtainedAt: new Date(),
  equippedToId: null,
  equippedToType: null,
  forId: null,
  forType: null,
  data,
  cosmetic: { type: 'ContentDecoration', data: HAT },
});
const frameRow = () => ({ ...hatRow(), cosmetic: { type: 'ContentDecoration', data: FRAME } });

const equipHat = () =>
  equipCosmeticToEntity({
    userId: OWNER,
    cosmeticId: 1,
    claimKey: 'tx-1',
    equippedToId: IMAGE,
    equippedToType: 'Image',
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(DURING);
  for (const entity of ['Model', 'Image', 'Article', 'Post', 'Model3D']) {
    caches.frame[entity] = entityCache();
    caches.event[entity] = entityCache();
  }
  db.image.findUnique.mockResolvedValue({ userId: OWNER });
  db.userCosmetic.findMany.mockResolvedValue([]);
  db.userCosmetic.updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.useRealTimers());

// Justin, 2026-10-09: an entity wears one frame AND one event decoration (a party hat). Before
// this, equipping anything unequipped everything on the entity. If you are about to go back to
// that, the hat seat of the birthday event and its scoring both depend on coexistence.
describe('a frame and an event decoration coexist on one entity', () => {
  const onEntity = [
    { cosmeticId: 10, claimKey: 'claimed', cosmetic: { data: FRAME } },
    { cosmeticId: 20, claimKey: 'tx-old', cosmetic: { data: HAT } },
  ];

  it('equipping a hat displaces only the previous hat, never the frame', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
    db.userCosmetic.findMany.mockResolvedValue(onEntity);

    await equipHat();

    const unequip = db.userCosmetic.updateMany.mock.calls[0][0];
    expect(unequip.data).toEqual({ equippedToId: null, equippedToType: null, equippedAt: null });
    expect(unequip.where).toEqual({ userId: OWNER, OR: [{ cosmeticId: 20, claimKey: 'tx-old' }] });
  });

  it('equipping a frame displaces only the previous frame, never the hat', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(frameRow());
    db.userCosmetic.findMany.mockResolvedValue(onEntity);

    await equipHat();

    const unequip = db.userCosmetic.updateMany.mock.calls[0][0];
    expect(unequip.where).toEqual({ userId: OWNER, OR: [{ cosmeticId: 10, claimKey: 'claimed' }] });
  });

  it('refreshes both decoration caches for the entity', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
    await equipHat();
    expect(caches.frame.Image.refresh).toHaveBeenCalledWith([IMAGE]);
    expect(caches.event.Image.refresh).toHaveBeenCalledWith([IMAGE]);
  });
});

describe('placing an event decoration', () => {
  const expectRefused = async (message: RegExp) => {
    await expect(equipHat()).rejects.toThrow(message);
    expect(db.userCosmetic.updateMany).not.toHaveBeenCalled();
  };

  it('is refused on content the wearer does not own', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
    db.image.findUnique.mockResolvedValue({ userId: OWNER + 1 });
    await expectRefused(/your own content/);
  });

  it('is refused when the content does not exist', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
    db.image.findUnique.mockResolvedValue(null);
    await expectRefused(/your own content/);
  });

  it('is refused before the event starts and after it ends', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
    vi.setSystemTime(new Date(BIRTHDAY_2026_STARTS_AT.getTime() - 1));
    await expectRefused(/while its event is running/);
    vi.setSystemTime(BIRTHDAY_2026_ENDS_AT);
    await expectRefused(/while its event is running/);
  });

  it('is refused on a content type its event does not allow', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
    await expect(
      equipCosmeticToEntity({
        userId: OWNER,
        cosmeticId: 1,
        claimKey: 'tx-1',
        equippedToId: 9,
        equippedToType: 'Post',
      })
    ).rejects.toThrow(/that kind of content/);
    expect(db.userCosmetic.updateMany).not.toHaveBeenCalled();
  });

  it('is refused within the cooldown, even after being taken off in between', async () => {
    const fiveMinutesAgo = new Date(DURING.getTime() - 5 * 60 * 1000).toISOString();
    db.userCosmetic.findFirst.mockResolvedValue(hatRow({ placedAt: fiveMinutesAgo }));
    await expectRefused(/move it again at 2026-11-12T08:05:00.000Z/);
  });

  it('is allowed once the cooldown has passed, and records when it was placed', async () => {
    const elevenMinutesAgo = new Date(DURING.getTime() - 11 * 60 * 1000).toISOString();
    db.userCosmetic.findFirst.mockResolvedValue(hatRow({ placedAt: elevenMinutesAgo, lights: 3 }));

    await equipHat();

    const place = db.userCosmetic.updateMany.mock.calls.at(-1)![0];
    expect(place.where).toEqual({ userId: OWNER, cosmeticId: 1, claimKey: 'tx-1' });
    expect(place.data).toEqual({
      equippedToId: IMAGE,
      equippedToType: 'Image',
      equippedAt: DURING,
      data: { placedAt: DURING.toISOString(), lights: 3 },
    });
  });

  it('leaves frames out of the event window and the cooldown record', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(frameRow());
    vi.setSystemTime(BIRTHDAY_2026_ENDS_AT);

    await equipHat();

    const place = db.userCosmetic.updateMany.mock.calls.at(-1)![0];
    expect(place.data).toEqual({
      equippedToId: IMAGE,
      equippedToType: 'Image',
      equippedAt: BIRTHDAY_2026_ENDS_AT,
    });
  });
});

describe('getEventDecorationsForEntity', () => {
  it('reads the cache while an event lets that type wear one', async () => {
    caches.event.Image.fetch.mockResolvedValue({ [IMAGE]: { id: 1 } });
    await expect(getEventDecorationsForEntity({ ids: [IMAGE], entity: 'Image' })).resolves.toEqual({
      [IMAGE]: { id: 1 },
    });
  });

  it('skips the read between events and for types no event allows', async () => {
    await getEventDecorationsForEntity({ ids: [9], entity: 'Post' });
    vi.setSystemTime(BIRTHDAY_2026_ENDS_AT);
    await getEventDecorationsForEntity({ ids: [IMAGE], entity: 'Image' });
    expect(caches.event.Post.fetch).not.toHaveBeenCalled();
    expect(caches.event.Image.fetch).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_PREVIEW_FROM,
  BIRTHDAY_2026_STARTS_AT,
} from '~/shared/constants/birthday2026.constants';
import { testerFlag } from '~/test-utils/testerFlagFake';
import type * as HatSync from '~/server/events/points/sync';

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
const hatSync = vi.hoisted(() => ({ owner: vi.fn(), owners: vi.fn() }));
vi.mock('~/server/events/points/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof HatSync>()),
  syncOwnerEventHats: hatSync.owner,
  syncOwnersEventHats: hatSync.owners,
}));
vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});

const {
  equipCosmeticToEntity,
  getEventDecorationsForEntity,
  revokeCosmeticsFromUsers,
  unequipCosmetic,
} = await import('~/server/services/cosmetic.service');
const { equipCosmeticSchema, unequipCosmeticSchema } = await import(
  '~/server/schema/cosmetic.schema'
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

const COOLDOWN_MS = 10 * 60 * 1000;
const minutesAgo = (n: number) => new Date(DURING.getTime() - n * 60 * 1000);

/** The values bound into the placement UPDATE, in template order. */
const placementValues = () => db.$executeRaw.mock.calls.at(-1)!.slice(1);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(DURING);
  // Launched: these pin the decoration rules, not who the flag lets in (event-access.test.ts).
  testerFlag.reset({ public: true });
  for (const entity of ['Model', 'Image', 'Article', 'Post', 'Model3D']) {
    caches.frame[entity] = entityCache();
    caches.event[entity] = entityCache();
  }
  db.image.findUnique.mockResolvedValue({ userId: OWNER });
  // clearAllMocks keeps resolved values; a lookup one test set must not answer the next.
  for (const lookup of [db.model.findUnique, db.article.findUnique, db.post.findUnique])
    lookup.mockReset().mockResolvedValue(null);
  db.userCosmetic.findMany.mockResolvedValue([]);
  db.userCosmetic.updateMany.mockResolvedValue({ count: 1 });
  db.$executeRaw.mockResolvedValue(1);
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

  it('looks only at what this user has on the target entity', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
    await equipHat();
    expect(db.userCosmetic.findMany.mock.calls[0][0].where).toEqual({
      userId: OWNER,
      equippedToId: IMAGE,
      equippedToType: 'Image',
    });
  });

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

  it('putting a hat back on the entity it is already on does not take it off again', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
    db.userCosmetic.findMany.mockResolvedValue([
      { cosmeticId: 1, claimKey: 'tx-1', cosmetic: { data: HAT } },
    ]);
    await equipHat();
    expect(db.userCosmetic.updateMany).not.toHaveBeenCalled();
  });
});

describe('placing an event decoration', () => {
  const expectRefused = async (message: RegExp) => {
    await expect(equipHat()).rejects.toThrow(message);
    expect(db.$executeRaw).not.toHaveBeenCalled();
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

  it('is refused before the event starts', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
    vi.setSystemTime(new Date(BIRTHDAY_2026_STARTS_AT.getTime() - 1));
    await expectRefused(/isn't available right now/);
  });

  it('is refused on a content type its event does not allow', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
    db.post.findUnique.mockResolvedValue({ userId: OWNER });
    await expect(
      equipCosmeticToEntity({
        userId: OWNER,
        cosmeticId: 1,
        claimKey: 'tx-1',
        equippedToId: 9,
        equippedToType: 'Post',
      })
    ).rejects.toThrow(/that kind of content/);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('is refused within the cooldown, even after being taken off in between', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow({ placedAt: minutesAgo(5).toISOString() }));
    const readyAt = new Date(minutesAgo(5).getTime() + COOLDOWN_MS).toISOString();
    await expectRefused(new RegExp(`move it again at ${readyAt.replace(/\./g, '\\.')}`));
  });

  it('is allowed exactly when the cooldown ends', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow({ placedAt: minutesAgo(10).toISOString() }));
    await equipHat();
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  // The read above cannot stop concurrent equips that all saw the same placedAt; the write must.
  it('is refused when the write finds the cooldown already restarted, and moves nothing', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow({ placedAt: minutesAgo(30).toISOString() }));
    db.userCosmetic.findMany.mockResolvedValue([
      { cosmeticId: 20, claimKey: 'tx-old', cosmetic: { data: HAT } },
    ]);
    db.$executeRaw.mockResolvedValue(0);

    await expect(equipHat()).rejects.toThrow(/moved recently/);
    expect(db.userCosmetic.updateMany).not.toHaveBeenCalled();
    expect(caches.event.Image.refresh).not.toHaveBeenCalled();
  });

  it('moves it in one write that records when it was placed and re-checks the cooldown', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow({ placedAt: minutesAgo(30).toISOString() }));

    await equipHat();

    const sql = (db.$executeRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toMatch(/jsonb_build_object\('placedAt', \?::text\)/);
    // Prisma binds strings as text, which Postgres will not assign to an enum column uncast. The
    // PGlite behaviour test cannot see this: it infers untyped parameters from the column.
    expect(sql).toMatch(/"equippedToType" = \?::"CosmeticEntity",/);
    // Anchored on the whole condition: a weakened clause beside it would leave a fragment match.
    expect(sql).toMatch(
      /AND \("data"->>'placedAt' IS NULL\s+OR \("data"->>'placedAt'\)::timestamptz <= \?\)\s*$/
    );
    expect(placementValues()).toEqual([
      IMAGE,
      'Image',
      DURING,
      DURING.toISOString(),
      OWNER,
      1,
      'tx-1',
      minutesAgo(10),
    ]);
    expect(db.userCosmetic.updateMany).not.toHaveBeenCalled();
  });

  // A cosmetic can be granted outside the event's own join and shop flows (claims, mod grants).
  // The event rules must not depend on how it was obtained, so equip never reads the source: if
  // you are adding it here, every grant route needs the same rules applied.
  it('decides from the cosmetic itself, never from how it was obtained', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
    await equipHat();
    expect(db.userCosmetic.findFirst.mock.calls[0][0].select.cosmetic).toEqual({
      select: { type: true, data: true },
    });
  });

  it('leaves frames out of the event window and the cooldown record', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(frameRow());
    vi.setSystemTime(BIRTHDAY_2026_ENDS_AT);

    await equipHat();

    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.userCosmetic.updateMany.mock.calls.at(-1)![0].data).toEqual({
      equippedToId: IMAGE,
      equippedToType: 'Image',
      equippedAt: BIRTHDAY_2026_ENDS_AT,
    });
  });
});

// A cosmetic awarded for one entity (forId/forType) goes on that entity only: the id AND the type
// must both match, as the decoration picker already requires.
describe('a cosmetic locked to one entity', () => {
  const lockedTo = (forId: number, forType: string) => ({ ...frameRow(), forId, forType });

  it.each([
    ['another entity of the same type', IMAGE + 1, 'Image'],
    ['the same id on another type', IMAGE, 'Model'],
  ])('is refused on %s', async (_, forId, forType) => {
    db.userCosmetic.findFirst.mockResolvedValue(lockedTo(forId, forType));
    await expect(equipHat()).rejects.toThrow(/cannot equip this cosmetic to this entity/);
    expect(db.userCosmetic.updateMany).not.toHaveBeenCalled();
  });

  it('is allowed on the entity it is locked to', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(lockedTo(IMAGE, 'Image'));
    await equipHat();
    expect(db.userCosmetic.updateMany.mock.calls.at(-1)![0].data).toMatchObject({
      equippedToId: IMAGE,
      equippedToType: 'Image',
    });
  });
});

describe('equipping any decoration requires owning the content', () => {
  it.each([
    ['a frame', frameRow],
    ['an event decoration', () => hatRow()],
  ])('refuses %s on content owned by someone else', async (_, row) => {
    db.userCosmetic.findFirst.mockResolvedValue(row());
    db.image.findUnique.mockResolvedValue({ userId: OWNER + 1 });

    await expect(equipHat()).rejects.toThrow(/your own content/);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.userCosmetic.updateMany).not.toHaveBeenCalled();
  });

  // The image here belongs to the wearer, so only a lookup against the target's own table can
  // refuse: a lookup hard-wired to images would let these through.
  it.each([
    ['Model', () => db.model.findUnique],
    ['Article', () => db.article.findUnique],
  ] as const)('looks the owner up in the %s table', async (equippedToType, lookup) => {
    db.userCosmetic.findFirst.mockResolvedValue(frameRow());
    lookup().mockResolvedValue({ userId: OWNER + 1 });

    await expect(
      equipCosmeticToEntity({
        userId: OWNER,
        cosmeticId: 1,
        claimKey: 'tx-1',
        equippedToId: 42,
        equippedToType,
      })
    ).rejects.toThrow(/your own content/);
    expect(lookup()).toHaveBeenCalledWith({ where: { id: 42 }, select: { userId: true } });
    expect(db.userCosmetic.updateMany).not.toHaveBeenCalled();
  });

  it('reads the owner from the primary, by the target entity', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(frameRow());
    await equipHat();
    expect(db.image.findUnique).toHaveBeenCalledWith({
      where: { id: IMAGE },
      select: { userId: true },
    });
    expect(dbMock.dbRead.image.findUnique).not.toHaveBeenCalled();
  });
});

describe('taking a decoration off refreshes the event decoration cache too', () => {
  it('on unequip', async () => {
    await unequipCosmetic({
      userId: OWNER,
      cosmeticId: 1,
      claimKey: 'tx-1',
      equippedToId: IMAGE,
      equippedToType: 'Image',
    });
    expect(caches.event.Image.refresh).toHaveBeenCalledWith([IMAGE]);
    expect(caches.frame.Image.refresh).toHaveBeenCalledWith([IMAGE]);
  });

  it('on revoke', async () => {
    db.userCosmetic.findMany.mockResolvedValue([{ equippedToId: IMAGE, equippedToType: 'Image' }]);
    db.userCosmetic.deleteMany.mockResolvedValue({ count: 1 });
    await revokeCosmeticsFromUsers({ userIds: [OWNER], cosmeticIds: [1] });
    expect(caches.event.Image.refresh).toHaveBeenCalledWith([IMAGE]);
  });

  it('when equipping moves a decoration off its previous entity', async () => {
    db.userCosmetic.findFirst.mockResolvedValue({
      ...hatRow(),
      equippedToId: 777,
      equippedToType: 'Image',
    });
    await equipHat();
    expect(caches.event.Image.refresh).toHaveBeenCalledWith([777]);
  });
});

// Feeds do not carry a hat's claimKey, so the owner's "Remove" menu item sends none.
describe('unequip without a claim key', () => {
  it('takes off only what this owner wears on that entity', async () => {
    await unequipCosmetic({
      userId: OWNER,
      cosmeticId: 1,
      equippedToId: IMAGE,
      equippedToType: 'Image',
    });
    expect(db.userCosmetic.updateMany).toHaveBeenCalledWith({
      where: { cosmeticId: 1, equippedToId: IMAGE, equippedToType: 'Image', userId: OWNER },
      data: { equippedToId: null, equippedToType: null, equippedAt: null },
    });
  });

  it('still narrows to the claim key when one is sent', async () => {
    await unequipCosmetic({
      userId: OWNER,
      cosmeticId: 1,
      claimKey: 'tx-1',
      equippedToId: IMAGE,
      equippedToType: 'Image',
    });
    expect(db.userCosmetic.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          cosmeticId: 1,
          equippedToId: IMAGE,
          equippedToType: 'Image',
          userId: OWNER,
          claimKey: 'tx-1',
        },
      })
    );
  });

  it('is accepted by the unequip input and still refused by equip', () => {
    const input = { cosmeticId: 1, equippedToId: IMAGE, equippedToType: 'Image' };
    expect(unequipCosmeticSchema.safeParse(input).success).toBe(true);
    expect(equipCosmeticSchema.safeParse(input).success).toBe(false);
  });
});

describe('getEventDecorationsForEntity', () => {
  it('reads the cache while an event lets that type wear one', async () => {
    caches.event.Image.fetch.mockResolvedValue({ [IMAGE]: { id: 1, data: HAT } });
    await expect(getEventDecorationsForEntity({ ids: [IMAGE], entity: 'Image' })).resolves.toEqual({
      [IMAGE]: { id: 1, data: HAT },
    });
  });

  // Feed responses attach these objects as they are, so the claimKey must not survive even when
  // an entry cached before it was dropped still carries one.
  it('returns what a card renders and never the claim key', async () => {
    const rendered = {
      id: 1,
      name: 'Party Hat',
      type: 'ContentDecoration',
      source: 'Event',
      data: HAT,
      equippedToId: IMAGE,
      equippedToType: 'Image',
    };
    caches.event.Image.fetch.mockResolvedValue({
      [IMAGE]: { ...rendered, claimKey: 'tx-claim-8841' },
    });
    const result = await getEventDecorationsForEntity({ ids: [IMAGE], entity: 'Image' });
    expect(JSON.stringify(result)).not.toContain('tx-claim-8841');
    expect(result).toStrictEqual({ [IMAGE]: rendered });
  });

  it('passes the write-back choice through to the cache', async () => {
    await getEventDecorationsForEntity({ ids: [IMAGE], entity: 'Image', writeBack: false });
    expect(caches.event.Image.fetch).toHaveBeenCalledWith([IMAGE], { writeBack: false });
  });

  it('skips the read before any event is released and for types no event allows', async () => {
    await getEventDecorationsForEntity({ ids: [9], entity: 'Post' });
    vi.setSystemTime(new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() - 1));
    await getEventDecorationsForEntity({ ids: [IMAGE], entity: 'Image' });
    expect(caches.event.Post.fetch).not.toHaveBeenCalled();
    expect(caches.event.Image.fetch).not.toHaveBeenCalled();
  });
});

// Justin, 2026-10-09: the whole event runs for testers and moderators before launch, behind the
// `birthday2026` flag, and nobody else sees any of it. See event-access.test.ts for the rule.
describe('behind the flag before launch', () => {
  const PREVIEW = new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() + 24 * 60 * 60 * 1000);
  beforeEach(() => {
    vi.setSystemTime(PREVIEW);
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
  });

  it('lets a tester place a hat during the preview', async () => {
    testerFlag.reset({ testers: [OWNER] });
    await equipHat();
    expect(db.$executeRaw).toHaveBeenCalled();
  });

  it('refuses everyone else during the preview, and the tester once it is armed', async () => {
    testerFlag.reset({ testers: [] });
    await expect(equipHat()).rejects.toThrow(/isn't available right now/);
    testerFlag.reset({ public: true, testers: [OWNER] });
    await expect(equipHat()).rejects.toThrow(/isn't available right now/);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('shows hats only to a viewer the flag is on for, and to nobody unnamed', async () => {
    testerFlag.reset({ testers: [OWNER] });
    caches.event.Image.fetch.mockResolvedValue({ [IMAGE]: { id: 1, data: HAT } });

    expect(await getEventDecorationsForEntity({ ids: [IMAGE], entity: 'Image' })).toEqual({});
    expect(
      await getEventDecorationsForEntity({ ids: [IMAGE], entity: 'Image', viewer: { id: 99 } })
    ).toEqual({});
    expect(caches.event.Image.fetch).not.toHaveBeenCalled();

    expect(
      await getEventDecorationsForEntity({ ids: [IMAGE], entity: 'Image', viewer: { id: OWNER } })
    ).toEqual({ [IMAGE]: { id: 1, data: HAT } });
  });

  it('shows a decoration only for an event the viewer may see', async () => {
    testerFlag.reset({ testers: [OWNER] });
    caches.event.Image.fetch.mockResolvedValue({
      [IMAGE]: { id: 1, data: HAT },
      [IMAGE + 1]: { id: 2, data: { ...HAT, event: 'some-other-event' } },
    });
    expect(
      await getEventDecorationsForEntity({
        ids: [IMAGE, IMAGE + 1],
        entity: 'Image',
        viewer: { id: OWNER },
      })
    ).toEqual({ [IMAGE]: { id: 1, data: HAT } });
  });
});

// Justin and Ellie, 2026-10-09: hats are kept after the event, like the frames and decorations of
// past birthdays. They stop scoring and stop being sold; they do not come off content. If you are
// about to make an ended event take its hats away again, that reverses a product decision.
describe('hats are kept after the event ends', () => {
  const AFTER = [
    ['the moment it ends', BIRTHDAY_2026_ENDS_AT],
    ['a year later', new Date(BIRTHDAY_2026_ENDS_AT.getTime() + 365 * 24 * 60 * 60 * 1000)],
  ] as const;

  it.each(AFTER)('can still be placed %s', async (_, at) => {
    vi.setSystemTime(at);
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
    await equipHat();
    expect(db.$executeRaw).toHaveBeenCalled();
  });

  it.each(AFTER)('are still shown on content %s', async (_, at) => {
    vi.setSystemTime(at);
    caches.event.Image.fetch.mockResolvedValue({ [IMAGE]: { id: 1, data: HAT } });
    expect(await getEventDecorationsForEntity({ ids: [IMAGE], entity: 'Image' })).toEqual({
      [IMAGE]: { id: 1, data: HAT },
    });
  });

  it('are hidden, and cannot be placed, once the flag is off', async () => {
    vi.setSystemTime(BIRTHDAY_2026_ENDS_AT);
    testerFlag.reset({ testers: [] });
    caches.event.Image.fetch.mockResolvedValue({ [IMAGE]: { id: 1, data: HAT } });
    expect(
      await getEventDecorationsForEntity({ ids: [IMAGE], entity: 'Image', viewer: { id: OWNER } })
    ).toEqual({});
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
    await expect(equipHat()).rejects.toThrow(/isn't available right now/);
  });
});

// The live hat map is written in the same request (sync.behavior.test.ts runs what these calls do).
describe('a hat placement change writes through to the live hat map', () => {
  it('on equip, for the content it went on', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(hatRow());
    await equipHat();
    expect(hatSync.owner.mock.calls).toEqual([[OWNER, [{ entityType: 'Image', entityId: IMAGE }]]]);
  });

  it('on a move, for the content it left too', async () => {
    db.userCosmetic.findFirst.mockResolvedValue({
      ...hatRow(),
      equippedToId: 777,
      equippedToType: 'Image',
    });
    await equipHat();
    expect(hatSync.owner.mock.calls).toEqual([
      [
        OWNER,
        [
          { entityType: 'Image', entityId: IMAGE },
          { entityType: 'Image', entityId: 777 },
        ],
      ],
    ]);
  });

  it('not when a frame is equipped: it cannot move a hat', async () => {
    db.userCosmetic.findFirst.mockResolvedValue(frameRow());
    await equipHat();
    expect(hatSync.owner).not.toHaveBeenCalled();
  });

  it('on unequip, only when something came off', async () => {
    const unequip = () =>
      unequipCosmetic({
        userId: OWNER,
        cosmeticId: 1,
        claimKey: 'tx-1',
        equippedToId: IMAGE,
        equippedToType: 'Image',
      });
    db.userCosmetic.updateMany.mockResolvedValueOnce({ count: 0 });
    await unequip();
    expect(hatSync.owner).not.toHaveBeenCalled();
    await unequip();
    expect(hatSync.owner.mock.calls).toEqual([[OWNER, [{ entityType: 'Image', entityId: IMAGE }]]]);
  });

  it('on revoke, for every holder and the content each wore it on', async () => {
    db.userCosmetic.findMany.mockResolvedValue([
      { userId: OWNER, equippedToId: IMAGE, equippedToType: 'Image' },
      { userId: 8, equippedToId: 9, equippedToType: 'Model' },
    ]);
    db.userCosmetic.deleteMany.mockResolvedValue({ count: 2 });
    await revokeCosmeticsFromUsers({ userIds: [OWNER, 8], cosmeticIds: [1] });
    expect(hatSync.owners.mock.calls).toEqual([
      [
        [
          { userId: OWNER, entityType: 'Image', entityId: IMAGE },
          { userId: 8, entityType: 'Model', entityId: 9 },
        ],
      ],
    ]);
  });
});

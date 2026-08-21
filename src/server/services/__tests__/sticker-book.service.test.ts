import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

const blockedPairIds = vi.fn(async () => [] as number[]);

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  getBlockedPairIds: (...args: [number]) => blockedPairIds(...args),
}));

const { getStickerBook } = await import('~/server/services/sticker-book.service');

const CREATOR = 11;
const STRANGER = 22;
const MODERATOR = 33;
const IMAGE = 500;

const userFindFirst = dbMock.dbRead.user.findFirst;
const placementGroupBy = dbMock.dbRead.placement.groupBy;
const placementFindMany = dbMock.dbRead.placement.findMany;
const imageFindMany = dbMock.dbRead.image.findMany;
const queryRaw = dbMock.dbRead.$queryRaw;

const levels = { domainLevels: allBrowsingLevelsFlag, viewerLevels: allBrowsingLevelsFlag };

/** The profile whose book is being asked for. */
const creatorWithSettings = (settings: Record<string, unknown> | null) =>
  userFindFirst.mockResolvedValue({
    id: CREATOR,
    username: 'creator',
    settings,
    bannedAt: null,
    deletedAt: null,
  });

/**
 * A single image carrying two approved placements, on whichever side is asked
 * for. Both sections run the same query with one column swapped, so one fixture
 * answers either.
 */
const oneStickeredImage = () => {
  placementGroupBy.mockResolvedValue([
    { targetId: IMAGE, _count: { _all: 2 }, _max: { createdAt: new Date('2026-08-20') } },
  ]);
  placementFindMany.mockResolvedValue([
    {
      targetId: IMAGE,
      createdAt: new Date('2026-08-20'),
      owner: { id: CREATOR, username: 'creator', deletedAt: null },
      placer: { id: STRANGER, username: 'placer', deletedAt: null },
    },
  ]);
  imageFindMany.mockResolvedValue([
    {
      id: IMAGE,
      url: 'abc',
      name: 'pic',
      width: 100,
      height: 100,
      type: 'image',
      metadata: {},
      // Public. `toQueueImage` masks on this, and a 0 would fail closed and make
      // every assertion below pass for the wrong reason.
      nsfwLevel: 1,
    },
  ]);
};

/** Two holdings of two different stickers, one of them unlimited. */
const holdings = () =>
  queryRaw.mockResolvedValue([
    { cosmeticId: 1, remaining: 4, unlimited: false },
    { cosmeticId: 2, remaining: null, unlimited: true },
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  blockedPairIds.mockResolvedValue([]);
  creatorWithSettings(null);
  oneStickeredImage();
  holdings();
});

describe('getStickerBook — what leaves the server', () => {
  it('sends a stranger the stickers but never the quantities', async () => {
    const book = await getStickerBook({ username: 'creator', viewerId: STRANGER, ...levels });

    expect(book.stickers).toHaveLength(2);
    // Absent, not null and not zero: `null` already means unlimited on this
    // field, so a stranger handed `remaining: null` is being told the creator
    // has infinite uses.
    for (const sticker of book.stickers) expect(sticker).not.toHaveProperty('remaining');
  });

  it('sends the owner their own quantities, unlimited included', async () => {
    const book = await getStickerBook({ username: 'creator', viewerId: CREATOR, ...levels });

    expect(book.stickers).toEqual([
      { cosmeticId: 1, remaining: 4 },
      { cosmeticId: 2, remaining: null },
    ]);
  });

  it('does not send quantities to a moderator', async () => {
    const book = await getStickerBook({
      username: 'creator',
      viewerId: MODERATOR,
      isModerator: true,
      ...levels,
    });

    expect(book.access.canViewStickers).toBe(true);
    for (const sticker of book.stickers) expect(sticker).not.toHaveProperty('remaining');
  });

  it('sends a hidden book to nobody but privileged viewers, content included', async () => {
    creatorWithSettings({ hideStickerBook: true });

    const book = await getStickerBook({ username: 'creator', viewerId: STRANGER, ...levels });

    expect(book.access.canViewBook).toBe(false);
    // The sections are the point of the assertion, not the flag: a payload that
    // carried the images and relied on the tab to hide them would be a control
    // one fetch away from being useless.
    expect(book.placed).toEqual([]);
    expect(book.received).toEqual([]);
    expect(book.stickers).toEqual([]);
    expect(book.earnedBuzz).toBeNull();
    // And nothing was even asked for.
    expect(placementGroupBy).not.toHaveBeenCalled();
  });

  it('sends a moderator the hidden book, marked as an override', async () => {
    creatorWithSettings({ hideStickerBook: true });

    const book = await getStickerBook({
      username: 'creator',
      viewerId: MODERATOR,
      isModerator: true,
      ...levels,
    });

    expect(book.access.canViewBook).toBe(true);
    expect(book.access.moderatorOverride).toBe(true);
    expect(book.placed).toHaveLength(1);
  });

  it('withholds the stickers alone when only that toggle is set', async () => {
    creatorWithSettings({ hidePurchasedStickers: true });

    const book = await getStickerBook({ username: 'creator', viewerId: STRANGER, ...levels });

    expect(book.stickers).toEqual([]);
    // The rest of the book is untouched by that toggle.
    expect(book.received).toHaveLength(1);
  });

  it('never sends earnings to a stranger', async () => {
    const book = await getStickerBook({ username: 'creator', viewerId: STRANGER, ...levels });

    expect(book.earnedBuzz).toBeNull();
    // Two raw queries exist — holdings and earnings — and the earnings one must
    // not have run at all.
    const earningsQueries = queryRaw.mock.calls.filter((call) =>
      String(call[0]?.join?.('') ?? '').includes('PlacementTransaction')
    );
    expect(earningsQueries).toHaveLength(0);
  });

  it('counts placements from the group, not from the rows it could name', async () => {
    // Two placements, one nameable row. A count taken from the rows would say 1
    // — wrong exactly on the images that got the most attention.
    const book = await getStickerBook({ username: 'creator', viewerId: CREATOR, ...levels });

    expect(book.received[0].placementCount).toBe(2);
    expect(book.received[0].counterparts).toHaveLength(1);
  });

  it('asks only for approved placements', async () => {
    await getStickerBook({ username: 'creator', viewerId: CREATOR, ...levels });

    for (const call of placementGroupBy.mock.calls)
      expect(call[0].where).toMatchObject({ status: 'approved' });
  });

  it('excludes the other end of a block from both sections', async () => {
    blockedPairIds.mockResolvedValue([STRANGER]);

    await getStickerBook({ username: 'creator', viewerId: STRANGER, ...levels });

    const wheres = placementGroupBy.mock.calls.map((call) => call[0].where);
    // The placed side filters on the image owner, the received side on the
    // placer: each excludes the end that is NOT this creator, which is the only
    // end their book can put in front of the viewer.
    expect(wheres).toContainEqual(expect.objectContaining({ ownerId: { notIn: [STRANGER] } }));
    expect(wheres).toContainEqual(expect.objectContaining({ placerId: { notIn: [STRANGER] } }));
  });

  it('drops an image this domain may not serve rather than sending it withheld', async () => {
    imageFindMany.mockResolvedValue([
      { id: IMAGE, url: 'abc', name: null, width: 1, height: 1, type: 'image', metadata: {}, nsfwLevel: 8 },
    ]);

    const book = await getStickerBook({
      username: 'creator',
      viewerId: CREATOR,
      domainLevels: 1,
      viewerLevels: 1,
    });

    expect(book.placed).toEqual([]);
    expect(book.received).toEqual([]);
  });

  it('drops an image outside the viewer own band', async () => {
    // Servable by the domain, above what this viewer asked for. A queue marks
    // this and keeps the row because the owner still has to act on it; a book
    // has nothing to act on.
    const book = await getStickerBook({
      username: 'creator',
      viewerId: CREATOR,
      domainLevels: allBrowsingLevelsFlag,
      viewerLevels: 8,
    });

    expect(book.received).toEqual([]);
  });

  it('closes a banned creator book to visitors and opens it to moderators', async () => {
    userFindFirst.mockResolvedValue({
      id: CREATOR,
      username: 'creator',
      settings: null,
      bannedAt: new Date(),
      deletedAt: null,
    });

    const visitor = await getStickerBook({ username: 'creator', viewerId: STRANGER, ...levels });
    expect(visitor.access.canViewBook).toBe(false);

    const moderator = await getStickerBook({
      username: 'creator',
      viewerId: MODERATOR,
      isModerator: true,
      ...levels,
    });
    expect(moderator.access.canViewBook).toBe(true);
  });

  it('refuses a deleted account', async () => {
    userFindFirst.mockResolvedValue({
      id: CREATOR,
      username: 'creator',
      settings: null,
      bannedAt: null,
      deletedAt: new Date(),
    });

    await expect(getStickerBook({ username: 'creator', ...levels })).rejects.toThrow();
  });

  it('bounds the section limit rather than passing a caller number through', async () => {
    await getStickerBook({ username: 'creator', viewerId: CREATOR, limit: 5000, ...levels });

    for (const call of placementGroupBy.mock.calls) expect(call[0].take).toBe(60);
  });
});

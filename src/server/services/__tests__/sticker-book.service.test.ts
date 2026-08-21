import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as UserPreferences from '~/server/services/user-preferences.service';

const blockedPairIds = vi.fn(async () => [] as number[]);

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  getBlockedPairIds: (...args: [number]) => blockedPairIds(...args),
}));

const { getStickerBook, getStickerBookSection } = await import(
  '~/server/services/sticker-book.service'
);

const CREATOR = 11;
const STRANGER = 22;
const MODERATOR = 33;
/**
 * The creator on the OTHER end of a placement the profile subject made.
 * Distinct from everyone else on purpose: with the subject reused as the row's
 * owner, the two sections become indistinguishable and `side === 'placer' ?
 * row.owner : row.placer` can be collapsed to either arm with nothing going red.
 */
const OTHER = 44;
const IMAGE = 500;

const userFindFirst = dbMock.dbRead.user.findFirst;
const placementGroupBy = dbMock.dbRead.placement.groupBy;
const placementFindMany = dbMock.dbRead.placement.findMany;
const imageFindMany = dbMock.dbRead.image.findMany;
const queryRaw = dbMock.dbRead.$queryRaw;

/**
 * Kept as an empty spread so every call reads the same. The service takes no
 * browsing level any more — it returns ids, and the page's own image query is
 * where levels apply.
 */
const levels = {};

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
      owner: { id: OTHER, username: 'other', deletedAt: null },
      placer: { id: STRANGER, username: 'placer', deletedAt: null },
    },
    // A second placement by the same person, so the de-duplication has
    // something to remove — with one row, deleting the Set is invisible.
    {
      targetId: IMAGE,
      createdAt: new Date('2026-08-19'),
      owner: { id: OTHER, username: 'other', deletedAt: null },
      placer: { id: STRANGER, username: 'placer', deletedAt: null },
    },
    // And a deleted account, which keeps its placement but is not somebody to
    // name. Without it, dropping that branch names deleted users and stays green.
    {
      targetId: IMAGE,
      createdAt: new Date('2026-08-18'),
      owner: { id: 77, username: 'gone', deletedAt: new Date('2026-01-01') },
      placer: { id: 88, username: 'alsogone', deletedAt: new Date('2026-01-01') },
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

const EARNED = 1234;

/**
 * Two raw queries share this mock — the sticker holdings and the earnings sum —
 * and a flat `mockResolvedValue` hands the holdings rows to BOTH. That made
 * `earnedBuzz` come out as `undefined ?? 0`, so every mutation inside
 * `getEarnedBuzz` was invisible: dropping the `transactionId IS NOT NULL` guard,
 * dropping `feeToOwner`, dropping the surface filter. Dispatching on the SQL is
 * what lets the money path be asserted at all.
 */
const holdings = () =>
  queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = [...strings].join('');
    if (sql.includes('PlacementTransaction')) return [{ earned: EARNED }];
    return [
      { cosmeticId: 1, remaining: 4, unlimited: false },
      { cosmeticId: 2, remaining: null, unlimited: true },
    ];
  });

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
    // Without the length, gating holdings on `canViewQuantities` instead of
    // `canViewStickers` empties the array, the loop body never runs, and a test
    // named for quantities passes over a payload with no stickers in it.
    expect(book.stickers).toHaveLength(2);
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

  it('returns one card per image, however many placements it carries', async () => {
    // Two placements on one image. The section is a grid of images, not of
    // placements — a repeat per sticker is the shape Ellie objected to.
    const book = await getStickerBook({ username: 'creator', viewerId: CREATOR, ...levels });

    expect(book.received).toHaveLength(1);
    expect(book.received[0].counterparts).toHaveLength(1);
  });

  it('sends image IDS and no image payload', async () => {
    const book = await getStickerBook({ username: 'creator', viewerId: CREATOR, ...levels });

    // 🔴 The invariant that keeps the visibility rules in ONE place. This service
    // decides which images and in what order; whether an image may be SHOWN —
    // browsing level, domain ceiling, publish state, moderation flags, the
    // viewer's hidden users and tags — belongs to `image.getInfinite`, which the
    // page calls with these ids. A url appearing in this payload means a second
    // copy of those rules has grown here, and it is the copy that will drift.
    expect(book.received[0]).not.toHaveProperty('image');
    expect(JSON.stringify(book)).not.toMatch(/"url"/);
    expect(book.received[0].imageId).toBe(IMAGE);

    // And this service asks the image table for nothing at all.
    expect(imageFindMany).not.toHaveBeenCalled();
  });

  it('reports the Buzz the ledger actually paid the owner', async () => {
    const book = await getStickerBook({ username: 'creator', viewerId: CREATOR, ...levels });

    // The number, not just the gate. Dropping the `transactionId IS NOT NULL`
    // guard, dropping `feeToOwner`, or dropping the surface filter all change
    // this value and nothing else in the payload.
    expect(book.earnedBuzz).toBe(EARNED);

    const earnings = queryRaw.mock.calls.filter((call) =>
      String((call[0] as TemplateStringsArray | undefined)?.join?.('') ?? '').includes(
        'PlacementTransaction'
      )
    );
    // The control for the stranger test's zero: if the identifier is ever
    // renamed or moved behind an interpolation, that filter becomes permanently
    // empty and its assertion becomes one that cannot fail.
    expect(earnings).toHaveLength(1);
  });

  it("applies the VIEWER's blocks, not the profile owner's", async () => {
    await getStickerBook({ username: 'creator', viewerId: STRANGER, ...levels });

    // The mock ignores its argument, so without this the whole block feature can
    // be pointed at the wrong user — the creator's blocks applied to everyone's
    // view of their book — with all three block assertions still green.
    expect(blockedPairIds).toHaveBeenCalledWith(STRANGER);
    expect(blockedPairIds).toHaveBeenCalledTimes(1);
  });

  it('asks nobody for blocks when there is no viewer', async () => {
    await getStickerBook({ username: 'creator', ...levels });

    expect(blockedPairIds).not.toHaveBeenCalled();
  });

  it('names the other end of the placement on each side', async () => {
    const book = await getStickerBook({ username: 'creator', viewerId: CREATOR, ...levels });

    // Collapsing `side === 'placer' ? row.owner : row.placer` to either arm
    // survives a fixture where the two are the same person — in production the
    // received section would then name the creator under their own image.
    expect(book.placed[0].counterparts).toEqual([{ id: OTHER, username: 'other' }]);
    expect(book.received[0].counterparts).toEqual([{ id: STRANGER, username: 'placer' }]);
  });

  it('asks only for approved placements', async () => {
    await getStickerBook({ username: 'creator', viewerId: CREATOR, ...levels });

    // `surface` and `targetType` alongside the status: without them this is a
    // book of every placement surface and every target type, and nothing goes
    // red.
    for (const call of placementGroupBy.mock.calls)
      expect(call[0].where).toMatchObject({
        status: 'approved',
        surface: 'sticker',
        targetType: 'image',
      });
  });

  it('excludes the other end of a block from both sections', async () => {
    blockedPairIds.mockResolvedValue([STRANGER]);

    await getStickerBook({ username: 'creator', viewerId: STRANGER, ...levels });

    const wheres = placementGroupBy.mock.calls.map((call) => call[0].where);
    // Asserted as a PAIR on each side, not as two independent facts. Naming the
    // wrong end does not merely filter the wrong column — it takes the place of
    // the id that scopes the query to this creator, and a test that only checked
    // for the presence of a `notIn` passed straight through that.
    expect(wheres).toContainEqual(
      expect.objectContaining({ placerId: CREATOR, ownerId: { notIn: [STRANGER] } })
    );
    expect(wheres).toContainEqual(
      expect.objectContaining({ ownerId: CREATOR, placerId: { notIn: [STRANGER] } })
    );
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
    // The flag alone would keep passing if the early return were ever split from
    // it — which `resolveBookAccess` has just done.
    expect(visitor.placed).toEqual([]);
    expect(visitor.received).toEqual([]);

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

    await expect(getStickerBook({ username: 'creator', ...levels })).rejects.toThrow(/not found/i);
  });

  it('bounds the section limit rather than passing a caller number through', async () => {
    await getStickerBook({ username: 'creator', viewerId: CREATOR, limit: 5000, ...levels });

    // The cap plus the one row that decides `hasMore`. Asserted as the cap it
    // came from rather than as 61, so raising the cap fails here rather than
    // silently letting a caller ask for 5000.
    for (const call of placementGroupBy.mock.calls) expect(call[0].take).toBe(60 + 1);
  });
});

describe('getStickerBookSection — the drill-in page', () => {
  it('refuses a hidden book, as its own gate', async () => {
    // The page is a URL of its own. A guard that lived only on the tab would be
    // no guard at all, and this is exactly the shape that ends up optional
    // during a fix round.
    creatorWithSettings({ hideStickerBook: true });

    const section = await getStickerBookSection({
      username: 'creator',
      side: 'owner',
      viewerId: STRANGER,
      ...levels,
    });

    expect(section.access.canViewBook).toBe(false);
    expect(section.items).toEqual([]);
    expect(placementGroupBy).not.toHaveBeenCalled();
  });

  it('serves the hidden book to a moderator', async () => {
    creatorWithSettings({ hideStickerBook: true });

    const section = await getStickerBookSection({
      username: 'creator',
      side: 'owner',
      viewerId: MODERATOR,
      isModerator: true,
      ...levels,
    });

    expect(section.items).toHaveLength(1);
  });

  it('applies the viewer blocks the same way the tab does', async () => {
    blockedPairIds.mockResolvedValue([STRANGER]);

    await getStickerBookSection({
      username: 'creator',
      side: 'owner',
      viewerId: STRANGER,
      ...levels,
    });

    expect(placementGroupBy.mock.calls[0][0].where).toMatchObject({
      ownerId: CREATOR,
      placerId: { notIn: [STRANGER] },
    });
  });

  it('offsets by whole pages', async () => {
    await getStickerBookSection({
      username: 'creator',
      side: 'placer',
      page: 3,
      limit: 10,
      viewerId: CREATOR,
      ...levels,
    });

    expect(placementGroupBy.mock.calls[0][0].skip).toBe(20);
    expect(placementGroupBy.mock.calls[0][0].take).toBe(11);
  });

  it('starts at the top when no page is given', async () => {
    await getStickerBookSection({
      username: 'creator',
      side: 'placer',
      viewerId: CREATOR,
      ...levels,
    });

    expect(placementGroupBy.mock.calls[0][0].skip).toBe(0);
  });

  it('reports another page from the lookahead row, not from what survived', async () => {
    // Two groups for a page of one. `hasMore` is the extra row the query asked
    // for, so a walk continues on the group count rather than on anything the
    // page happened to render.
    placementGroupBy.mockResolvedValue([
      { targetId: IMAGE, _max: { createdAt: new Date('2026-08-20') } },
      { targetId: IMAGE + 1, _max: { createdAt: new Date('2026-08-19') } },
    ]);

    const section = await getStickerBookSection({
      username: 'creator',
      side: 'owner',
      limit: 1,
      viewerId: CREATOR,
      ...levels,
    });

    expect(section.items).toHaveLength(1);
    expect(section.hasMore).toBe(true);
  });
});

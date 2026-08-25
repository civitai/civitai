import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageService from '~/server/services/image.service';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import { STICKER_BOOK_TAB_LIMIT } from '~/shared/utils/sticker-book';

const blockedPairIds = vi.fn(async () => [] as number[]);
/**
 * Stands in for the feed. The book asks it for the images behind the ids it
 * chose, so a test can withhold one by leaving it out of the answer — which is
 * exactly what the feed does to an image the viewer may not see.
 */
const allImages = vi.fn(async ({ ids }: { ids?: number[] }) => ({
  items: (ids ?? []).map((id) => ({ id, url: `url-${id}` })),
  nextCursor: undefined,
}));

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  getBlockedPairIds: (...args: [number]) => blockedPairIds(...args),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: (...args: [{ ids?: number[] }]) => allImages(...args),
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

/** The level every call asserts, held constant so a difference is a permission. */
const levels = { browsingLevel: 1 };

/** The viewer, as the service takes them — it reads `user.id` for everything. */
const viewer = (id: number) => ({ user: { id } as never });

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

/**
 * A section with more images than the tab draws, so a count assertion is about
 * the tab's own limit rather than about the fixture running out. Ids are even so
 * a test can withhold the odd half and still have enough left to fill the page.
 */
const manyStickeredImages = (count: number) => {
  const rows = (base: number) =>
    Array.from({ length: count }, (_, i) => ({
      targetId: base + i,
      _max: { createdAt: new Date(2026, 0, 1, 0, count - i) },
    }));

  // 🔴 HONOURS `take` AND `skip`, and DISPATCHES ON `where`.
  //
  // `take`: a flat `mockResolvedValue` hands back every row whatever the query
  // asked for, which makes the overfetch invisible — the walk sees all the
  // candidates even with the overfetch removed, and a test named for it passes
  // over code that does not do it. Caught by reverting `SECTION_OVERFETCH`.
  //
  // `where`: without this the two sections return IDENTICAL rows, so the two
  // per-section hydrations hold the same map and sharing one between them is
  // unobservable. In production their image sets are disjoint and the loser's
  // `attach` finds nothing — an empty row.
  placementGroupBy.mockImplementation(
    async (args: { take?: number; skip?: number; where?: { placerId?: number } }) => {
      // 🔴 `typeof === 'number'`, NOT truthiness. On the owner side the service
      // builds `placerId: blocked`, and `blocked` is `{ notIn: [...] }` — an
      // object, so truthy — the moment the viewer has any block. A truthy test
      // would hand both sections the same rows again and silently un-observe the
      // isolation the tests below exist to hold.
      const placedSide = typeof args?.where?.placerId === 'number';
      const all = rows(placedSide ? PLACED_BASE : RECEIVED_BASE);
      const from = args?.skip ?? 0;
      return all.slice(from, from + (args?.take ?? all.length));
    }
  );
  placementFindMany.mockResolvedValue([]);
};

/** Disjoint id ranges, so a section drawing the other one's images is visible. */
const PLACED_BASE = 900;
const RECEIVED_BASE = 5000;

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
  allImages.mockImplementation(async ({ ids }: { ids?: number[] }) => ({
    items: (ids ?? []).map((id) => ({ id, url: `url-${id}` })),
    nextCursor: undefined,
  }));
  blockedPairIds.mockResolvedValue([]);
  creatorWithSettings(null);
  oneStickeredImage();
  holdings();
});

describe('getStickerBook — what leaves the server', () => {
  it('sends a stranger the stickers but never the quantities', async () => {
    const book = await getStickerBook({ username: 'creator', ...viewer(STRANGER), ...levels });

    expect(book.stickers).toHaveLength(2);
    // Absent, not null and not zero: `null` already means unlimited on this
    // field, so a stranger handed `remaining: null` is being told the creator
    // has infinite uses.
    for (const sticker of book.stickers) expect(sticker).not.toHaveProperty('remaining');
  });

  it('sends the owner their own quantities, unlimited included', async () => {
    const book = await getStickerBook({ username: 'creator', ...viewer(CREATOR), ...levels });

    expect(book.stickers).toEqual([
      { cosmeticId: 1, remaining: 4 },
      { cosmeticId: 2, remaining: null },
    ]);
  });

  it('does not send quantities to a moderator', async () => {
    const book = await getStickerBook({
      username: 'creator',
      ...viewer(MODERATOR),
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

    const book = await getStickerBook({ username: 'creator', ...viewer(STRANGER), ...levels });

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
      ...viewer(MODERATOR),
      isModerator: true,
      ...levels,
    });

    expect(book.access.canViewBook).toBe(true);
    expect(book.access.moderatorOverride).toBe(true);
    expect(book.placed).toHaveLength(1);
  });

  it('withholds the stickers alone when only that toggle is set', async () => {
    creatorWithSettings({ hidePurchasedStickers: true });

    const book = await getStickerBook({ username: 'creator', ...viewer(STRANGER), ...levels });

    expect(book.stickers).toEqual([]);
    // The rest of the book is untouched by that toggle.
    expect(book.received).toHaveLength(1);
  });

  it('never sends earnings to a stranger', async () => {
    const book = await getStickerBook({ username: 'creator', ...viewer(STRANGER), ...levels });

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
    const book = await getStickerBook({ username: 'creator', ...viewer(CREATOR), ...levels });

    expect(book.received).toHaveLength(1);
    expect(book.received[0].counterparts).toHaveLength(1);
  });

  it('hydrates its images through the feed, not through a read of its own', async () => {
    const book = await getStickerBook({ username: 'creator', ...viewer(CREATOR), ...levels });

    // 🔴 The invariant that keeps the visibility rules in ONE place. This service
    // decides which images and in what order; whether an image may be SHOWN —
    // browsing level, domain ceiling, publish state, moderation flags, the
    // blocked-tag policy — belongs to `getAllImages`. A `dbRead.image` call here
    // would be a second copy of those rules, and it is the copy that drifts.
    expect(imageFindMany).not.toHaveBeenCalled();
    expect(allImages).toHaveBeenCalled();
    expect(allImages.mock.calls[0][0]).toMatchObject({ ids: [IMAGE], browsingLevel: 1 });
    // 🔴 `user`, and NOT `userId`. The feed reads `userId` as its AUTHOR filter,
    // so passing the viewer there narrows the book to images the viewer
    // uploaded — which empties "images you stickered" entirely, because those
    // are by definition somebody else's. Costs nothing to assert and the bug
    // renders as an empty section rather than as an error.
    expect(allImages.mock.calls[0][0]).not.toHaveProperty('userId');
    expect(allImages.mock.calls[0][0]).toMatchObject({ user: { id: CREATOR } });
    expect(book.received[0].image).toMatchObject({ id: IMAGE });
  });

  it('drops a row whose image the feed withheld', async () => {
    // The feed answering with nothing is how it says "not for this viewer". A
    // book has nothing to act on, so the row goes with it — unlike the review
    // queues, which keep a withheld row so its escrow can still be answered.
    allImages.mockResolvedValue({ items: [], nextCursor: undefined });

    const book = await getStickerBook({ username: 'creator', ...viewer(CREATOR), ...levels });

    expect(book.received).toEqual([]);
    expect(book.placed).toEqual([]);
  });

  it('reports the Buzz the ledger actually paid the owner', async () => {
    const book = await getStickerBook({ username: 'creator', ...viewer(CREATOR), ...levels });

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
    await getStickerBook({ username: 'creator', ...viewer(STRANGER), ...levels });

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
    const book = await getStickerBook({ username: 'creator', ...viewer(CREATOR), ...levels });

    // Collapsing `side === 'placer' ? row.owner : row.placer` to either arm
    // survives a fixture where the two are the same person — in production the
    // received section would then name the creator under their own image.
    expect(book.placed[0].counterparts).toEqual([{ id: OTHER, username: 'other' }]);
    expect(book.received[0].counterparts).toEqual([{ id: STRANGER, username: 'placer' }]);
  });

  it('asks only for approved placements', async () => {
    await getStickerBook({ username: 'creator', ...viewer(CREATOR), ...levels });

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

    await getStickerBook({ username: 'creator', ...viewer(STRANGER), ...levels });

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

    const visitor = await getStickerBook({ username: 'creator', ...viewer(STRANGER), ...levels });
    expect(visitor.access.canViewBook).toBe(false);
    // The flag alone would keep passing if the early return were ever split from
    // it — which `resolveBookAccess` has just done.
    expect(visitor.placed).toEqual([]);
    expect(visitor.received).toEqual([]);

    const moderator = await getStickerBook({
      username: 'creator',
      ...viewer(MODERATOR),
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
    await getStickerBook({ username: 'creator', ...viewer(CREATOR), limit: 5000, ...levels });

    // The cap, overfetched, plus the lookahead row. Written as arithmetic over
    // the two literals rather than as 121, so raising either fails here rather
    // than silently letting a caller ask for 5000.
    for (const call of placementGroupBy.mock.calls) expect(call[0].take).toBe(60 * 2 + 1);

    // 🔴 The invariant the clamp exists for, which the clamp itself cannot show:
    // `imagesForBook` passes `ids.length` as `getInfiniteImagesSchema`'s limit,
    // and that schema caps at 200. Today's window is 121 so this passes without
    // the clamp — it goes red only when someone raises `MAX_SECTION_LIMIT`
    // WITHOUT it, which is the 500 that takes stickers and earnings down too.
    for (const call of placementGroupBy.mock.calls) expect(call[0].take).toBeLessThanOrEqual(200);
  });

  it('overfetches so images the feed withholds cannot leave the tab short', async () => {
    // Forty candidates with every other one withheld. Without the overfetch the
    // tab asks for exactly its 14, loses half of them to the feed, and draws the
    // half-empty last row this was reported for.
    manyStickeredImages(40);
    allImages.mockImplementation(async ({ ids }: { ids?: number[] }) => ({
      items: (ids ?? []).filter((id) => id % 2 === 0).map((id) => ({ id, url: `url-${id}` })),
      nextCursor: undefined,
    }));

    const book = await getStickerBook({ username: 'creator', ...viewer(CREATOR), ...levels });

    // 🔴 The exact ids in order, not a length and a parity check.
    //
    // A parity loop here CANNOT FAIL: `attach` drops any row whose id is absent
    // from the hydration map, and that map holds only the evens — so every row
    // reaching the assertion is even whatever the walk did. Length alone is just
    // as weak: it stays green under a walk that reverses the candidates (oldest
    // first), or pushes `groups[0]` fourteen times. Only the id list sees those.
    expect(book.placed.map((row) => row.imageId)).toEqual(
      Array.from({ length: STICKER_BOOK_TAB_LIMIT }, (_, i) => PLACED_BASE + i * 2)
    );
  });

  it('keeps the two sections hydrated apart', async () => {
    // One `sectionImages` per section. Shared, the second hydration erases the
    // first and the losing section renders empty — and with a fixture whose two
    // sections return the same rows, that mutation is invisible.
    manyStickeredImages(20);

    const book = await getStickerBook({ username: 'creator', ...viewer(CREATOR), ...levels });

    expect(book.placed.map((row) => row.imageId)).toEqual(
      Array.from({ length: STICKER_BOOK_TAB_LIMIT }, (_, i) => PLACED_BASE + i)
    );
    expect(book.received.map((row) => row.imageId)).toEqual(
      Array.from({ length: STICKER_BOOK_TAB_LIMIT }, (_, i) => RECEIVED_BASE + i)
    );
    // One feed query per section. A regression to hydrating twice would still
    // return the right rows, so the count is the only thing that sees it.
    expect(allImages).toHaveBeenCalledTimes(2);
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
      ...viewer(STRANGER),
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
      ...viewer(MODERATOR),
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
      ...viewer(STRANGER),
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
      ...viewer(CREATOR),
      ...levels,
    });

    expect(placementGroupBy.mock.calls[0][0].skip).toBe(20);
    expect(placementGroupBy.mock.calls[0][0].take).toBe(11);
  });

  it('starts at the top when no page is given', async () => {
    await getStickerBookSection({
      username: 'creator',
      side: 'placer',
      ...viewer(CREATOR),
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
      ...viewer(CREATOR),
      ...levels,
    });

    expect(section.items).toHaveLength(1);
    expect(section.hasMore).toBe(true);
  });
});

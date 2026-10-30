import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PlacementEscrow from '~/server/services/placement-escrow.service';
import type * as PlacementModeration from '~/server/services/placement-moderation.service';
import type * as PlacementSpaceService from '~/server/services/placement-space.service';
import type * as StorylineService from '~/server/services/storyline.service';
import type { ResolvedPlacementSpace } from '~/server/services/placement-space.service';
import { PLACEMENT_SURFACES } from '~/shared/utils/placement';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';

const resolveSpace = vi.fn();
const assertCanPlace = vi.fn();
const holdPlacementEscrow = vi.fn();
const settlePlacement = vi.fn();
const assertCanContinueStoryline = vi.fn();

vi.mock('~/server/services/placement-space.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementSpaceService>()),
  resolvePlacementSpaceFor: resolveSpace,
}));
vi.mock('~/server/services/placement-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementModeration>()),
  assertCanPlace,
}));
vi.mock('~/server/services/placement-escrow.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementEscrow>()),
  holdPlacementEscrow,
  settlePlacement,
}));

vi.mock('~/server/services/storyline.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StorylineService>()),
  assertCanContinueStoryline,
}));

const { createStorylinePlacement } = await import('~/server/services/storyline-placement.service');
// Real, not stubbed: the tests below run the free tier's own predicates over the rows a storyline
// submission writes.
const { getFreePlacementAllowance, hasUsedFreePlacementOn } = await import(
  '~/server/services/free-placement.service'
);

const OWNER = 10;
const PLACER = 20;
const CHAPTER = 77;
const CONTINUATION = 78;
const PLACER_LOCK_CLASS = 0x74ee0003;

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/**
 * One table every fake reads and writes, so a cap or an allowance is decided by
 * rows the code under test actually wrote rather than by a number handed back.
 */
let rows: Row[];

/**
 * The subset of Prisma `where` these services use, evaluated over `rows`. An
 * operator it does not know throws rather than matching, so a predicate this
 * fake cannot see is a failure by name instead of a silent pass.
 */
const matches = (row: Row, where: Where) =>
  Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const ops = condition as Record<string, unknown>;
      for (const op of Object.keys(ops))
        if (op !== 'gte' && op !== 'in') throw new Error(`fake: unsupported operator ${op}`);
      if ('gte' in ops && !((row[key] as Date) >= (ops.gte as Date))) return false;
      if ('in' in ops && !(ops.in as unknown[]).includes(row[key])) return false;
      return true;
    }
    return row[key] === condition;
  });

/**
 * The transaction gets its own client, distinct from `dbWrite`, and every call
 * on it is recorded in order. A lock or a count made on `dbWrite` outside the
 * callback lands on the wrong client and is visible as such: an xact lock taken
 * outside a transaction is released at the end of its own statement.
 */
let txLog: string[];
const tx = {
  $executeRawUnsafe: vi.fn(async (sql: string) => {
    txLog.push(`unsafe ${sql}`);
    return 0;
  }),
  $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    txLog.push(`raw ${strings.join('?')} [${values.join(',')}]`);
    return 0;
  }),
  // Only the storyline lock: the storyline of the chapter on the parent post.
  $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!/FOR SHARE OF st\s*$/.test(strings.join('?')))
      throw new Error('fake: unexpected raw query in the submit transaction');
    txLog.push(`lock storyline of post ${values.join(',')}`);
    return [{ id: 1 }];
  }),
  placement: {
    count: vi.fn(async ({ where }: { where: Where }) => {
      txLog.push('count');
      return rows.filter((row) => matches(row, where)).length;
    }),
    // Only the shape the duplicate check sends: a status list and a payload
    // path. Anything else throws, so a changed predicate fails by name.
    findFirst: vi.fn(async ({ where }: { where: Where }) => {
      txLog.push('findFirst');
      const { data, status, ...rest } = where as {
        data: { path: string[]; equals: unknown };
        status: { in: string[] };
      };
      if (data?.path?.join('.') !== 'postId' || !status?.in)
        throw new Error('fake: unexpected duplicate predicate');
      const hit = rows.find(
        (row) =>
          matches(row, rest) &&
          status.in.includes(row.status as string) &&
          (row.data as Row | undefined)?.postId === data.equals
      );
      return hit ? { id: rows.indexOf(hit) + 1 } : null;
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      txLog.push('create');
      rows.push({ createdAt: new Date(), ...data });
      return { id: rows.length };
    }),
  },
};

type Image = {
  ingestion: string;
  tosViolation: boolean;
  minor: boolean;
  poi: boolean;
  needsReview: string | null;
};
const SCANNED: Image = {
  ingestion: 'Scanned',
  tosViolation: false,
  minor: false,
  poi: false,
  needsReview: null,
};

/** The continuation post, finished and rated PG unless overridden. */
const givenPost = (
  overrides: Partial<{
    userId: number;
    publishedAt: Date | null;
    nsfwLevel: number;
    tosViolation: boolean;
    storylineChapter: { id: number } | null;
    images: Image[];
  }> = {}
) =>
  dbMock.dbWrite.post.findUnique.mockResolvedValue({
    userId: PLACER,
    publishedAt: new Date('2026-01-01'),
    nsfwLevel: 1,
    tosViolation: false,
    storylineChapter: null,
    images: [SCANNED],
    ...overrides,
  });

/**
 * What the storyline service's `assertCanContinueStoryline` returns for a placer it lets through.
 */
const givenAccess = ({
  isCollaborator = false,
  whoCanContinue = 'Anyone',
  maxNsfwLevel = 4,
}: { isCollaborator?: boolean; whoCanContinue?: string; maxNsfwLevel?: number } = {}) =>
  assertCanContinueStoryline.mockResolvedValue({
    storylineId: 5,
    ownerId: OWNER,
    isOwner: false,
    isCollaborator,
    parent: {
      id: 1,
      storylineId: 5,
      depth: 0,
      userId: OWNER,
      storyline: { userId: OWNER, maxNsfwLevel, tosViolation: false, whoCanContinue },
    },
  });

const givenTable = () => {
  rows = [];
  txLog = [];
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) =>
    fn(tx)
  );
  // The free tier's display reads, against the same table.
  dbMock.dbRead.placement.count.mockImplementation(
    async ({ where }: { where: Where }) => rows.filter((row) => matches(row, where)).length
  );
};

const givenSpace = (overrides: Partial<ResolvedPlacementSpace> = {}) =>
  resolveSpace.mockResolvedValue({
    ownerId: OWNER,
    ownerUsername: 'storyteller',
    mode: 'review',
    setPrice: 0,
    price: 0,
    cap: 500,
    ownerShare: 1,
    declineFee: 0,
    declineFeeRate: 0.3,
    hostDeclineFeePercent: null,
    setFreeSlots: 0,
    freeSlots: 0,
    freeSlotCap: 1,
    freeSlotsRemaining: 0,
    settings: {},
    ...overrides,
  } satisfies ResolvedPlacementSpace);

const submit = (overrides: { expectedPrice?: number; placerId?: number; postId?: number } = {}) =>
  createStorylinePlacement({
    placerId: PLACER,
    parentPostId: CHAPTER,
    postId: CONTINUATION,
    expectedPrice: 0,
    spendType: 'yellow',
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  givenTable();
  givenSpace();
  assertCanPlace.mockResolvedValue(undefined);
  givenPost();
  givenAccess();
  // `settleStorylineContinuation` checks the surface before it settles.
  dbMock.dbWrite.placement.findUnique.mockResolvedValue({ surface: 'storyline' });
  holdPlacementEscrow.mockResolvedValue({ fee: 0, principal: 0 });
  settlePlacement.mockResolvedValue({ settled: true });
});

describe('createStorylinePlacement — priced at zero', () => {
  it('lands five continuations on one zero-priced storyline in one day', async () => {
    for (let i = 0; i < 5; i++)
      await expect(submit({ postId: CONTINUATION + i })).resolves.toEqual({ id: i + 1 });

    expect(rows).toHaveLength(5);
    for (const [i, row] of rows.entries())
      expect(row).toMatchObject({
        surface: 'storyline',
        targetType: 'post',
        targetId: CHAPTER,
        data: { postId: CONTINUATION + i },
        ownerId: OWNER,
        placerId: PLACER,
        free: false,
        amount: 0,
        status: 'pending',
        spendType: 'yellow',
      });
  });

  // Nothing to hold. The escrow would return harmlessly for zero, but a call
  // here would also re-stamp and re-check a row that has no money behind it.
  it('takes no escrow', async () => {
    await submit();

    expect(holdPlacementEscrow).not.toHaveBeenCalled();
  });

  it('stamps a deadline in the insert, at the storyline expiry', async () => {
    const before = Date.now();
    await submit();

    const expiresAt = rows[0].expiresAt as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    const hours = (expiresAt.getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThanOrEqual(PLACEMENT_SURFACES.storyline.expiryHours - 0.01);
    expect(hours).toBeLessThan(PLACEMENT_SURFACES.storyline.expiryHours + 0.01);
    // Its own expiry: a fallback to another surface's would not pass the window above.
    expect(PLACEMENT_SURFACES.storyline.expiryHours).not.toBe(
      PLACEMENT_SURFACES.sticker.expiryHours
    );
  });
});

/**
 * A zero-priced continuation spends neither the placer's daily free allowance nor their
 * once-per-target free placement. Run through the free tier's own predicates
 * (`getFreePlacementAllowance`, `hasUsedFreePlacementOn`) over the rows the storyline path wrote,
 * so this goes red if a storyline row is written as `free`, or the allowance count stops selecting
 * on `free`.
 */
describe('createStorylinePlacement — the free allowance is untouched', () => {
  it('leaves the daily allowance and the free-on-target rule unspent after five', async () => {
    for (let i = 0; i < 5; i++) await submit({ postId: CONTINUATION + i });

    await expect(getFreePlacementAllowance({ placerId: PLACER })).resolves.toMatchObject({
      used: 0,
      remaining: 1,
    });
    await expect(
      hasUsedFreePlacementOn({
        surface: 'storyline',
        targetType: 'post',
        targetId: CHAPTER,
        placerId: PLACER,
      })
    ).resolves.toBe(false);
  });

  // The control for the test above: the same reads DO see a free row made
  // today, so their zeros there are the rows' doing and not the fake's.
  it('would see a free placement made today', async () => {
    await submit();
    rows.push({
      surface: 'sticker',
      targetType: 'image',
      targetId: 5,
      placerId: PLACER,
      free: true,
      createdAt: new Date(),
    });

    await expect(getFreePlacementAllowance({ placerId: PLACER })).resolves.toMatchObject({
      used: 1,
      remaining: 0,
    });
  });
});

describe('createStorylinePlacement — the pending cap', () => {
  // With no price, the cap is the spam control an owner has left. Counted from
  // rows this test wrote, so a cap that read the wrong predicate would let the
  // eleventh through.
  it('refuses the continuation past the per-owner pending cap', async () => {
    const cap = PLACEMENT_SURFACES.storyline.maxPendingPerOwner;
    for (let i = 0; i < cap; i++) await submit({ postId: CONTINUATION + i });

    await expect(submit({ postId: CONTINUATION + cap })).rejects.toThrow(
      /maximum continuations waiting/
    );
    expect(rows).toHaveLength(cap);
  });

  // Rows that must not count: someone else's, another owner's, ones already
  // answered, and pending ones on another surface. Seeded at the cap each, so a
  // predicate that dropped any one column refuses the first submission.
  it('counts only this placer’s pending continuations with this owner', async () => {
    const cap = PLACEMENT_SURFACES.storyline.maxPendingPerOwner;
    const seed = (row: Row) => {
      for (let i = 0; i < cap; i++) rows.push({ createdAt: new Date(), ...row });
    };
    const base = { surface: 'storyline', ownerId: OWNER, placerId: PLACER, status: 'pending' };
    seed({ ...base, placerId: PLACER + 1 });
    seed({ ...base, ownerId: OWNER + 1 });
    seed({ ...base, status: 'approved' });
    seed({ ...base, status: 'declined' });
    seed({ ...base, surface: 'remixGallery' });

    for (let i = 0; i < cap; i++)
      await expect(submit({ postId: CONTINUATION + i })).resolves.toBeDefined();
    await expect(submit({ postId: CONTINUATION + cap })).rejects.toThrow(
      /maximum continuations waiting/
    );
  });

  // A spammer pays nothing to race the cap, so the count and the insert happen
  // after the lock, in the transaction, in this order — and nothing of it on
  // `dbWrite` outside the callback.
  it('counts and inserts under a per-placer lock, inside the transaction', async () => {
    await submit();

    expect(txLog).toEqual([
      "unsafe SET LOCAL lock_timeout = '3s'",
      `raw SELECT pg_advisory_xact_lock(?::int, ?::int) [${PLACER_LOCK_CLASS},${PLACER}]`,
      'count',
      'findFirst',
      `lock storyline of post ${CHAPTER}`,
      'create',
    ]);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.placement.count).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.placement.create).not.toHaveBeenCalled();
  });
  // The storyline lock is what makes a delete wait for this submit, or this submit see the
  // delete: a storyline deleted between the terms check and the insert is refused, not escrowed.
  it('refuses, taking no Buzz, when the storyline is gone by the time it locks', async () => {
    tx.$queryRaw.mockResolvedValueOnce([] as never);
    await expect(submit()).rejects.toThrow(STORYLINE_REFUSALS.notAChapter);
    expect(tx.placement.create).not.toHaveBeenCalled();
  });
});

describe('createStorylinePlacement — the rules that hold at any price', () => {
  it('refuses a closed storyline', async () => {
    givenSpace({ mode: 'off' });
    await expect(submit()).rejects.toThrow(/not accepting continuations/);
    expect(rows).toHaveLength(0);
  });

  it('refuses a mode the surface does not allow, however the row got that way', async () => {
    givenSpace({ mode: 'auto' });
    await expect(submit()).rejects.toThrow(/not accepting continuations/);
    expect(rows).toHaveLength(0);
  });

  it('refuses continuing your own storyline through a placement', async () => {
    givenSpace({ ownerId: PLACER });
    await expect(submit()).rejects.toThrow(/your own storyline/);
    expect(rows).toHaveLength(0);
  });

  // A continuation offers the placer's OWN post; someone else's would put the placer's name on it.
  it('refuses offering a post the placer does not own', async () => {
    givenPost({ userId: PLACER + 1 });
    await expect(submit()).rejects.toThrow(new RegExp(STORYLINE_REFUSALS.notYourPost));
    expect(dbMock.dbWrite.post.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CONTINUATION } })
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a post that no longer exists', async () => {
    dbMock.dbWrite.post.findUnique.mockResolvedValue(null);
    await expect(submit()).rejects.toThrow(new RegExp(STORYLINE_REFUSALS.notYourPost));
    expect(rows).toHaveLength(0);
  });

  // At a price, a refusal must come before any money moves.
  it('refuses before taking escrow on a priced storyline', async () => {
    givenSpace({ price: 100, setPrice: 100 });
    givenPost({ userId: PLACER + 1 });
    await expect(submit({ expectedPrice: 100 })).rejects.toThrow(
      new RegExp(STORYLINE_REFUSALS.notYourPost)
    );
    await expect(submit({ expectedPrice: 100, postId: CHAPTER })).rejects.toThrow(
      /cannot continue itself/
    );
    expect(holdPlacementEscrow).not.toHaveBeenCalled();
  });

  it('refuses a chapter continuing itself', async () => {
    await expect(submit({ postId: CHAPTER } as never)).rejects.toThrow(/cannot continue itself/);
    expect(rows).toHaveLength(0);
  });

  it('resolves the space from the chapter post being continued', async () => {
    await submit();
    expect(resolveSpace).toHaveBeenCalledTimes(1);
    expect(resolveSpace).toHaveBeenCalledWith({
      surface: 'storyline',
      targetType: 'post',
      targetId: CHAPTER,
    });
  });

  it('refuses a hand-edited space with no price', async () => {
    givenSpace({ price: null, setPrice: null });
    await expect(submit()).rejects.toThrow(/not set a price/);
    expect(rows).toHaveLength(0);
  });

  it('refuses a blocked or suspended placer', async () => {
    assertCanPlace.mockRejectedValue(
      new Error('placement: your placement privileges are suspended')
    );
    await expect(submit()).rejects.toThrow(/suspended/);
    expect(rows).toHaveLength(0);
  });

  // Blocks and suspension are a statement about this pair, the right way round.
  // Swapped, a suspended placer would be checked as an owner and pass.
  it('checks the placer against the owner it resolved', async () => {
    await submit();
    expect(assertCanPlace).toHaveBeenCalledWith({ ownerId: OWNER, placerId: PLACER });
  });

  // The price the placer saw was free; the owner has since started charging.
  // Charging them is a spend they never agreed to.
  it('refuses when the owner started charging after the placer looked', async () => {
    givenSpace({ price: 100, setPrice: 100 });
    await expect(submit({ expectedPrice: 0 })).rejects.toThrow(
      /^storyline: the price changed while you were deciding: now 100 Buzz$/
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses when the owner dropped the price after the placer looked', async () => {
    await expect(submit({ expectedPrice: 100 })).rejects.toThrow(
      /^storyline: the price changed while you were deciding: now 0 Buzz$/
    );
    expect(rows).toHaveLength(0);
  });
});

describe('createStorylinePlacement — priced above zero', () => {
  beforeEach(() => givenSpace({ price: 100, setPrice: 100 }));

  it('writes the price and takes the escrow for it', async () => {
    await submit({ expectedPrice: 100 });

    expect(rows[0]).toMatchObject({ free: false, amount: 100 });
    expect(holdPlacementEscrow).toHaveBeenCalledWith({
      placementId: 1,
      placerId: PLACER,
      surface: 'storyline',
      amount: 100,
      spendType: 'yellow',
    });
  });

  it('expires the row it just wrote when the escrow cannot be taken', async () => {
    holdPlacementEscrow.mockRejectedValue(new Error('insufficient funds'));

    await expect(submit({ expectedPrice: 100 })).rejects.toThrow(/insufficient funds/);
    expect(settlePlacement).toHaveBeenCalledWith({ placementId: 1, action: 'expire' });
  });
});

/**
 * Who may continue, decided by the storyline service's assert (blocks,
 * collaborators-only) and the access rule (closed, auto-approve, review).
 */
describe('createStorylinePlacement — who may continue', () => {
  // Settles the way the real escrow does as far as these tests can see: the
  // row it names leaves `pending`.
  const settleFlips = () =>
    settlePlacement.mockImplementation(
      async ({ placementId, action }: { placementId: number; action: string }) => {
        rows[placementId - 1].status = action === 'approve' ? 'approved' : 'declined';
        return { settled: true, placement: rows[placementId - 1] };
      }
    );

  it('asks the storyline service about this placer and this chapter', async () => {
    await submit();
    expect(assertCanContinueStoryline).toHaveBeenCalledWith({
      parentPostId: CHAPTER,
      placerId: PLACER,
    });
  });

  it('lands an endorsed collaborator approved, with no pending row left', async () => {
    settleFlips();
    givenAccess({ isCollaborator: true });

    await expect(submit()).resolves.toEqual({ id: 1 });

    expect(settlePlacement).toHaveBeenCalledTimes(1);
    expect(settlePlacement).toHaveBeenCalledWith(
      expect.objectContaining({
        placementId: 1,
        action: 'approve',
        inTransaction: expect.any(Function),
      })
    );
    expect(rows.map((row) => row.status)).toEqual(['approved']);
  });

  it('lands an endorsed collaborator approved on a collaborators-only storyline', async () => {
    settleFlips();
    givenAccess({ isCollaborator: true, whoCanContinue: 'Collaborators' });

    await submit();
    expect(rows.map((row) => row.status)).toEqual(['approved']);
  });

  it('lands a stranger pending for the owner', async () => {
    settleFlips();

    await submit();
    expect(settlePlacement).not.toHaveBeenCalled();
    expect(rows.map((row) => row.status)).toEqual(['pending']);
  });

  it('refuses a stranger on a collaborators-only storyline, before writing', async () => {
    assertCanContinueStoryline.mockRejectedValue(new Error(STORYLINE_REFUSALS.collaboratorsOnly));

    await expect(submit()).rejects.toThrow(STORYLINE_REFUSALS.collaboratorsOnly);
    expect(rows).toHaveLength(0);
  });

  // The access rule refuses it too, should the assert ever let one through.
  it('refuses a stranger the assert let through on a collaborators-only storyline', async () => {
    givenAccess({ whoCanContinue: 'Collaborators' });

    await expect(submit()).rejects.toThrow(STORYLINE_REFUSALS.collaboratorsOnly);
    expect(rows).toHaveLength(0);
  });

  it('refuses a collaborator on a closed storyline', async () => {
    givenSpace({ mode: 'off' });
    givenAccess({ isCollaborator: true });

    await expect(submit()).rejects.toThrow(STORYLINE_REFUSALS.notOpen);
    expect(rows).toHaveLength(0);
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  it('refuses a placer the storyline service refuses (a block)', async () => {
    assertCanContinueStoryline.mockRejectedValue(
      new Error('Continuations are not available on this chapter')
    );
    await expect(submit()).rejects.toThrow(/not available on this chapter/);
    expect(rows).toHaveLength(0);
  });

  // The row is written and, at a price, paid for. An approval the edge refuses
  // leaves it with the owner rather than failing a submission that happened.
  it('leaves an endorsed continuation pending when its approval is refused', async () => {
    givenAccess({ isCollaborator: true });
    settlePlacement.mockRejectedValue(new Error('This post is already in a storyline'));

    await expect(submit()).resolves.toEqual({ id: 1 });
    // Attempted, so pending is the refusal's doing and not a skipped approval.
    expect(settlePlacement).toHaveBeenCalledTimes(1);
    expect(rows.map((row) => row.status)).toEqual(['pending']);
  });
});

describe('createStorylinePlacement — the continuation post', () => {
  // One message for every verdict on purpose: saying which one would let anyone probe the scans.
  it.each([
    ['taken down', { tosViolation: true }],
    ['with a taken-down image', { images: [{ ...SCANNED, tosViolation: true }] }],
    ['with a minor image', { images: [SCANNED, { ...SCANNED, minor: true }] }],
    ['with a poi image', { images: [{ ...SCANNED, poi: true }] }],
    ['with a blocked image', { images: [{ ...SCANNED, ingestion: 'Blocked' }] }],
    // A verdict refuses even while the post is a draft: waiting cannot clear it.
    [
      'blocked and unpublished',
      { publishedAt: null, images: [{ ...SCANNED, ingestion: 'Blocked' }] },
    ],
  ])('refuses a post %s', async (_, post) => {
    givenPost(post);
    await expect(submit()).rejects.toThrow(STORYLINE_REFUSALS.cannotSubmit);
    expect(rows).toHaveLength(0);
  });

  it('refuses a post rated above the storyline', async () => {
    givenAccess({ maxNsfwLevel: 1 });
    givenPost({ nsfwLevel: 4 });
    await expect(submit()).rejects.toThrow(
      `${STORYLINE_REFUSALS.aboveRating}. This storyline allows up to PG; this post is R`
    );
    expect(rows).toHaveLength(0);
  });

  // Blocked is a moderation verdict, not a rating: it is refused like the other verdicts.
  it('refuses a post at the Blocked level without naming it', async () => {
    givenAccess({ maxNsfwLevel: 1 });
    givenPost({ nsfwLevel: 4 | 32 });
    await expect(submit()).rejects.toThrow(new RegExp(`^${STORYLINE_REFUSALS.cannotSubmit}$`));
    expect(rows).toHaveLength(0);
  });

  // The control for the refusal above: the same post under a higher ceiling lands.
  it('takes the same post under a ceiling it fits', async () => {
    givenAccess({ maxNsfwLevel: 4 });
    givenPost({ nsfwLevel: 4 });
    await expect(submit()).resolves.toEqual({ id: 1 });
  });

  it('refuses a post with an image under review', async () => {
    givenPost({ images: [{ ...SCANNED, needsReview: 'poi' }] });
    await expect(submit()).rejects.toThrow(STORYLINE_REFUSALS.inReview);
    expect(rows).toHaveLength(0);
  });

  it('refuses a post that is already a chapter', async () => {
    givenPost({ storylineChapter: { id: 9 } });
    await expect(submit()).rejects.toThrow(STORYLINE_REFUSALS.alreadyAChapter);
    expect(rows).toHaveLength(0);
  });

  it.each([
    ['unpublished', { publishedAt: null }],
    ['scheduled', { publishedAt: new Date(Date.now() + 86_400_000) }],
    ['still scanning', { images: [SCANNED, { ...SCANNED, ingestion: 'Pending' }] }],
    ['without images yet', { images: [] }],
    ['not rated yet', { nsfwLevel: 0 }],
  ])('accepts a post %s and marks it awaiting readiness', async (_, post) => {
    givenPost(post);
    await submit();
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toEqual({ postId: CONTINUATION, awaitingReadiness: true });
  });

  // The rating cannot be compared until there is one: an unscanned post rated
  // above the ceiling waits, and the readiness pass refuses it.
  it('defers the rating check on a post still scanning', async () => {
    givenAccess({ maxNsfwLevel: 1 });
    givenPost({ nsfwLevel: 16, images: [{ ...SCANNED, ingestion: 'Pending' }] });
    await submit();
    expect(rows[0].data).toEqual({ postId: CONTINUATION, awaitingReadiness: true });
  });

  it('leaves a finished post unmarked', async () => {
    await submit();
    expect(rows[0].data).toEqual({ postId: CONTINUATION });
  });

  // The approval would refuse an unfinished post; the readiness pass approves it.
  it('does not auto-approve a collaborator whose post is not ready', async () => {
    givenAccess({ isCollaborator: true });
    givenPost({ publishedAt: null });
    await submit();
    expect(settlePlacement).not.toHaveBeenCalled();
    expect(rows[0].status).toBe('pending');
  });

  it.each(['pending', 'approved'])(
    'refuses a post already %s as a continuation',
    async (status) => {
      rows.push({ surface: 'storyline', status, data: { postId: CONTINUATION } });
      await expect(submit()).rejects.toThrow(STORYLINE_REFUSALS.alreadySubmitted);
      expect(rows).toHaveLength(1);
    }
  );

  // Answered ones do not hold the post: a declined continuation may be offered again.
  it('takes a post whose earlier continuation was declined or expired', async () => {
    rows.push({ surface: 'storyline', status: 'declined', data: { postId: CONTINUATION } });
    rows.push({ surface: 'storyline', status: 'expired', data: { postId: CONTINUATION } });
    await expect(submit()).resolves.toEqual({ id: 3 });
  });
});

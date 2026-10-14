import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PlacementEscrow from '~/server/services/placement-escrow.service';
import type * as PlacementModeration from '~/server/services/placement-moderation.service';
import type * as PlacementSpaceService from '~/server/services/placement-space.service';
import type { ResolvedPlacementSpace } from '~/server/services/placement-space.service';
import { PLACEMENT_SURFACES } from '~/shared/utils/placement';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';

const resolveSpace = vi.fn();
const assertCanPlace = vi.fn();
const holdPlacementEscrow = vi.fn();
const settlePlacement = vi.fn();

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

const { createStorylinePlacement } = await import('~/server/services/storyline-placement.service');
// Real, not stubbed: the D2 tests below run the free tier's own predicates over
// the rows a storyline submission writes.
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
  placement: {
    count: vi.fn(async ({ where }: { where: Where }) => {
      txLog.push('count');
      return rows.filter((row) => matches(row, where)).length;
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      txLog.push('create');
      rows.push({ createdAt: new Date(), ...data });
      return { id: rows.length };
    }),
  },
};

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
  dbMock.dbWrite.post.findUnique.mockResolvedValue({ userId: PLACER });
  holdPlacementEscrow.mockResolvedValue({ fee: 0, principal: 0 });
  settlePlacement.mockResolvedValue({ settled: true });
});

describe('createStorylinePlacement — priced at zero', () => {
  // The closing condition for zero-priced surfaces: one placer, one storyline,
  // one UTC day, five continuations, all land. On a sticker or a remix gallery
  // the second would be refused by the daily allowance and the third by the
  // once-per-target rule; here neither applies because these are not free rows.
  it('lands five continuations on one zero-priced storyline in one day', async () => {
    for (let i = 0; i < 5; i++) await expect(submit()).resolves.toEqual({ id: i + 1 });

    expect(rows).toHaveLength(5);
    for (const row of rows)
      expect(row).toMatchObject({
        surface: 'storyline',
        targetType: 'post',
        targetId: CHAPTER,
        data: { postId: CONTINUATION },
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
    // Its own figure: 48h is what every other surface uses, so a fallback to
    // another surface's expiry would not pass the window above.
    expect(PLACEMENT_SURFACES.storyline.expiryHours).not.toBe(
      PLACEMENT_SURFACES.sticker.expiryHours
    );
  });
});

/**
 * D2, end to end: a zero-priced continuation spends neither the placer's daily
 * free allowance nor their once-per-target free placement. Run through the free
 * tier's own predicates (`getFreePlacementAllowance`, `hasUsedFreePlacementOn`),
 * over the rows the storyline path wrote, so this goes red if either side moves:
 * a storyline row written as `free`, or an allowance count that stops selecting
 * on `free`.
 */
describe('createStorylinePlacement — the free allowance is untouched', () => {
  it('leaves the daily allowance and the free-on-target rule unspent after five', async () => {
    for (let i = 0; i < 5; i++) await submit();

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
    for (let i = 0; i < cap; i++) await submit();

    await expect(submit()).rejects.toThrow(/maximum continuations waiting/);
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

    for (let i = 0; i < cap; i++) await expect(submit()).resolves.toBeDefined();
    await expect(submit()).rejects.toThrow(/maximum continuations waiting/);
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
      'create',
    ]);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.placement.count).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.placement.create).not.toHaveBeenCalled();
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

  // The closing condition for posts as targets: a continuation offers the
  // placer's OWN post. Someone else's would put the placer's name on it.
  it('refuses offering a post the placer does not own', async () => {
    dbMock.dbWrite.post.findUnique.mockResolvedValue({ userId: PLACER + 1 });
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
    dbMock.dbWrite.post.findUnique.mockResolvedValue({ userId: PLACER + 1 });
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

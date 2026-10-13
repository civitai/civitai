import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PlacementEscrow from '~/server/services/placement-escrow.service';
import type * as PlacementModeration from '~/server/services/placement-moderation.service';
import type * as PlacementSpaceService from '~/server/services/placement-space.service';
import type { ResolvedPlacementSpace } from '~/server/services/placement-space.service';
import { PLACEMENT_SURFACES } from '~/shared/utils/placement';

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

const OWNER = 10;
const PLACER = 20;
const CHAPTER = 77;

const placementCount = dbMock.dbWrite.placement.count;
const placementCreate = dbMock.dbWrite.placement.create;
const executeRaw = dbMock.dbWrite.$executeRaw;

/**
 * A table the fake count and create share, so the pending cap is decided by rows
 * this test actually wrote rather than by a number handed to the count.
 *
 * Any count that is not the pending cap throws. The free tier's questions — the
 * daily allowance and the reserved slots — both select on `free: true`, and a
 * zero-priced continuation must ask neither; a count this fake does not
 * recognise is that mistake, reported by name instead of answered with 0.
 */
let rows: Record<string, unknown>[];
const givenTable = () => {
  rows = [];
  placementCount.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if ('free' in where || 'createdAt' in where)
      throw new Error(
        `a storyline continuation asked a free-tier question: ${JSON.stringify(where)}`
      );
    if (where.status !== 'pending' || where.ownerId === undefined)
      throw new Error(`unrecognised count: ${JSON.stringify(where)}`);
    return rows.filter(
      (row) =>
        row.surface === where.surface &&
        row.ownerId === where.ownerId &&
        row.placerId === where.placerId &&
        row.status === 'pending'
    ).length;
  });
  placementCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    rows.push(data);
    return { id: rows.length };
  });
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

const submit = (overrides: { expectedPrice?: number } = {}) =>
  createStorylinePlacement({
    placerId: PLACER,
    targetType: 'image',
    targetId: CHAPTER,
    spendType: 'yellow',
    data: { postId: 1 },
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  givenTable();
  givenSpace();
  assertCanPlace.mockResolvedValue(undefined);
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
        targetId: CHAPTER,
        ownerId: OWNER,
        placerId: PLACER,
        free: false,
        amount: 0,
        status: 'pending',
        spendType: 'yellow',
      });
  });

  // `free: false` is what keeps a zero-priced continuation out of both free-tier
  // counts. Written `true`, it would spend the placer's one free sticker or remix
  // of the day, and hold one of the creator's free slots.
  it('writes an ordinary row worth nothing, never a free one', async () => {
    await submit();

    expect(rows[0].free).toBe(false);
    expect(rows[0].amount).toBe(0);
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
  });

  // With no price, the cap is the spam control an owner has left. It is counted
  // from rows this test wrote, so a cap that read the wrong predicate would let
  // the eleventh through.
  it('refuses the continuation past the per-owner pending cap', async () => {
    const cap = PLACEMENT_SURFACES.storyline.maxPendingPerOwner;
    for (let i = 0; i < cap; i++) await submit();

    await expect(submit()).rejects.toThrow(/maximum continuations waiting/);
    expect(rows).toHaveLength(cap);
  });

  // A spammer pays nothing to race the cap, so it is counted under a lock in the
  // same transaction as the insert.
  it('counts the pending cap under a per-placer lock', async () => {
    await submit();

    const lock = executeRaw.mock.calls.find(([strings]: [TemplateStringsArray]) =>
      strings.join('?').includes('pg_advisory_xact_lock')
    );
    expect(lock).toBeDefined();
    expect(lock![0].join('?')).toBe('SELECT pg_advisory_xact_lock(?::int, ?::int)');
    expect(lock![2]).toBe(PLACER);
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

  it('refuses a blocked or suspended placer', async () => {
    assertCanPlace.mockRejectedValue(
      new Error('placement: your placement privileges are suspended')
    );
    await expect(submit()).rejects.toThrow(/suspended/);
    expect(rows).toHaveLength(0);
  });

  // The price the placer saw was free; the owner has since started charging.
  // Charging them is a spend they never agreed to.
  it('refuses when the price moved off the one the placer was shown', async () => {
    givenSpace({ price: 100, setPrice: 100 });
    await expect(submit({ expectedPrice: 0 })).rejects.toThrow(/price changed to 100/);
    expect(rows).toHaveLength(0);
  });
});

describe('createStorylinePlacement — priced above zero', () => {
  it('writes the price and takes the escrow for it', async () => {
    givenSpace({ price: 100, setPrice: 100 });

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
    givenSpace({ price: 100, setPrice: 100 });
    holdPlacementEscrow.mockRejectedValue(new Error('insufficient funds'));

    await expect(submit()).rejects.toThrow(/insufficient funds/);
    expect(settlePlacement).toHaveBeenCalledWith({ placementId: 1, action: 'expire' });
  });
});

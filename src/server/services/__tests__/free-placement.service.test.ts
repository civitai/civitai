import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { ResolvedPlacementSpace } from '~/server/services/placement-space.service';
import { FREE_PLACEMENTS_PER_DAY } from '~/shared/utils/placement';

const { createFreePlacement, getFreePlacementAllowance } = await import(
  '~/server/services/free-placement.service'
);

const OWNER = 10;
const PLACER = 20;

const placementCount = dbMock.dbWrite.placement.count;
const placementCreate = dbMock.dbWrite.placement.create;
const executeRaw = dbMock.dbWrite.$executeRaw;

/**
 * The three counts the claim runs, told apart by their `where` rather than by
 * the order they happen to be called in.
 *
 * Ordering the answers with `mockResolvedValueOnce` would pass just as well if
 * the service asked the same question three times — which is the mistake worth
 * catching, since the daily allowance and the never-twice rule differ only in
 * their predicate.
 */
const givenCounts = ({ usedToday = 0, alreadyHere = 0, reserved = 0 } = {}) =>
  placementCount.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.createdAt) return usedToday;
    if (where.status) return reserved;
    if (where.targetId !== undefined) return alreadyHere;
    throw new Error(`unrecognised count: ${JSON.stringify(where)}`);
  });

const givenSpace = (overrides: Partial<ResolvedPlacementSpace> = {}): ResolvedPlacementSpace => ({
  ownerId: OWNER,
  ownerUsername: 'creator',
  mode: 'review',
  setPrice: 100,
  price: 100,
  cap: 500,
  ownerShare: 1,
  setFreeSlots: 4,
  freeSlots: 4,
  freeSlotCap: 4,
  // Deliberately generous, and deliberately ignored by the service: this is what
  // the caller SHOWED someone, computed before their other checks ran. Every
  // refusal below has to come from the counts re-read under the lock instead.
  freeSlotsRemaining: 99,
  settings: {},
  ...overrides,
});

const claim = (space = givenSpace()) =>
  createFreePlacement({
    surface: 'sticker',
    targetType: 'image',
    targetId: 77,
    placerId: PLACER,
    space,
    data: { cosmeticId: 5 },
  });

beforeEach(() => {
  vi.clearAllMocks();
  givenCounts();
  placementCreate.mockResolvedValue({ id: 1 });
});

describe('createFreePlacement', () => {
  it('writes a free row worth nothing, with a deadline on it', async () => {
    await claim();

    const written = placementCreate.mock.calls[0][0].data;
    expect(written).toMatchObject({ free: true, amount: 0, status: 'pending', ownerId: OWNER });
    // The deadline is what releases the slot when the creator never acts. A free
    // row without one holds a slot forever and no sweep will reach it: the expiry
    // query is `expiresAt <= now()`, which NULL never satisfies.
    expect(written.expiresAt).toBeInstanceOf(Date);
    expect(written.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses once the slots on this image are taken', async () => {
    givenCounts({ reserved: 4 });

    await expect(claim()).rejects.toThrow(/free slots/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('counts a pending placement as holding its slot', async () => {
    // The distinction the whole feature rests on. `reservedFreeSlots` asks for
    // both statuses; if it asked only for `approved`, fifty people would submit
    // into four slots and the creator would get a fifty-item review queue.
    givenCounts({ reserved: 4 });
    await expect(claim()).rejects.toThrow(/free slots/);

    const [{ where }] = placementCount.mock.calls
      .map(([args]: [{ where: Record<string, unknown> }]) => args)
      .filter((args: { where: Record<string, unknown> }) => args.where.status);
    expect((where.status as { in: string[] }).in).toEqual(
      expect.arrayContaining(['pending', 'approved'])
    );
    expect(where.free).toBe(true);
  });

  it('refuses a space whose owner takes no free placements', async () => {
    await expect(claim(givenSpace({ freeSlots: 0 }))).rejects.toThrow(/not taking free/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('refuses a second free placement in the same UTC day', async () => {
    givenCounts({ usedToday: FREE_PLACEMENTS_PER_DAY });

    await expect(claim()).rejects.toThrow(/today/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('spends the day whatever became of the earlier placement', async () => {
    givenCounts({ usedToday: FREE_PLACEMENTS_PER_DAY });
    await expect(claim()).rejects.toThrow(/today/);

    // No status predicate, on purpose and asymmetrically with the slot count
    // above: a decline or an expiry gives the IMAGE's slot back but not the
    // placer's day. Refunding the day turns the free tier into an unlimited
    // retry loop against whoever declines fastest.
    const daily = placementCount.mock.calls
      .map(([args]: [{ where: Record<string, unknown> }]) => args.where)
      .find((where: Record<string, unknown>) => where.createdAt);
    expect(daily).not.toHaveProperty('status');
  });

  it('refuses a second free placement on the same image, ever', async () => {
    givenCounts({ alreadyHere: 1 });

    await expect(claim()).rejects.toThrow(/already used a free placement here/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('asks about this image without a date or a status, so it means "ever"', async () => {
    givenCounts({ alreadyHere: 1 });
    await expect(claim()).rejects.toThrow(/already used/);

    // An image posted and deleted daily is otherwise a farm for one account's
    // alts: a day-scoped or status-scoped version of this check would let the
    // same placer back onto the same image tomorrow, or after a decline.
    const everHere = placementCount.mock.calls
      .map(([args]: [{ where: Record<string, unknown> }]) => args.where)
      .find(
        (where: Record<string, unknown>) =>
          where.targetId !== undefined && !where.createdAt && !where.status
      );
    expect(everHere).toMatchObject({ placerId: PLACER, free: true, surface: 'sticker' });
  });

  it('takes both locks before it counts anything, placer first', async () => {
    // The race is two placers claiming the last slot, and the counts are only a
    // decision if nothing can insert between them and the create. Asserted on the
    // calls because a unit test cannot observe Postgres serialising: what it CAN
    // pin is that the locks are taken, in one fixed order, before the reads that
    // depend on them. A second call site acquiring them the other way round is
    // the deadlock this ordering exists to prevent.
    await claim();

    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      placementCount.mock.invocationCallOrder[0]
    );
    expect(executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
      placementCount.mock.invocationCallOrder[0]
    );
    const [placerLock, targetLock] = executeRaw.mock.calls.map(([strings]: [string[]]) =>
      strings.join('?')
    );
    expect(placerLock).toContain('pg_advisory_xact_lock');
    expect(targetLock).toContain('hashtext');
  });

  it('claims inside one transaction, so the count and the insert cannot be split', async () => {
    await claim();

    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('getFreePlacementAllowance', () => {
  it('reports the day as spent and says when it comes back', async () => {
    placementCount.mockResolvedValue(FREE_PLACEMENTS_PER_DAY);

    const allowance = await getFreePlacementAllowance({ placerId: PLACER });

    expect(allowance).toMatchObject({ used: FREE_PLACEMENTS_PER_DAY, remaining: 0 });
    expect(allowance.resetsAt.getTime()).toBeGreaterThan(Date.now());
    // Midnight UTC, not the placer's midnight: a local day would refresh twice
    // for anyone willing to change timezone, and two servers would disagree about
    // which day a placement fell in.
    expect(allowance.resetsAt.toISOString()).toMatch(/T00:00:00\.000Z$/);
  });

  it('never reports a negative remainder', async () => {
    placementCount.mockResolvedValue(FREE_PLACEMENTS_PER_DAY + 5);

    expect((await getFreePlacementAllowance({ placerId: PLACER })).remaining).toBe(0);
  });
});

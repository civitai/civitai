import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PlacementModeration from '~/server/services/placement-moderation.service';
import type * as PlacementSpaceService from '~/server/services/placement-space.service';
import type { ResolvedPlacementSpace } from '~/server/services/placement-space.service';
import { FREE_PLACEMENTS_PER_DAY, PLACEMENT_SURFACES } from '~/shared/utils/placement';

const resolveSpace = vi.fn();
const assertCanPlace = vi.fn();

// `reservedFreeSlots` is deliberately NOT stubbed: it is the predicate the claim
// decides on, and a double would let the count-under-lock be tested against a
// shape the real query does not have.
vi.mock('~/server/services/placement-space.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementSpaceService>()),
  resolvePlacementSpaceFor: resolveSpace,
}));
vi.mock('~/server/services/placement-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementModeration>()),
  assertCanPlace,
}));

const { createFreePlacement, getFreePlacementAllowance } = await import(
  '~/server/services/free-placement.service'
);

const OWNER = 10;
const PLACER = 20;
const TARGET = 77;

const placementCount = dbMock.dbWrite.placement.count;
const placementCreate = dbMock.dbWrite.placement.create;
const executeRaw = dbMock.dbWrite.$executeRaw;

/**
 * The four counts the claim runs, told apart by their `where` rather than by the
 * order they happen to be called in.
 *
 * Ordering the answers with `mockResolvedValueOnce` would pass just as well if
 * the service asked the same question four times — which is the mistake worth
 * catching, since these differ only in their predicates.
 */
const givenCounts = ({ usedToday = 0, pending = 0, alreadyHere = 0, reserved = 0 } = {}) =>
  placementCount.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.createdAt) return usedToday;
    if (where.ownerId !== undefined) return pending;
    if (where.status) return reserved;
    if (where.targetId !== undefined) return alreadyHere;
    throw new Error(`unrecognised count: ${JSON.stringify(where)}`);
  });

const givenSpace = (overrides: Partial<ResolvedPlacementSpace> = {}) =>
  resolveSpace.mockResolvedValue({
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
    // Deliberately generous, and deliberately ignored: this is what a surface
    // SHOWS, computed before the caller's other checks ran. Every refusal below
    // has to come from the counts re-read under the lock instead.
    freeSlotsRemaining: 99,
    settings: {},
    ...overrides,
  } satisfies ResolvedPlacementSpace);

const claim = () =>
  createFreePlacement({
    surface: 'sticker',
    targetType: 'image',
    targetId: TARGET,
    placerId: PLACER,
    data: { cosmeticId: 5 },
  });

const whereOf = (predicate: (where: Record<string, unknown>) => boolean) =>
  placementCount.mock.calls
    .map(([args]: [{ where: Record<string, unknown> }]) => args.where)
    .find(predicate);

beforeEach(() => {
  vi.clearAllMocks();
  givenCounts();
  givenSpace();
  assertCanPlace.mockResolvedValue(undefined);
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

  // The owner is taken from the space this function resolved, from the target it
  // was given. Passing a pre-resolved space alongside a separate target let the
  // two disagree: a caller resolving once and looping would write a placement
  // onto image B carrying image A's owner, sending the review and every payout
  // attribution to the wrong creator with nothing raising.
  it('resolves the space from the target it is about, not from an argument', async () => {
    await claim();

    expect(resolveSpace).toHaveBeenCalledWith({
      surface: 'sticker',
      targetType: 'image',
      targetId: TARGET,
    });
    expect(placementCreate.mock.calls[0][0].data.targetId).toBe(TARGET);
  });
});

/**
 * Free is placement that costs no Buzz, not a lighter kind of placement. Every
 * rule about who may place on whom is untouched by the price being zero, and the
 * function's own docstring promises they are all here — a promise PR 2's author
 * will read and rely on.
 */
describe('createFreePlacement — the refusals the paid path makes', () => {
  it('refuses a space its owner has closed', async () => {
    givenSpace({ mode: 'off' });

    await expect(claim()).rejects.toThrow(/not accepting placements/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  // A gallery row saying `auto` predates the rule that galleries always review.
  // Refused where it is acted on, not only where it is written: a listing that
  // filters is not a mutation that refuses.
  it('refuses a mode the surface no longer allows, however the row got that way', async () => {
    givenSpace({ mode: 'auto' });

    await expect(
      createFreePlacement({
        surface: 'remixGallery',
        targetType: 'image',
        targetId: TARGET,
        placerId: PLACER,
        data: {},
      })
    ).rejects.toThrow(/not accepting placements/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('still allows auto on a surface that permits it', async () => {
    givenSpace({ mode: 'auto' });

    await expect(claim()).resolves.toBeDefined();
  });

  // Free self-placement is not "harmless because no money moves" — it is the
  // creator filling their own slots so nobody else can have them, which defeats
  // the scarcity the feature is built on.
  it('refuses placing on your own content', async () => {
    givenSpace({ ownerId: PLACER });

    await expect(claim()).rejects.toThrow(/your own content/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  // The half the free path could not do without: a block declines the rows
  // pending when it lands, but a moderator suspension is the only thing that
  // stops tomorrow's placement. Without this a suspended placer keeps placing
  // free ones forever.
  it('refuses a suspended or blocked placer, before any lock is taken', async () => {
    assertCanPlace.mockRejectedValue(
      new Error('placement: your placement privileges are suspended')
    );

    await expect(claim()).rejects.toThrow(/suspended/);
    expect(placementCreate).not.toHaveBeenCalled();
    // Outside the transaction, because it is I/O and `no-io-in-transaction`
    // guards that — and because a refusal should not first queue on a lock.
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('checks the placer against the owner it resolved, not against the target', async () => {
    await claim();

    expect(assertCanPlace).toHaveBeenCalledWith({ ownerId: OWNER, placerId: PLACER });
  });

  it('refuses once the placer holds the maximum pending with this creator', async () => {
    givenCounts({ pending: PLACEMENT_SURFACES.sticker.maxPendingPerOwner });

    await expect(claim()).rejects.toThrow(/maximum pending/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('counts that cap per surface and per owner, over pending rows only', async () => {
    givenCounts({ pending: PLACEMENT_SURFACES.sticker.maxPendingPerOwner });
    await expect(claim()).rejects.toThrow(/maximum pending/);

    expect(whereOf((where) => where.ownerId !== undefined)).toMatchObject({
      surface: 'sticker',
      ownerId: OWNER,
      placerId: PLACER,
      status: 'pending',
    });
  });
});

describe('createFreePlacement — the free-tier refusals', () => {
  it('refuses once the slots on this image are taken', async () => {
    givenCounts({ reserved: 4 });

    await expect(claim()).rejects.toThrow(/free slots/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('counts a pending placement as holding its slot', async () => {
    // The distinction the whole feature rests on. If the count asked only for
    // `approved`, fifty people would submit into four slots and the creator
    // would get a fifty-item review queue.
    givenCounts({ reserved: 4 });
    await expect(claim()).rejects.toThrow(/free slots/);

    const where = whereOf(
      (candidate) => !!candidate.status && typeof candidate.status === 'object'
    );
    expect((where?.status as { in: string[] }).in.slice().sort()).toEqual(['approved', 'pending']);
    expect(where).toMatchObject({ free: true, surface: 'sticker', targetId: TARGET });
  });

  it('refuses a space whose owner takes no free placements', async () => {
    givenSpace({ freeSlots: 0 });

    await expect(claim()).rejects.toThrow(/not taking free/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('refuses a second free placement in the same UTC day', async () => {
    givenCounts({ usedToday: FREE_PLACEMENTS_PER_DAY });

    await expect(claim()).rejects.toThrow(/today/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('asks about free rows only, in this UTC day, whatever became of them', async () => {
    givenCounts({ usedToday: FREE_PLACEMENTS_PER_DAY });
    await expect(claim()).rejects.toThrow(/today/);

    const daily = whereOf((where) => !!where.createdAt);
    // `free: true` asserted, not assumed. Without it a PAID placement spends the
    // free day, and every other test in this file stays green.
    expect(daily).toMatchObject({ placerId: PLACER, free: true });
    // No status predicate, asymmetrically with the slot count above: a decline or
    // an expiry gives the IMAGE's slot back but not the placer's day. Refunding
    // the day turns the free tier into an unlimited retry loop against whoever
    // declines fastest.
    expect(daily).not.toHaveProperty('status');
    // No surface predicate: the allowance is one placement a day across the
    // site, not one per surface.
    expect(daily).not.toHaveProperty('surface');

    // The window itself. `gte: new Date(0)` makes the allowance once-ever and
    // `gte: Date.now()` makes it never spend; both leave every assertion above
    // untouched.
    const since = (daily?.createdAt as { gte: Date }).gte;
    expect(since.toISOString()).toMatch(/T00:00:00\.000Z$/);
    expect(since.getTime()).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - since.getTime()).toBeLessThan(24 * 3_600_000);
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
    // alts: a day-scoped or status-scoped version would let the same placer back
    // onto the same image tomorrow, or after a decline.
    const everHere = whereOf(
      (where) => where.targetId !== undefined && !where.createdAt && !where.status
    );
    expect(everHere).toMatchObject({ placerId: PLACER, free: true, surface: 'sticker' });
  });
});

describe('createFreePlacement — the lock', () => {
  const rawStatements = () =>
    executeRaw.mock.calls.map(([strings]: [string[]]) => strings.join('?'));

  it('bounds how long a claim waits, so a wedged holder cannot pile up backends', async () => {
    await claim();

    // `pg_advisory_xact_lock` waits forever by default, and Prisma's client-side
    // timeout does not cancel a backend already blocked inside the statement.
    expect(rawStatements()[0]).toContain('SET LOCAL lock_timeout');
  });

  it('takes the placer lock first and the target lock second', async () => {
    await claim();

    const [, placerLock, targetLock] = rawStatements();
    expect(placerLock).toContain('pg_advisory_xact_lock');
    expect(targetLock).toContain('hashtext');
    expect(executeRaw).toHaveBeenCalledTimes(3);
  });

  // Asserted on the calls because a unit test cannot observe Postgres
  // serialising. What it CAN pin is that both locks are held before the reads
  // that depend on them, in one fixed order — a second call site acquiring them
  // the other way round is the deadlock this ordering exists to prevent.
  it('holds the target lock before it counts what is reserved on the target', async () => {
    givenCounts({ reserved: 4 });
    await expect(claim()).rejects.toThrow(/free slots/);

    const targetLockAt = executeRaw.mock.invocationCallOrder[2];
    const reservedCountAt =
      placementCount.mock.invocationCallOrder[placementCount.mock.calls.length - 1];
    expect(targetLockAt).toBeLessThan(reservedCountAt);
  });

  // Everyone who has already spent their day would otherwise queue on a shared,
  // contended lock to learn a fact about nobody but themselves.
  it('answers the placer-only question before taking the shared target lock', async () => {
    givenCounts({ usedToday: FREE_PLACEMENTS_PER_DAY });
    await expect(claim()).rejects.toThrow(/today/);

    // Two statements, not three: it refused before the target lock existed.
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it('claims inside one transaction, so the count and the insert cannot be split', async () => {
    await claim();

    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
  });
});

/**
 * The lock ordering is load-bearing and cannot be enforced by a type.
 *
 * PRs 2 and 4 are written by people who have not read the file that explains it,
 * so "take them placer-first" must not be a rule anyone has to know. The keys are
 * module-private and there is one acquisition site; this is what makes that a
 * fact rather than an intention, and it fails on the commit that adds a second
 * site rather than under load six months later.
 */
describe('the advisory locks have exactly one call site', () => {
  /**
   * Any advisory lock, of any arity.
   *
   * Deliberately not scoped to the two-argument form. Disjoint key spaces mean a
   * one-argument lock can never *be* one of these — but a deadlock needs a cycle
   * in the waits-for graph, not a shared key space, so a one-argument lock taken
   * inside this transaction deadlocks against a caller taking them the other way
   * round exactly as one in the same space would. An arity-scoped pattern is also
   * brittle in both directions: `pg_advisory_xact_lock(hashtext(key), id)` is a
   * two-argument call it would miss, and `pg_advisory_xact_lock(hashtext(a, b))`
   * a one-argument call it would flag.
   *
   * An explicit expected list rather than a "no new matches" count: a count
   * passes when one caller is added and another removed, and says nothing about
   * which files it was happy with.
   */
  const ADVISORY_LOCK = /pg_advisory/;
  const ALLOWED = ['services/article.service.ts', 'services/free-placement.service.ts'];

  it('is taken only inside createFreePlacement', () => {
    const root = path.resolve(__dirname, '../..');
    const callers = fs
      .readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((name) => name.split(path.sep).join('/'))
      // Excluded explicitly rather than left to luck: this file names the
      // function it is guarding, so without this it matches itself.
      .filter((name) => name.endsWith('.ts') && !name.includes('__tests__/'))
      // Comments stripped first. `webhook-debounce.ts` explains the article
      // service's lock in prose, and an allowlist entry for a file that takes no
      // lock is an entry nobody can later tell from a real one.
      .filter((name) =>
        ADVISORY_LOCK.test(
          fs
            .readFileSync(path.join(root, name), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '')
        )
      );

    expect(callers.sort()).toEqual(ALLOWED);
  });

  it('exports nothing but the three functions, so there is no lock to take', async () => {
    const exported = await import('~/server/services/free-placement.service');

    // Surface-shaped, not name-shaped: a pattern like /LOCK/ passes for a new
    // export under any other name, which is most of them.
    expect(Object.keys(exported).sort()).toEqual([
      'createFreePlacement',
      'getFreePlacementAllowance',
      'hasUsedFreePlacementOn',
    ]);
  });
});

describe('getFreePlacementAllowance', () => {
  it('reports the day as spent and says when it comes back', async () => {
    dbMock.dbRead.placement.count.mockResolvedValue(FREE_PLACEMENTS_PER_DAY);

    const allowance = await getFreePlacementAllowance({ placerId: PLACER });

    expect(allowance).toMatchObject({ used: FREE_PLACEMENTS_PER_DAY, remaining: 0 });
    expect(allowance.resetsAt.getTime()).toBeGreaterThan(Date.now());
    // Midnight UTC, not the placer's midnight: a local day would refresh twice
    // for anyone willing to change timezone, and two servers would disagree about
    // which day a placement fell in.
    expect(allowance.resetsAt.toISOString()).toMatch(/T00:00:00\.000Z$/);
  });

  it('never reports a negative remainder', async () => {
    dbMock.dbRead.placement.count.mockResolvedValue(FREE_PLACEMENTS_PER_DAY + 5);

    expect((await getFreePlacementAllowance({ placerId: PLACER })).remaining).toBe(0);
  });

  // The predicate is shared with the claim rather than written twice. Scope it by
  // status in one copy and the surface offers a placement the mutation refuses.
  it('asks the same question the claim decides on', async () => {
    dbMock.dbRead.placement.count.mockResolvedValue(0);
    await getFreePlacementAllowance({ placerId: PLACER });
    const displayed = dbMock.dbRead.placement.count.mock.calls[0][0].where;

    givenCounts();
    await claim();
    const decided = whereOf((where) => !!where.createdAt);

    expect(displayed).toEqual(decided);
  });
});

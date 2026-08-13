import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MetricHelpers from '~/server/utils/metric-helpers';

const queryRaw = vi.fn();
const updateMany = vi.fn();
const updateEntityMetricDetached = vi.fn();
const logToAxiom = vi.fn();
const isFlipt = vi.fn();

const count = vi.fn(async () => 0);

vi.mock('~/env/server', () => ({ env: { CLICKHOUSE_TRACKER_URL: 'http://tracker.test' } }));

vi.mock('~/server/db/client', () => ({
  dbWrite: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    placement: { updateMany, count },
  },
}));

vi.mock('~/server/flipt/client', () => ({
  isFlipt,
  FLIPT_FEATURE_FLAGS: { PLACEMENT_METRIC_SWEEP: 'placement-metric-sweep' },
}));

vi.mock('~/server/utils/metric-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof MetricHelpers>()),
  updateEntityMetricDetached,
}));

vi.mock('~/server/logging/client', () => ({ logToAxiom }));

const { sweepUncountedPlacements } = await import('~/server/services/placement-metrics.service');

type Row = {
  id: number;
  targetId: number;
  placerId: number;
  amount: number;
  metricClaimedAt: Date;
  metricAttempts: number;
};

/** Fresh, because the sweep stops emitting once its own lease has aged out. */
const LEASE = new Date();

const row = (over: Partial<Row> & { id: number }): Row => ({
  targetId: 10,
  placerId: 20,
  amount: 100,
  metricClaimedAt: LEASE,
  metricAttempts: 1,
  ...over,
});

const claims = (rows: Row[]) => queryRaw.mockResolvedValue(rows);

/** Ids CONFIRMED as counted — not the deferred rows, whose claim is released. */
const confirmedIds = () =>
  updateMany.mock.calls
    .filter((call) => call[0].data.metricCountedAt)
    .flatMap((call) => call[0].where.id.in as number[]);

/** Ids handed back for the next tick. */
const releasedIds = () =>
  updateMany.mock.calls
    .filter((call) => call[0].data.metricClaimedAt === null)
    .flatMap((call) => call[0].where.id.in as number[]);

/** The claim statement's SQL, reassembled from the tagged template. */
const claimSql = () => ((queryRaw.mock.calls[0]?.[0] as string[]) ?? []).join(' ? ');

/** The values Prisma interpolates into it, in order. */
const claimValues = () => (queryRaw.mock.calls[0] ?? []).slice(1);

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([]);
  updateMany.mockImplementation(async ({ where }) => ({ count: where.id.in.length }));
  updateEntityMetricDetached.mockResolvedValue(true);
  logToAxiom.mockResolvedValue(undefined);
  // Only the sweep's own gate. `disable-app-entity-metrics` is the kill switch,
  // and returning true for everything would have it permanently off.
  isFlipt.mockImplementation(async (flag: string) => flag === 'placement-metric-sweep');
});

describe('sweepUncountedPlacements', () => {
  it('does nothing at all while the flag is off, and says so', async () => {
    isFlipt.mockResolvedValue(false);
    claims([row({ id: 1 })]);

    const result = await sweepUncountedPlacements({ limit: 100 });

    // Not merely "counted nothing": it must not even claim, or it would take
    // rows the pre-deploy backfill has not yet accounted for.
    expect(queryRaw).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
    expect(result.counted).toBe(0);
  });

  it('claims rows before emitting, so two overlapping runs cannot take the same one', async () => {
    await sweepUncountedPlacements({ limit: 100 });

    const sql = claimSql();
    // The claim and the confirmation are separate writes on purpose. Without
    // `SKIP LOCKED` two runs read the same unstamped rows and both emit before
    // either stamps, and the counter never comes back down.
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/SET "metricClaimedAt" = now\(\)/);
    // Every clause the sweep's correctness rests on, because nothing downstream
    // of this query can tell that one of them is missing. Deleting the stale
    // check makes the claim decorative; deleting the counted check re-emits
    // finished rows forever; deleting the approved leg silently counts only
    // takedowns; deleting the targetType check emits Image metrics for
    // placements that are not on images.
    expect(sql).toMatch(/"metricCountedAt" IS NULL/);
    expect(sql).toMatch(/"metricClaimedAt" IS NULL OR "metricClaimedAt" </);
    expect(sql).toMatch(/status = 'approved' OR/);
    expect(sql).toMatch(/"targetType" = 'image'/);
    expect(sql).toMatch(/"metricAttempts" </);
    expect(sql).toMatch(/ORDER BY "resolvedAt" ASC/);
    expect(sql).toMatch(/LIMIT/);
    // The bindings, so an interpolation dropped from the template shows up as a
    // missing value rather than as a query that quietly matches everything.
    const [staleBefore, attempts, limit] = claimValues();
    expect(staleBefore).toBeInstanceOf(Date);
    expect(attempts).toBeGreaterThan(0);
    expect(limit).toBe(100);
  });

  it('fences every write on the lease it was handed', async () => {
    claims([row({ id: 1 })]);

    await sweepUncountedPlacements({ limit: 100 });

    // A run slower than the stale window has lost its claim, and another run may
    // hold these rows. Confirming without the token lets the loser write over
    // work the winner is still doing.
    expect(updateMany.mock.calls[0][0].where.metricClaimedAt).toEqual(LEASE);
  });

  it('releases a deferred claim only while it still holds it', async () => {
    const alreadyEmitted = new Set<string>();
    claims([row({ id: 1 })]);
    await sweepUncountedPlacements({ limit: 100, alreadyEmitted });
    claims([row({ id: 2 })]);

    await sweepUncountedPlacements({ limit: 100, alreadyEmitted });

    const release = updateMany.mock.calls.find((call) => call[0].data.metricClaimedAt === null);
    expect(release?.[0].where.metricClaimedAt).toEqual(LEASE);
    // And gives the attempt back: a deferred row was never tried, so letting
    // deferrals burn the ceiling would abandon a group whose only fault is
    // spanning pages often enough.
    expect(release?.[0].data.metricAttempts).toEqual({ decrement: 1 });
  });

  it('excludes a placement that went straight from pending to removed', async () => {
    await sweepUncountedPlacements({ limit: 100 });

    // A moderator clearing an abusive placer forfeits that escrow: no owner was
    // paid and nothing was ever live. Counting it would make moderating abuse
    // inflate the counter on the images the abuse targeted.
    expect(claimSql()).toMatch(/status = 'removed' AND "takenDownAt" IS NOT NULL/);
    expect(claimSql()).not.toMatch(/status IN \('approved', 'removed'\)/);
  });

  it('emits one summed event per image and placer, not one per placement', async () => {
    claims([row({ id: 1, amount: 100 }), row({ id: 2, amount: 250 })]);

    const result = await sweepUncountedPlacements({ limit: 100 });

    // Two events for the same image, placer and second collapse in the metric
    // pipeline — the second payment would vanish.
    expect(updateEntityMetricDetached).toHaveBeenCalledTimes(1);
    expect(updateEntityMetricDetached).toHaveBeenCalledWith({
      entityType: 'Image',
      entityId: 10,
      metricType: 'Buzz',
      amount: 350,
      userId: 20,
      awaitDelivery: true,
    });
    expect(result.counted).toBe(2);
    expect(result.amount).toBe(350);
    expect(confirmedIds()).toEqual([1, 2]);
  });

  it('keeps different placers on one image apart, so neither is attributed to the other', async () => {
    claims([row({ id: 1, placerId: 20, amount: 100 }), row({ id: 2, placerId: 21, amount: 300 })]);

    await sweepUncountedPlacements({ limit: 100 });

    expect(updateEntityMetricDetached).toHaveBeenCalledTimes(2);
    expect(updateEntityMetricDetached.mock.calls.map((call) => call[0].userId)).toEqual([20, 21]);
    expect(updateEntityMetricDetached.mock.calls.map((call) => call[0].amount)).toEqual([100, 300]);
  });

  it('defers a group already emitted earlier in the same run rather than emitting twice', async () => {
    const alreadyEmitted = new Set<string>();
    claims([row({ id: 1, amount: 100 })]);
    await sweepUncountedPlacements({ limit: 100, alreadyEmitted });

    // Page two of the same drain, same (image, placer). Emitting again inside
    // the same second would collapse against the first and lose one of them.
    claims([row({ id: 2, amount: 400 })]);
    const second = await sweepUncountedPlacements({ limit: 100, alreadyEmitted });

    expect(updateEntityMetricDetached).toHaveBeenCalledTimes(1);
    expect(second.deferred).toBe(1);
    expect(second.counted).toBe(0);
    expect(confirmedIds()).toEqual([1]);
    // Released, not just skipped: a claim left standing sits out the whole
    // stale window — three ticks — for a collision the next tick cannot have.
    expect(releasedIds()).toEqual([2]);
  });

  it('confirms a zero-amount group without emitting, so it cannot be re-claimed forever', async () => {
    claims([row({ id: 1, amount: 0 })]);

    const result = await sweepUncountedPlacements({ limit: 100 });

    expect(updateEntityMetricDetached).not.toHaveBeenCalled();
    expect(confirmedIds()).toEqual([1]);
    expect(result.counted).toBe(1);
  });

  it('leaves a group unconfirmed when the emit fails, and still counts the rest', async () => {
    claims([row({ id: 1, targetId: 10, amount: 100 }), row({ id: 2, targetId: 11, amount: 400 })]);
    updateEntityMetricDetached.mockImplementation(async ({ entityId }: { entityId: number }) => {
      if (entityId === 10) throw new Error('clickhouse is down');
      return true;
    });

    const result = await sweepUncountedPlacements({ limit: 100 });

    // Unconfirmed, not unclaimed: the claim goes stale on its own and the row
    // comes back. Confirming it here would lose the Buzz for good.
    expect(confirmedIds()).toEqual([2]);
    expect(result.counted).toBe(1);
    expect(result.amount).toBe(400);
  });

  it('claims nothing at all while the metric kill switch is on', async () => {
    // Discovering it after claiming burned an attempt and held the claim for the
    // full stale window on every row — ten cycles of that abandons the whole
    // queue in a couple of hours, over an incident switch that gets left on for
    // an afternoon.
    isFlipt.mockImplementation(async () => true);

    const result = await sweepUncountedPlacements({ limit: 100 });

    expect(queryRaw).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
  });

  it('hands a group back rather than holding its claim when nothing was delivered', async () => {
    claims([row({ id: 1, amount: 100 })]);
    updateEntityMetricDetached.mockResolvedValue(false);

    const result = await sweepUncountedPlacements({ limit: 100 });

    expect(confirmedIds()).toEqual([]);
    expect(releasedIds()).toEqual([1]);
    expect(result.counted).toBe(0);
    // Counted apart from a collision defer: the job's alarm excuses one and not
    // the other, and conflating them silences it on the case it exists for.
    expect(result.undelivered).toBe(1);
    expect(result.deferred).toBe(0);
  });

  it('stops emitting once its own lease has expired', async () => {
    // The fence protects the writes; the emit is the irreversible half and no
    // database guard reaches it. A run that outlives its claim would emit for
    // rows its successor has already emitted for.
    const expired = new Date(Date.now() - 60 * 60 * 1000);
    claims([
      row({ id: 1, metricClaimedAt: expired }),
      row({ id: 2, targetId: 11, metricClaimedAt: expired }),
    ]);

    const result = await sweepUncountedPlacements({ limit: 100 });

    expect(updateEntityMetricDetached).not.toHaveBeenCalled();
    expect(result.counted).toBe(0);
  });

  it('reports an idle run when nothing is claimable, having tried to claim', async () => {
    const result = await sweepUncountedPlacements({ limit: 100 });

    // The claim ran and came back empty — distinct from the flag case above,
    // which must not touch the table at all.
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(updateEntityMetricDetached).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      considered: 0,
      counted: 0,
      amount: 0,
      deferred: 0,
      undelivered: 0,
      skipped: false,
    });
  });
});

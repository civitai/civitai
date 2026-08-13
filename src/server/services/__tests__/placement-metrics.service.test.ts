import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MetricHelpers from '~/server/utils/metric-helpers';

const findMany = vi.fn();
const updateMany = vi.fn();
const updateEntityMetricDetached = vi.fn();
const logToAxiom = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbWrite: { placement: { findMany, updateMany } },
  dbRead: { placement: { findMany } },
}));

vi.mock('~/server/utils/metric-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof MetricHelpers>()),
  updateEntityMetricDetached,
}));

vi.mock('~/server/logging/client', () => ({ logToAxiom }));

const { recordPlacementTip, sweepUncountedPlacements } = await import(
  '~/server/services/placement-metrics.service'
);

type Row = {
  id: number;
  targetId: number;
  placerId: number;
  amount: number;
  surface: string;
};

const row = (over: Partial<Row> & { id: number }): Row => ({
  targetId: 10,
  placerId: 20,
  amount: 100,
  surface: 'sticker',
  ...over,
});

const pending = (rows: Row[]) => findMany.mockResolvedValue(rows);

/** Every marked id across every `updateMany` call, in order. */
const markedIds = () => updateMany.mock.calls.flatMap((call) => call[0].where.id.in as number[]);

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  updateMany.mockImplementation(async ({ where }) => ({ count: where.id.in.length }));
  updateEntityMetricDetached.mockResolvedValue(true);
  logToAxiom.mockResolvedValue(undefined);
});

describe('recordPlacementTip', () => {
  it('marks the placement counted only after the emit has landed', async () => {
    const order: string[] = [];
    updateEntityMetricDetached.mockImplementation(async () => {
      order.push('emit');
      return true;
    });
    updateMany.mockImplementation(async () => {
      order.push('mark');
      return { count: 1 };
    });

    await recordPlacementTip({
      surface: 'sticker',
      placementId: 7,
      imageId: 10,
      amount: 100,
      placerId: 20,
    });

    expect(order).toEqual(['emit', 'mark']);
    expect(markedIds()).toEqual([7]);
  });

  it('leaves the placement unmarked when the emit throws, so the sweep can still find it', async () => {
    updateEntityMetricDetached.mockRejectedValue(new Error('clickhouse is down'));

    await recordPlacementTip({
      surface: 'sticker',
      placementId: 7,
      imageId: 10,
      amount: 100,
      placerId: 20,
    });

    expect(markedIds()).toEqual([]);
  });

  it('waits for delivery rather than for dispatch', async () => {
    await recordPlacementTip({
      surface: 'sticker',
      placementId: 7,
      imageId: 10,
      amount: 100,
      placerId: 20,
    });

    // Without this the tracker returns as soon as it has handed the row to a
    // fire-and-forget POST, and the stamp below records a dropped event as
    // counted — which is worse than the loss it replaced.
    expect(updateEntityMetricDetached.mock.calls[0][0].awaitDelivery).toBe(true);
  });

  it('leaves the placement unmarked when metrics are switched off, so nothing in that window is lost', async () => {
    updateEntityMetricDetached.mockResolvedValue(false);

    await recordPlacementTip({
      surface: 'sticker',
      placementId: 7,
      imageId: 10,
      amount: 100,
      placerId: 20,
    });

    expect(markedIds()).toEqual([]);
  });

  it('never throws, because it runs after the money has already moved', async () => {
    updateMany.mockRejectedValue(new Error('postgres is down'));

    await expect(
      recordPlacementTip({
        surface: 'remixGallery',
        placementId: 7,
        imageId: 10,
        amount: 100,
        placerId: 20,
      })
    ).resolves.toBeUndefined();
  });

  it('guards the stamp on NULL, so a row the sweep already counted keeps its original time', async () => {
    await recordPlacementTip({
      surface: 'sticker',
      placementId: 7,
      imageId: 10,
      amount: 100,
      placerId: 20,
    });

    expect(updateMany.mock.calls[0][0].where.metricCountedAt).toBeNull();
  });
});

describe('sweepUncountedPlacements', () => {
  it('emits one summed event per image and placer, not one per placement', async () => {
    pending([row({ id: 1, amount: 100 }), row({ id: 2, amount: 250 })]);

    const result = await sweepUncountedPlacements({ limit: 100 });

    // Two events for the same image, placer and second collapse into one in the
    // metric pipeline — the second payment would vanish. Summing first is what
    // makes that unreachable.
    expect(updateEntityMetricDetached).toHaveBeenCalledTimes(1);
    expect(updateEntityMetricDetached).toHaveBeenCalledWith({
      entityType: 'Image',
      entityId: 10,
      metricType: 'Buzz',
      amount: 350,
      userId: 20,
      awaitDelivery: true,
    });
    expect(result).toEqual({ considered: 2, counted: 2, amount: 350 });
    expect(markedIds()).toEqual([1, 2]);
  });

  it('keeps different placers on one image apart, so neither is attributed to the other', async () => {
    pending([row({ id: 1, placerId: 20, amount: 100 }), row({ id: 2, placerId: 21, amount: 300 })]);

    await sweepUncountedPlacements({ limit: 100 });

    expect(updateEntityMetricDetached).toHaveBeenCalledTimes(2);
    expect(updateEntityMetricDetached.mock.calls.map((call) => call[0].userId)).toEqual([20, 21]);
    expect(updateEntityMetricDetached.mock.calls.map((call) => call[0].amount)).toEqual([100, 300]);
  });

  it('selects only settled placements that were approved and are still uncounted', async () => {
    await sweepUncountedPlacements({ limit: 100 });

    const where = findMany.mock.calls[0][0].where;
    // `declined`, `expired` and `pending` counted nothing when they settled and
    // must not start counting here; `removed` was approved first, and the
    // counter counts the approval and never reverses.
    expect(where.status).toEqual({ in: ['approved', 'removed'] });
    expect(where.metricCountedAt).toBeNull();
    expect(where.targetType).toBe('image');
    expect(where.resolvedAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - 5 * 60 * 1000);
  });

  it('marks a zero-amount group without emitting, so it cannot re-fill the batch forever', async () => {
    pending([row({ id: 1, amount: 0 })]);

    const result = await sweepUncountedPlacements({ limit: 100 });

    expect(updateEntityMetricDetached).not.toHaveBeenCalled();
    expect(markedIds()).toEqual([1]);
    expect(result.counted).toBe(1);
  });

  it('steps over a failing group without marking it, and still counts the rest', async () => {
    pending([row({ id: 1, targetId: 10, amount: 100 }), row({ id: 2, targetId: 11, amount: 400 })]);
    updateEntityMetricDetached.mockImplementation(async ({ entityId }: { entityId: number }) => {
      if (entityId === 10) throw new Error('clickhouse is down');
      return true;
    });

    const result = await sweepUncountedPlacements({ limit: 100 });

    expect(markedIds()).toEqual([2]);
    expect(result).toEqual({ considered: 2, counted: 1, amount: 400 });
  });

  it('marks nothing while metrics are switched off, and leaves the work in the queue', async () => {
    pending([row({ id: 1, amount: 100 }), row({ id: 2, targetId: 11, amount: 400 })]);
    updateEntityMetricDetached.mockResolvedValue(false);

    const result = await sweepUncountedPlacements({ limit: 100 });

    expect(markedIds()).toEqual([]);
    expect(result).toEqual({ considered: 2, counted: 0, amount: 0 });
  });

  it('does nothing at all when there is nothing uncounted', async () => {
    const result = await sweepUncountedPlacements({ limit: 100 });

    expect(updateEntityMetricDetached).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ considered: 0, counted: 0, amount: 0 });
  });
});

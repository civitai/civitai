import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as NewOrderUtils from '~/server/games/new-order/utils';
import type * as NewOrderService from '~/server/services/games/new-order.service';

// The daily rating-slot purge empties the old slot's pools; the images it purged lose their vote
// tallies too, so a later round on any of them starts from zero.

const { pool, mockClear, mockInsert } = vi.hoisted(() => ({
  pool: { getAll: vi.fn(), reset: vi.fn() },
  mockClear: vi.fn(),
  mockInsert: vi.fn(),
}));

vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, _cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    run: fn,
  }),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { insert: mockInsert } }));
vi.mock('~/server/games/new-order/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof NewOrderUtils>()),
  poolCounters: { Knight: { a: [pool], b: [] } },
  getActiveSlot: vi.fn().mockResolvedValue('a'),
  setActiveSlot: vi.fn(),
  clearImageRatings: mockClear,
}));
vi.mock('~/server/services/games/new-order.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NewOrderService>()),
  processFinalRatings: vi.fn().mockResolvedValue({ status: 'processed' }),
}));

import { newOrderJobs } from '~/server/jobs/new-order-jobs';

const purge = () => {
  const job = newOrderJobs.find((j) => j.name === 'new-order-change-rate-target');
  if (!job) throw new Error('rating-slot purge job not found');
  return (job as unknown as { run: (e: unknown) => Promise<unknown> }).run({});
};

beforeEach(() => {
  vi.clearAllMocks();
  pool.reset.mockResolvedValue(undefined);
  mockInsert.mockResolvedValue(undefined);
});

describe('daily rating-slot purge', () => {
  it('drops the tallies of the images it purged', async () => {
    pool.getAll.mockResolvedValue(['11', '12']);

    await purge();

    expect(pool.reset).toHaveBeenCalledWith({ all: true });
    expect(mockClear).toHaveBeenCalledWith([11, 12]);
  });

  it('control: an empty slot clears nothing', async () => {
    pool.getAll.mockResolvedValue([]);

    await purge();

    expect(mockClear).not.toHaveBeenCalled();
  });
});

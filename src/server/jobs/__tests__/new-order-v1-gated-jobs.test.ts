import { beforeEach, describe, expect, it, vi } from 'vitest';

// After the cutover (`newOrderGame` off) the v1-only jobs do nothing. grant-bless-buzz and
// change-rate-target keep running: they settle and pay out what players earned in v1.

const { v1Live, setActiveSlot, getActiveSlot } = vi.hoisted(() => ({
  v1Live: vi.fn(),
  setActiveSlot: vi.fn().mockResolvedValue(undefined),
  getActiveSlot: vi.fn().mockResolvedValue('a'),
}));

vi.mock('~/server/games/new-order/v1-gate', () => ({ isV1KnightsLive: v1Live }));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: vi.fn().mockResolvedValue([]), insert: vi.fn() },
}));
vi.mock('~/server/games/new-order/utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveSlot,
  setActiveSlot,
  poolCounters: { Knight: { a: [], b: [] }, Templar: { a: [], b: [] } },
}));
vi.mock('~/server/services/moderator-app.service', () => ({ moderatorApp: {} }));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { newOrderJobs } from '~/server/jobs/new-order-jobs';

const run = (name: string) => {
  const job = newOrderJobs.find((j) => j.name === name);
  if (!job) throw new Error(`no job ${name}`);
  return job.run({}).result;
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.newOrderPlayer.findMany.mockResolvedValue([] as never);
  dbMock.dbRead.newOrderSmite.findMany.mockResolvedValue([] as never);
});

describe('v1-only jobs', () => {
  it('daily-reset reads players while v1 is live and not once it is retired', async () => {
    v1Live.mockResolvedValue(true);
    await run('new-order-daily-reset');
    expect(dbMock.dbRead.newOrderPlayer.findMany).toHaveBeenCalled();

    vi.clearAllMocks();
    v1Live.mockResolvedValue(false);
    await run('new-order-daily-reset');
    expect(dbMock.dbRead.newOrderPlayer.findMany).not.toHaveBeenCalled();
  });

  it('cleanse-smites reads smites while v1 is live and not once it is retired', async () => {
    v1Live.mockResolvedValue(true);
    await run('new-order-cleanse-smites');
    expect(dbMock.dbRead.newOrderSmite.findMany).toHaveBeenCalled();

    vi.clearAllMocks();
    v1Live.mockResolvedValue(false);
    await run('new-order-cleanse-smites');
    expect(dbMock.dbRead.newOrderSmite.findMany).not.toHaveBeenCalled();
  });

  it('change-fill-target rotates the filling slot while v1 is live and not once it is retired', async () => {
    v1Live.mockResolvedValue(true);
    await run('new-order-change-fill-target');
    expect(setActiveSlot).toHaveBeenCalledWith('Knight', 'filling', 'b');

    vi.clearAllMocks();
    v1Live.mockResolvedValue(false);
    await run('new-order-change-fill-target');
    expect(setActiveSlot).not.toHaveBeenCalled();
  });
});

describe('v1 jobs that outlive the cutover', () => {
  beforeEach(() => v1Live.mockResolvedValue(false));

  it('change-rate-target still rotates the rating slot', async () => {
    await run('new-order-change-rate-target');
    expect(setActiveSlot).toHaveBeenCalledWith('Knight', 'rating', 'b');
  });

  it('grant-bless-buzz still looks for players to pay', async () => {
    await run('new-order-grant-bless-buzz');
    expect(dbMock.dbRead.newOrderPlayer.findMany).toHaveBeenCalled();
  });
});

import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDbWrite, mockApply, mockSetLastRun, jobDate } = vi.hoisted(() => ({
  mockDbWrite: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    image: { findMany: vi.fn() },
    comicProject: { updateMany: vi.fn() },
  },
  mockApply: vi.fn(),
  mockSetLastRun: vi.fn(),
  jobDate: { lastRun: new Date(0) },
}));

vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));
vi.mock('~/server/rewards', () => ({ firstDailyPostReward: { apply: mockApply } }));
vi.mock('~/server/events', () => ({ eventEngine: { processEngagement: vi.fn() } }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: vi.fn() },
  userImageVideoCountCaches: { refresh: vi.fn() },
}));
vi.mock('~/server/services/image.service', () => ({ queueImageSearchIndexUpdate: vi.fn() }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/services/model-version.service', () => ({
  bustMvCache: vi.fn(),
  publishModelVersionsWithEarlyAccess: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/nsfwLevels.service', () => ({ updateComicNsfwLevels: vi.fn() }));
vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
  getJobDate: async () => [jobDate.lastRun, mockSetLastRun] as const,
}));

import { processScheduledPublishing } from '~/server/jobs/process-scheduled-publishing';

type Row = { id: number; userId: number };

// The job fires five tagged-template reads; route on the SQL text so the test
// doesn't break when their order changes.
const stubReads = ({ scheduled = [], newlyLive = [] }: { scheduled?: Row[]; newlyLive?: Row[] }) => {
  mockDbWrite.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    const sql = (args[0] as string[]).join(' ');
    if (sql.includes('"ComicChapter"')) return [];
    if (sql.includes('JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"')) return scheduled;
    if (sql.includes('FROM "Post" p')) return newlyLive;
    return [];
  });
};

const standaloneCall = () =>
  mockDbWrite.$queryRaw.mock.calls.find(
    (args) =>
      (args[0] as string[]).join(' ').includes('FROM "Post" p') &&
      !(args[0] as string[]).join(' ').includes('JOIN "ModelVersion"')
  ) as unknown[];

const runJob = () => (processScheduledPublishing as unknown as () => Promise<void>)();

beforeEach(() => {
  vi.clearAllMocks();
  jobDate.lastRun = new Date(0);
  mockApply.mockResolvedValue(undefined);
  mockDbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $executeRaw: vi.fn(), $queryRaw: vi.fn().mockResolvedValue([]) })
  );
  mockDbWrite.image.findMany.mockResolvedValue([]);
  stubReads({});
});

describe('processScheduledPublishing :: first daily post reward', () => {
  it('rewards posts published by the ModelVersion schedule, which never reach the inline path', async () => {
    stubReads({ scheduled: [{ id: 1, userId: 10 }] });
    await runJob();
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply).toHaveBeenCalledWith({ postId: 1, posterId: 10 });
  });

  it('rewards standalone scheduled posts on the day they go live', async () => {
    stubReads({ newlyLive: [{ id: 2, userId: 20 }] });
    await runJob();
    expect(mockApply).toHaveBeenCalledWith({ postId: 2, posterId: 20 });
  });

  it('rewards a post once when both queries return it', async () => {
    stubReads({ scheduled: [{ id: 3, userId: 30 }], newlyLive: [{ id: 3, userId: 30 }] });
    await runJob();
    expect(mockApply).toHaveBeenCalledTimes(1);
  });

  it('keeps publishing when a reward fails', async () => {
    mockApply.mockRejectedValueOnce(new Error('buzz down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubReads({ newlyLive: [{ id: 4, userId: 40 }, { id: 5, userId: 50 }] });
    await runJob();
    expect(mockApply).toHaveBeenCalledTimes(2);
    expect(mockSetLastRun).toHaveBeenCalled();
  });
});

describe('processScheduledPublishing :: standalone sweep window', () => {
  it('clamps an epoch job date so a fresh env does not sweep every post ever published', async () => {
    await runJob();
    const [, windowStart, now] = standaloneCall() as [unknown, Date, Date];
    expect(now.getTime() - windowStart.getTime()).toBe(60 * 60 * 1000);
  });

  it('starts at the previous run when that is inside the lookback limit', async () => {
    jobDate.lastRun = new Date(Date.now() - 60 * 1000);
    await runJob();
    const [, windowStart] = standaloneCall() as [unknown, Date];
    expect(windowStart).toEqual(jobDate.lastRun);
  });

  // Bound as a parameter the minute count arrives as int8 and make_interval only
  // takes int4, so the query fails to resolve the function (42883) on every run.
  it('inlines the schedule offset rather than binding it', async () => {
    await runJob();
    const interval = standaloneCall().at(-1) as Prisma.Sql;
    expect(interval.sql).toBe('make_interval(mins => 60)');
    expect(interval.values).toEqual([]);
  });
});

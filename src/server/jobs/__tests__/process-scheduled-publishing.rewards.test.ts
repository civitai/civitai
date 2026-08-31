import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockApply,
  mockRewardedIds,
  mockSetLastRun,
  mockProcessEngagement,
  mockCreateNotification,
  jobDate,
} = vi.hoisted(() => ({
  mockApply: vi.fn(),
  mockRewardedIds: vi.fn(),
  mockSetLastRun: vi.fn(),
  mockProcessEngagement: vi.fn(),
  mockCreateNotification: vi.fn(),
  jobDate: { lastRun: new Date(0) },
}));

// Hand-listed rather than spread via importOriginal: the rewards barrel reaches
// modules that build query caches from the db client at import time, so pulling the
// real one in drops this suite to zero collected tests.
vi.mock('~/server/rewards', () => ({ firstDailyPostReward: { apply: mockApply } }));
vi.mock('~/server/rewards/active/firstDailyPost.reward', () => ({
  getFirstDailyPostRewardedIds: mockRewardedIds,
}));
vi.mock('~/server/events', () => ({ eventEngine: { processEngagement: mockProcessEngagement } }));
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
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/services/nsfwLevels.service', () => ({
  updateComicNsfwLevels: vi.fn(async () => undefined),
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
  getJobDate: async () => [jobDate.lastRun, mockSetLastRun] as const,
}));

import { processScheduledPublishing } from '~/server/jobs/process-scheduled-publishing';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockLogToAxiom = loggingMock.logToAxiom;
const mockDbWrite = dbMock.dbWrite;

type Row = { id: number; userId: number };
type Chapter = {
  projectId: number;
  position: number;
  userId: number;
  projectName: string;
  chapterName: string;
  username: string | null;
};
type Follower = { projectId: number; userId: number };

// Routed on SQL text rather than call order so adding a read doesn't shift these.
const stubReads = ({
  scheduled = [],
  newlyLive = [],
  chapters = [],
  followers = [],
}: {
  scheduled?: Row[];
  newlyLive?: Row[];
  chapters?: Chapter[];
  followers?: Follower[];
}) => {
  mockDbWrite.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    const sql = (args[0] as string[]).join(' ');
    // There is no "ComicEngagement" table — prod answers 42P01. Throwing rather than
    // returning [] keeps a revert from reading as "this project has no followers".
    if (sql.includes('"ComicEngagement"'))
      throw new Error('relation "ComicEngagement" does not exist');
    if (sql.includes('"ComicProjectEngagement"')) return followers;
    if (sql.includes('"ComicChapter"')) return chapters;
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
  mockRewardedIds.mockResolvedValue(new Set<number>());
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

  it('registers the published engagement for standalone scheduled posts too', async () => {
    stubReads({ newlyLive: [{ id: 6, userId: 60 }] });
    await runJob();
    expect(mockProcessEngagement).toHaveBeenCalledWith({
      userId: 60,
      type: 'published',
      entityType: 'post',
      entityId: 6,
    });
  });

  // The two reads can't overlap today — the flip happens after both — so this pins
  // the guard that keeps that true if either query moves.
  it('rewards a post once when both queries return it', async () => {
    stubReads({ scheduled: [{ id: 3, userId: 30 }], newlyLive: [{ id: 3, userId: 30 }] });
    await runJob();
    expect(mockApply).toHaveBeenCalledTimes(1);
  });

  it('reports a failed reward to Axiom and keeps publishing', async () => {
    mockApply.mockRejectedValueOnce(new Error('buzz down'));
    stubReads({
      newlyLive: [
        { id: 4, userId: 40 },
        { id: 5, userId: 50 },
      ],
    });
    await runJob();
    expect(mockApply).toHaveBeenCalledTimes(2);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', postId: 4 })
    );
    expect(mockSetLastRun).toHaveBeenCalled();
  });

  // The ledger keys this reward on the post id and never expires it, so re-applying
  // to a post it already paid for spends the user's daily cap and then gets refused
  // as a duplicate — 25 Buzz never moves and the day's real post is capped.
  it('skips posts the reward has already been granted for', async () => {
    mockRewardedIds.mockResolvedValue(new Set([2]));
    stubReads({
      newlyLive: [
        { id: 2, userId: 20 },
        { id: 3, userId: 30 },
      ],
    });
    await runJob();
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply).toHaveBeenCalledWith({ postId: 3, posterId: 30 });
  });

  it('checks both publish paths against the prior grants, deduped', async () => {
    stubReads({ scheduled: [{ id: 7, userId: 70 }], newlyLive: [{ id: 7, userId: 70 }] });
    await runJob();
    expect(mockRewardedIds).toHaveBeenCalledWith([{ id: 7, userId: 70 }]);
  });

  // Dropping the sweep's rewards on a ClickHouse blip would lose them for good: the
  // window only advances forward, so these posts are never reconsidered.
  it('keeps granting, and says so, when the prior-grant lookup fails', async () => {
    mockRewardedIds.mockRejectedValue(new Error('clickhouse down'));
    stubReads({ newlyLive: [{ id: 8, userId: 80 }] });
    await runJob();
    expect(mockApply).toHaveBeenCalledWith({ postId: 8, posterId: 80 });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('unfiltered') })
    );
  });

  it('warns instead of silently truncating when the sweep hits its row limit', async () => {
    stubReads({ newlyLive: Array.from({ length: 5000 }, (_, i) => ({ id: i, userId: i })) });
    await runJob();
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', message: expect.stringContaining('row limit') })
    );
  });
});

describe('processScheduledPublishing :: comic chapter notifications', () => {
  const chapter: Chapter = {
    projectId: 5,
    position: 2,
    userId: 50,
    projectName: 'Proj',
    chapterName: 'Ch2',
    username: 'author',
  };

  it('notifies the project followers when a scheduled chapter goes live', async () => {
    stubReads({
      chapters: [chapter],
      followers: [
        { projectId: 5, userId: 101 },
        { projectId: 5, userId: 102 },
      ],
    });
    await runJob();
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'new-comic-chapter',
        key: 'new-comic-chapter:5:2',
        userIds: [101, 102],
      })
    );
  });

  // The follower read sits ahead of every publish side effect and outside the
  // transaction, so a failure there takes down the whole run — after the chapters
  // have already flipped to Published, which is what makes the loss permanent.
  it('completes the rest of the run once a chapter batch is handled', async () => {
    stubReads({
      chapters: [chapter],
      followers: [{ projectId: 5, userId: 101 }],
      newlyLive: [{ id: 9, userId: 90 }],
    });
    await runJob();
    expect(mockApply).toHaveBeenCalledWith({ postId: 9, posterId: 90 });
    expect(mockSetLastRun).toHaveBeenCalled();
  });
});

describe('processScheduledPublishing :: standalone sweep window', () => {
  // The reward's dedup entry expires at UTC midnight, so a window reaching back past
  // it would re-grant yesterday's posts on today's cap.
  it('never reaches back past the start of the UTC day', async () => {
    await runJob();
    const [, windowStart] = standaloneCall() as [unknown, Date];
    expect(windowStart.toISOString()).toBe(
      new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString()
    );
  });

  it('starts at the previous run when that is inside the current UTC day', async () => {
    const startOfDay = new Date().setUTCHours(0, 0, 0, 0);
    jobDate.lastRun = new Date(Math.max(Date.now() - 60 * 1000, startOfDay + 1));
    await runJob();
    const [, windowStart] = standaloneCall() as [unknown, Date];
    expect(windowStart).toEqual(jobDate.lastRun);
  });

  // Bound as a parameter the minute count arrives as int8 and make_interval only
  // takes int4, so the query fails to resolve the function (42883) on every run.
  it('inlines the schedule offset rather than binding it', async () => {
    await runJob();
    const interval = standaloneCall().find(
      (value) => typeof (value as Prisma.Sql)?.sql === 'string'
    ) as Prisma.Sql;
    expect(interval.sql).toBe('make_interval(mins => 60)');
    expect(interval.values).toEqual([]);
  });
});

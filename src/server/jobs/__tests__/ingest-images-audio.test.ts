import { beforeEach, describe, expect, it, vi } from 'vitest';

// A posted song is scanned like an image: the cron re-sends a Pending song whose scan has not
// reported back, sends one that was never sent however old it is, and ages a stuck one to Error for
// the capped retry lane.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const now = Date.now();

const row = (over: {
  id: number;
  type?: string;
  ingestion?: string;
  createdAt?: Date;
  scanRequestedAt?: Date | null;
}) => ({
  url: `song-${over.id}`,
  type: 'audio',
  width: null,
  height: null,
  prompt: null,
  retryCount: 0,
  failureClass: null,
  rateLimitedSince: null,
  isBackfill: false,
  ingestion: 'Pending',
  createdAt: new Date(now - 10 * MINUTE),
  scanRequestedAt: null,
  ...over,
});

const ROWS = [
  // Never requested, past the submit-in-flight grace: sent.
  row({ id: 1 }),
  // Requested a minute ago: its scan is in flight, so it waits.
  row({ id: 2, scanRequestedAt: new Date(now - MINUTE) }),
  // Requested long ago and still Pending, past the age-out: Error, not re-sent.
  row({ id: 3, createdAt: new Date(now - 2 * HOUR), scanRequestedAt: new Date(now - 2 * HOUR) }),
  // Requested long ago, within the age-out: re-sent.
  row({ id: 4, scanRequestedAt: new Date(now - 20 * MINUTE) }),
  // A song whose first submit never happened (the orchestrator was down), old enough to age out: it
  // has never been scanned, so it is sent, not failed unsent.
  row({ id: 6, createdAt: new Date(now - 2 * HOUR), scanRequestedAt: null }),
  // No longer awaiting a scan: the one genuinely stale row, which the cron prunes.
  row({ id: 5, ingestion: 'Scanned' }),
];

const { execLog, mockIngestImage } = vi.hoisted(() => ({
  execLog: [] as { sql: string; values: unknown[] }[],
  mockIngestImage: vi.fn(async (_args: { image: { id: number } }) => true),
}));

vi.mock('~/server/services/image.service', () => ({
  ingestImage: mockIngestImage,
  deleteImages: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/concurrency-helpers', () => ({
  limitConcurrency: async (tasks: Array<() => Promise<unknown>>) => {
    for (const task of tasks) await task();
  },
}));
vi.mock('~/env/other', () => ({ isProd: true }));
vi.mock('~/env/server', () => ({
  env: {
    IMAGE_SCANNING_MAX_PER_RUN: 100,
    IMAGE_SCANNING_RETRY_DELAY: 5,
    IMAGE_SCANNING_PENDING_TIMEOUT: 30,
    DATABASE_IS_PROD: true,
  },
}));

import { ingestImages } from '~/server/jobs/image-ingestion';
import { dbMock } from '~/__tests__/mocks/db.mock';

dbMock.dbRead.jobQueue.findMany.mockImplementation(async () =>
  ROWS.map(({ id }) => ({ entityId: id }))
);
dbMock.dbWrite.$queryRaw.mockImplementation(async () => ROWS);
dbMock.dbWrite.$executeRaw.mockImplementation(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    execLog.push({ sql: strings.join('?'), values });
    return 0;
  }
);

const sentIds = () => mockIngestImage.mock.calls.map(([args]) => args.image.id);
const pruned = () => execLog.find((c) => c.sql.includes('DELETE FROM "JobQueue"'));

beforeEach(() => {
  execLog.length = 0;
  mockIngestImage.mockClear();
});

const run = () => (ingestImages.run({} as never) as { result: Promise<unknown> }).result;

describe('ingest-images with songs', () => {
  it('re-sends a Pending song whose scan has not reported back, and only those past the cooldown', async () => {
    await run();

    expect(sentIds().sort()).toEqual([1, 4, 6]);
  });

  it('leaves a song whose scan is in flight in the queue', async () => {
    await run();

    const prunedIds = (pruned()?.values.find(Array.isArray) as number[] | undefined) ?? [];
    expect(prunedIds).toContain(5);
    expect(prunedIds).not.toContain(2);
    expect(prunedIds).not.toContain(1);
  });

  it('ages a song stuck Pending to Error, for the capped retry lane', async () => {
    await run();

    const update = execLog.find(
      (c) => c.sql.includes('UPDATE "Image"') && c.sql.includes("'Pending'")
    );
    expect(update?.values.find(Array.isArray)).toEqual([3]);
    expect(sentIds()).not.toContain(3);
  });

  it('sends a song that was never sent exactly once, however old, and does not age it out', async () => {
    await run();

    expect(sentIds().filter((id) => id === 6)).toHaveLength(1);
    const update = execLog.find(
      (c) => c.sql.includes('UPDATE "Image"') && c.sql.includes("'Pending'")
    );
    expect(update?.values.find(Array.isArray)).not.toContain(6);
  });
});

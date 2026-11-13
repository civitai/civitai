import { describe, it, expect, vi, beforeEach } from 'vitest';

// Which Error rows the cron re-sends, keeps waiting, or prunes, by failure class. The retry
// filter and the waiting-for-retry mirror must agree on each class's delay: a row one of them
// calls due and the other calls waiting is neither sent nor kept, and its queue row is deleted.

const MINUTE = 60_000;

const { rows, mockIngestImage } = vi.hoisted(() => {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    mockIngestImage: vi.fn(async (_input: { image: { id: number } }) => true),
  };
});

vi.mock('~/server/services/image.service', () => ({
  ingestImage: mockIngestImage,
  deleteImages: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/concurrency-helpers', () => ({
  limitConcurrency: async (tasks: Array<() => Promise<unknown>>) => {
    for (const t of tasks) await t();
  },
}));
vi.mock('~/env/other', () => ({ isProd: true }));
vi.mock('~/env/server', () => ({
  env: {
    IMAGE_SCANNING_MAX_PER_RUN: 100,
    IMAGE_SCANNING_RETRY_DELAY: 5,
    IMAGE_SCANNING_PENDING_TIMEOUT: 60,
    DATABASE_IS_PROD: true,
  },
}));

import { ingestImages } from '~/server/jobs/image-ingestion';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
const mockDbWrite = dbMock.dbWrite;
dbMock.dbRead.jobQueue.findMany.mockImplementation(async () =>
  rows.map((row) => ({
    entityId: row.id as number,
    entityType: EntityType.Image,
    type: JobQueueType.ImageScan,
    createdAt: new Date(),
  }))
);
dbMock.dbWrite.$queryRaw.mockImplementation(async () => rows);

const errorRow = (
  id: number,
  {
    minutesAgo,
    failureClass = null,
    failureReason = null,
    retryCount = 1,
  }: {
    minutesAgo: number;
    failureClass?: string | null;
    failureReason?: string | null;
    retryCount?: number;
  }
) => ({
  id,
  url: `img-${id}`,
  type: 'image',
  width: 100,
  height: 100,
  prompt: null,
  scanRequestedAt: new Date(Date.now() - minutesAgo * MINUTE),
  createdAt: new Date(Date.now() - 120 * MINUTE),
  ingestion: 'Error',
  retryCount,
  failureClass,
  failureReason,
  rateLimitedSince: null,
  isBackfill: false,
});

const run = async () => {
  await ingestImages.run({} as Parameters<typeof ingestImages.run>[0]).result;
  const sent = mockIngestImage.mock.calls.map(([input]) => input.image.id);
  // Reads ids from the job's one prune statement; the cap test below is its positive control.
  const pruned = mockDbWrite.$executeRaw.mock.calls
    .filter(([strings]) =>
      (strings as unknown as string[]).join('').includes('DELETE FROM "JobQueue"')
    )
    .flatMap((call) => {
      const ids = call.slice(1).find(Array.isArray);
      if (!ids) throw new Error('JobQueue DELETE without an id array: update this extractor');
      return ids as number[];
    });
  return { sent: sent.sort(), pruned: pruned.sort() };
};

beforeEach(() => {
  rows.length = 0;
  mockIngestImage.mockClear();
  mockDbWrite.$executeRaw.mockClear();
});

describe('ingest-images — Error retries by failure class', () => {
  it('re-sends a provider-unavailable failure after 15 minutes, even one stamped Unknown before', async () => {
    rows.push(
      errorRow(1, { minutesAgo: 20, failureReason: 'No provider supports this job' }),
      errorRow(2, {
        minutesAgo: 20,
        failureClass: 'unknown',
        failureReason: 'Submodel retracted support for this job',
      })
    );
    expect(await run()).toEqual({ sent: [1, 2], pruned: [] });
  });

  it('keeps a Transient failure queued, unsent, while its 15 minutes run', async () => {
    rows.push(errorRow(3, { minutesAgo: 5, failureClass: 'transient' }));
    expect(await run()).toEqual({ sent: [], pruned: [] });
  });

  it('keeps an Unknown failure waiting the full hour: neither sent at 20 minutes nor pruned', async () => {
    rows.push(errorRow(4, { minutesAgo: 20, failureReason: 'something odd' }));
    expect(await run()).toEqual({ sent: [], pruned: [] });
  });

  it('prunes a Transient failure past its retry cap', async () => {
    rows.push(errorRow(5, { minutesAgo: 20, failureClass: 'transient', retryCount: 30 }));
    expect(await run()).toEqual({ sent: [], pruned: [5] });
  });

  it('re-sends an Unknown failure once its hour is up', async () => {
    rows.push(errorRow(6, { minutesAgo: 65, failureReason: 'something odd' }));
    expect(await run()).toEqual({ sent: [6], pruned: [] });
  });

  it('re-sends a row stamped Transient by the webhook after 15 minutes', async () => {
    rows.push(errorRow(7, { minutesAgo: 20, failureClass: 'transient' }));
    expect(await run()).toEqual({ sent: [7], pruned: [] });
  });

  it('gives a reclassified row the Transient cap, past the Unknown one', async () => {
    rows.push(
      errorRow(8, {
        minutesAgo: 20,
        failureClass: 'unknown',
        failureReason: 'No provider supports this job',
        retryCount: 12,
      })
    );
    expect(await run()).toEqual({ sent: [8], pruned: [] });
  });
});

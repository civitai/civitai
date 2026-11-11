import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import type * as ReportService from '~/server/services/report.service';

/**
 * Report CSAM without the report pages only flags the image for the CSAM queue; it names no one. For
 * a feedback page capture that flag is what keeps it from the 30-day purge until a moderator files
 * the report from the subject picker, so this path must flag a capture as it flags any image.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  bulkSetReportStatus: vi.fn(async () => undefined),
}));

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const { reportCsamImages } = await import('~/server/services/image.service');
const { expiredCapturesSql } = await import('~/server/jobs/purge-feedback-captures');

const CAPTURE = 1;
const OTHER_CAPTURE = 2;
const OLD = new Date('2026-01-01T00:00:00Z');
const CUTOFF = new Date('2026-06-01T00:00:00Z');

const query = async (sql: Prisma.Sql) =>
  (await holder.db.query<{ id: number }>(sql.text, sql.values as unknown[])).rows;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "createdAt" timestamp(3) NOT NULL,
      "needsReview" text, "blockedFor" text, minor boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, images jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE "EvidenceHoldImage" ("imageId" int PRIMARY KEY);
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  await holder.db.exec(`TRUNCATE "Image"`);
  await holder.db.query(
    `INSERT INTO "Image" (id, "userId", "createdAt") VALUES ($1, $3, $4), ($2, $3, $4)`,
    [CAPTURE, OTHER_CAPTURE, FEEDBACK_CAPTURE_OWNER_ID, OLD]
  );
  // The flag write runs on PGlite; the rest of the report is outside this test.
  const tx = {
    image: {
      updateMany: async ({ where, data }: { where: { id: { in: number[] } }; data: object }) => {
        const { needsReview } = data as { needsReview: string };
        await holder.db.query(`UPDATE "Image" SET "needsReview" = $1 WHERE id = ANY($2::int[])`, [
          needsReview,
          where.id.in,
        ]);
      },
    },
    $queryRaw: async () => [{ deletable: null }],
    $executeRaw: async () => 0,
  };
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (t: typeof tx) => unknown) =>
    fn(tx)) as never);
  dbMock.dbWrite.image.count.mockImplementation(
    (async ({ where }: { where: { id: { in: number[] }; userId?: number } }) =>
      (
        await holder.db.query<{ n: number }>(
          `SELECT count(*)::int n FROM "Image" WHERE id = ANY($1::int[])
          AND ($2::int IS NULL OR "userId" = $2::int)`,
          [where.id.in, where.userId ?? null]
        )
      ).rows[0].n) as never
  );
  dbMock.dbRead.image.findMany.mockResolvedValue([] as never);
});

describe('Report CSAM on a feedback page capture without the report pages', () => {
  it('puts it in the CSAM queue, where the purge keeps it; an unflagged capture is purged (control)', async () => {
    await reportCsamImages({ imageIds: [CAPTURE], user: { id: 2, isModerator: true } as never });

    const flags = await holder.db.query<{ id: number; needsReview: string | null }>(
      `SELECT id, "needsReview" FROM "Image" ORDER BY id`
    );
    expect(flags.rows).toEqual([
      { id: CAPTURE, needsReview: 'csam' },
      { id: OTHER_CAPTURE, needsReview: null },
    ]);
    expect((await query(expiredCapturesSql(CUTOFF))).map((r) => r.id)).toEqual([OTHER_CAPTURE]);
  });
});

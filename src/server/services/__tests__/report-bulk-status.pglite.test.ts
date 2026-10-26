import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as Rewards from '~/server/rewards';
import type * as ModeratorService from '~/server/services/moderator.service';
import { ReportStatus } from '~/shared/utils/prisma/enums';

/**
 * `bulkSetReportStatus` against a real Postgres `Report` row, beside the moderator app's own status
 * change (its guarded UPDATE, as `apps/moderator/src/lib/server/reports.service.ts` writes it). The
 * replica is whatever `dbRead` answers, so it can lag the row. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { apply } = vi.hoisted(() => ({ apply: vi.fn(async () => undefined) }));
vi.mock('~/server/rewards', async (importOriginal) => ({
  ...(await importOriginal<typeof Rewards>()),
  reportAcceptedReward: { apply },
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: vi.fn(async () => undefined),
}));

const { bulkSetReportStatus } = await import('~/server/services/report.service');

const REPORT = 7;
const FILER = 41;
const CO_REPORTER = 42;
const LATE_CO_REPORTER = 43;
const MOD_APP_MODERATOR = 3;
const MAIN_MODERATOR = 2;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
    CREATE TABLE "Report" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      status "ReportStatus" NOT NULL DEFAULT 'Pending',
      "alsoReportedBy" int[] NOT NULL DEFAULT '{}',
      "previouslyReviewedCount" int NOT NULL DEFAULT 0,
      details jsonb,
      "statusSetAt" timestamp(3),
      "statusSetBy" int
    );
  `);
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
});
afterAll(() => db.close());

async function seed(alsoReportedBy: number[], details: Record<string, unknown> = {}) {
  await db.query(`DELETE FROM "Report"`);
  await db.query(
    `INSERT INTO "Report" (id, "userId", "alsoReportedBy", details) VALUES ($1, $2, $3, $4)`,
    [REPORT, FILER, alsoReportedBy, details]
  );
}

/** The replica's view: the row as it was before anything below changed it. */
function replicaSees(alsoReportedBy: number[]) {
  dbMock.dbRead.report.findMany.mockResolvedValue([
    { id: REPORT, userId: FILER, alsoReportedBy, details: {} },
  ] as never);
}

/** The moderator app's status change: guarded on status, and it pays for the row it returns. */
async function moderatorAppSets(status: ReportStatus) {
  const { rows } = await db.query<{ userId: number; alsoReportedBy: number[] }>(
    `UPDATE "Report" SET status = $1, "statusSetAt" = now(), "statusSetBy" = $2
     WHERE id = $3 AND status != $1 RETURNING "userId", "alsoReportedBy"`,
    [status, MOD_APP_MODERATOR, REPORT]
  );
  return rows[0];
}

const mainSets = (status: ReportStatus) =>
  bulkSetReportStatus({ ids: [REPORT], status, userId: MAIN_MODERATOR });

const paid = () => apply.mock.calls.map(([event]) => (event as { userId: number }).userId).sort();

const stored = async () =>
  (
    await db.query<{ status: string; statusSetBy: number; previouslyReviewedCount: number }>(
      `SELECT status, "statusSetBy", "previouslyReviewedCount" FROM "Report" WHERE id = $1`,
      [REPORT]
    )
  ).rows[0];

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.report.update.mockResolvedValue({} as never);
});

describe('actioning one report from both apps', () => {
  it('pays nothing from the main app when the moderator app actioned it first', async () => {
    await seed([CO_REPORTER]);
    replicaSees([CO_REPORTER]);

    expect(await moderatorAppSets(ReportStatus.Actioned)).toBeDefined();
    await mainSets(ReportStatus.Actioned);

    expect(paid()).toEqual([]);
    expect(await stored()).toMatchObject({ status: 'Actioned', statusSetBy: MOD_APP_MODERATOR });
  });

  it('leaves the moderator app nothing to pay when the main app actioned it first', async () => {
    await seed([CO_REPORTER]);
    replicaSees([CO_REPORTER]);

    await mainSets(ReportStatus.Actioned);

    expect(paid()).toEqual([FILER, CO_REPORTER]);
    expect(await moderatorAppSets(ReportStatus.Actioned)).toBeUndefined();
    expect(await stored()).toMatchObject({ status: 'Actioned', statusSetBy: MAIN_MODERATOR });
  });
});

describe('actioning from the main app', () => {
  it('counts the filer alone on a report nobody else filed', async () => {
    await seed([]);
    replicaSees([]);

    await mainSets(ReportStatus.Actioned);

    expect(paid()).toEqual([FILER]);
    expect(await stored()).toMatchObject({ previouslyReviewedCount: 1 });
  });

  it('pays nobody the row marks as earning nothing for it', async () => {
    await seed([CO_REPORTER], {
      noReportReward: true,
      additionalReports: [{ userId: CO_REPORTER, details: { comment: 'me too' } }],
    });
    replicaSees([CO_REPORTER]);

    await mainSets(ReportStatus.Actioned);

    expect(paid()).toEqual([CO_REPORTER]);
  });

  it('pays and counts the reporters the row holds, not the replica', async () => {
    await seed([CO_REPORTER, LATE_CO_REPORTER]);
    replicaSees([CO_REPORTER]);

    await mainSets(ReportStatus.Actioned);

    expect(paid()).toEqual([FILER, CO_REPORTER, LATE_CO_REPORTER]);
    expect(await stored()).toMatchObject({ previouslyReviewedCount: 3 });
  });

  it('still moves a report to a different status, and pays nobody for it', async () => {
    await seed([CO_REPORTER]);
    replicaSees([CO_REPORTER]);

    await mainSets(ReportStatus.Unactioned);

    expect(paid()).toEqual([]);
    expect(await stored()).toMatchObject({ status: 'Unactioned', statusSetBy: MAIN_MODERATOR });
  });
});

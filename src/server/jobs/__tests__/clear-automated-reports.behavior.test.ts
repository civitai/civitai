import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

dbMock.dbWrite.$executeRaw.mockImplementation((async (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  const { affectedRows } = await holder.db.query(flat.text, flat.values as unknown[]);
  return affectedRows ?? 0;
}) as never);

const { clearAutomatedReports, AUTOMATED_REPORT_RETENTION_DAYS, EXPIRED_AUTOMATED_REPORT_NOTE } =
  await import('~/server/jobs/clear-automated-reports');
const { entityModerationJobs } = await import('~/server/jobs/entity-moderation');

const SYSTEM = -1;
const MODERATOR = 573;
const DAY = 24 * 60 * 60 * 1000;
// Far from the wall clock, so code that ignored the cutoff and used SQL now() would close the wrong rows.
const NOW = new Date('2020-01-15T06:00:00Z');
const CUTOFF = new Date(NOW.getTime() - AUTOMATED_REPORT_RETENTION_DAYS * DAY);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

// Report ids, named for the case each one pins.
const EXPIRING = 1; // evidence past retention, still Pending -> must close
const FRESH = 2; // evidence inside retention -> stays Pending, evidence kept
const BACKLOG = 3; // evidence already gone before this job ran -> untouched
const RULED = 4; // a moderator already actioned it -> their ruling stands
const HUMAN = 5; // not an Automated report, even with an evidence row -> untouched
const DISMISSED = 6; // a moderator already dismissed it -> their ruling stands
const PROCESSING = 7; // being worked -> left alone
const ANNOTATED = 8; // like EXPIRING, but a moderator left a note on it -> note kept, marker added
const MOD_NOTE = 'looked at this, unsure';

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
    CREATE TYPE "ReportReason" AS ENUM ('TOSViolation', 'NSFW', 'Automated', 'Spam');
    CREATE TABLE "Report" (
      id int PRIMARY KEY,
      reason "ReportReason" NOT NULL,
      status "ReportStatus" NOT NULL,
      "createdAt" timestamp(3) NOT NULL,
      "statusSetAt" timestamp(3),
      "statusSetBy" int,
      "internalNotes" text
    );
    CREATE TABLE "ReportAutomated" (
      id serial PRIMARY KEY,
      "reportId" int UNIQUE NOT NULL REFERENCES "Report"(id),
      "createdAt" timestamp(3) NOT NULL
    );
  `);
});

beforeEach(async () => {
  dbMock.dbWrite.keyValue.findUnique.mockResolvedValue(null);
  await holder.db.exec(`
    TRUNCATE "ReportAutomated", "Report";
    INSERT INTO "Report" (id, reason, status, "createdAt", "statusSetAt", "statusSetBy") VALUES
      (${EXPIRING}, 'Automated', 'Pending', '${daysAgo(15)}', NULL, NULL),
      (${FRESH}, 'Automated', 'Pending', '${daysAgo(13)}', NULL, NULL),
      (${BACKLOG}, 'Automated', 'Pending', '${daysAgo(200)}', NULL, NULL),
      (${RULED}, 'Automated', 'Actioned', '${daysAgo(15)}', '${daysAgo(14.5)}', ${MODERATOR}),
      (${HUMAN}, 'TOSViolation', 'Pending', '${daysAgo(15)}', NULL, NULL),
      (${DISMISSED}, 'Automated', 'Unactioned', '${daysAgo(15)}', '${daysAgo(14.5)}', ${MODERATOR}),
      (${PROCESSING}, 'Automated', 'Processing', '${daysAgo(15)}', NULL, NULL);
    INSERT INTO "Report" (id, reason, status, "createdAt", "internalNotes") VALUES
      (${ANNOTATED}, 'Automated', 'Pending', '${daysAgo(15)}', '${MOD_NOTE}');
    INSERT INTO "ReportAutomated" ("reportId", "createdAt") VALUES
      (${EXPIRING}, '${daysAgo(15)}'),
      (${FRESH}, '${daysAgo(13)}'),
      (${RULED}, '${daysAgo(15)}'),
      (${HUMAN}, '${daysAgo(15)}'),
      (${DISMISSED}, '${daysAgo(15)}'),
      (${PROCESSING}, '${daysAgo(15)}'),
      (${ANNOTATED}, '${daysAgo(15)}');
  `);
});

const reports = async () =>
  (
    await holder.db.query<{ id: number; status: string; statusSetBy: number | null }>(
      `SELECT id, status, "statusSetBy" FROM "Report" ORDER BY id`
    )
  ).rows;

const dbNow = async () =>
  (await holder.db.query<{ now: Date }>(`SELECT localtimestamp(3) AS now`)).rows[0]!.now;

const evidenceFor = async () =>
  (
    await holder.db.query<{ reportId: number }>(
      `SELECT "reportId" FROM "ReportAutomated" ORDER BY "reportId"`
    )
  ).rows.map((r) => r.reportId);

describe('clearAutomatedReports', () => {
  it('closes as Unactioned by the system exactly the Pending Automated reports whose evidence it deletes', async () => {
    const result = await clearAutomatedReports(CUTOFF);

    expect(result).toEqual({ closed: 2, deleted: 6 });
    expect(await reports()).toEqual([
      { id: EXPIRING, status: 'Unactioned', statusSetBy: SYSTEM },
      { id: FRESH, status: 'Pending', statusSetBy: null },
      { id: BACKLOG, status: 'Pending', statusSetBy: null },
      { id: RULED, status: 'Actioned', statusSetBy: MODERATOR },
      { id: HUMAN, status: 'Pending', statusSetBy: null },
      { id: DISMISSED, status: 'Unactioned', statusSetBy: MODERATOR },
      { id: PROCESSING, status: 'Processing', statusSetBy: null },
      { id: ANNOTATED, status: 'Unactioned', statusSetBy: SYSTEM },
    ]);
    expect(await evidenceFor()).toEqual([FRESH]);
  });

  it('stamps when the system closed it, and notes that nobody reviewed it', async () => {
    const before = await dbNow();
    await clearAutomatedReports(CUTOFF);
    const after = await dbNow();
    const { rows } = await holder.db.query<{
      id: number;
      statusSetAt: Date | null;
      internalNotes: string | null;
    }>(`SELECT id, "statusSetAt", "internalNotes" FROM "Report" ORDER BY id`);
    const expiring = rows.find((r) => r.id === EXPIRING);
    expect(expiring?.statusSetAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(expiring?.statusSetAt?.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(rows.filter((r) => r.internalNotes !== null)).toEqual([
      expect.objectContaining({ id: EXPIRING, internalNotes: EXPIRED_AUTOMATED_REPORT_NOTE }),
      expect.objectContaining({
        id: ANNOTATED,
        internalNotes: `${MOD_NOTE} | ${EXPIRED_AUTOMATED_REPORT_NOTE}`,
      }),
    ]);
  });

  // Deliberate, and the obvious "simplification" undoes it: closing by REPORT AGE instead would also
  // close the ~1.29M-row evidence-less backlog the first time this job ran after a deploy. That backlog
  // is closed by a one-off, batched, separately approved write; this job must never do it implicitly.
  it('never closes a report whose evidence was already gone, however old', async () => {
    await clearAutomatedReports(new Date(NOW.getTime() + 365 * DAY));

    const backlog = (await reports()).find((r) => r.id === BACKLOG);
    expect(backlog).toEqual({ id: BACKLOG, status: 'Pending', statusSetBy: null });
  });
});

describe('the entity-moderation clear-automated job', () => {
  it('closes reports as it deletes their evidence', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const job = entityModerationJobs.find((j) => j.name === 'entity-moderation-clear-automated');
      if (!job) throw new Error('clear-automated job is not registered');
      await job.run({}).result;
    } finally {
      vi.useRealTimers();
    }

    expect((await reports()).find((r) => r.id === EXPIRING)?.status).toBe('Unactioned');
    expect(await evidenceFor()).toEqual([FRESH]);
  });
});

import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('$lib/server/db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => ({}) }));

const { getOpenUserReports } = await import('../reads');
const { ReportReason, ReportStatus } = await import('$lib/reports');
const { TOOLS } = await import('../tools');

// Real enum types, so a literal the database does not know fails here as it would in prod.
const enumType = (name: string, values: string[]) =>
  `CREATE TYPE "${name}" AS ENUM (${values.map((v) => `'${v}'`).join(', ')});`;
const SCHEMA = `
${enumType('ReportReason', Object.values(ReportReason))}
${enumType('ReportStatus', Object.values(ReportStatus))}
CREATE TABLE "Report" (
  "id" INTEGER PRIMARY KEY,
  "reason" "ReportReason" NOT NULL,
  "status" "ReportStatus" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "userId" INTEGER NOT NULL,
  "details" JSONB,
  "alsoReportedBy" INTEGER[]
);
CREATE TABLE "UserReport" ("reportId" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
`;

// id, reason, status. Ids rise with age, so the newest report has the highest id.
const REPORTS: [number, string, string][] = [
  [1, 'Spam', 'Pending'],
  [2, 'TOSViolation', 'Processing'],
  [3, 'Spam', 'Processing'],
  [4, 'AdminAttention', 'Pending'],
  [5, 'Automated', 'Pending'],
  [6, 'Spam', 'Actioned'],
  [7, 'Spam', 'Pending'],
];

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  for (const [id, reason, status] of REPORTS) {
    await db.query(
      `INSERT INTO "Report" ("id", "reason", "status", "userId") VALUES ($1, $2, $3, 9)`,
      [id, reason, status]
    );
    await db.query(`INSERT INTO "UserReport" ("reportId", "userId") VALUES ($1, $2)`, [
      id,
      100 + id,
    ]);
  }
  await db.query(
    `UPDATE "Report" SET "details" = '{"comment": "selling buzz"}', "alsoReportedBy" = '{11,12}' WHERE "id" = 7`
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const ids = async (query: Parameters<typeof getOpenUserReports>[0]) =>
  (await getOpenUserReports(query)).map((r) => r.reportId);

describe('getOpenUserReports', () => {
  it('reads the open human-filed queue newest first by default', async () => {
    expect(await ids({})).toEqual([7, 4, 3, 2, 1]);
  });

  it('returns each report with its account, reporter, reason, status and comment', async () => {
    const [newest] = await getOpenUserReports({ limit: 1 });
    expect(newest).toMatchObject({
      reportId: 7,
      userId: 107,
      reporterId: 9,
      reason: 'Spam',
      status: 'Pending',
      comment: 'selling buzz',
      alsoReportedBy: 2,
    });
  });

  it('pages with a cursor in either order', async () => {
    expect(await ids({ limit: 2 })).toEqual([7, 4]);
    expect(await ids({ limit: 2, cursor: 4 })).toEqual([3, 2]);
    expect(await ids({ order: 'oldest', limit: 2 })).toEqual([1, 2]);
    expect(await ids({ order: 'oldest', limit: 2, cursor: 2 })).toEqual([3, 4]);
  });

  it('filters by status and by reason', async () => {
    expect(await ids({ statuses: ['Processing'] })).toEqual([3, 2]);
    expect(await ids({ reasons: ['Spam'] })).toEqual([7, 3, 1]);
    expect(await ids({ statuses: ['Pending'], reasons: ['Spam', 'AdminAttention'] })).toEqual([
      7, 4, 1,
    ]);
  });

  it('never builds SQL from a value outside its lists', async () => {
    // A value the input schema would refuse, reaching the function anyway, filters nothing in.
    expect(await ids({ reasons: ["Spam') OR ('1'='1"] })).toEqual([7, 4, 3, 2, 1]);
    expect(await ids({ statuses: ['Actioned'] })).toEqual([7, 4, 3, 2, 1]);
    expect(await ids({ reasons: ['Automated'] })).toEqual([7, 4, 3, 2, 1]);
  });
});

describe('open_user_reports', () => {
  const tool = TOOLS.find((t) => t.name === 'open_user_reports')!;
  const input = tool.input;

  it('hands its filters to the query and returns the next cursor', async () => {
    const run = tool.run as (args: unknown, ctx: unknown) => Promise<{ data: unknown }>;
    const call = async (args: unknown) =>
      (await run(input.parse(args), {})).data as {
        reports: { reportId: number }[];
        nextCursor: number | null;
      };
    const page = await call({ reasons: ['Spam'], statuses: ['Processing', 'Pending'], limit: 2 });
    expect(page.reports.map((r) => r.reportId)).toEqual([7, 3]);
    expect(page.nextCursor).toBe(3);
    const last = await call({ reasons: ['Spam'], statuses: ['Pending'], cursor: 3 });
    expect(last.reports.map((r) => r.reportId)).toEqual([1]);
    expect(last.nextCursor).toBeNull();
    const oldest = await call({ order: 'oldest', limit: 2 });
    expect(oldest.reports.map((r) => r.reportId)).toEqual([1, 2]);
    expect(oldest.nextCursor).toBe(2);
  });

  it('refuses a reason or status off its list', () => {
    expect(input.safeParse({ reasons: ['Automated'] }).success).toBe(false);
    expect(input.safeParse({ reasons: ['spam'] }).success).toBe(false);
    expect(input.safeParse({ statuses: ['Actioned'] }).success).toBe(false);
    expect(input.safeParse({ reasons: ['Spam'], statuses: ['Pending'] }).success).toBe(true);
  });
});

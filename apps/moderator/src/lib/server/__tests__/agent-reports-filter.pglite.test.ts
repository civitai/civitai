import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { REPORT_ENTITIES } from '../report-entities';

/**
 * The `?agents=` filter on the report queues, against real SQL: the list, its total (which pages it),
 * the status chips and the image queue's cursor all narrow together, and the sidebar badge does not.
 */

process.env.AGENT_REPORTER_USER_IDS = ' 501, junk,502,,-3, 501';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { loadReportQueue } = await import('../report-queue-load');
const { getReportCounts } = await import('../reports.service');
const { getReportedImageQueue } = await import('../image-review.service');
const { agentReportWhere } = await import('../agent-reporters');

const HUMAN = 99;
const AGENT_A = 501;
const AGENT_B = 502;

const SCHEMA = `
CREATE TABLE "JobQueue" ("entityId" INTEGER, "entityType" TEXT, "type" TEXT, data JSONB);
CREATE TABLE "User" (
  "id" INTEGER PRIMARY KEY, "username" TEXT, "email" TEXT, "bannedAt" TIMESTAMP(3),
  "muted" BOOLEAN, "deletedAt" TIMESTAMP(3), "isModerator" BOOLEAN
);
CREATE TABLE "Report" (
  "id" INTEGER PRIMARY KEY,
  "reason" TEXT NOT NULL DEFAULT 'TOSViolation',
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "statusSetAt" TIMESTAMP(3),
  "statusSetBy" INTEGER,
  "userId" INTEGER NOT NULL,
  "details" JSONB,
  "internalNotes" TEXT,
  "alsoReportedBy" INTEGER[],
  "previouslyReviewedCount" INTEGER
);
${REPORT_ENTITIES.map(
  (e) =>
    `CREATE TABLE IF NOT EXISTS "${e.reportTable}" ("reportId" INTEGER NOT NULL, "${e.fk}" INTEGER);`
).join('\n')}
CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "userId" INTEGER, "title" TEXT);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL DEFAULT 'u', "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "width" INTEGER, "height" INTEGER, "type" TEXT NOT NULL DEFAULT 'image', "needsReview" TEXT,
  "minor" BOOLEAN NOT NULL DEFAULT FALSE, "poi" BOOLEAN NOT NULL DEFAULT FALSE,
  "userId" INTEGER NOT NULL DEFAULT 10, "postId" INTEGER,
  "modelRestricted" BOOLEAN NOT NULL DEFAULT FALSE,
  "ingestion" TEXT NOT NULL DEFAULT 'Scanned', "blockedFor" TEXT, "metadata" JSONB
);
CREATE TABLE "ModerationRule" ("id" INTEGER PRIMARY KEY, "action" TEXT NOT NULL);
CREATE TABLE "ModerationRuleVersion" ("id" SERIAL PRIMARY KEY, "ruleId" INTEGER NOT NULL, "action" TEXT NOT NULL);
INSERT INTO "User" ("id", "username") VALUES
  (${HUMAN}, 'human'), (${AGENT_A}, 'agent-a'), (${AGENT_B}, 'agent-b'), (10, 'owner');
INSERT INTO "Post" VALUES (1, 10, 'p');
-- Post reports: two human (one with an agent merged in through alsoReportedBy), three agent, one
-- agent report already Processing so the status chips have two numbers to get right.
INSERT INTO "Report" ("id", "userId", "status", "alsoReportedBy") VALUES
  (1, ${HUMAN}, 'Pending', ARRAY[${AGENT_A}]),
  (2, ${AGENT_A}, 'Pending', NULL),
  (3, ${HUMAN}, 'Pending', NULL),
  (4, ${AGENT_B}, 'Pending', NULL),
  (5, ${AGENT_A}, 'Processing', NULL);
INSERT INTO "PostReport" ("reportId", "postId") VALUES (1, 1), (2, 1), (3, 1), (4, 1), (5, 1);
-- Image reports, alternating filer, for the keyset walk.
INSERT INTO "Image" ("id") VALUES (100), (101), (102), (103), (104), (105);
INSERT INTO "Report" ("id", "userId") VALUES
  (10, ${HUMAN}), (11, ${AGENT_A}), (12, ${HUMAN}), (13, ${AGENT_B}), (14, ${HUMAN}), (15, ${AGENT_A});
INSERT INTO "ImageReport" ("imageId", "reportId") VALUES
  (100, 10), (101, 11), (102, 12), (103, 13), (104, 14), (105, 15);
`;

let db: PGlite;
beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});
afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const postQueue = (query: string) =>
  loadReportQueue(
    'post' as never,
    new URL(`https://mod.example/reports/post?status=Pending&status=Processing&limit=2${query}`),
    {
      statusCounts: true,
      limit: 2,
    }
  );

describe('the post report queue under ?agents=', () => {
  it('lists every report by default, marking the agent-filed ones', async () => {
    const q = await postQueue('');
    expect(q.agentFilter).toBe('all');
    expect(q.totalItems).toBe(5);
    expect(q.statusCounts).toEqual({ Pending: 4, Processing: 1 });
    expect(q.items.map((r) => [r.id, r.agentFiled])).toEqual([
      [5, true],
      [4, true],
    ]);
  });

  it('agents only: the list, its total and the status chips count only agent-filed reports', async () => {
    const q = await postQueue('&agents=only');
    expect(q.agentFilter).toBe('only');
    expect(q.totalItems).toBe(3);
    expect(q.statusCounts).toEqual({ Pending: 2, Processing: 1 });
    const page2 = await postQueue('&agents=only&page=2');
    expect([...q.items, ...page2.items].map((r) => r.id)).toEqual([5, 4, 2]);
  });

  it('hide agents: keeps human reports, including one an agent was merged into', async () => {
    const q = await postQueue('&agents=hide');
    expect(q.totalItems).toBe(2);
    expect(q.statusCounts).toEqual({ Pending: 2 });
    expect(q.items.map((r) => [r.id, r.agentFiled])).toEqual([
      [3, false],
      [1, false],
    ]);
  });

  it('ignores the filter on a ?report= view, which opens one report whatever the filters say', async () => {
    const q = await postQueue('&agents=hide&report=2');
    expect(q.items.map((r) => r.id)).toEqual([2]);
    expect(q.agentFilter).toBeNull();
  });

  it('reads an unknown value as all', async () => {
    expect((await postQueue('&agents=bogus')).totalItems).toBe(5);
  });
});

describe('the sidebar badge', () => {
  // The badge is the whole queue's number. A filtered view's chips differ from it on purpose; it must
  // not start following the filter.
  it('counts agent-filed reports while a filtered queue page counts fewer', async () => {
    expect((await postQueue('&agents=hide')).statusCounts).toEqual({ Pending: 2 });
    // Open means Pending here, so report 5 (Processing) is outside it either way.
    const counts = await getReportCounts();
    expect(counts['report:post']).toBe(4);
    expect(counts['report:image']).toBe(6);
  });
});

describe('the reported image queue under ?agents=', () => {
  const walk = async (filter: 'all' | 'only' | 'hide') => {
    const seen: number[] = [];
    let cursor: number | undefined;
    for (let i = 0; i < 10; i++) {
      const { items, nextCursor } = await getReportedImageQueue({
        browsingLevel: 31,
        cursor,
        limit: 1,
        agents: agentReportWhere(filter),
      });
      seen.push(...items.map((it) => it.report.id));
      if (!nextCursor) return seen;
      cursor = nextCursor;
    }
    throw new Error('the cursor never ran out');
  };

  it('pages through every report with no filter', async () => {
    expect(await walk('all')).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it('pages through agent-filed reports only, ending where they end', async () => {
    expect(await walk('only')).toEqual([11, 13, 15]);
  });

  it('pages through human-filed reports only, marking none as agent', async () => {
    expect(await walk('hide')).toEqual([10, 12, 14]);
    const { items } = await getReportedImageQueue({ browsingLevel: 31, limit: 10 });
    expect(items.filter((i) => i.report.agentFiled).map((i) => i.report.id)).toEqual([11, 13, 15]);
  });
});

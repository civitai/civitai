import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The daily Clavata expiry closes reports as the system user (-1). Every "who worked this queue"
 * surface must skip those, or the whole queue reads as worked today by "civitai" and the real
 * moderator resolutions scroll out of view.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ dbRead: null as unknown, pg: null as unknown as PGlite }));

vi.mock('../db', () => ({
  get dbRead() {
    return holder.dbRead;
  },
  get dbWrite() {
    return holder.dbRead;
  },
}));
vi.mock('../moderator-db', () => ({ getModeratorDb: () => null }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn() }));
vi.mock('../rewards', () => ({ rewardReportReporters: vi.fn() }));
vi.mock('../redis', () => ({ getRedis: () => null }));

const { getRecentQueueActivity } = await import('../moderation-board.service');
const { getReportHistory } = await import('../reports.service');
const { REPORT_ENTITIES } = await import('../report-entities');
const { ReportEntity } = await import('$lib/reports');

const MODERATOR = 573;
// A literal, not the app's constant: -1 is what the main-app expiry job writes, so a fixture that
// followed a changed constant would keep passing while the filter stopped matching real rows.
const SYSTEM = -1;
const modelQueue = REPORT_ENTITIES.find((e) => e.reportTable === 'ModelReport')!.label;

beforeAll(async () => {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, username text);
    CREATE TABLE "Report" (
      id int PRIMARY KEY,
      status text NOT NULL,
      "statusSetAt" timestamp(3),
      "statusSetBy" int
    );
    ${REPORT_ENTITIES.map(
      (e) => `CREATE TABLE "${e.reportTable}" ("reportId" int, "${e.fk}" int);`
    ).join('\n')}

    INSERT INTO "User" VALUES (${MODERATOR}, 'a-moderator'), (${SYSTEM}, 'civitai');
    -- Report 3 has no recorded setter and is newer than the moderator's: it must still count, so
    -- != (which drops NULLs) is not a substitute for IS DISTINCT FROM.
    INSERT INTO "Report" VALUES
      (1, 'Unactioned', '2026-09-01T10:00:00Z', ${MODERATOR}),
      (2, 'Unactioned', '2026-10-03T06:00:00Z', ${SYSTEM}),
      (3, 'Actioned', '2026-09-15T10:00:00Z', NULL);
    INSERT INTO "ModelReport" VALUES (1, 11), (2, 12), (3, 13);
    INSERT INTO "PostReport" VALUES (1, 21), (2, 22), (3, 23);
  `);
  holder.dbRead = new Kysely({ dialect: pgliteDialect(pg) });
  holder.pg = pg;
});

describe('getRecentQueueActivity', () => {
  it('names the last PERSON who worked a queue, never the system user', async () => {
    const activity = await getRecentQueueActivity();
    const { rows } = await holder.pg.query<{ statusSetAt: Date }>(
      `SELECT "statusSetAt" FROM "Report" WHERE id = 3`
    );

    expect(activity.get(modelQueue)).toEqual({
      type: `${modelQueue} reports`,
      at: rows[0]!.statusSetAt,
      moderator: null,
    });
  });
});

describe('getReportHistory', () => {
  it('lists what people resolved, without the system closes', async () => {
    const { items } = await getReportHistory(ReportEntity.Post);

    expect(items.map((r) => [r.id, r.moderator])).toEqual([
      [3, null],
      [1, 'a-moderator'],
    ]);
  });
});

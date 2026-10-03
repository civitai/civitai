import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ dbRead: null as unknown }));

vi.mock('../db', () => ({
  get dbRead() {
    return holder.dbRead;
  },
  get dbWrite() {
    return holder.dbRead;
  },
}));
vi.mock('../moderator-db', () => ({ getModeratorDb: () => null }));

const { getRecentQueueActivity } = await import('../moderation-board.service');
const { REPORT_ENTITIES } = await import('../report-entities');
const { SYSTEM_USER_ID } = await import('../users.service');

const MODERATOR = 573;
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
    ${REPORT_ENTITIES.map((e) => `CREATE TABLE "${e.reportTable}" ("reportId" int);`).join('\n')}

    INSERT INTO "User" VALUES (${MODERATOR}, 'a-moderator'), (${SYSTEM_USER_ID}, 'civitai');
    INSERT INTO "Report" VALUES
      (1, 'Unactioned', '2026-09-01T10:00:00Z', ${MODERATOR}),
      (2, 'Unactioned', '2026-10-03T06:00:00Z', ${SYSTEM_USER_ID});
    INSERT INTO "ModelReport" VALUES (1), (2);
  `);
  holder.dbRead = new Kysely({ dialect: pgliteDialect(pg) });
});

describe('getRecentQueueActivity', () => {
  // The daily Clavata expiry closes reports as the system user. Without this, every queue it touches
  // reads "worked today by civitai" and hides the queues no person has opened in weeks.
  it('names the last PERSON who worked a queue, never the system user', async () => {
    const activity = await getRecentQueueActivity();

    expect(activity.get(modelQueue)).toEqual({
      type: `${modelQueue} reports`,
      at: expect.any(Date),
      moderator: 'a-moderator',
    });
  });
});

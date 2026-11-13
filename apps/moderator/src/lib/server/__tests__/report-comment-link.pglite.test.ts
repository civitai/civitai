import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

// A comment report links to the comment's permalink while the comment is live, and to nothing once
// it is deleted. The same resolver feeds every reports surface that renders the link.

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
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn() }));
vi.mock('../rewards', () => ({ rewardReportReporters: vi.fn() }));
vi.mock('../redis', () => ({ getRedis: () => null }));

const { reportReachability } = await import('../reports.service');

beforeAll(async () => {
  const pg = await freshPglite();
  await pg.exec(`
    CREATE TABLE "CommentV3" (id int PRIMARY KEY, "deletedAt" timestamp(3));
    CREATE TABLE "CommentV3Report" ("reportId" int, "commentId" int);
    INSERT INTO "CommentV3" VALUES (31, NULL), (32, now());
    INSERT INTO "CommentV3Report" VALUES (1, 31), (2, 32);
  `);
  holder.dbRead = new Kysely({ dialect: pgliteDialect(pg) });
});

describe('comment report link', () => {
  it('links a report on a live comment to its permalink', async () => {
    expect(await reportReachability('commentV3', 1)).toEqual({
      reachable: true,
      contextUrl: '/comments/31',
    });
  });

  it('gives a report on a deleted comment no link', async () => {
    expect(await reportReachability('commentV3', 2)).toEqual({
      reachable: true,
      contextUrl: null,
    });
  });
});

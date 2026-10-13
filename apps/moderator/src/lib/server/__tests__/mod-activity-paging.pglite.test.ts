import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityGroup } from '$lib/mod-activity';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { walkPages } from './keyset-walk.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../users.service')>()),
  usersByIds: async () => new Map(),
}));

const { getModActivityPage, getModActivitySummary } = await import('../user-account.service');

const SCHEMA = `
CREATE TABLE "ModActivity" (
  "id" INTEGER PRIMARY KEY, "activity" TEXT NOT NULL, "entityType" TEXT, "entityId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL, "userId" INTEGER
);
CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
CREATE TABLE "Model" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
CREATE TABLE "Article" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
`;

const SUBJECT = 7;

// [id, activity, entityType, entityId, minute]. Ids deliberately do NOT follow time, and minutes 30 and
// 20 are each shared by rows from different sources, so the order depends on the (createdAt, id) pair.
const ROWS: [number, string, string, number, number][] = [
  [1, 'buzz:send:green:Reward:100000', 'user', SUBJECT, 10],
  [9, 'buzz:send:blue:Refund:500', 'user', SUBJECT, 30],
  [4, 'buzz:deduct:green:ChargeBack:10', 'user', SUBJECT, 30],
  [6, 'on', 'impersonate', SUBJECT, 20],
  [2, 'setNsfwLevel', 'image', 101, 30],
  [8, 'minor:true', 'image', 102, 20],
  [3, 'minor:false', 'image', 102, 5],
  [5, 'setMinor', 'model', 301, 40],
  [7, 'resolveAppeal', 'image', 101, 50],
  // Crowd votes and a tag edit, all newer than every decision above.
  [20, 'setNsfwLevelKono', 'image', 101, 60],
  [21, 'setNsfwLevelKono', 'image', 102, 61],
  [22, 'setNsfwLevelKono', 'image', 101, 62],
  [23, 'moderateTag', 'image', 102, 63],
  [24, 'ratingReview', 'article', 401, 64],
  // Someone else's account and content: never this subject's history.
  [30, 'setNsfwLevel', 'image', 201, 70],
  [31, 'buzz:send:green:Reward:5', 'user', 8, 70],
];

/** The enforcement view, newest first by (createdAt, id). */
const ENFORCEMENT = [7, 5, 9, 4, 2, 8, 6, 1, 3];

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "ModActivity", "Image", "Model", "Article";
    INSERT INTO "Image" VALUES (101, ${SUBJECT}), (102, ${SUBJECT}), (201, 8);
    INSERT INTO "Model" VALUES (301, ${SUBJECT});
    INSERT INTO "Article" VALUES (401, ${SUBJECT});
  `);
  for (const [id, activity, entityType, entityId, minute] of ROWS)
    await db.query(
      `INSERT INTO "ModActivity" VALUES ($1, $2, $3, $4, TIMESTAMP '2026-10-01 00:00:00' + make_interval(mins => $5), 99)`,
      [id, activity, entityType, entityId, minute]
    );
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const walk = (
  scope: Omit<Parameters<typeof getModActivityPage>[0], 'userId' | 'before'>,
  size: number
) =>
  walkPages((before: { at: string; id: number } | undefined) =>
    getModActivityPage({ userId: SUBJECT, ...scope, before }, size).then((p) => ({
      items: p.rows,
      nextCursor: p.next,
    }))
  );

describe('moderator activity pages', () => {
  it.each([1, 2, 3, 4])(
    'reach every decision exactly once, in order, at %i per page',
    async (size) => {
      expect(await walk({ bucket: 'enforcement' }, size)).toEqual(ENFORCEMENT);
    }
  );

  it('keep newer crowd votes from pushing decisions off the first page', async () => {
    const page = await getModActivityPage({ userId: SUBJECT, bucket: 'enforcement' }, 2);
    expect(page.rows.map((r) => r.id)).toEqual([7, 5]);
  });

  it('include the votes and tag edits when ratings are asked for', async () => {
    expect((await walk({}, 4)).slice(0, 5)).toEqual([24, 23, 22, 21, 20]);
  });

  it('filter a directional family by its group, across every amount and reason', async () => {
    expect(await walk({ bucket: 'enforcement', activity: 'buzz:send' }, 1)).toEqual([9, 1]);
  });

  it('keep opposite flag decisions apart', async () => {
    expect(await walk({ bucket: 'enforcement', activity: 'minor:true' }, 2)).toEqual([8]);
  });

  it('filter by the entity the action was taken on', async () => {
    expect(await walk({ bucket: 'enforcement', entityType: 'model' }, 2)).toEqual([5]);
    expect(await walk({ bucket: 'enforcement', entityType: 'user' }, 2)).toEqual([9, 4, 1]);
  });
});

describe('moderator activity summary', () => {
  it('counts the whole history by filter key, without other accounts or hidden ratings', async () => {
    const summary = await getModActivitySummary(SUBJECT, 'enforcement');
    const byKey = Object.fromEntries(
      summary.map((c) => [`${c.activity}|${c.entityType}`, c.count])
    );
    expect(byKey).toEqual({
      'buzz:send|user': 2,
      'buzz:deduct|user': 1,
      'on|impersonate': 1,
      'setNsfwLevel|image': 1,
      'resolveAppeal|image': 1,
      'minor:true|image': 1,
      'minor:false|image': 1,
      'setMinor|model': 1,
    });
  });

  it('counts the ratings too when they are included', async () => {
    const summary = await getModActivitySummary(SUBJECT);
    expect(summary.find((c) => c.activity === 'setNsfwLevelKono')?.count).toBe(3);
  });
});

describe('activityGroup', () => {
  it.each([
    ['buzz:send:green:Reward:100000', 'buzz:send'],
    ['comments:removeAsTos:12', 'comments:removeAsTos'],
    ['minor:true', 'minor:true'],
    ['restriction:overturned', 'restriction:overturned'],
    ['setNsfwLevel', 'setNsfwLevel'],
  ])('%s -> %s', (activity, group) => {
    expect(activityGroup(activity)).toBe(group);
  });
});

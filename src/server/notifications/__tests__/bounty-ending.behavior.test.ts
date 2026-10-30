import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bountyNotifications } from '~/server/notifications/bounty.notifications';

/** Runs the real `bounty-ending` query against an in-process Postgres. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const OWNER = 1;
const TRACKER = 2;
const LIVE = 10;
const KEPT = 11;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Bounty" (
      id int PRIMARY KEY, name text NOT NULL, "expiresAt" timestamp(3) NOT NULL, meta jsonb
    );
    CREATE TABLE "BountyBenefactor" ("bountyId" int, "userId" int, "awardedAt" timestamp(3));
    CREATE TABLE "BountyEngagement" ("bountyId" int, "userId" int, type text);
    CREATE TABLE "UserNotificationSettings" ("userId" int, type text);
    INSERT INTO "Bounty" VALUES
      (${LIVE}, 'live', now() + interval '12 hours', '{}'),
      (${KEPT}, 'kept', now() + interval '12 hours', '{"removedWithOwner": true}');
    INSERT INTO "BountyBenefactor" VALUES (${LIVE}, ${OWNER}, NULL), (${KEPT}, ${OWNER}, NULL);
    INSERT INTO "BountyEngagement" VALUES (${LIVE}, ${TRACKER}, 'Track'), (${KEPT}, ${TRACKER}, 'Track');
  `);
});
afterAll(() => db.close());

describe('bounty-ending', () => {
  it('tells the supporters and trackers of a live bounty, and no one of one kept after a delete', async () => {
    const query = await bountyNotifications['bounty-ending'].prepareQuery!({
      lastSent: '2000-01-01T00:00:00.000Z',
    } as never);
    const { rows } = await db.query<{ key: string; userId: number }>(query as string);

    expect(rows.map((r) => [r.key, r.userId]).sort()).toEqual([
      [`bounty-ending:${LIVE}`, OWNER],
      [`bounty-ending:${LIVE}`, TRACKER],
    ]);
  });
});

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { crucibleNotifications } from '~/server/notifications/crucible.notifications';

/**
 * Runs the real `crucible-ending-soon` query against an in-process Postgres. A string match on the
 * query cannot tell a recipient set that is right from one that is merely plausible, and the
 * properties that matter here (once per crucible, followers and entrants, never an unfollower or a
 * user who muted the type) are all about which rows come back.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

type Row = { key: string; userId: number; type: string; details: Record<string, unknown> };

const def = (
  crucibleNotifications as unknown as Record<
    string,
    { prepareQuery: (a: { lastSent: string }) => string }
  >
)['crucible-ending-soon'];

let db: PGlite;
let pgNow: Date;

const HOST = 1;
const FOLLOWER = 2;
const ENTRANT = 3; // two entries, still one notification
const FOLLOWING_ENTRANT = 4;
const UNFOLLOWED = 5;
const MUTED = 6;
const MUTED_OTHER_TYPE = 7;
const BLOCKED = 8;
const BLOCKS_HOST = 9;
const HIDES_HOST = 11;
const HOST_HIDES = 12;

const run = async (lastSent: Date) =>
  (await db.query<Row>(def.prepareQuery({ lastSent: lastSent.toISOString() }))).rows;

const secondsFromNow = (s: number) => new Date(pgNow.getTime() + s * 1000).toISOString();
const HOURS_8 = 8 * 60 * 60;

async function seedCrucible({
  id,
  status = 'Active',
  endsInSeconds,
  durationSeconds = 72 * 60 * 60,
  name = 'Neon Dreams',
  ingestion = 'Scanned',
  textNsfw = false,
  coverIngestion = 'Scanned' as string | null,
}: {
  id: number;
  status?: string;
  endsInSeconds: number;
  durationSeconds?: number;
  name?: string;
  ingestion?: string;
  textNsfw?: boolean;
  coverIngestion?: string | null;
}) {
  if (coverIngestion)
    await db.query(`INSERT INTO "Image" (id, ingestion) VALUES ($1, $2)`, [id, coverIngestion]);
  await db.query(
    `INSERT INTO "Crucible" (id, "userId", name, status, ingestion, "textNsfw", "startAt", "endAt", "createdAt", "imageId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7, $9)`,
    [
      id,
      HOST,
      name,
      status,
      ingestion,
      textNsfw,
      secondsFromNow(endsInSeconds - durationSeconds),
      secondsFromNow(endsInSeconds),
      coverIngestion ? id : null,
    ]
  );
}

const follow = (crucibleId: number, userId: number) =>
  db.query(
    `INSERT INTO "CrucibleEngagement" ("userId", "crucibleId", type) VALUES ($1, $2, 'Notify')`,
    [userId, crucibleId]
  );
const enter = (crucibleId: number, userId: number) =>
  db.query(`INSERT INTO "CrucibleEntry" ("crucibleId", "userId") VALUES ($1, $2)`, [
    crucibleId,
    userId,
  ]);

const recipients = (rows: Row[], crucibleId: number) =>
  rows
    .filter((r) => r.key === `crucible-ending-soon:${crucibleId}`)
    .map((r) => r.userId)
    .sort((a, b) => a - b);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    SET TIME ZONE 'UTC';
    CREATE TYPE "CrucibleStatus" AS ENUM ('Pending','Active','Completed','Cancelled');
    CREATE TYPE "CrucibleIngestionStatus" AS ENUM ('Pending','Scanned','Blocked','Error');
    CREATE TYPE "CrucibleEngagementType" AS ENUM ('Notify');
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending','Scanned','Error','Blocked','NotFound','Rescan');
    CREATE TABLE "Image" (
      id INT PRIMARY KEY,
      ingestion "ImageIngestionStatus" NOT NULL
    );
    CREATE TABLE "UserEngagement" (
      "userId" INT NOT NULL,
      "targetUserId" INT NOT NULL,
      type TEXT NOT NULL
    );
    CREATE TABLE "Crucible" (
      id INT PRIMARY KEY,
      "userId" INT NOT NULL,
      name TEXT NOT NULL,
      status "CrucibleStatus" NOT NULL,
      ingestion "CrucibleIngestionStatus" NOT NULL,
      "textNsfw" BOOLEAN NOT NULL DEFAULT false,
      "startAt" TIMESTAMP(3),
      "endAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL,
      "imageId" INT
    );
    CREATE TABLE "CrucibleEntry" (
      id SERIAL PRIMARY KEY,
      "crucibleId" INT NOT NULL,
      "userId" INT NOT NULL
    );
    CREATE TABLE "CrucibleEngagement" (
      "userId" INT NOT NULL,
      "crucibleId" INT NOT NULL,
      type "CrucibleEngagementType" NOT NULL,
      PRIMARY KEY (type, "crucibleId", "userId")
    );
    CREATE TABLE "UserNotificationSettings" (
      "userId" INT NOT NULL,
      type TEXT NOT NULL
    );
  `);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "Crucible", "CrucibleEntry", "CrucibleEngagement", "UserNotificationSettings", "Image", "UserEngagement";
  `);
  pgNow = (await db.query<{ now: Date }>('SELECT now() AS now')).rows[0].now;
});

describe('crucible-ending-soon recipients', () => {
  // The window opened 30s ago, and the previous run was a minute ago.
  const crossing = { endsInSeconds: HOURS_8 - 30 };
  const lastRun = () => new Date(pgNow.getTime() - 60_000);

  it('reaches every follower and entrant exactly once, and nobody else', async () => {
    await seedCrucible({ id: 10, ...crossing });
    await follow(10, FOLLOWER);
    await enter(10, ENTRANT);
    await enter(10, ENTRANT);
    await follow(10, FOLLOWING_ENTRANT);
    await enter(10, FOLLOWING_ENTRANT);

    const rows = await run(lastRun());

    expect(recipients(rows, 10)).toEqual([FOLLOWER, ENTRANT, FOLLOWING_ENTRANT]);
    expect(rows.length).toBe(3);
    expect(rows[0]).toMatchObject({
      type: 'crucible-ending-soon',
      details: { crucibleId: 10, crucibleName: 'Neon Dreams' },
    });
  });

  it('fires on the run that crosses into the window, and not on the next one', async () => {
    await seedCrucible({ id: 10, ...crossing });
    await follow(10, FOLLOWER);

    expect(recipients(await run(lastRun()), 10)).toEqual([FOLLOWER]);
    // The next minute's run: its lastSent is now, already inside the window.
    expect(recipients(await run(pgNow), 10)).toEqual([]);
  });

  it('does not fire before the window opens, or again deep inside it', async () => {
    await seedCrucible({ id: 10, endsInSeconds: HOURS_8 + 30 });
    await seedCrucible({ id: 11, endsInSeconds: HOURS_8 - 60 * 60 });
    await follow(10, FOLLOWER);
    await follow(11, FOLLOWER);

    expect(await run(lastRun())).toEqual([]);
  });

  // Only the query half: that an unfollow deletes this row is pinned in crucible-engagement.service.test.
  it('skips a user whose follow row is gone, as after an unfollow', async () => {
    await seedCrucible({ id: 10, ...crossing });
    await follow(10, FOLLOWER);
    await follow(10, UNFOLLOWED);
    await db.query(`DELETE FROM "CrucibleEngagement" WHERE "userId" = $1`, [UNFOLLOWED]);

    expect(recipients(await run(lastRun()), 10)).toEqual([FOLLOWER]);
  });

  it('skips a user who muted crucible-ending-soon, but not one who muted something else', async () => {
    await seedCrucible({ id: 10, ...crossing });
    await follow(10, MUTED);
    await follow(10, MUTED_OTHER_TYPE);
    await db.query(
      `INSERT INTO "UserNotificationSettings" ("userId", type) VALUES ($1, 'crucible-ending-soon'), ($2, 'crucible-results')`,
      [MUTED, MUTED_OTHER_TYPE]
    );

    expect(recipients(await run(lastRun()), 10)).toEqual([MUTED_OTHER_TYPE]);
  });

  it('skips a crucible that is not Active', async () => {
    await seedCrucible({ id: 10, ...crossing, status: 'Cancelled' });
    await follow(10, FOLLOWER);

    expect(await run(lastRun())).toEqual([]);
  });

  it('skips a crucible no longer than the window, which is inside it from the start', async () => {
    await seedCrucible({ id: 10, ...crossing, durationSeconds: HOURS_8 - 60 });
    await follow(10, FOLLOWER);

    expect(await run(lastRun())).toEqual([]);
  });

  it('withholds a name that has not passed its scan as safe for everyone', async () => {
    await seedCrucible({ id: 10, ...crossing, textNsfw: true });
    await seedCrucible({ id: 11, ...crossing, ingestion: 'Pending' });
    await follow(10, FOLLOWER);
    await follow(11, HOST);

    const rows = await run(lastRun());

    const names = rows
      .map((r) => [r.details.crucibleId, r.details.crucibleName])
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(names).toEqual([
      [10, null],
      [11, null],
    ]);
  });

  it.each([
    ['its text', { ingestion: 'Pending' }],
    ['its cover', { coverIngestion: 'Pending' }],
    ['it has no cover', { coverIngestion: null }],
  ])('reaches only the host while %s keeps it hidden', async (_, hidden) => {
    await seedCrucible({ id: 10, ...crossing, ...hidden });
    await follow(10, FOLLOWER);
    await enter(10, ENTRANT);
    await follow(10, HOST);

    expect(recipients(await run(lastRun()), 10)).toEqual([HOST]);
  });

  it('skips anyone on either side of a block with the host, or who hid the host', async () => {
    await seedCrucible({ id: 10, ...crossing });
    for (const userId of [FOLLOWER, BLOCKED, BLOCKS_HOST, HIDES_HOST, HOST_HIDES])
      await follow(10, userId);
    await enter(10, ENTRANT);
    await db.query(
      `INSERT INTO "UserEngagement" ("userId", "targetUserId", type) VALUES
        ($1, $2, 'Block'), ($1, $3, 'Block'), ($4, $1, 'Block'), ($5, $1, 'Hide'),
        ($1, $6, 'Hide'), ($1, $7, 'Follow')`,
      [HOST, BLOCKED, ENTRANT, BLOCKS_HOST, HIDES_HOST, HOST_HIDES, FOLLOWER]
    );

    // A Hide only counts in the recipient's own direction, so HOST_HIDES still hears.
    expect(recipients(await run(lastRun()), 10)).toEqual([FOLLOWER, HOST_HIDES]);
  });
});

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { storylineInviteNotifications } from '~/server/notifications/storyline.notifications';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

/** Runs the real `storyline-collaborator-invited` query against an in-process Postgres. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const OWNER = 1;
const INVITEE = 2;
const LAST_SENT = '2026-10-23T10:00:00.000Z';
const AFTER = '2026-10-23 10:00:05';
const BEFORE = '2026-10-23 09:59:00';

const processor = storylineInviteNotifications['storyline-collaborator-invited'];
let db: PGlite;

const run = async () =>
  (
    await db.query<{ key: string; userId: number; type: string; details: Record<string, unknown> }>(
      await (processor.prepareQuery as (a: { lastSent: string }) => Promise<string>)({
        lastSent: LAST_SENT,
      })
    )
  ).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User"(id int PRIMARY KEY, username text);
    CREATE TABLE "UserEngagement"("userId" int, "targetUserId" int, type text);
    CREATE TABLE "UserNotificationSettings"("userId" int, type text);
    CREATE TABLE "Storyline"(id int PRIMARY KEY, "userId" int, title text,
      "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "StorylineCollaborator"("storylineId" int, "userId" int,
      "createdAt" timestamp(3), "acceptedAt" timestamp(3));
    INSERT INTO "User" VALUES (${OWNER}, 'owner'), (${INVITEE}, 'invitee');
  `);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "UserEngagement", "UserNotificationSettings", "Storyline", "StorylineCollaborator";
    INSERT INTO "Storyline" VALUES (10, ${OWNER}, 'The Patch', false);
  `);
});

const invite = ({ createdAt = AFTER, acceptedAt = null as string | null } = {}) =>
  db.query(`INSERT INTO "StorylineCollaborator" VALUES (10, $1, $2, $3)`, [
    INVITEE,
    createdAt,
    acceptedAt,
  ]);

describe('storyline-collaborator-invited', () => {
  it('tells the invitee, naming the owner, linked to the storyline page', async () => {
    expect(notificationProcessors['storyline-collaborator-invited']).toBe(processor);
    await invite();
    const rows = await run();
    expect(rows).toEqual([
      {
        key: `storyline-collaborator-invited:10:${INVITEE}`,
        userId: INVITEE,
        type: 'storyline-collaborator-invited',
        details: expect.objectContaining({ storylineId: 10, ownerUsername: 'owner' }),
      },
    ]);
    expect(
      processor.prepareMessage({
        type: 'storyline-collaborator-invited',
        details: rows[0].details,
      } as never)
    ).toEqual({
      message: 'owner invited you to collaborate on "The Patch"',
      url: '/storylines/10',
    });
  });

  it.each([
    ['the invitation was already accepted', () => invite({ acceptedAt: AFTER })],
    ['it predates the last run', () => invite({ createdAt: BEFORE })],
    [
      'the storyline is taken down',
      async () => {
        await db.exec(`UPDATE "Storyline" SET "tosViolation" = true`);
        await invite();
      },
    ],
    [
      'the invitee blocked the owner',
      async () => {
        await db.exec(`INSERT INTO "UserEngagement" VALUES (${INVITEE}, ${OWNER}, 'Block')`);
        await invite();
      },
    ],
    [
      'the owner blocked the invitee',
      async () => {
        await db.exec(`INSERT INTO "UserEngagement" VALUES (${OWNER}, ${INVITEE}, 'Block')`);
        await invite();
      },
    ],
    [
      'the invitee turned this notification off',
      async () => {
        await db.exec(
          `INSERT INTO "UserNotificationSettings" VALUES (${INVITEE}, 'storyline-collaborator-invited')`
        );
        await invite();
      },
    ],
  ])('sends nothing when %s', async (_name, setup) => {
    await setup();
    expect(await run()).toEqual([]);
  });
});

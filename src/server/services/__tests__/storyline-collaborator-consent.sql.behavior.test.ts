import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import type * as PlacementService from '~/server/services/placement.service';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Collaborator consent, run as written against an in-process Postgres built from the shipped
 * storyline migrations: the migration accepting existing collaborators, and the open feed of a
 * collaborators-only storyline and the continue offer on every listing, both only for an accepted
 * collaborator. All of it lives in SQL, which a mocked client cannot see.
 */

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getAllHiddenForUser: vi.fn().mockResolvedValue({ hiddenImages: [], hiddenTags: [] }),
  getBlockedPairIds: vi.fn().mockResolvedValue([]),
  HiddenUsers: { getCached: vi.fn().mockResolvedValue([]) },
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));
vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  placementPriceRanges: vi.fn().mockResolvedValue(new Map()),
}));

const { getStorylinesInfinite } = await import('~/server/services/storyline.service');

const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

const db = { pg: null as unknown as PGlite };
const r = dbMock.dbRead;

const OWNER = 1;
const STRANGER = 2;
const VETERAN = 4;
const INVITEE = 5;
const COLLAB_ONLY = 4;

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY, username text, "bannedAt" timestamp(3),
      "deletedAt" timestamp(3));
    CREATE TABLE "Post" ("id" integer PRIMARY KEY, "userId" integer, "nsfwLevel" integer NOT NULL DEFAULT 0,
      "publishedAt" timestamp(3), "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "Report" ("id" integer PRIMARY KEY);
    CREATE TABLE "Image" ("id" integer PRIMARY KEY);
    CREATE TABLE "PlacementSpace" (surface text, "entityType" text, "entityId" integer, mode text,
      price integer);
  `);
  for (const name of [
    '20261023120000_storylines',
    '20261023130000_storyline_children_index',
    '20261023140000_storyline_engagement',
    '20261024120000_storyline_chapter_removed',
    '20261024130000_storyline_cover_hero',
    '20261024140000_storyline_title_moderation',
    '20261024150000_storyline_moderator_takedown',
    '20261024160000_storyline_minor_by_scan',
    '20261106120000_storyline_rejoin',
    '20261122120000_storyline_pending_chapter',
  ])
    await db.pg.exec(migration(name));

  await db.pg.exec(`
    INSERT INTO "User" (id, username) VALUES (1, 'owner'), (2, 'stranger'), (3, 'mod');
    INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt") VALUES
      (100, 1, 1, now() - interval '1 day'), (110, 1, 1, now() - interval '1 day'),
      (200, 1, 0, NULL), (201, 2, 0, NULL), (202, 2, 0, NULL), (203, 1, 0, NULL);
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt") VALUES
      (1, 1, 'Started from a post', 1, now()), (2, 1, 'Started empty', 1, now()),
      (3, 1, 'Another story', 1, now());
    INSERT INTO "StorylineChapter" (id, "storylineId", "postId", "userId", depth) VALUES
      (10, 1, 100, 1, 0), (11, 3, 110, 1, 0);
  `);

  // A collaborator from before invitations existed, to be kept as accepted.
  await db.pg.exec(`
    INSERT INTO "User" (id, username) VALUES (4, 'veteran'), (5, 'invitee');
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt", "whoCanContinue")
      VALUES (4, 1, 'Collaborators only', 1, now(), 'Collaborators');
    INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt") VALUES (400, 1, 1, now() - interval '1 day');
    INSERT INTO "StorylineChapter" (id, "storylineId", "postId", "userId", depth) VALUES (40, 4, 400, 1, 0);
    INSERT INTO "StorylineCollaborator" ("storylineId", "userId", "createdAt")
      VALUES (4, 4, '2026-10-20');
  `);
  await db.pg.exec(migration('20261215120000_storyline_collaborator_accepted'));

  const raw = pgliteRaw(db.pg);
  // The feed's own statement runs in Postgres; its image reads find nothing.
  r.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.join('?').includes('FROM "Storyline" st')
      ? raw.queryRaw(strings, ...values)
      : Promise.resolve([])) as never);
});

afterAll(async () => {
  await db.pg.close();
});

const acceptedAt = async (userId: number) =>
  (
    await db.pg.query<{ acceptedAt: Date | null }>(
      `SELECT "acceptedAt" FROM "StorylineCollaborator" WHERE "storylineId" = 4 AND "userId" = $1`,
      [userId]
    )
  ).rows[0]?.acceptedAt;

describe('the collaborator invitation migration', () => {
  it('keeps an existing collaborator, accepted when they were added', async () => {
    expect(await acceptedAt(VETERAN)).toEqual(new Date('2026-10-20'));
  });

  it('re-run, accepts no invitation made since', async () => {
    await db.pg.exec(
      `INSERT INTO "StorylineCollaborator" ("storylineId", "userId") VALUES (4, ${INVITEE})`
    );
    await db.pg.exec(migration('20261215120000_storyline_collaborator_accepted'));
    expect(await acceptedAt(INVITEE)).toBeNull();
    await db.pg.exec(`DELETE FROM "StorylineCollaborator" WHERE "userId" = ${INVITEE}`);
  });
});

describe('the open feed of a collaborators-only storyline', () => {
  const openFeed = async (viewerId: number) =>
    (
      await getStorylinesInfinite({
        filter: 'open',
        sort: 'newest',
        limit: 20,
        viewer: { id: viewerId },
        browsingLevel: NsfwLevel.PG,
      })
    ).items.filter((item) => item.id === COLLAB_ONLY);

  beforeEach(() =>
    db.pg.exec(`
      DELETE FROM "StorylineCollaborator" WHERE "userId" = ${INVITEE};
      INSERT INTO "StorylineCollaborator" ("storylineId", "userId") VALUES (4, ${INVITEE});
    `)
  );

  it('is open to an accepted collaborator', async () => {
    expect(await openFeed(VETERAN)).toHaveLength(1);
  });

  it('is not open to someone only invited', async () => {
    expect(await openFeed(INVITEE)).toEqual([]);
    expect(await openFeed(STRANGER)).toEqual([]);
  });

  it('does not offer continuing to someone only invited, wherever the storyline is listed', async () => {
    const item = async (viewerId: number) =>
      (
        await getStorylinesInfinite({
          filter: 'all',
          sort: 'newest',
          limit: 20,
          viewer: { id: viewerId },
          browsingLevel: NsfwLevel.PG,
        })
      ).items.find((i) => i.id === COLLAB_ONLY);
    expect(await item(INVITEE)).toMatchObject({ open: false });
    expect(await item(VETERAN)).toMatchObject({ open: true });
  });

  it('opens once the invitation is accepted', async () => {
    await db.pg.exec(
      `UPDATE "StorylineCollaborator" SET "acceptedAt" = now() WHERE "userId" = ${INVITEE}`
    );
    expect(await openFeed(INVITEE)).toHaveLength(1);
  });
});

// Last: it re-opens VETERAN's endorsement, which the feed tests above read as accepted.
describe('re-asking the collaborators the backfill accepted', () => {
  const ACCEPTED_IN_APP = 6;
  // Accepted in the millisecond it was made: equal stamps, but after invitations shipped.
  const ACCEPTED_INSTANTLY = 7;
  // Pending since the day invitations shipped, made before the invite notification was: never told.
  const NEVER_TOLD = 8;
  const invitesSince = async (lastSent: Date) => {
    const { storylineInviteNotifications } = await import(
      '~/server/notifications/storyline.notifications'
    );
    const query = await storylineInviteNotifications[
      'storyline-collaborator-invited'
    ].prepareQuery?.({ lastSent: lastSent.toISOString() } as never);
    return (await db.pg.query<{ userId: number }>(query as string)).rows
      .map((row) => row.userId)
      .sort((a, b) => a - b);
  };
  const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);
  const createdAt = async (userId: number) =>
    (
      await db.pg.query<{ createdAt: Date }>(
        `SELECT "createdAt" FROM "StorylineCollaborator" WHERE "storylineId" = 4 AND "userId" = $1`,
        [userId]
      )
    ).rows[0]?.createdAt;
  let invitedBefore: number[] = [];

  beforeAll(async () => {
    await db.pg.exec(`
      CREATE TABLE IF NOT EXISTS "UserEngagement" ("userId" integer, "targetUserId" integer, type text);
      CREATE TABLE IF NOT EXISTS "UserNotificationSettings" ("userId" integer, type text);
      INSERT INTO "User" (id, username) VALUES (${ACCEPTED_IN_APP}, 'accepted-in-app'),
        (${ACCEPTED_INSTANTLY}, 'accepted-instantly'), (${NEVER_TOLD}, 'never-told');
      DELETE FROM "StorylineCollaborator" WHERE "userId" = ${INVITEE};
      INSERT INTO "StorylineCollaborator" ("storylineId", "userId", "createdAt", "acceptedAt") VALUES
        (4, ${ACCEPTED_IN_APP}, '2026-10-31', '2026-11-01'),
        (4, ${ACCEPTED_INSTANTLY}, '2026-11-01', '2026-11-01'),
        (4, ${INVITEE}, '2026-10-31', NULL),
        (4, ${NEVER_TOLD}, '2026-10-30 09:23', NULL);
    `);
    expect(await acceptedAt(VETERAN)).toEqual(new Date('2026-10-20'));
    invitedBefore = await invitesSince(minutesFromNow(-1));
    // Applied from a client whose session is not in UTC, as a hand-applier's may be.
    await db.pg.exec(`
      SET TimeZone = 'America/Los_Angeles';
      ${migration('20261218120000_storyline_collaborator_reask')}
      RESET TimeZone;
    `);
  });

  it('puts a backfilled collaborator back to pending and sends them the invite', async () => {
    expect(invitedBefore).toEqual([]);
    expect(await acceptedAt(VETERAN)).toBeNull();
    expect(await invitesSince(minutesFromNow(-1))).toContain(VETERAN);
  });

  it('sends the invite to a collaborator pending since before the notification existed', async () => {
    expect(await acceptedAt(NEVER_TOLD)).toBeNull();
    expect(await invitesSince(minutesFromNow(-1))).toEqual([VETERAN, NEVER_TOLD]);
  });

  // A notification run that recorded its start after the UPDATE began, but read the replica before
  // the rows arrived, moves its watermark past them. The next runs must still find them.
  it('is still found by a run whose watermark passed the UPDATE', async () => {
    expect(await invitesSince(minutesFromNow(30))).toEqual([VETERAN, NEVER_TOLD]);
  });

  it('leaves an invitation accepted in the app, or still pending, alone', async () => {
    expect(await acceptedAt(ACCEPTED_IN_APP)).toEqual(new Date('2026-11-01'));
    expect(await acceptedAt(ACCEPTED_INSTANTLY)).toEqual(new Date('2026-11-01'));
    expect(await acceptedAt(INVITEE)).toBeNull();
    expect(await createdAt(INVITEE)).toEqual(new Date('2026-10-31'));
  });

  it('re-run, changes nothing', async () => {
    const before = [await createdAt(VETERAN), await createdAt(NEVER_TOLD)];
    await db.pg.exec(migration('20261218120000_storyline_collaborator_reask'));
    expect([await createdAt(VETERAN), await createdAt(NEVER_TOLD)]).toEqual(before);
  });
});

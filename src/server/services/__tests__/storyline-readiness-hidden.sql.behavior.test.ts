import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import type * as PlacementEscrow from '~/server/services/placement-escrow.service';
import type * as PlacementService from '~/server/services/placement.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Which continuations the readiness pass selects while chapter 1 hides their storyline, run as
 * written against an in-process Postgres built from the shipped storyline migrations. A row that
 * an unpublished or unrated chapter 1 hides from its placer is left out, so it cannot take a batch
 * slot every tick; one a removed chapter 1 hides is selected, to be refunded at once. Only the
 * selection is under test: what the pass does with a row is stubbed.
 */

vi.mock('~/server/services/placement-escrow.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementEscrow>()),
  settlePlacement: vi.fn(),
  isPlacementEscrowFunded: vi.fn().mockResolvedValue(true),
}));
vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  getPlacementConfig: async () => ({ expiryHours: () => 168 }),
}));

const { startReadyStorylineContinuations } = await import(
  '~/server/services/storyline-placement.service'
);

const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

const db = { pg: null as unknown as PGlite };
const w = dbMock.dbWrite;

const OWNER = 1;
const STRANGER = 2;
const COLLABORATOR = 3;
const CONTRIBUTOR = 4;
const INVITEE = 5;
/** One continuation of chapter 2 (post 101) from each placer, by placement id. */
const FROM = { [STRANGER]: 1, [COLLABORATOR]: 2, [CONTRIBUTOR]: 3, [INVITEE]: 4 } as const;
const EVERYONE = [1, 2, 3, 4];
const PARTICIPANTS = [FROM[COLLABORATOR], FROM[CONTRIBUTOR]];

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY, username text, "bannedAt" timestamp(3),
      "deletedAt" timestamp(3));
    CREATE TABLE "Post" ("id" integer PRIMARY KEY, "userId" integer, "nsfwLevel" integer NOT NULL DEFAULT 0,
      "publishedAt" timestamp(3), "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "Report" ("id" integer PRIMARY KEY);
    CREATE TABLE "Image" ("id" serial PRIMARY KEY, "postId" integer,
      "tosViolation" boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false, ingestion text NOT NULL DEFAULT 'Scanned',
      "needsReview" text);
    CREATE TABLE "PlacementSpace" (surface text, "entityType" text, "entityId" integer, mode text,
      price integer);
    CREATE TABLE "Placement" (id integer PRIMARY KEY, surface text NOT NULL,
      "targetType" text NOT NULL, "targetId" integer NOT NULL, "ownerId" integer NOT NULL,
      "placerId" integer NOT NULL, data jsonb NOT NULL DEFAULT '{}', status text NOT NULL,
      amount integer NOT NULL);
    CREATE TABLE "PlacementTransaction" (id serial PRIMARY KEY, "placementId" integer NOT NULL,
      kind text NOT NULL, "transactionId" text, amount integer NOT NULL);
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
    '20261215120000_storyline_collaborator_accepted',
  ])
    await db.pg.exec(migration(name));

  await db.pg.exec(`
    INSERT INTO "User" (id, username) VALUES
      (1, 'owner'), (2, 'stranger'), (3, 'collaborator'), (4, 'contributor'), (5, 'invitee');
    INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt") VALUES
      (100, 1, 1, now() - interval '1 day'), (101, 1, 1, now() - interval '1 day'),
      (102, 4, 1, now() - interval '1 day'),
      (201, 2, 1, now() - interval '1 hour'), (202, 3, 1, now() - interval '1 hour'),
      (203, 4, 1, now() - interval '1 hour'), (204, 5, 1, now() - interval '1 hour');
    INSERT INTO "Image" ("postId") VALUES (201), (202), (203), (204);
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt") VALUES
      (1, 1, 'The Long Road', 1, now());
    INSERT INTO "StorylineChapter" (id, "storylineId", "postId", "userId", depth) VALUES
      (10, 1, 100, 1, 0), (11, 1, 101, 1, 1), (12, 1, 102, 4, 1);
    INSERT INTO "StorylineCollaborator" ("storylineId", "userId", "acceptedAt") VALUES
      (1, 3, now()), (1, 5, NULL);
    INSERT INTO "Placement" (id, surface, "targetType", "targetId", "ownerId", "placerId", data,
      status, amount) VALUES
      (1, 'storyline', 'post', 101, 1, 2, '{"awaitingReadiness": true, "postId": 201}', 'pending', 0),
      (2, 'storyline', 'post', 101, 1, 3, '{"awaitingReadiness": true, "postId": 202}', 'pending', 0),
      (3, 'storyline', 'post', 101, 1, 4, '{"awaitingReadiness": true, "postId": 203}', 'pending', 0),
      (4, 'storyline', 'post', 101, 1, 5, '{"awaitingReadiness": true, "postId": 204}', 'pending', 0);
  `);
});

afterAll(async () => {
  await db.pg.close();
});

/** The ids the readiness statement selected, as Postgres returned them. */
let selected: number[] = [];
beforeEach(() => {
  selected = [];
  const raw = pgliteRaw(db.pg);
  w.$queryRaw.mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!strings.join('?').includes('FROM "Placement" pl')) return [];
    const rows = (await raw.queryRaw(strings, ...values)) as { id: number }[];
    selected = rows.map((row) => row.id);
    return rows;
  }) as never);
  // What the pass does with the rows is not under test.
  w.placement.findMany.mockResolvedValue([] as never);
  w.post.findMany.mockResolvedValue([] as never);
});

afterEach(() =>
  db.pg.exec(`
    UPDATE "StorylineChapter" SET "postId" = 100, "removedAt" = NULL WHERE id = 10;
    UPDATE "Post" SET "nsfwLevel" = 1, "publishedAt" = now() - interval '1 day',
      "tosViolation" = false WHERE id = 100;
    UPDATE "User" SET "bannedAt" = NULL WHERE id = 1;
    UPDATE "StorylineChapter" SET "removedAt" = NULL WHERE id = 12;
  `)
);

const select = async () => {
  await startReadyStorylineContinuations();
  return [...selected].sort((a, b) => a - b);
};

describe('the readiness selection while chapter 1 hides the storyline', () => {
  it('selects every ready row while chapter 1 is shown', async () => {
    await expect(select()).resolves.toEqual(EVERYONE);
  });

  it.each([
    ['unpublished', `UPDATE "Post" SET "publishedAt" = NULL WHERE id = 100`],
    ['scheduled', `UPDATE "Post" SET "publishedAt" = now() + interval '1 day' WHERE id = 100`],
    ['unrated', `UPDATE "Post" SET "nsfwLevel" = 0 WHERE id = 100`],
  ])(
    'leaves out a non-participant’s row while chapter 1 is %s, and keeps participants’',
    async (_n, sql) => {
      await db.pg.exec(sql);
      await expect(select()).resolves.toEqual(PARTICIPANTS);
    }
  );

  // Selected so the pass refunds them at once rather than holding them to the deadline.
  it.each([
    ['removed', `UPDATE "StorylineChapter" SET "removedAt" = now() WHERE id = 10`],
    ['deleted', `UPDATE "StorylineChapter" SET "postId" = NULL WHERE id = 10`],
    ['taken down', `UPDATE "Post" SET "tosViolation" = true WHERE id = 100`],
    ['wholly Blocked', `UPDATE "Post" SET "nsfwLevel" = ${NsfwLevel.Blocked} WHERE id = 100`],
    ['by a banned author', `UPDATE "User" SET "bannedAt" = now() WHERE id = 1`],
  ])('still selects every row while chapter 1 is %s', async (_n, sql) => {
    await db.pg.exec(sql);
    await expect(select()).resolves.toEqual(EVERYONE);
  });

  it('leaves out a contributor whose only chapter was removed, as a non-participant', async () => {
    await db.pg.exec(`
      UPDATE "Post" SET "nsfwLevel" = 0 WHERE id = 100;
      UPDATE "StorylineChapter" SET "removedAt" = now() WHERE id = 12;
    `);
    await expect(select()).resolves.toEqual([FROM[COLLABORATOR]]);
  });
});

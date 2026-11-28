import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// The winners query, run against an in-process Postgres: which winner images come back.

const { getChallengeWinners } = await import('~/server/games/daily-challenge/challenge-helpers');

const pg = { db: null as unknown as PGlite };
const CHALLENGE = 500;

type ImageRow = {
  nsfwLevel: number;
  ingestion: string;
  blockedFor?: string | null;
  nsfwLevelLocked?: boolean;
  modelRestricted?: boolean;
  type?: 'image' | 'audio';
  needsReview?: string;
};

const images: Record<string, ImageRow> = {
  scanned: { nsfwLevel: NsfwLevel.X, ingestion: 'Scanned' },
  'Blocked level': { nsfwLevel: NsfwLevel.Blocked, ingestion: 'Scanned' },
  'Blocked ingestion': { nsfwLevel: NsfwLevel.X, ingestion: 'Blocked' },
  'block reason after a rescan': { nsfwLevel: NsfwLevel.X, ingestion: 'Rescan', blockedFor: 'tos' },
  'no media': { nsfwLevel: NsfwLevel.X, ingestion: 'NotFound' },
  'still pending': { nsfwLevel: NsfwLevel.X, ingestion: 'Pending' },
  'pending with a moderator rating': {
    nsfwLevel: NsfwLevel.X,
    ingestion: 'Pending',
    nsfwLevelLocked: true,
  },
  'mature level under a restricting model': {
    nsfwLevel: NsfwLevel.R,
    ingestion: 'Scanned',
    modelRestricted: true,
  },
  'SFW level under a restricting model': {
    nsfwLevel: NsfwLevel.PG,
    ingestion: 'Scanned',
    modelRestricted: true,
  },
  // A song held for csam by its lyrics or cover (PR #10162). Other media under a review keep
  // their image, as before.
  'song held for csam review': {
    nsfwLevel: NsfwLevel.PG,
    ingestion: 'Scanned',
    type: 'audio',
    needsReview: 'csam',
  },
  'scanned song': { nsfwLevel: NsfwLevel.PG, ingestion: 'Scanned', type: 'audio' },
  'picture under csam review': {
    nsfwLevel: NsfwLevel.PG,
    ingestion: 'Scanned',
    needsReview: 'csam',
  },
};
const shown = [
  'scanned',
  'pending with a moderator rating',
  'SFW level under a restricting model',
  'scanned song',
  'picture under csam review',
];
const names = Object.keys(images);

beforeAll(async () => {
  pg.db = new PGlite();
  await pg.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "User" (id int PRIMARY KEY, username text);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, type text NOT NULL DEFAULT 'image', "needsReview" text,
      url text NOT NULL, hash text, "nsfwLevel" int NOT NULL,
      ingestion "ImageIngestionStatus" NOT NULL, "blockedFor" text,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, metadata jsonb, "scanJobs" jsonb,
      "userId" int, "modelRestricted" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Challenge" (id int PRIMARY KEY, "collectionId" int);
    CREATE TABLE "CollectionItem" ("collectionId" int, "imageId" int, note text);
    CREATE TABLE "ChallengeWinner" (
      id int PRIMARY KEY, "challengeId" int NOT NULL, "userId" int NOT NULL, "imageId" int,
      place int NOT NULL, "buzzAwarded" int NOT NULL, "pointsAwarded" int NOT NULL, reason text
    );
    INSERT INTO "Challenge" VALUES (${CHALLENGE}, NULL);
  `);
  for (const [i, name] of names.entries()) {
    const id = i + 1;
    const img = images[name];
    await pg.db.query(`INSERT INTO "User" VALUES ($1, $2)`, [id, `user${id}`]);
    await pg.db.query(
      `INSERT INTO "Image" (id, url, hash, "nsfwLevel", ingestion, "blockedFor", "nsfwLevelLocked", "userId", "modelRestricted", type, "needsReview")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        100 + id,
        `url-${id}`,
        `hash-${id}`,
        img.nsfwLevel,
        img.ingestion,
        img.blockedFor ?? null,
        img.nsfwLevelLocked ?? false,
        id,
        img.modelRestricted ?? false,
        img.type ?? 'image',
        img.needsReview ?? null,
      ]
    );
    await pg.db.query(`INSERT INTO "ChallengeWinner" VALUES ($1, $2, $1, $3, $1, 0, 0, NULL)`, [
      id,
      CHALLENGE,
      100 + id,
    ]);
  }
  const raw = pgliteRaw(pg.db);
  dbMock.dbRead.$queryRaw.mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => raw.queryRaw(strings, ...values)) as never);
});

afterAll(async () => {
  await pg.db.close();
});

describe('getChallengeWinners — winner images', () => {
  const imageOf = async (name: string) => {
    const winners = await getChallengeWinners(CHALLENGE);
    expect(winners).toHaveLength(names.length);
    return winners.find((w) => w.place === names.indexOf(name) + 1)!;
  };

  it.each(shown)('returns a %s image', async (name) => {
    const id = names.indexOf(name) + 1;
    expect(await imageOf(name)).toMatchObject({
      imageId: 100 + id,
      imageUrl: `url-${id}`,
      imageHash: `hash-${id}`,
    });
  });

  it.each(names.filter((n) => !shown.includes(n)))(
    'withholds an image with a %s and keeps the winner',
    async (name) => {
      const id = names.indexOf(name) + 1;
      expect(await imageOf(name)).toMatchObject({
        userId: id,
        username: `user${id}`,
        place: id,
        imageId: null,
        imageUrl: null,
        imageHash: null,
        imageNsfwLevel: null,
      });
    }
  );
});

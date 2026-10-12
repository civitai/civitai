import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// Hand-listed: the real module builds Meilisearch clients and prom collectors at load.
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  bountiesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  comicsSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

/**
 * `updateCollectionsNsfwLevels`' own statement, unmodified, on stand-in tables. The precedence
 * between the forced level, the item probes, the text floor and a moderator rating is a matter of
 * how the CASE composes, which only running it on rows can show.
 */
const holder = { db: null as unknown as PGlite };

// The service passes one `Prisma.sql` object rather than a tagged template.
dbMock.dbWrite.$queryRaw.mockImplementation((query: Prisma.Sql) =>
  holder.db.query(query.text, query.values as unknown[]).then((r) => r.rows)
);

const { updateCollectionsNsfwLevels } = await import('~/server/services/nsfwLevels.service');

const PG = 1;
const PG13 = 2;
const R = 4;
const NSFW_BUCKET = 28;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Collection" (
      "id" integer PRIMARY KEY,
      "nsfwLevel" integer NOT NULL DEFAULT 0,
      "moderatorNsfwLevel" integer,
      "metadata" jsonb NOT NULL DEFAULT '{}',
      "availability" text NOT NULL DEFAULT 'Public',
      "read" text NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "CollectionItem" (
      "id" serial PRIMARY KEY,
      "collectionId" integer NOT NULL,
      "imageId" integer, "postId" integer, "modelId" integer, "articleId" integer, "model3dId" integer,
      "status" text NOT NULL DEFAULT 'ACCEPTED'
    );
    CREATE TABLE "Image" ("id" integer PRIMARY KEY, "nsfwLevel" integer NOT NULL DEFAULT 0);
    CREATE TABLE "Post" ("id" integer PRIMARY KEY, "nsfwLevel" integer NOT NULL DEFAULT 0, "publishedAt" timestamp);
    CREATE TABLE "Model" ("id" integer PRIMARY KEY, "nsfwLevel" integer NOT NULL DEFAULT 0, "status" text);
    CREATE TABLE "Article" ("id" integer PRIMARY KEY, "nsfwLevel" integer NOT NULL DEFAULT 0, "publishedAt" timestamp);
    CREATE TABLE "Model3D" ("id" integer PRIMARY KEY, "nsfwLevel" integer NOT NULL DEFAULT 0, "status" text);
    CREATE TABLE "EntityModeration" (
      "entityType" text NOT NULL,
      "entityId" integer NOT NULL,
      "nsfwLevel" integer,
      "result" jsonb
    );
    INSERT INTO "Image" ("id", "nsfwLevel") VALUES (1, ${PG}), (2, ${R});
  `);
});

afterAll(async () => {
  await holder.db.close();
});

beforeEach(async () => {
  await holder.db.exec(
    `TRUNCATE "Collection", "CollectionItem", "EntityModeration"; ALTER SEQUENCE "CollectionItem_id_seq" RESTART;`
  );
});

let nextId = 1;
async function collection({
  verdict,
  items = [],
  moderatorNsfwLevel = null,
  metadata = {},
  read = 'Public',
  availability = 'Public',
}: {
  verdict?: number;
  items?: ('safe' | 'nsfw')[];
  moderatorNsfwLevel?: number | null;
  metadata?: Record<string, unknown>;
  read?: string;
  availability?: string;
}) {
  const id = nextId++;
  await holder.db.query(
    `INSERT INTO "Collection" ("id", "moderatorNsfwLevel", "metadata", "read", "availability") VALUES ($1, $2, $3, $4, $5)`,
    [id, moderatorNsfwLevel, JSON.stringify(metadata), read, availability]
  );
  for (const item of items)
    await holder.db.query(
      `INSERT INTO "CollectionItem" ("collectionId", "imageId") VALUES ($1, $2)`,
      [id, item === 'safe' ? 1 : 2]
    );
  if (verdict !== undefined)
    await holder.db.query(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", "nsfwLevel", "result") VALUES ('Collection', $1, $2, '{"version":1}')`,
      [id, verdict]
    );
  return id;
}

async function levelAfterRecompute(id: number) {
  await updateCollectionsNsfwLevels([id]);
  const { rows } = await holder.db.query<{ nsfwLevel: number }>(
    `SELECT "nsfwLevel" FROM "Collection" WHERE "id" = $1`,
    [id]
  );
  return rows[0].nsfwLevel;
}

describe('updateCollectionsNsfwLevels — text floor', () => {
  it('rates an empty collection NSFW on an R verdict', async () => {
    expect(await levelAfterRecompute(await collection({ verdict: R }))).toBe(NSFW_BUCKET);
  });

  it('adds the NSFW bucket to safe items on an R verdict', async () => {
    const id = await collection({ verdict: R, items: ['safe'] });
    expect(await levelAfterRecompute(id)).toBe(PG | NSFW_BUCKET);
  });

  it('keeps NSFW items rating it after a PG moderator rating clears the floor', async () => {
    const id = await collection({ verdict: R, items: ['nsfw'], moderatorNsfwLevel: PG });
    expect(await levelAfterRecompute(id)).toBe(NSFW_BUCKET);
  });

  it('clears the floor for safe items under a PG moderator rating', async () => {
    const id = await collection({ verdict: R, items: ['safe'], moderatorNsfwLevel: PG });
    expect(await levelAfterRecompute(id)).toBe(PG);
  });

  it('adds no floor for a PG13 verdict', async () => {
    const id = await collection({ verdict: PG13, items: ['safe'] });
    expect(await levelAfterRecompute(id)).toBe(PG);
  });

  it('lets a forced level win over items, the verdict and a moderator rating', async () => {
    const id = await collection({
      verdict: R,
      items: ['nsfw'],
      moderatorNsfwLevel: R,
      metadata: { forcedBrowsingLevel: PG | PG13 },
    });
    expect(await levelAfterRecompute(id)).toBe(PG);
  });

  it('skips a collection that is not visible', async () => {
    const id = await collection({ verdict: R, items: ['nsfw'], read: 'Private' });
    expect(await levelAfterRecompute(id)).toBe(0);
  });

  it('skips a collection whose availability is Private', async () => {
    const id = await collection({ verdict: R, items: ['nsfw'], availability: 'Private' });
    expect(await levelAfterRecompute(id)).toBe(0);
  });

  it('rates an Unlisted collection', async () => {
    const id = await collection({ verdict: R, items: ['safe'], read: 'Unlisted' });
    expect(await levelAfterRecompute(id)).toBe(PG | NSFW_BUCKET);
  });
});

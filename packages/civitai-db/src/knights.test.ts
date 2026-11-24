import { PGlite } from '@electric-sql/pglite';
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type QueryResult,
} from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Availability } from '@civitai/db-schema/enums';
import type { DB } from '@civitai/db-schema/kysely';
import {
  closeYesNoItemRow,
  gradeKnightsVotes,
  postHiddenFromKnights,
  postNotPrivate,
  servableImage,
  servableImageForSweeps,
} from './knights';

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`CREATE TABLE "KnightsVote" (
    "id" SERIAL PRIMARY KEY, "itemId" INTEGER NOT NULL, "answer" TEXT NOT NULL,
    "verdict" TEXT NOT NULL DEFAULT 'pending'
  )`);
  await pg.exec(`CREATE TABLE "KnightsQueueItem" (
    "id" INTEGER PRIMARY KEY, "status" TEXT NOT NULL DEFAULT 'Open', "reason" TEXT,
    "resolvedAt" TIMESTAMP, "updatedAt" TIMESTAMP, "meta" JSONB
  )`);
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const result = await pg.query(compiled.sql, [...compiled.parameters]);
      return { rows: result.rows as R[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('streaming is not used');
    },
  };
  const dialect: Dialect = {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: async () => undefined,
      acquireConnection: async () => connection,
      beginTransaction: async () => undefined,
      commitTransaction: async () => undefined,
      rollbackTransaction: async () => undefined,
      releaseConnection: async () => undefined,
      destroy: async () => undefined,
    }),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
  db = new Kysely<DB>({ dialect });
});

afterAll(async () => {
  await pg.close();
});

// Players are never served a minor-flagged image, whatever moderators may see.
describe('servableImage', () => {
  beforeAll(async () => {
    await pg.exec(`
      CREATE TABLE "Image" (
        id INTEGER PRIMARY KEY, type TEXT NOT NULL DEFAULT 'image', "nsfwLevel" INTEGER NOT NULL DEFAULT 4,
        ingestion TEXT NOT NULL DEFAULT 'Scanned', "blockedFor" TEXT, "needsReview" TEXT,
        "acceptableMinor" BOOLEAN NOT NULL DEFAULT false, poi BOOLEAN NOT NULL DEFAULT false,
        minor BOOLEAN NOT NULL DEFAULT false, "postId" INTEGER NOT NULL,
        "tosViolation" BOOLEAN NOT NULL DEFAULT false, "userId" INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE "Post" (
        id INTEGER PRIMARY KEY, "publishedAt" TIMESTAMP, availability TEXT NOT NULL DEFAULT 'Public',
        "modelVersionId" INTEGER
      );
      CREATE TABLE "User" (
        id INTEGER PRIMARY KEY, "deletedAt" TIMESTAMP, "bannedAt" TIMESTAMP, muted BOOLEAN NOT NULL DEFAULT false
      );
      CREATE TABLE "Model" (
        id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'Published',
        availability TEXT NOT NULL DEFAULT 'Public', "deletedAt" TIMESTAMP
      );
      CREATE TABLE "ModelVersion" (
        id INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'Published',
        availability TEXT NOT NULL DEFAULT 'Public'
      );
      CREATE TABLE "CsamReport" (
        id SERIAL PRIMARY KEY, "userId" INTEGER, details JSONB NOT NULL DEFAULT '{}', images JSONB NOT NULL DEFAULT '[]'
      );
      CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER NOT NULL);
      INSERT INTO "User" (id) VALUES (1);
      INSERT INTO "Post" (id, "publishedAt") VALUES (1, now() - interval '1 day');
      INSERT INTO "Image" (id, "postId", minor, "acceptableMinor", "needsReview") VALUES
        (990000201, 1, false, false, NULL),
        (990000202, 1, true, false, NULL),
        (990000203, 1, false, true, NULL),
        (990000204, 1, false, false, 'minor');
      INSERT INTO "Post" (id, "publishedAt", availability) VALUES
        (2, now() - interval '1 day', 'Private'),
        (3, now() - interval '1 day', 'Unsearchable'),
        (4, now() - interval '1 day', 'EarlyAccess');
      INSERT INTO "Image" (id, "postId") VALUES (990000205, 2), (990000206, 3), (990000207, 4);
    `);
  });

  const servedBy = async (rule: typeof servableImage) =>
    (
      await db
        .selectFrom('Image as img')
        .innerJoin('Post as p', 'p.id', 'img.postId')
        .select('img.id')
        .where('img.id', '>=', 990000205)
        .where(rule)
        .orderBy('img.id')
        .execute()
    ).map((r) => r.id);

  it('refuses an image on a Private post and serves Unsearchable and EarlyAccess ones', async () => {
    expect(await servedBy(servableImage)).toEqual([990000206, 990000207]);
  });

  it('keeps an image on a Private post for the sweeps, which must only hide it', async () => {
    expect(await servedBy(servableImageForSweeps)).toEqual([990000205, 990000206, 990000207]);
  });

  it('hides the same availabilities whether the rule runs in SQL or on a row already read', async () => {
    const values = Object.values(Availability);
    for (const [index, availability] of values.entries()) {
      await pg.query(
        `INSERT INTO "Post" (id, "publishedAt", availability) VALUES ($1, now() - interval '1 day', $2)`,
        [100 + index, availability]
      );
      await pg.query(`INSERT INTO "Image" (id, "postId") VALUES ($1, $2)`, [
        990000300 + index,
        100 + index,
      ]);
    }
    const shown = await db
      .selectFrom('Image as img')
      .innerJoin('Post as p', 'p.id', 'img.postId')
      .select('p.availability')
      .where('img.id', '>=', 990000300)
      .where(postNotPrivate)
      .orderBy('img.id')
      .execute();

    expect(shown.map((r) => r.availability)).toEqual(
      values.filter((a) => !postHiddenFromKnights(a))
    );
    expect(values.filter(postHiddenFromKnights)).toEqual(['Private']);
    await pg.exec(`DELETE FROM "Image" WHERE id >= 990000300; DELETE FROM "Post" WHERE id >= 100`);
  });

  // Moderation Lead ruling 2026-11-23 on the Knights exclusions: CSAM-listed or held, ToS-violating, deleted-uploader and
  // deleted-model images fail the content rule, so sweeps retire them; a banned or muted uploader and a Draft or Private
  // model or version only hide the image, since each can be lifted.
  describe('exclusions', () => {
    beforeAll(async () => {
      await pg.exec(`
        INSERT INTO "User" (id, "deletedAt", "bannedAt", muted) VALUES
          (5, NULL, NULL, false), (6, now(), NULL, false), (7, NULL, now(), false), (8, NULL, NULL, true),
          (9, NULL, NULL, false);
        INSERT INTO "CsamReport" ("userId", images) VALUES (NULL, '["990000303"]'), (5, '[]');
        INSERT INTO "EvidenceHeldUser" ("userId") VALUES (9);
        INSERT INTO "Model" (id, status, availability, "deletedAt") VALUES
          (201, 'Published', 'Public', NULL), (202, 'Deleted', 'Public', NULL), (203, 'Published', 'Public', now()),
          (204, 'Published', 'Public', NULL), (205, 'Published', 'Public', NULL), (206, 'Draft', 'Public', NULL),
          (207, 'Published', 'Private', NULL), (208, 'Published', 'Public', NULL),
          (209, 'Published', 'Public', NULL), (210, 'UnpublishedViolation', 'Public', NULL);
        INSERT INTO "ModelVersion" (id, "modelId", status, availability) VALUES
          (101, 201, 'Deleted', 'Public'), (102, 202, 'Published', 'Public'), (103, 203, 'Published', 'Public'),
          (104, 204, 'Draft', 'Public'), (105, 205, 'Published', 'Private'), (106, 206, 'Published', 'Public'),
          (107, 207, 'Published', 'Public'), (108, 208, 'Published', 'Public'),
          (109, 209, 'UnpublishedViolation', 'Public'), (110, 210, 'Published', 'Public');
        INSERT INTO "Post" (id, "publishedAt", "modelVersionId")
          SELECT 10 + n, now() - interval '1 day', 100 + n FROM generate_series(1, 10) n;
        INSERT INTO "Image" (id, "postId", "userId", "tosViolation") VALUES
          (990000301, 1, 1, false), (990000302, 1, 1, true), (990000303, 1, 1, false), (990000304, 1, 5, false),
          (990000305, 1, 6, false), (990000306, 11, 1, false), (990000307, 12, 1, false), (990000308, 13, 1, false),
          (990000309, 1, 7, false), (990000310, 1, 8, false), (990000311, 14, 1, false), (990000312, 15, 1, false),
          (990000313, 16, 1, false), (990000314, 17, 1, false), (990000315, 18, 1, false), (990000316, 1, 9, false),
          (990000317, 19, 1, false), (990000318, 20, 1, false);
      `);
    });

    const served = async (rule: typeof servableImage, id: number) =>
      (
        await db
          .selectFrom('Image as img')
          .innerJoin('Post as p', 'p.id', 'img.postId')
          .select('img.id')
          .where('img.id', '=', id)
          .where(rule)
          .execute()
      ).length === 1;

    it('serves a clean image, with and without a published public model', async () => {
      for (const id of [990000301, 990000315]) {
        expect(await served(servableImage, id)).toBe(true);
        expect(await served(servableImageForSweeps, id)).toBe(true);
      }
    });

    it.each([
      ['a ToS violation', 990000302],
      ['a listing on a CSAM report', 990000303],
      ['an uploader named on a CSAM report', 990000304],
      ['an uploader under an evidence hold', 990000316],
      ['a deleted uploader', 990000305],
      ['a deleted model version', 990000306],
      ['a deleted model', 990000307],
      ['a model with deletedAt set', 990000308],
      ['a model version unpublished for a violation', 990000317],
      ['a model unpublished for a violation', 990000318],
    ])('refuses and lets sweeps retire an image with %s', async (_, id) => {
      expect(await served(servableImage, id)).toBe(false);
      expect(await served(servableImageForSweeps, id)).toBe(false);
    });

    it.each([
      ['a banned uploader', 990000309],
      ['a muted uploader', 990000310],
      ['a Draft model version', 990000311],
      ['a Private model version', 990000312],
      ['a Draft model', 990000313],
      ['a Private model', 990000314],
    ])('hides an image with %s but keeps it for the sweeps', async (_, id) => {
      expect(await served(servableImage, id)).toBe(false);
      expect(await served(servableImageForSweeps, id)).toBe(true);
    });
  });

  it('serves a clean image and refuses each minor flag', async () => {
    const rows = await db
      .selectFrom('Image as img')
      .innerJoin('Post as p', 'p.id', 'img.postId')
      .select('img.id')
      .where('img.id', '<', 990000205)
      .where(servableImage)
      .execute();
    expect(rows.map((r) => r.id)).toEqual([990000201]);
  });
});

describe('gradeKnightsVotes', () => {
  it('grades pending votes of one item against the answer and leaves everything else alone', async () => {
    await pg.exec(`INSERT INTO "KnightsVote" ("itemId","answer","verdict") VALUES
      (1,'8','pending'), (1,'2','pending'), (1,'8','inconclusive'), (2,'8','pending')`);

    await gradeKnightsVotes(db, 1, '8');

    const { rows } = await pg.query<{ itemId: number; answer: string; verdict: string }>(
      `SELECT "itemId","answer","verdict" FROM "KnightsVote" ORDER BY "id"`
    );
    expect(rows.map((r) => r.verdict)).toEqual(['correct', 'failed', 'inconclusive', 'pending']);
  });
});

describe('closeYesNoItemRow', () => {
  it('closes the item with the reason, merges the meta patch and makes only its pending votes inconclusive', async () => {
    await pg.exec(`DELETE FROM "KnightsVote";
      INSERT INTO "KnightsQueueItem" ("id","meta") VALUES (10,'{"keep":"1"}'), (11,NULL);
      INSERT INTO "KnightsVote" ("itemId","answer","verdict") VALUES
      (10,'yes','pending'), (10,'no','correct'), (11,'yes','pending')`);

    await closeYesNoItemRow(db, 10, 'moderator-retired', new Date('2026-12-01T10:00:00Z'), {
      moderation: { by: 4 },
    });

    const item = await pg.query<Record<string, unknown>>(
      `SELECT "status","reason","meta","resolvedAt"::text AS "resolvedAt" FROM "KnightsQueueItem" WHERE "id" = 10`
    );
    expect(item.rows[0]).toMatchObject({
      status: 'Closed',
      reason: 'moderator-retired',
      meta: { keep: '1', moderation: { by: 4 } },
    });
    expect(item.rows[0].resolvedAt).toBe('2026-12-01 10:00:00');
    const votes = await pg.query<{ itemId: number; verdict: string }>(
      `SELECT "itemId","verdict" FROM "KnightsVote" ORDER BY "id"`
    );
    expect(votes.rows.map((v) => `${v.itemId}:${v.verdict}`)).toEqual([
      '10:inconclusive',
      '10:correct',
      '11:pending',
    ]);
  });

  it('leaves meta alone without a patch', async () => {
    await closeYesNoItemRow(db, 11, 'moderator-retired', new Date());
    const { rows } = await pg.query<{ meta: unknown }>(
      `SELECT "meta" FROM "KnightsQueueItem" WHERE "id" = 11`
    );
    expect(rows[0].meta).toBeNull();
  });
});

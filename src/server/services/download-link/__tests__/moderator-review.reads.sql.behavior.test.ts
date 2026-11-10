import { PGlite } from '@electric-sql/pglite';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
} from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readModeratorFlags } from '~/server/services/download-link/moderator-review.reads';

// The flags live in `meta` JSON, so only real Postgres can say the read finds them.

const dialect = (pg: PGlite): Dialect => {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const result = await pg.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as never[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not supported');
    },
  };
  const noop = async () => undefined;
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
};

let pg: PGlite;
let db: Kysely<DB>;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, meta jsonb);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL, meta jsonb);
    INSERT INTO "Model" (id, meta) VALUES
      (1, '{}'),
      (2, '{"needsReview": true}'),
      (3, '{}'),
      (4, '{"removedWithOwner": true, "statusBeforeRemoval": "Draft"}'),
      (5, NULL),
      (6, '{"needsReview": false}');
    INSERT INTO "ModelVersion" (id, "modelId", meta) VALUES
      (10, 1, '{}'),
      (20, 2, '{}'),
      (30, 3, '{"needsReview": true}'),
      (40, 4, '{}'),
      (50, 5, NULL),
      (60, 6, '{"needsReview": false}'),
      (31, 1, '{"removedWithOwner": true}');
  `);
  db = new Kysely<DB>({ dialect: dialect(pg) });
});
afterAll(() => pg.close());

describe('readModeratorFlags', () => {
  it.each([
    ['an unflagged version (control)', 10, { inReview: false, removedWithOwner: false }],
    ['a model flagged for review', 20, { inReview: true, removedWithOwner: false }],
    ['a version flagged for review', 30, { inReview: true, removedWithOwner: false }],
    ["a model kept after its owner's removal", 40, { inReview: false, removedWithOwner: true }],
    ['null meta on both', 50, { inReview: false, removedWithOwner: false }],
    ['needsReview set false', 60, { inReview: false, removedWithOwner: false }],
    // Only the model's flag marks a kept model; the version's meta is not read for it.
    ['removedWithOwner on the version only', 31, { inReview: false, removedWithOwner: false }],
    ['a missing version', 999, { inReview: false, removedWithOwner: false }],
  ])('%s', async (_label, id, expected) => {
    expect(await readModeratorFlags(db, id)).toEqual(expected);
  });
});

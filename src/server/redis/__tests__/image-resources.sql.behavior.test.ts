import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { imageResourcesQuery } from '~/server/redis/image-resources.sql';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const ORDER_BY = 'ORDER BY ir."imageId", ir."modelVersionId"';

const pg = { db: null as unknown as PGlite };

beforeAll(async () => {
  pg.db = new PGlite();
  // No keys or indexes, and every row inserted against the order the query must return: without an
  // ORDER BY the rows come back in the order they were written.
  await pg.db.exec(`
    CREATE TABLE "Model" (
      id int NOT NULL, name text NOT NULL, type text NOT NULL,
      poi boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "ModelVersion" (
      id int NOT NULL, "modelId" int NOT NULL, name text NOT NULL, "baseModel" text NOT NULL
    );
    CREATE TABLE "ImageResourceNew" (
      "imageId" int NOT NULL, "modelVersionId" int NOT NULL, strength int,
      detected boolean NOT NULL DEFAULT false
    );
    INSERT INTO "Model" (id, name, type) VALUES
      (303, 'a lora', 'LORA'), (202, 'checkpoint b', 'Checkpoint'),
      (101, 'checkpoint a', 'Checkpoint'), (155, 'another lora', 'LORA');
    INSERT INTO "ModelVersion" (id, "modelId", name, "baseModel") VALUES
      (30, 303, 'lora v1', 'SDXL 1.0'), (20, 202, 'b v1', 'Pony'),
      (15, 155, 'other v1', 'Flux.1 D'), (10, 101, 'a v1', 'Illustrious');
    INSERT INTO "ImageResourceNew" ("imageId", "modelVersionId", strength, detected) VALUES
      (2, 15, NULL, true), (1, 30, 80, true), (1, 20, NULL, false), (1, 10, 100, true);
  `);
});

afterAll(async () => {
  await pg.db?.close();
});

type Row = { imageId: number; modelVersionId: number; modelType: string; baseModel: string };

describe('imageResourcesQuery', () => {
  // The rows' order is the image-resources cache's order: `modelVersionIds` on the public images
  // endpoint and the image feed, and the first Checkpoint's `baseModel`. Unordered, it was whatever
  // the plan returned, and the Node app and feed-go computed the same image's ids in different
  // orders (and, for an image with two Checkpoints, different base models).
  it('returns each image its resources ordered by model version', async () => {
    const rows = (await pgliteRaw(pg.db).queryRaw(imageResourcesQuery([2, 1]))) as Row[];
    expect(rows.map((r) => [r.imageId, r.modelVersionId])).toEqual([
      [1, 10],
      [1, 20],
      [1, 30],
      [2, 15],
    ]);
    // The first Checkpoint is now the lowest version's: 'Illustrious', not 'Pony'.
    expect(rows.find((r) => r.imageId === 1 && r.modelType === 'Checkpoint')?.baseModel).toBe(
      'Illustrious'
    );
  });

  // Cross-app parity pin: feed-go computes the same cache's misses with its own copy of this query
  // (it cannot import it), and the two must order identically or their answers differ again.
  it('orders as feed-go sqlImageResources orders', () => {
    const goSource = fs.readFileSync(
      path.resolve(__dirname, '../../../../apps/feed-go/internal/hydrate/resources.go'),
      'utf8'
    );
    const goSql = goSource.match(/const sqlImageResources = `([^`]*)`/)?.[1];
    expect(goSql).toBeDefined();
    const orderBys = (sql: string) =>
      [...sql.matchAll(/ORDER BY [^\n`]*/g)].map((m) => m[0].replace(/\s+/g, ' ').trim());
    expect(orderBys(imageResourcesQuery([1]).text)).toEqual([ORDER_BY]);
    expect(orderBys(goSql ?? '')).toEqual([ORDER_BY]);
  });
});

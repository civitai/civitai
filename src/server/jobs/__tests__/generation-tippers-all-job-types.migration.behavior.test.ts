import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = readFileSync(
  path.resolve(
    __dirname,
    '../../../../packages/civitai-db-schema/prisma/migrations/20261119200000_generation_tippers_all_job_types/migration.sql'
  ),
  'utf8'
);

// The generationTippers query as it stands in prod, byte for byte (CRLF line ends, tab indents).
// It is ClickHouse SQL, so PGlite only stores it: these tests pin the rewrite, not its results.
const LIVE_QUERY = [
  'WITH clickhouse_data AS (',
  '\tSELECT',
  '\t\tuserId,',
  '\t\tSUM(creatorsTip) AS tips,',
  '\t\tuniq(jobId) as generations',
  '\tFROM orchestration.jobs',
  "\tWHERE jobType IN ('TextToImageV2', 'TextToImage', 'Comfy')",
  '\t\tAND creatorsTip > 0',
  "\t\tAND createdAt > '2024-08-01'",
  '\t\tAND createdAt > subtractDays(now(), 30)',
  '\tGROUP BY 1',
  '\tORDER BY 2 DESC',
  '\tLIMIT 1000',
  ')',
  'SELECT',
  '\tuserId,',
  '\tfloor(tips) AS score,',
  "\ttoJSONString(map('imageCount', cast(generations as int))) as metrics",
  'FROM clickhouse_data',
].join('\r\n');

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

async function seed(pg: PGlite, query: string) {
  await pg.exec('CREATE TABLE "Leaderboard" (id text PRIMARY KEY, query text NOT NULL)');
  await pg.query(`INSERT INTO "Leaderboard" VALUES ('generationTippers', $1), ('other', $1)`, [
    query,
  ]);
}

async function boardQuery(pg: PGlite, id = 'generationTippers') {
  const { rows } = await pg.query<{ query: string }>(
    'SELECT query FROM "Leaderboard" WHERE id = $1',
    [id]
  );
  return rows[0].query;
}

describe('generation tippers all job types migration', () => {
  const db = { pg: null as unknown as PGlite };

  beforeAll(async () => {
    db.pg = new PGlite();
    await seed(db.pg, LIVE_QUERY);
    await db.pg.exec(MIGRATION);
  });

  afterAll(async () => {
    await db.pg.close();
  });

  it('starts from the live prod query', () => {
    expect(md5(LIVE_QUERY)).toBe('ba129c01d01f9275ff0ebc65d78dae33');
  });

  it('counts tips on every job type, keeps out future-dated and garbage-tip rows, labels the count Generations', async () => {
    const after = (await boardQuery(db.pg)).split('\r\n');
    const live = LIVE_QUERY.split('\r\n');
    expect(live.filter((l) => !after.includes(l))).toEqual([
      "\tWHERE jobType IN ('TextToImageV2', 'TextToImage', 'Comfy')",
      '\t\tAND creatorsTip > 0',
      "\ttoJSONString(map('imageCount', cast(generations as int))) as metrics",
    ]);
    expect(after.filter((l) => !live.includes(l))).toEqual([
      '\tWHERE creatorsTip > 0',
      '\t\tAND creatorsTip < 1000000',
      '\t\tAND createdAt <= now()',
      "\ttoJSONString(map('generationCount', cast(generations as int))) as metrics",
    ]);
  });

  it('updates only the generationTippers row', async () => {
    expect(await boardQuery(db.pg, 'other')).toBe(LIVE_QUERY);
  });

  it('is idempotent: a re-run leaves the fixed query as it is', async () => {
    const once = await boardQuery(db.pg);
    await db.pg.exec(MIGRATION);
    expect(await boardQuery(db.pg)).toBe(once);
  });
});

describe('generation tippers all job types migration preconditions', () => {
  it('raises when the generationTippers row is missing', async () => {
    const pg = new PGlite();
    try {
      await pg.exec('CREATE TABLE "Leaderboard" (id text PRIMARY KEY, query text NOT NULL)');
      await expect(pg.exec(MIGRATION)).rejects.toThrow(/row not found/);
    } finally {
      await pg.close();
    }
  });

  it('refuses to touch a query that differs from the reviewed live text', async () => {
    const pg = new PGlite();
    try {
      const edited = LIVE_QUERY.replace('LIMIT 1000', 'LIMIT 500');
      await seed(pg, edited);
      await expect(pg.exec(MIGRATION)).rejects.toThrow(/differs from the reviewed text/);
      await pg.exec('ROLLBACK');
      expect(await boardQuery(pg)).toBe(edited);
    } finally {
      await pg.close();
    }
  });
});

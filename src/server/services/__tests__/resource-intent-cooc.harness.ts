import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import type { CoocDrawRow, CoocRawQuery } from '~/server/services/resource-intent-cooc/build';
import type { CoocSql } from '~/server/services/resource-intent-cooc/store';

/** Test harness for the co-occurrence store: the real migration in an in-memory PGlite. */
export const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'packages/civitai-db-schema/prisma/migrations/20261011120000_resource_intent_cooc_snapshot/migration.sql'
  ),
  'utf8'
);

/**
 * `timestamp(3)` (no zone) read as UTC and a UTC session, as the app's database runs; PGlite's
 * default would read it in the test host's local zone and shift every date.
 */
export async function freshDb() {
  const db = new PGlite({
    parsers: { 1114: (v: string) => new Date(`${v.replace(' ', 'T')}Z`) },
  });
  await db.exec(`SET TIME ZONE 'UTC'`);
  await db.exec(MIGRATION_SQL);
  const statements: string[] = [];
  const sql: CoocSql = {
    query: async <T>(s: Prisma.Sql) => {
      statements.push(s.text);
      return (await db.query<T>(s.text, s.values as unknown[])).rows;
    },
    execute: async (s: Prisma.Sql) => {
      statements.push(s.text);
      return (await db.query(s.text, s.values as unknown[])).affectedRows ?? 0;
    },
  };
  return { db, sql, statements };
}

const DAY = 86_400_000;
export type SeedRow = {
  id?: string;
  kind: 'production' | 'study';
  status?: string;
  trainEnd: Date;
  builtAt: Date;
  pinnedUntil?: Date | null;
  contentHash?: string;
};

/** Insert a row directly, with an explicit (test-only) builtAt. Ready rows get dummy bytes. */
export async function seed(db: PGlite, r: SeedRow): Promise<string> {
  const status = r.status ?? 'ready';
  const ready = status === 'ready';
  const res = await db.query<{ id: string }>(
    `INSERT INTO "ResourceIntentCoocSnapshot"
      ("id", "kind", "status", "contentHash", "specHash", "trainStart", "trainEnd", "seed",
       "pinnedUntil", "builtAt", "trainCreatedAtMin", "trainCreatedAtMax", "trainRows",
       "payload", "trainImageIds")
     VALUES (COALESCE($1, gen_random_uuid()::text), $2, $3, $4, 'spec', $5, $6, 1, $7, $8,
       $9, $10, $11, $12, $13)
     RETURNING "id"`,
    [
      r.id ?? null,
      r.kind,
      status,
      ready ? r.contentHash ?? `hash-${Math.random()}` : null,
      new Date(r.trainEnd.getTime() - 120 * DAY),
      r.trainEnd,
      r.pinnedUntil ?? null,
      r.builtAt,
      ready ? new Date(r.trainEnd.getTime() - 100 * DAY) : null,
      ready ? new Date(r.trainEnd.getTime() - 1) : null,
      ready ? 1 : null,
      ready ? new Uint8Array([1]) : null,
      ready ? new Uint8Array([1]) : null,
    ]
  );
  return res.rows[0].id;
}

export async function ids(db: PGlite): Promise<string[]> {
  return (
    await db.query<{ id: string }>('SELECT "id" FROM "ResourceIntentCoocSnapshot" ORDER BY "id"')
  ).rows.map((r) => r.id);
}

/**
 * A synthetic Image table for the pipeline: `rows` images inside the window, each with synthetic
 * prompt words and attachments. No real data.
 */
export function fakeImageDb(opts: { trainStart: Date; trainEnd: Date; images: number }) {
  const span = opts.trainEnd.getTime() - opts.trainStart.getTime();
  // As in production, newer images exist past `trainEnd` (the id bound search relies on it).
  const maxId = opts.images + 50;
  const createdAt = (id: number) =>
    new Date(opts.trainStart.getTime() + Math.floor(((id - 0.5) / opts.images) * span));
  const queries: string[] = [];
  const query: CoocRawQuery = async (s: Prisma.Sql) => {
    queries.push(s.sql);
    const text = s.sql;
    if (text.includes('max(id)')) return [{ max: maxId }];
    if (text.includes('ORDER BY id LIMIT 1')) {
      const mid = s.values[0] as number;
      return mid <= maxId ? [{ id: mid, createdAt: createdAt(mid) }] : [];
    }
    if (text.includes('WITH s AS')) {
      const [batch, start, end] = s.values as [number[], Date, Date];
      return batch
        .filter((id) => createdAt(id) >= start && createdAt(id) < end)
        .map(
          (id): CoocDrawRow => ({
            imageId: id,
            createdAt: createdAt(id),
            prompt: `tok${String(id % 17).padStart(5, '0')} tok${String(id % 5).padStart(
              5,
              '0'
            )} shared rare${id % 40}`,
            att: [
              { modelId: 1000 + (id % 4), modelType: 'LORA', versionId: 2000 + (id % 4) },
              { modelId: 9000, modelType: 'Checkpoint', versionId: 9900 },
            ],
          })
        );
    }
    if (text.includes('FROM "ModelVersion" mv')) {
      return (s.values[0] as number[]).map((id) => ({
        id,
        trainedWords: id === 2000 ? ['rare0'] : null,
        modelName: `Model ${id}`,
      }));
    }
    throw new Error(`unexpected query: ${text.slice(0, 80)}`);
  };
  return { query, queries };
}

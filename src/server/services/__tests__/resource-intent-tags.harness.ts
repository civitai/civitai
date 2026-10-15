import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import type { CoocSql } from '~/server/services/resource-intent-cooc/store';
import { asFixtureWriter } from './resource-intent-cooc.harness';

/** Test harness for the content-tag tables: the real migration in an in-memory PGlite. */
export const TAGS_MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'packages/civitai-db-schema/prisma/migrations/20261029120000_resource_intent_tags/migration.sql'
  ),
  'utf8'
);

/** A synthetic vocabulary document and its version (sha256 hex of the bytes). */
export function vocabularyPayload(label: string) {
  const payload = Buffer.from(JSON.stringify({ tags: [label, `${label} two`] }));
  return { payload, vocabVersion: createHash('sha256').update(payload).digest('hex') };
}

export const VOCAB = vocabularyPayload('fixture');

/** As the cooc harness: `timestamp(3)` read as UTC, a UTC session, one vocabulary inserted. */
export async function freshTagDb(opts: { extraSql?: string } = {}) {
  const db = new PGlite({
    parsers: { 1114: (v: string) => new Date(`${v.replace(' ', 'T')}Z`) },
  });
  await db.exec(`SET TIME ZONE 'UTC'`);
  if (opts.extraSql) await db.exec(opts.extraSql);
  await db.exec(TAGS_MIGRATION_SQL);
  await db.query(
    `INSERT INTO "ResourceIntentVocabulary" ("vocabVersion", "payload", "rulesSummary") VALUES ($1, $2, '{}')`,
    [VOCAB.vocabVersion, VOCAB.payload]
  );
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

/** Insert a snapshot row directly, with an explicit (test-only) builtAt. Ready rows get dummy bytes. */
export async function seedTagIndex(
  db: PGlite,
  r: {
    id?: string;
    kind: 'production' | 'study';
    status?: string;
    trainEnd: Date;
    builtAt: Date;
    pinnedUntil?: Date | null;
    contentHash?: string;
  }
): Promise<string> {
  const status = r.status ?? 'ready';
  const ready = status === 'ready';
  const res = await asFixtureWriter(db, () =>
    db.query<{ id: string }>(
      `INSERT INTO "ResourceIntentTagIndexSnapshot"
      ("id", "kind", "status", "contentHash", "specHash", "vocabVersion", "trainStart", "trainEnd",
       "seed", "pinnedUntil", "builtAt", "trainCreatedAtMin", "trainCreatedAtMax", "trainRows",
       "payload", "trainImageIds")
     VALUES (COALESCE($1, gen_random_uuid()::text), $2, $3, $4, 'spec', $5, $6, $7, 1, $8, $9,
       $10, $11, $12, $13, $14)
     RETURNING "id"`,
      [
        r.id ?? null,
        r.kind,
        status,
        ready ? r.contentHash ?? `hash-${Math.random()}` : null,
        VOCAB.vocabVersion,
        new Date(r.trainEnd.getTime() - 90 * DAY),
        r.trainEnd,
        r.pinnedUntil ?? null,
        r.builtAt,
        ready ? new Date(r.trainEnd.getTime() - 80 * DAY) : null,
        ready ? new Date(r.trainEnd.getTime() - 1) : null,
        ready ? 1 : null,
        ready ? new Uint8Array([1]) : null,
        ready ? new Uint8Array([1]) : null,
      ]
    )
  );
  return res.rows[0].id;
}

export async function tagIndexIds(db: PGlite): Promise<string[]> {
  return (
    await db.query<{ id: string }>(
      'SELECT "id" FROM "ResourceIntentTagIndexSnapshot" ORDER BY "id"'
    )
  ).rows.map((r) => r.id);
}

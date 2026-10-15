import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

/** `ResourceIntentVocabulary`'s CHECKs and unique key, against the real migration in PGlite. */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'packages/civitai-db-schema/prisma/migrations/20261029120000_resource_intent_tags/migration.sql'
  ),
  'utf8'
);

/** A synthetic vocabulary document and its version (sha256 hex of the bytes). */
function vocabulary(label: string) {
  const payload = Buffer.from(JSON.stringify({ tags: [label, `${label} two`] }));
  return { payload, vocabVersion: createHash('sha256').update(payload).digest('hex') };
}

async function freshDb() {
  const db = new PGlite();
  await db.exec(MIGRATION_SQL);
  return db;
}

type Row = {
  vocabVersion: string;
  payload: Buffer;
  status?: string;
  frozenAt?: string | null;
  frozenBy?: string | null;
};
const insert = (db: PGlite, r: Row) =>
  db.query(
    `INSERT INTO "ResourceIntentVocabulary"
       ("vocabVersion", "payload", "rulesSummary", "status", "frozenAt", "frozenBy")
     VALUES ($1, $2, '{}', COALESCE($3, 'candidate'), $4, $5)`,
    [r.vocabVersion, r.payload, r.status ?? null, r.frozenAt ?? null, r.frozenBy ?? null]
  );

describe('ResourceIntentVocabulary on the real migration', () => {
  it('the migration is re-runnable', async () => {
    const db = await freshDb();
    await expect(db.exec(MIGRATION_SQL)).resolves.toBeDefined();
  });

  it('creates the table and its constraints, and no trigger', async () => {
    const db = await freshDb();
    const cons = await db.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"ResourceIntentVocabulary"'::regclass ORDER BY conname`
    );
    expect(cons.rows.map((r) => r.conname)).toEqual([
      'ResourceIntentVocabulary_pkey',
      'ResourceIntentVocabulary_status_check',
      'ResourceIntentVocabulary_version_check',
    ]);
    const idx = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'ResourceIntentVocabulary' ORDER BY indexname`
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual([
      'ResourceIntentVocabulary_pkey',
      'ResourceIntentVocabulary_vocabVersion_key',
    ]);
    const trg = await db.query(
      `SELECT 1 FROM pg_trigger WHERE tgrelid = '"ResourceIntentVocabulary"'::regclass AND NOT tgisinternal`
    );
    expect(trg.rows).toEqual([]);
  });

  it('the version must be the sha256 of the payload, and is unique', async () => {
    const db = await freshDb();
    const a = vocabulary('a');
    const b = vocabulary('b');
    await insert(db, a);
    // b's payload under a's (valid, already used) version fails the CHECK before the unique key.
    await expect(insert(db, { ...b, vocabVersion: a.vocabVersion })).rejects.toThrow(
      /version_check/
    );
    await expect(insert(db, { ...b, vocabVersion: 'a'.repeat(64) })).rejects.toThrow(
      /version_check/
    );
    await expect(insert(db, a)).rejects.toThrow(/vocabVersion_key/);
    await expect(insert(db, b)).resolves.toBeDefined();
    const n = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "ResourceIntentVocabulary"`
    );
    expect(n.rows[0].n).toBe(2);
  });

  it('defaults to a candidate', async () => {
    const db = await freshDb();
    const a = vocabulary('a');
    await db.query(
      `INSERT INTO "ResourceIntentVocabulary" ("vocabVersion", "payload", "rulesSummary") VALUES ($1, $2, '{}')`,
      [a.vocabVersion, a.payload]
    );
    const r = await db.query<{ status: string }>(`SELECT "status" FROM "ResourceIntentVocabulary"`);
    expect(r.rows[0].status).toBe('candidate');
  });

  it.each([
    ['candidate', null, null, true],
    ['candidate', '2026-10-15', null, false],
    ['candidate', null, 'operator', false],
    ['frozen', '2026-10-15', 'operator', true],
    ['frozen', null, 'operator', false],
    ['frozen', '2026-10-15', null, false],
    ['frozen', null, null, false],
    ['retired', null, null, true],
    ['retired', '2026-10-15', 'operator', true],
    ['retired', '2026-10-15', null, false],
    ['retired', null, 'operator', false],
    ['other', null, null, false],
  ] as const)(
    'status %s with frozenAt %s and frozenBy %s: accepted = %s',
    async (status, frozenAt, frozenBy, ok) => {
      const db = await freshDb();
      const p = insert(db, { ...vocabulary('a'), status, frozenAt, frozenBy });
      if (ok) await expect(p).resolves.toBeDefined();
      else await expect(p).rejects.toThrow(/status_check/);
    }
  );

  it('a status change is held by the same CHECK on update', async () => {
    const db = await freshDb();
    const a = vocabulary('a');
    await insert(db, a);
    const set = (sql: string) =>
      db.query(`UPDATE "ResourceIntentVocabulary" SET ${sql} WHERE "vocabVersion" = $1`, [
        a.vocabVersion,
      ]);
    await expect(set(`"status" = 'frozen'`)).rejects.toThrow(/status_check/);
    await set(`"status" = 'frozen', "frozenAt" = now(), "frozenBy" = 'operator'`);
    await expect(set(`"frozenBy" = NULL`)).rejects.toThrow(/status_check/);
    await expect(set(`"status" = 'candidate'`)).rejects.toThrow(/status_check/);
    await set(`"status" = 'retired'`);
    const r = await db.query<{ status: string }>(`SELECT "status" FROM "ResourceIntentVocabulary"`);
    expect(r.rows[0].status).toBe('retired');
  });
});

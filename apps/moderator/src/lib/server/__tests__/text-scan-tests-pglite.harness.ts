import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEST_SETS_SCHEMA = readFileSync(
  join(HERE, '../../../../text-scan-test-sets/schema.sql'),
  'utf8'
);

export async function freshTestSetsDb(): Promise<{ pg: PGlite; db: Kysely<ModeratorDB> }> {
  const pg = await PGlite.create();
  await pg.exec(TEST_SETS_SCHEMA);
  return { pg, db: new Kysely<ModeratorDB>({ dialect: pgliteDialect(pg) }) };
}

// Only the main-database columns the deletion check reads.
const MAIN_STUB = `
  CREATE TABLE "User" (id integer PRIMARY KEY, "deletedAt" timestamp);
  CREATE TABLE "Model" (id integer PRIMARY KEY, "userId" integer, "deletedAt" timestamp);
  CREATE TABLE "CommentV2" (id integer PRIMARY KEY, "userId" integer);
`;

export async function freshMainDb(): Promise<{ pg: PGlite; main: Kysely<MainDB> }> {
  const pg = await PGlite.create();
  await pg.exec(MAIN_STUB);
  return { pg, main: new Kysely<MainDB>({ dialect: pgliteDialect(pg) }) };
}

export const MOD = 990001;

export async function seedSet(
  db: Kysely<ModeratorDB>,
  over: { name?: string; workspace?: 'prompts' | 'modelRules' } = {}
): Promise<number> {
  const row = await db
    .insertInto('text_scan_test_set')
    .values({
      name: over.name ?? `set ${Math.random().toString(36).slice(2, 8)}`,
      workspace: over.workspace ?? 'prompts',
      created_by: MOD,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

export async function seedCase(
  db: Kysely<ModeratorDB>,
  setId: number,
  over: {
    entityType?: string;
    entityId?: number | null;
    authorId?: number | null;
    text?: string;
    expected?: unknown;
    fields?: null;
  } = {}
): Promise<number> {
  const text = over.text ?? `synthetic text ${Math.random().toString(36).slice(2, 8)}`;
  const row = await db
    .insertInto('text_scan_test_case')
    .values({
      set_id: String(setId),
      entity_type: over.entityType ?? 'CommentV2',
      entity_id: over.entityId ?? null,
      author_id: over.authorId ?? null,
      fields: over.fields === null ? null : JSON.stringify([{ heading: 'Comment', text }]),
      source_deleted_at: over.fields === null ? new Date() : null,
      text_hash: `hash-${text}`,
      expected: JSON.stringify(over.expected ?? { scam: false }),
      origin: 'try',
      added_by: MOD,
      updated_by: MOD,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

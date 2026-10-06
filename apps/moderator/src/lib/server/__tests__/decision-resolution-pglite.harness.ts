import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DecisionResolutionTables } from '../decision-resolution-tables';
import { executableSchemaSql, pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * `apps/moderator/decisions/schema.sql`, APPLIED to an in-process Postgres — the same instrument and
 * the same dialect the abuse-detection tier uses (see that harness for why this tier exists and why
 * it is not skippable).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const DECISIONS_SCHEMA_PATH = join(HERE, '../../../../decisions/schema.sql');

export const readDecisionsSchemaSql = (): string => readFileSync(DECISIONS_SCHEMA_PATH, 'utf8');

export async function applyDecisionsSchema(db: PGlite): Promise<void> {
  await db.exec(executableSchemaSql(readDecisionsSchemaSql()));
}

export async function freshDecisionsDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await applyDecisionsSchema(db);
  return db;
}

export const decisionsKysely = (db: PGlite): Kysely<DecisionResolutionTables> =>
  new Kysely<DecisionResolutionTables>({ dialect: pgliteDialect(db) });

/**
 * The PREVIOUS version of `schema.sql`, byte-identical to it as of the commit before the `resolved`
 * ruling. Applying this and then the current file is what a database that already exists goes through.
 */
export const DECISIONS_SCHEMA_V1_PATH = join(HERE, 'decisions-schema.v1.fixture.sql');

export async function applyDecisionsSchemaV1(db: PGlite): Promise<void> {
  await db.exec(executableSchemaSql(readFileSync(DECISIONS_SCHEMA_V1_PATH, 'utf8')));
}

export async function v1DecisionsDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await applyDecisionsSchemaV1(db);
  return db;
}

type RawRow = {
  source: string;
  item_key: string;
  sub_key: string;
  ruling: string;
  target_key: string | null;
  escalate_to: string | null;
  apply_state: string;
  answer_text: string | null;
  answer_ticket_id: string | null;
  answer_conversation_id: string | null;
};

/**
 * A raw insert with sensible defaults, for constraint tests that must bypass the service's guards.
 * The `answer_*` columns are named only when given, so this also inserts into a v1 table.
 */
export async function insertRaw(db: PGlite, row: Partial<RawRow>): Promise<void> {
  const cols: Record<string, unknown> = {
    source: row.source ?? 'support-ticket',
    item_key: row.item_key ?? 'g_aaaaaaaaaaaa',
    sub_key: row.sub_key ?? '',
    source_version: 'v-test',
    ruling: row.ruling ?? 'correct',
    target_key: row.target_key ?? null,
    escalate_to: row.escalate_to ?? null,
    ruled_by: 1,
    apply_state: row.apply_state ?? 'n/a',
    shown: '{}',
  };
  for (const k of ['answer_text', 'answer_ticket_id', 'answer_conversation_id'] as const)
    if (k in row) cols[k] = row[k];
  const names = Object.keys(cols);
  await db.query(
    `INSERT INTO decision_resolution (${names.join(', ')})
     VALUES (${names
       .map((n, i) => (n === 'shown' ? `$${i + 1}::jsonb` : `$${i + 1}`))
       .join(', ')})`,
    Object.values(cols)
  );
}

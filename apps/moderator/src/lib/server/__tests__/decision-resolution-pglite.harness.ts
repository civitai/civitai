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

/** A raw insert with sensible defaults, for constraint tests that must bypass the service's guards. */
export async function insertRaw(
  db: PGlite,
  row: Partial<{
    source: string;
    item_key: string;
    sub_key: string;
    ruling: string;
    target_key: string | null;
    escalate_to: string | null;
    apply_state: string;
  }>
): Promise<void> {
  await db.query(
    `INSERT INTO decision_resolution
       (source, item_key, sub_key, source_version, ruling, target_key, escalate_to, ruled_by,
        apply_state, shown)
     VALUES ($1, $2, $3, 'v-test', $4, $5, $6, 1, $7, '{}'::jsonb)`,
    [
      row.source ?? 'support-ticket',
      row.item_key ?? 'g_aaaaaaaaaaaa',
      row.sub_key ?? '',
      row.ruling ?? 'correct',
      row.target_key ?? null,
      row.escalate_to ?? null,
      row.apply_state ?? 'n/a',
    ]
  );
}

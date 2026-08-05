import { parsePrismaSchema } from '../../parse-prisma-schema';
import { planStatements } from '../plan';
import type { ParsedSchema } from '../../types';
import type { CatalogIndexEntry, RemediationCatalog, RemediationPlan } from '../types';

/**
 * Small hand-built inputs for the planner.
 *
 * Deliberately tiny: every case below differs from the baseline in ONE respect, so a
 * refusal it produces is attributable to that one difference. A shared 400-model fixture
 * would make every assertion a claim about the fixture.
 */

export function schemaFrom(source: string): ParsedSchema {
  return parsePrismaSchema(source);
}

export interface CatalogSpec {
  tables?: string[];
  columns?: Array<[table: string, column: string, notNull: boolean]>;
  foreignKeys?: Array<{ name: string; table: string; columns: string[]; refTable: string }>;
  uniqueIndexes?: Array<[table: string, ...columns: string[]]>;
  /** Omit entirely to model a catalog captured without index data. */
  indexes?: Array<[table: string, ...columns: string[]]>;
}

export function catalogFrom(spec: CatalogSpec): RemediationCatalog {
  const catalog: RemediationCatalog = {
    tables: spec.tables ?? [],
    columns: (spec.columns ?? []).map(([table, column, notNull]) => ({ table, column, notNull })),
    foreignKeys: (spec.foreignKeys ?? []).map((fk) => ({
      name: fk.name,
      table: fk.table,
      columns: fk.columns,
      refTable: fk.refTable,
      refColumns: ['id'],
      onDelete: null,
      onUpdate: null,
    })),
    uniqueIndexes: (spec.uniqueIndexes ?? []).map(([table, ...columns]) => ({ table, columns })),
  };
  if (spec.indexes) {
    catalog.indexes = spec.indexes.map(([table, ...columns]) => ({
      table,
      columns,
    })) as CatalogIndexEntry[];
  }
  return catalog;
}

/** Every statement the plan would run, as one string. */
export function planSql(plan: RemediationPlan): string {
  return planStatements(plan)
    .map((s) => s.sql)
    .join('\n');
}

/** Only the statements that WRITE, as one string. */
export function writingSql(plan: RemediationPlan): string {
  return planStatements(plan)
    .filter((s) => s.writes)
    .map((s) => s.sql)
    .join('\n');
}

/**
 * Count top-level `DELETE FROM` / `UPDATE ... SET` occurrences in the statements a plan
 * would run.
 *
 * These two functions are the instrument the headline SetNull assertion reads. Their own
 * negative and positive controls are in `harness.test.ts`: a zero from an instrument that
 * has never been shown to produce a non-zero is a fact about the instrument.
 */
export function countDeletes(sql: string): number {
  return (sql.match(/\bDELETE FROM\b/g) ?? []).length;
}

export function countUpdates(sql: string): number {
  return (sql.match(/\bUPDATE "[^"]+" t SET\b/g) ?? []).length;
}

export function relation(plan: RemediationPlan, key: string) {
  const found = plan.relations.find((r) => r.key === key);
  if (!found) {
    throw new Error(
      `No relation "${key}" in the plan. Present: ${plan.relations.map((r) => r.key).join(', ')}`
    );
  }
  return found;
}

export function refusalCodes(plan: RemediationPlan, key: string): string[] {
  return relation(plan, key).refusals.map((r) => r.code);
}

export function refusalMessage(plan: RemediationPlan, key: string, code: string): string {
  const refusal = relation(plan, key).refusals.find((r) => r.code === code);
  if (!refusal) {
    throw new Error(
      `Relation "${key}" carries no refusal "${code}". It has: ` +
        `${refusalCodes(plan, key).join(', ') || '(none)'}`
    );
  }
  return refusal.message;
}

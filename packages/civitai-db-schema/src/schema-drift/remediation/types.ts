/**
 * Types for the foreign-key remediation planner and runner.
 *
 * The planner is pure data in / pure data out: it takes a parsed schema and a database
 * catalog and returns a plan. Nothing here connects to anything, so the interesting
 * behaviour — which relations get DELETEd, which get UPDATEd, which are refused — is
 * exercisable without a database.
 */
import type { DbCatalog, ReferentialAction } from '../types';

/**
 * How orphan rows are remediated for one relation.
 *
 * There is deliberately no third option and no flag that selects between these: the
 * strategy is DERIVED from the relation's declared `onDelete` and nothing else. The
 * predecessor of this module hardcoded `delete-orphans`, which is correct for a `Cascade`
 * relation and destroys live rows on a `SetNull` one.
 */
export type RemediationStrategy = 'delete-orphans' | 'null-orphans';

/**
 * What the planner decided for one relation.
 *
 * `ready`    — every guard passed; the statements may be executed.
 * `blocked`  — nothing is semantically wrong, but a prerequisite is unmet (no index on the
 *              referencing column, orphan count not measured). The prerequisite statement
 *              is included so a human can clear it.
 * `refused`  — the planner will not remediate this relation at all, at any time, without a
 *              code change. Refusals are terminal and are never downgraded by a flag.
 * `satisfied`— the foreign key already exists on these columns. Nothing to do.
 */
export type PlanOutcome = 'ready' | 'blocked' | 'refused' | 'satisfied';

/**
 * Why the planner refused. Each code names ONE guard.
 *
 * These are asserted individually by the tests. A test that only checks "it refused" is
 * satisfied by any guard firing, which makes a mutation to one guard die to a different
 * guard and reads as coverage it does not have.
 */
export type RefusalCode =
  /** On the never-add exclusion list. See `exclusions.ts` for the per-relation reason. */
  | 'excluded'
  /** Declared `NoAction` or `Restrict`: the parent delete is meant to FAIL, so an orphan
   *  is not something to clean up. Mutating rows here invents a policy the schema does
   *  not state. */
  | 'action-forbids-mutation'
  /** `onDelete` did not resolve to a known referential action. Fail closed. */
  | 'unknown-action'
  /** Declared `SetNull` but the live column is `NOT NULL`. The remediation is impossible
   *  and the combination means the DECLARATION is wrong, not the data. */
  | 'set-null-on-not-null-column'
  /** The referencing table is absent from the catalog (view, dropped, wrong db-schema). */
  | 'table-not-in-catalog'
  /** A referencing column is absent from the catalog. Without it, `NOT NULL` cannot be
   *  established, so the `SetNull` guard above could not be evaluated. Fail closed. */
  | 'column-not-in-catalog'
  /** The referenced table is absent from the catalog: `REFERENCES` would not resolve. */
  | 'referenced-table-not-in-catalog'
  /** A constraint of the derived name already exists on this table, on other columns.
   *  `ADD CONSTRAINT` would fail; a silently different name would be worse. */
  | 'constraint-name-taken'
  /** A generated identifier exceeds Postgres's 63-byte limit. Postgres TRUNCATES rather
   *  than erroring, so two relations could quietly share one backup table. */
  | 'identifier-too-long';

export interface Refusal {
  code: RefusalCode;
  message: string;
}

/**
 * Why the planner will not execute yet, though it would once this is cleared.
 */
export type PrerequisiteCode =
  /** No index whose leading key columns are the referencing columns. Without one, every
   *  delete of a parent row seq-scans this table. */
  | 'missing-index'
  /** The catalog carried no index data, so absence of an index could not be established.
   *  Not the same as "there is no index" — and treated the same way, because a runner that
   *  guesses here adds a constraint that turns a hot delete into a seq scan. */
  | 'index-coverage-unknown'
  /** Orphans have not been counted. `--plan` offline cannot count; execution must. */
  | 'orphan-count-not-measured';

export interface Prerequisite {
  code: PrerequisiteCode;
  message: string;
  /** The statement that clears it, where one exists. */
  sql?: string;
}

/**
 * Whether the referencing columns are covered by an index.
 *
 * `unknown` is a first-class value, not a synonym for `not-covered`: a catalog captured
 * without index data cannot distinguish them, and collapsing the two would either block
 * every relation or wave every relation through.
 */
export type IndexCoverage = 'covered' | 'not-covered' | 'unknown';

export type StatementKind =
  | 'count-orphans'
  | 'create-backup-schema'
  | 'create-backup-table'
  | 'remediate-batch'
  | 'add-constraint'
  | 'validate-constraint'
  | 'create-index';

export interface PlannedStatement {
  kind: StatementKind;
  sql: string;
  /** True when running this statement changes data or schema. */
  writes: boolean;
  /** Executed repeatedly until it affects zero rows. */
  batched?: boolean;
  note?: string;
}

export interface RelationPlan {
  /**
   * `Model.column`, or `Model.col1+col2` for a composite relation — the key used by the
   * exclusion list and by `--relation`.
   *
   * Keyed on the COLUMN rather than the Prisma relation field name because that is how
   * every audit, migration and constraint name spells it (`Club.coverImageId`, not
   * `Club.coverImage`), and because two relations on one model cannot share a column set
   * without being the same foreign key.
   */
  key: string;
  model: string;
  field: string;
  table: string;
  /** Referencing columns, in declaration order. */
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
  constraintName: string;
  backupTable: string;
  outcome: PlanOutcome;
  /** `null` whenever the outcome is `refused` or `satisfied`. */
  strategy: RemediationStrategy | null;
  refusals: Refusal[];
  prerequisites: Prerequisite[];
  indexCoverage: IndexCoverage;
  /** Measured orphan count, or `null` when not measured. */
  orphanCount: number | null;
  /** Everything the runner would execute, in order. Present even when refused, so the
   *  plan shows what was declined rather than an empty section. */
  statements: PlannedStatement[];
}

export interface PlanCounts {
  relationsConsidered: number;
  satisfied: number;
  ready: number;
  blocked: number;
  refused: number;
  /** Relations whose orphan remediation is a DELETE. The number the SetNull test pins. */
  deleteStrategy: number;
  /** Relations whose orphan remediation is an UPDATE ... SET NULL. */
  nullStrategy: number;
}

export interface RemediationPlan {
  counts: PlanCounts;
  relations: RelationPlan[];
  /** Keys named by the caller that matched no declared relation. */
  unmatchedSelectors: string[];
}

/** An index as read from the catalog: key columns in index order. */
export interface CatalogIndexEntry {
  table: string;
  columns: string[];
}

/**
 * The base drift catalog plus the index list this planner needs.
 *
 * `indexes` is optional because the committed production snapshot predates it. Absent, the
 * planner reports `index-coverage-unknown` rather than assuming either way — except where a
 * UNIQUE index already proves coverage, since a unique index is an index.
 */
export type RemediationCatalog = DbCatalog & { indexes?: CatalogIndexEntry[] };

export interface PlanOptions {
  /** Restrict the plan to these `Model.field` keys. Empty means every declared relation
   *  that is missing its foreign key. */
  only?: string[];
  /** Measured orphan counts by relation key, when a live count has been taken. */
  orphanCounts?: Record<string, number>;
  /** Rows per batch. Bounded so no single statement holds a long transaction. */
  batchSize?: number;
  /** Schema the orphan backups are written to. */
  backupSchema?: string;
}

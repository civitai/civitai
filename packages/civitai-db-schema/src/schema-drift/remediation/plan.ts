/**
 * The foreign-key remediation planner.
 *
 * Pure: a parsed schema and a catalog in, a plan out. No database, no clock, no filesystem.
 * That is what lets every decision below — including the refusals, which are the part that
 * matters — be exercised without touching anything.
 *
 * 🔴 THE DEFECT THIS MODULE EXISTS TO FIX. Its predecessor was written for one relation
 * (`CollectionItem`, all four of whose relations declare `Cascade`) and hardcoded both the
 * constraint's `ON DELETE CASCADE` and an orphan cleanup step that DELETEs. Pointed at the
 * relations the remediation backlog nominates as the natural starting point — the broken
 * cover-image ones — that step would have deleted roughly 23,500 live rows (610 articles,
 * 519 user accounts, 591 user profiles, 21,815 threads) where the schema asks only for a
 * cover-image reference to be cleared. The strategy here is DERIVED from each relation's
 * declared `onDelete` and there is no flag that overrides it.
 */
import { REFERENTIAL_ACTIONS } from '../types';
import type { ParsedModel, ParsedRelation, ParsedSchema, ReferentialAction } from '../types';
import { assertExclusionsResolve, findExclusion } from './exclusions';
import {
  MAX_IDENTIFIER_BYTES,
  addConstraintNotValidSql,
  backupTableNameFor,
  constraintNameFor,
  countOrphansSql,
  createBackupSchemaSql,
  createBackupTableSql,
  createIndexConcurrentlySql,
  deleteOrphanBatchSql,
  identifierBytes,
  indexNameFor,
  nullOrphanBatchSql,
  validateConstraintSql,
} from './sql';
import { DEFAULT_LOCK_TIMEOUT } from './types';
import type {
  ConstraintValidity,
  IndexCoverage,
  PlanCounts,
  PlanOptions,
  PlannedStatement,
  Prerequisite,
  Refusal,
  RelationPlan,
  RemediationCatalog,
  RemediationPlan,
  RemediationStrategy,
} from './types';

export const DEFAULT_BATCH_SIZE = 5000;
export const DEFAULT_BACKUP_SCHEMA = 'fk_remediation_backup';

/** NUL cannot appear in a Postgres identifier, so it is safe as a tuple separator. */
function tupleKey(parts: readonly string[]): string {
  return parts.join('\0');
}

/**
 * The strategy a declared referential action implies, or `null` when there is none.
 *
 * This is the whole action-awareness of the runner, in one function, with no parameters
 * other than the action. There is deliberately no `force`, no `strategy` override and no
 * default: an action with no entry here yields `null` and the caller refuses.
 */
export function strategyForAction(action: ReferentialAction | string): RemediationStrategy | null {
  switch (action) {
    // The parent row is meant to take its children with it, so a child with no parent is
    // a row that should already be gone.
    case 'Cascade':
      return 'delete-orphans';
    // The parent row is meant to leave its children behind with a cleared reference. The
    // ROW is not the thing being cleaned up — the REFERENCE is.
    case 'SetNull':
      return 'null-orphans';
    // 'NoAction' / 'Restrict': the schema says the parent delete should FAIL. There is no
    // cleanup that follows from that; an orphan under those actions is evidence about how
    // the row was created, and deciding what to do with it is a product question.
    // 'SetDefault': would mean UPDATE ... SET col = <default>, which requires reading the
    // column default and proving the default value has a parent row. Not implemented, so
    // refused rather than approximated.
    default:
      return null;
  }
}

function isKnownAction(action: string): action is ReferentialAction {
  return (REFERENTIAL_ACTIONS as readonly string[]).includes(action);
}

interface CatalogView {
  tables: Set<string>;
  /** `table\0column` -> notNull */
  columns: Map<string, boolean>;
  /** `table\0col[\0col...]` -> constraint name */
  fkByColumns: Map<string, string>;
  /** `table\0constraintName` -> constrained columns */
  fkByName: Map<string, string[]>;
  /**
   * `table\0constraintName` -> `pg_constraint.convalidated`.
   *
   * `null` means the catalog did not carry the field. Kept as a tri-state rather than a
   * set of not-valid names so that "we did not look" cannot decay into "it is fine".
   */
  fkValidated: Map<string, boolean | null>;
  /** Every column of a table, in catalog order — the explicit backup INSERT target list. */
  columnsByTable: Map<string, string[]>;
  /** table -> unique-index key-column tuples, for the referenced-side uniqueness check. */
  uniqueByTable: Map<string, string[][]>;
  /** table -> list of key-column tuples, from every index we can see */
  indexesByTable: Map<string, string[][]>;
  /** Whether the catalog carried a full index list, as opposed to unique indexes only. */
  hasFullIndexes: boolean;
}

function viewCatalog(catalog: RemediationCatalog): CatalogView {
  const columns = new Map<string, boolean>();
  const columnsByTable = new Map<string, string[]>();
  for (const c of catalog.columns) {
    columns.set(tupleKey([c.table, c.column]), c.notNull);
    const list = columnsByTable.get(c.table);
    if (list) list.push(c.column);
    else columnsByTable.set(c.table, [c.column]);
  }

  const fkByColumns = new Map<string, string>();
  const fkByName = new Map<string, string[]>();
  const fkValidated = new Map<string, boolean | null>();
  for (const fk of catalog.foreignKeys) {
    fkByColumns.set(tupleKey([fk.table, ...fk.columns]), fk.name);
    fkByName.set(tupleKey([fk.table, fk.name]), fk.columns);
    // `?? null` and not `?? true`: a catalog that never read `convalidated` must not be
    // able to certify a constraint it did not look at.
    fkValidated.set(tupleKey([fk.table, fk.name]), fk.validated ?? null);
  }

  const indexesByTable = new Map<string, string[][]>();
  const addIndex = (table: string, cols: string[]) => {
    const list = indexesByTable.get(table);
    if (list) list.push(cols);
    else indexesByTable.set(table, [cols]);
  };
  // A unique index IS an index, so it counts towards coverage even when the catalog
  // carries no general index list. This is why a POSITIVE coverage answer is trustworthy
  // against the committed snapshot while a negative one is not.
  for (const u of catalog.uniqueIndexes) addIndex(u.table, u.columns);
  for (const i of catalog.indexes ?? []) addIndex(i.table, i.columns);

  // Unique-index coverage on the REFERENCED side. Postgres requires the referenced columns
  // to carry a unique constraint or unique index and rejects ADD CONSTRAINT with SQLSTATE
  // 42830 otherwise — at step 4, which is after the orphan rows have already been deleted.
  const uniqueByTable = new Map<string, string[][]>();
  for (const u of catalog.uniqueIndexes) {
    const list = uniqueByTable.get(u.table);
    if (list) list.push(u.columns);
    else uniqueByTable.set(u.table, [u.columns]);
  }

  return {
    tables: new Set(catalog.tables),
    columns,
    columnsByTable,
    fkByColumns,
    fkByName,
    fkValidated,
    uniqueByTable,
    indexesByTable,
    hasFullIndexes: Array.isArray(catalog.indexes),
  };
}

/**
 * Whether an index supports lookups on `columns`.
 *
 * Postgres can use an index for a predicate on its LEADING key columns only, so an index
 * on `(userId, imageId)` does nothing for a delete cascading on `imageId`. That is not a
 * hypothetical: it is exactly `ImageEngagement`, 5.9M rows, whose only unique index leads
 * with `userId`. A membership test instead of a prefix test would call it covered.
 */
function indexCovers(indexColumns: readonly string[], columns: readonly string[]): boolean {
  if (indexColumns.length < columns.length) return false;
  return columns.every((c, i) => indexColumns[i] === c);
}

function coverageFor(live: CatalogView, table: string, columns: readonly string[]): IndexCoverage {
  const indexes = live.indexesByTable.get(table) ?? [];
  if (indexes.some((idx) => indexCovers(idx, columns))) return 'covered';
  return live.hasFullIndexes ? 'not-covered' : 'unknown';
}

function columnFor(model: ParsedModel, fieldName: string): string {
  return model.fields.find((f) => f.name === fieldName)?.column ?? fieldName;
}

/** `Model.column`, or `Model.col1+col2` for a composite relation. */
export function relationKey(model: string, columns: readonly string[]): string {
  return `${model}.${columns.join('+')}`;
}

function planRelation(
  model: ParsedModel,
  relation: ParsedRelation,
  modelsByName: Map<string, ParsedModel>,
  live: CatalogView,
  options: Required<Pick<PlanOptions, 'batchSize' | 'backupSchema' | 'lockTimeout'>> & {
    orphanCounts: Record<string, number>;
  }
): RelationPlan {
  const columns = relation.fields.map((f) => columnFor(model, f));
  const target = modelsByName.get(relation.targetModel);
  const refTable = target ? target.table : relation.targetModel;
  const refColumns = relation.references.map((f) => (target ? columnFor(target, f) : f));
  const key = relationKey(model.name, columns);

  const constraintName = constraintNameFor(model.table, columns);
  const backupTable = backupTableNameFor(model.table, columns);
  const indexName = indexNameFor(model.table, columns);

  const ctx = {
    table: model.table,
    columns,
    refTable,
    refColumns,
    constraintName,
    backupSchema: options.backupSchema,
    backupTable,
    batchSize: options.batchSize,
    // Named explicitly in the backup INSERT rather than relying on `t.*` matching a
    // backup table that a previous run created from a different table shape.
    allColumns: live.columnsByTable.get(model.table) ?? [],
    lockTimeout: options.lockTimeout,
  };

  const orphanCount = Object.prototype.hasOwnProperty.call(options.orphanCounts, key)
    ? options.orphanCounts[key]
    : null;

  const base = {
    key,
    model: model.name,
    field: relation.field,
    table: model.table,
    columns,
    refTable,
    refColumns,
    onDelete: relation.onDelete,
    onUpdate: relation.onUpdate,
    constraintName,
    backupTable,
    orphanCount,
  };

  // A constraint on these columns already exists — but "exists" is three states, not two.
  //
  // 🔴 A NOT VALID CONSTRAINT IS PRESENT AND NOT ENFORCING RETROACTIVELY. `pg_constraint`
  // lists it exactly like any other foreign key, so a reader filtering only on
  // `contype = 'f'` — which is what the drift detector does — reports the relation clean.
  // That matters because there is no `ADD CONSTRAINT ... IF NOT EXISTS` in Postgres: a run
  // that dies between ADD and VALIDATE cannot simply be re-run. Treating present as
  // finished would strand such a relation permanently: the constraint can never be added
  // again, this tool would report nothing to do, and the detector would call it enforced.
  //
  // The environment makes this the expected case rather than a rare one. `VALIDATE
  // CONSTRAINT` scans the whole table, and a 120s statement ceiling applies, so validation
  // is expected to time out on the large tables in this backlog (`Collection` 16.9M,
  // `TagsOnImageVote` 12M, `ImageEngagement` 5.9M, `ImageTool` 5.7M). It does NOT affect
  // `ImageTagForReview` at ~49k rows.
  const existing = live.fkByColumns.get(tupleKey([model.table, ...columns]));
  const existingValidated =
    existing === undefined ? undefined : live.fkValidated.get(tupleKey([model.table, existing]));
  const constraintValidity: ConstraintValidity =
    existing === undefined
      ? 'absent'
      : existingValidated === null || existingValidated === undefined
      ? 'unknown'
      : existingValidated
      ? 'validated'
      : 'not-valid';

  if (constraintValidity === 'validated' || constraintValidity === 'unknown') {
    return {
      ...base,
      outcome: 'satisfied',
      strategy: null,
      refusals: [],
      constraintValidity,
      // An `unknown` here is NOT a clean bill of health: the catalog carried no
      // `convalidated` data, so a NOT VALID constraint is indistinguishable from a
      // validated one. Surfaced as a prerequisite so it appears in the report rather than
      // being swallowed by a reassuring "satisfied".
      prerequisites:
        constraintValidity === 'unknown'
          ? [
              {
                code: 'constraint-validity-unknown',
                message:
                  `A constraint named "${existing}" exists on these columns, but this ` +
                  'catalog carried no validity data, so whether it is VALIDATED or still ' +
                  'NOT VALID could not be established. A NOT VALID constraint does not ' +
                  'enforce the rows that predate it. Re-read the catalog from a live ' +
                  'database to resolve this.',
              },
            ]
          : [],
      indexCoverage: coverageFor(live, model.table, columns),
      statements: [],
    };
  }

  if (constraintValidity === 'not-valid') {
    // The resume path returns before the refusal block below, so the two refusals that can
    // still apply once a constraint exists are evaluated HERE. Without this, a relation
    // carrying a half-applied constraint bypasses them entirely — and the SetNull case is
    // not theoretical: `ChallengeEvent.createdById` declares SetNull over a NOT NULL
    // column, so a resume would have emitted `UPDATE ... SET "createdById" = NULL` and
    // failed part-way through a campaign.
    //
    // The other refusals cannot apply here by construction: the tables and columns exist
    // (the catalog has a constraint on them), the referenced columns must already be
    // unique (Postgres would not have accepted the constraint otherwise), and the name is
    // this relation's own.
    const resumeRefusals: Refusal[] = [];
    const resumeExclusion = findExclusion(key);
    if (resumeExclusion) {
      resumeRefusals.push({
        code: 'excluded',
        message:
          `${resumeExclusion.reason}\n\n🔴 A NOT VALID foreign key exists on these columns ` +
          'anyway. This runner will not validate it — that would finish applying a ' +
          'constraint the list says must never exist. Investigate how it was created; ' +
          'dropping it is probably the right answer, but that is a decision with an owner.',
      });
    }
    const resumeStrategy = strategyForAction(relation.onDelete);
    if (resumeStrategy === 'null-orphans') {
      const notNull = columns.filter((c) => live.columns.get(tupleKey([model.table, c])));
      if (notNull.length > 0) {
        resumeRefusals.push({
          code: 'set-null-on-not-null-column',
          message:
            `onDelete is SetNull but ${notNull
              .map((c) => `"${model.table}"."${c}"`)
              .join(', ')} is NOT NULL. Resuming would emit an UPDATE ... SET NULL that ` +
            'cannot succeed. The declaration is wrong, not the data.',
        });
      }
    }
    if (resumeRefusals.length > 0) {
      return {
        ...base,
        outcome: 'refused',
        strategy: null,
        refusals: resumeRefusals,
        constraintValidity,
        prerequisites: [],
        indexCoverage: coverageFor(live, model.table, columns),
        statements: [
          { kind: 'count-orphans', sql: countOrphansSql(ctx), writes: false, note: 'read-only' },
        ],
      };
    }

    // The resume path. The constraint is already there, so ADD must NOT be reissued — it
    // would fail. Orphan remediation IS reissued: it is idempotent (its predicate matches
    // only rows that are still orphaned) and a validation that failed for any reason other
    // than a timeout means orphans remain.
    const resumeStatements: PlannedStatement[] = [
      { kind: 'count-orphans', sql: countOrphansSql(ctx), writes: false, note: 'read-only' },
    ];
    const strategy = resumeStrategy;
    if (strategy !== null && (orphanCount === null || orphanCount > 0)) {
      resumeStatements.push(
        {
          kind: 'create-backup-schema',
          sql: createBackupSchemaSql(options.backupSchema),
          writes: true,
        },
        { kind: 'create-backup-table', sql: createBackupTableSql(ctx), writes: true },
        {
          kind: 'remediate-batch',
          sql: strategy === 'delete-orphans' ? deleteOrphanBatchSql(ctx) : nullOrphanBatchSql(ctx),
          writes: true,
          batched: true,
          note: 'repeat until it affects 0 rows',
        }
      );
    }
    resumeStatements.push({
      kind: 'validate-constraint',
      sql: validateConstraintSql(ctx),
      writes: true,
      note:
        'RESUME: the constraint already exists but is NOT VALID, so ADD CONSTRAINT is ' +
        'deliberately not reissued. VALIDATE is itself resumable — a failed or timed-out ' +
        'VALIDATE leaves the constraint NOT VALID and changes nothing else, so it can be ' +
        'retried as many times as needed.',
    });

    return {
      ...base,
      outcome: 'needs-validation',
      strategy,
      refusals: [],
      constraintValidity,
      prerequisites:
        orphanCount === null
          ? [
              {
                code: 'orphan-count-not-measured',
                message:
                  'Orphans have not been counted. A constraint left NOT VALID usually means ' +
                  'validation failed; if that was because orphans remain, VALIDATE will keep ' +
                  'failing until they are cleared.',
                sql: countOrphansSql(ctx),
              },
            ]
          : [],
      indexCoverage: coverageFor(live, model.table, columns),
      statements: resumeStatements,
    };
  }

  const refusals: Refusal[] = [];

  // Guards are ACCUMULATED, not short-circuited. Returning at the first one would make a
  // later guard unreachable for any input that also trips an earlier one, and a guard that
  // cannot be reached cannot be tested — it would pass a mutation test by dying to its
  // neighbour.
  const exclusion = findExclusion(key);
  if (exclusion) {
    refusals.push({ code: 'excluded', message: exclusion.reason });
  }

  if (!live.tables.has(model.table)) {
    refusals.push({
      code: 'table-not-in-catalog',
      message:
        `"${model.table}" is not an ordinary table in this catalog (a view, or absent). ` +
        'A constraint cannot live on it.',
    });
  }
  if (!live.tables.has(refTable)) {
    refusals.push({
      code: 'referenced-table-not-in-catalog',
      message: `REFERENCES "${refTable}" would not resolve: no such table in this catalog.`,
    });
  }

  const absentColumns = columns.filter((c) => !live.columns.has(tupleKey([model.table, c])));
  if (absentColumns.length > 0) {
    refusals.push({
      code: 'column-not-in-catalog',
      message:
        `"${model.table}" has no column ${absentColumns.map((c) => `"${c}"`).join(', ')} in ` +
        'this catalog, so its nullability could not be read and the SET NULL guard could ' +
        'not be evaluated.',
    });
  }

  const strategy = strategyForAction(relation.onDelete);
  if (strategy === null) {
    if (relation.onDelete === 'NoAction' || relation.onDelete === 'Restrict') {
      refusals.push({
        code: 'action-forbids-mutation',
        message:
          `onDelete is ${relation.onDelete}: the schema says a delete of the referenced row ` +
          'should be REJECTED while a referencing row exists. There is no cleanup implied ' +
          'by that, so this runner will not delete or modify these rows. Reported only.',
      });
    } else {
      refusals.push({
        code: 'unknown-action',
        message:
          `onDelete "${relation.onDelete}" has no remediation strategy` +
          (isKnownAction(relation.onDelete)
            ? ' implemented in this runner'
            : ' and is not a Prisma referential action') +
          '. Failing closed rather than guessing one.',
      });
    }
  }

  // Only meaningful once the columns are known to exist; `absentColumns` above already
  // refused otherwise, and this would silently read `undefined === true` as false.
  if (strategy === 'null-orphans' && absentColumns.length === 0) {
    const notNullColumns = columns.filter((c) => live.columns.get(tupleKey([model.table, c])));
    if (notNullColumns.length > 0) {
      refusals.push({
        code: 'set-null-on-not-null-column',
        message:
          `onDelete is SetNull but ${notNullColumns
            .map((c) => `"${model.table}"."${c}"`)
            .join(', ')} is NOT NULL in the database. The remediation is impossible and the ` +
          'combination means the DECLARATION is wrong, not the data — a SetNull foreign key ' +
          'on a NOT NULL column errors at delete time, not at creation time. Fix the schema ' +
          '(or the column) first.',
      });
    }
  }

  // Postgres requires the REFERENCED columns to carry a unique constraint or unique index
  // and rejects ADD CONSTRAINT with SQLSTATE 42830 otherwise. Without this check that
  // rejection arrives at step 4 — after the orphan rows have already been deleted, for a
  // constraint that was never creatable. Only meaningful when the referenced table is in
  // the catalog; otherwise the earlier guard already refused and its unique list is empty
  // for a reason that has nothing to do with uniqueness.
  if (live.tables.has(refTable)) {
    const uniques = live.uniqueByTable.get(refTable) ?? [];
    const exact = uniques.some(
      (u) => u.length === refColumns.length && u.every((c, i) => c === refColumns[i])
    );
    if (!exact) {
      refusals.push({
        code: 'referenced-columns-not-unique',
        message:
          `"${refTable}"(${refColumns.join(', ')}) carries no unique constraint or unique ` +
          'index in this catalog. Postgres rejects a foreign key referencing non-unique ' +
          'columns (SQLSTATE 42830), and it does so at ADD CONSTRAINT — which in this ' +
          'plan is AFTER the orphan rows have been removed. Refusing up front instead.',
      });
    }
  }

  // Guarded here rather than left to throw at emission time. `sqlAction` throws on an
  // action it cannot spell, and statement construction happens inside the plan builder —
  // so one unrepresentable action would abort the WHOLE plan and hide the other 475
  // relations behind a stack trace, instead of refusing its own.
  for (const [label, action] of [
    ['onDelete', relation.onDelete],
    ['onUpdate', relation.onUpdate],
  ] as const) {
    if (!isKnownAction(action)) {
      refusals.push({
        code: 'unrepresentable-action',
        message:
          `${label} "${action}" has no SQL spelling, so the constraint for this relation ` +
          'cannot be written. Refusing this relation rather than aborting the plan.',
      });
    }
  }

  const takenBy = live.fkByName.get(tupleKey([model.table, constraintName]));
  if (takenBy && tupleKey(takenBy) !== tupleKey(columns)) {
    refusals.push({
      code: 'constraint-name-taken',
      message:
        `"${constraintName}" already names a constraint on "${model.table}" over ` +
        `(${takenBy.join(', ')}). ADD CONSTRAINT would fail; choosing a different name ` +
        'silently would make the constraint unfindable by its conventional name.',
    });
  }

  const overlong = [constraintName, backupTable, indexName].filter(
    (n) => identifierBytes(n) > MAX_IDENTIFIER_BYTES
  );
  if (overlong.length > 0) {
    refusals.push({
      code: 'identifier-too-long',
      message:
        `Generated identifier(s) exceed Postgres's ${MAX_IDENTIFIER_BYTES}-byte limit: ` +
        `${overlong.join(', ')}. Postgres TRUNCATES rather than erroring, so two relations ` +
        'could quietly share one backup table.',
    });
  }

  const indexCoverage = coverageFor(live, model.table, columns);
  const prerequisites: Prerequisite[] = [];
  if (indexCoverage === 'not-covered') {
    prerequisites.push({
      code: 'missing-index',
      message:
        `No index on "${model.table}" leads with (${columns.join(', ')}). Postgres does not ` +
        'create one for a foreign key, so every delete of a referenced row would scan this ' +
        'table. Create it first, CONCURRENTLY.',
      sql: createIndexConcurrentlySql(ctx, indexName),
    });
  } else if (indexCoverage === 'unknown') {
    prerequisites.push({
      code: 'index-coverage-unknown',
      message:
        'This catalog carries no general index list, only unique indexes, and no unique ' +
        `index leads with (${columns.join(', ')}). Whether an ordinary index exists could ` +
        'not be established — which is not the same as it being absent, and is treated the ' +
        'same way. Re-read the catalog from a live database, or run the statement below.',
      sql: createIndexConcurrentlySql(ctx, indexName),
    });
  }
  if (orphanCount === null) {
    prerequisites.push({
      code: 'orphan-count-not-measured',
      message:
        'Orphans have not been counted. The count decides whether a remediation pass is ' +
        'needed at all and is the only check that the constraint can be validated.',
      sql: countOrphansSql(ctx),
    });
  }

  const outcome = refusals.length > 0 ? 'refused' : prerequisites.length > 0 ? 'blocked' : 'ready';

  const statements: PlannedStatement[] = [
    {
      kind: 'count-orphans',
      sql: countOrphansSql(ctx),
      writes: false,
      note: 'read-only',
    },
  ];

  // A refused relation gets the read-only count and nothing else. Printing the DELETE it
  // declined to run would put the exact statement this module exists to prevent into a
  // copy-pasteable plan.
  if (outcome !== 'refused' && strategy !== null) {
    if (orphanCount === null || orphanCount > 0) {
      statements.push(
        {
          kind: 'create-backup-schema',
          sql: createBackupSchemaSql(options.backupSchema),
          writes: true,
        },
        {
          kind: 'create-backup-table',
          sql: createBackupTableSql(ctx),
          writes: true,
          note: 'columns only — no indexes, constraints or defaults',
        },
        {
          kind: 'remediate-batch',
          sql: strategy === 'delete-orphans' ? deleteOrphanBatchSql(ctx) : nullOrphanBatchSql(ctx),
          writes: true,
          batched: true,
          note:
            `repeat until it affects 0 rows; ${options.batchSize} rows per statement, ` +
            'rows preserved in the same statement that changes them',
        }
      );
    }
    statements.push(
      {
        kind: 'add-constraint',
        sql: addConstraintNotValidSql(ctx, relation.onDelete, relation.onUpdate),
        writes: true,
        note: 'NOT VALID: brief ACCESS EXCLUSIVE on both tables, no scan',
      },
      {
        kind: 'validate-constraint',
        sql: validateConstraintSql(ctx),
        writes: true,
        note: 'separate statement: SHARE UPDATE EXCLUSIVE, reads and writes continue',
      }
    );
  }

  return {
    ...base,
    outcome,
    strategy: outcome === 'refused' ? null : strategy,
    refusals,
    constraintValidity,
    prerequisites,
    indexCoverage,
    statements,
  };
}

/**
 * Build a remediation plan.
 *
 * Considers EVERY owning-side relation in the schema, not only the ones already known to
 * be missing a foreign key. A relation whose constraint exists comes back `satisfied`,
 * which makes `relationsConsidered` a positive control: a plan that considered nothing
 * looks exactly like a plan that found nothing to do.
 */
export function buildRemediationPlan(
  schema: ParsedSchema,
  catalog: RemediationCatalog,
  options: PlanOptions = {}
): RemediationPlan {
  const live = viewCatalog(catalog);
  const modelsByName = new Map(schema.models.map((m) => [m.name, m]));
  const only = options.only && options.only.length > 0 ? new Set(options.only) : null;
  const settings = {
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    backupSchema: options.backupSchema ?? DEFAULT_BACKUP_SCHEMA,
    lockTimeout: options.lockTimeout ?? DEFAULT_LOCK_TIMEOUT,
    orphanCounts: options.orphanCounts ?? {},
  };

  const relations: RelationPlan[] = [];
  const seen = new Set<string>();

  for (const model of schema.models) {
    // `@@ignore` means Prisma does not manage the model at all. Nothing downstream applies.
    if (model.ignored) continue;
    for (const relation of model.relations) {
      const columns = relation.fields.map((f) => columnFor(model, f));
      const key = relationKey(model.name, columns);
      seen.add(key);
      if (only && !only.has(key)) continue;
      relations.push(planRelation(model, relation, modelsByName, live, settings));
    }
  }

  // A selector that matched nothing must not read as "nothing to do". A mistyped relation
  // name would otherwise produce an entirely clean plan: zero refusals, zero deletes, zero
  // of everything, and no indication that it planned nothing.
  const unmatchedSelectors = only ? [...only].filter((k) => !seen.has(k)).sort() : [];

  // The exclusion list fails CLOSED: a key that no longer matches any declared relation is
  // a protection that has silently switched itself off, so it aborts the plan rather than
  // quietly not applying. Checked against the FULL schema (`seen`), not the `--only`
  // subset, so a single-relation run still catches a stale entry elsewhere.
  assertExclusionsResolve(seen, new Set(schema.models.map((m) => m.name)));

  const counts: PlanCounts = {
    relationsConsidered: relations.length,
    satisfied: relations.filter((r) => r.outcome === 'satisfied').length,
    ready: relations.filter((r) => r.outcome === 'ready').length,
    needsValidation: relations.filter((r) => r.outcome === 'needs-validation').length,
    blocked: relations.filter((r) => r.outcome === 'blocked').length,
    refused: relations.filter((r) => r.outcome === 'refused').length,
    deleteStrategy: relations.filter((r) => r.strategy === 'delete-orphans').length,
    nullStrategy: relations.filter((r) => r.strategy === 'null-orphans').length,
  };

  return { counts, relations, unmatchedSelectors };
}

/** Every statement the plan would execute, in order. */
export function planStatements(plan: RemediationPlan): PlannedStatement[] {
  return plan.relations.flatMap((r) => r.statements);
}

/** Only the statements that CHANGE something. The set a dry run must leave empty. */
export function writingStatements(plan: RemediationPlan): PlannedStatement[] {
  return planStatements(plan).filter((s) => s.writes);
}

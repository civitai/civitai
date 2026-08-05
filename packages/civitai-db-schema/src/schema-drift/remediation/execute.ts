/**
 * Execution of a remediation plan.
 *
 * Separated from the planner so that the decision of WHAT to do is testable without any
 * capacity to do it. Everything in this file requires an explicit `apply: true`; the
 * default of every entry point in this module is a dry run that issues no writes.
 */
import type { CatalogQueryRunner } from '../catalog';
import { countOrphansSql } from './sql';
import type { PlannedStatement, RelationPlan, RemediationPlan } from './types';

export interface ExecuteOptions {
  /**
   * Actually issue the writing statements. Absent or false, this module reads and reports.
   *
   * There is no environment variable and no config file that can set this. It is a
   * parameter, passed from one place (the CLI's `--apply`), so the call graph that can
   * write is one edge long.
   */
  apply?: boolean;
  /** Stop a batched statement after this many iterations. Guards against a batch that
   *  never drains because its predicate does not shrink. */
  maxBatches?: number;
  /** How many times `ADD CONSTRAINT` may be re-attempted after a `lock_timeout` expiry. */
  lockRetries?: number;
  /** Called before each statement, for logging. */
  onStatement?: (statement: PlannedStatement, relationKey: string) => void;
  /** Called when `ADD CONSTRAINT` gave up waiting for its locks and will be retried. */
  onLockTimeout?: (attempt: number, relationKey: string) => void;
}

export const DEFAULT_MAX_BATCHES = 10_000;
export const DEFAULT_LOCK_RETRIES = 5;

export interface RelationExecution {
  key: string;
  /** Statements actually issued. Empty on a dry run. */
  executed: PlannedStatement[];
  /** Rows changed by the batched remediation step. */
  rowsRemediated: number;
  batches: number;
  /** How many attempts `ADD CONSTRAINT` needed before it got its locks. */
  lockAttempts?: number;
}

export interface ExecutionResult {
  applied: boolean;
  relations: RelationExecution[];
}

export class RemediationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemediationRefused';
  }
}

/**
 * Count orphans for one relation. Read-only.
 *
 * Kept separate from `executePlan` so that measuring is available to a dry run — the plan
 * is far more useful with real counts, and counting writes nothing.
 */
export async function countOrphans(
  runner: CatalogQueryRunner,
  relation: RelationPlan,
  backupSchema: string,
  batchSize: number
): Promise<number> {
  const sql = countOrphansSql({
    table: relation.table,
    columns: relation.columns,
    refTable: relation.refTable,
    refColumns: relation.refColumns,
    constraintName: relation.constraintName,
    backupSchema,
    backupTable: relation.backupTable,
    batchSize,
  });
  const result = await runner.query<{ orphans: string | number }>(sql);
  const raw = result.rows[0]?.orphans;
  if (raw === undefined || raw === null) {
    throw new Error(`Orphan count for ${relation.key} returned no row`);
  }
  // `count(*)::bigint` arrives as a STRING from node-postgres — bigint has no lossless
  // JavaScript number, so the driver does not parse it. `Number(raw)` on a string is the
  // conversion; reading it as a number directly would give NaN comparisons that silently
  // read as "no orphans".
  const count = Number(raw);
  if (!Number.isFinite(count)) {
    throw new Error(`Orphan count for ${relation.key} was not a number: ${String(raw)}`);
  }
  return count;
}

/**
 * Execute a plan.
 *
 * Refuses, before issuing anything, if the plan contains a relation that is not `ready`.
 * The check is on the PLAN rather than per statement so that a partially-executable plan
 * is rejected whole: half-applying a batch of relations leaves the operator reasoning
 * about which ones landed.
 */
export async function executePlan(
  runner: CatalogQueryRunner,
  plan: RemediationPlan,
  options: ExecuteOptions = {}
): Promise<ExecutionResult> {
  const apply = options.apply === true;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;

  if (plan.unmatchedSelectors.length > 0) {
    throw new RemediationRefused(
      `These relation selectors matched nothing: ${plan.unmatchedSelectors.join(', ')}. ` +
        'Refusing to run a plan that was asked for relations it never saw.'
    );
  }

  const actionable = plan.relations.filter((r) => r.outcome !== 'satisfied');
  // `needs-validation` is executable: the constraint is already there and only VALIDATE
  // remains. Excluding it would make an interrupted run permanently unfinishable — there
  // is no `ADD CONSTRAINT ... IF NOT EXISTS`, so the relation could never be replanned
  // from scratch either.
  const notReady = actionable.filter(
    (r) => r.outcome !== 'ready' && r.outcome !== 'needs-validation'
  );
  if (notReady.length > 0) {
    throw new RemediationRefused(
      `Refusing to execute: ${notReady.length} relation(s) are not ready — ` +
        notReady.map((r) => `${r.key} (${r.outcome})`).join(', ') +
        '. Run the plan to see each reason.'
    );
  }
  // Independent of the outcome label. A relation reaches here only if its outcome says it
  // is executable, but the outcome is DERIVED from the prerequisites in two separate
  // places, and one of them had already got it wrong once — so this asserts the invariant
  // directly rather than trusting whichever branch computed it.
  const unmet = actionable.filter((r) => r.prerequisites.length > 0);
  if (unmet.length > 0) {
    throw new RemediationRefused(
      `Refusing to execute: ${unmet
        .map((r) => `${r.key} (${r.prerequisites.map((p) => p.code).join(', ')})`)
        .join('; ')}. A relation with an unmet prerequisite is not executable regardless of ` +
        'the outcome it carries.'
    );
  }
  if (actionable.length === 0) {
    throw new RemediationRefused(
      'Refusing to execute: the plan contains no actionable relation. An empty run reports ' +
        'the same success as a real one.'
    );
  }
  // One relation at a time. A run that applies several at once cannot be reasoned about
  // when the third one fails, and every relation here is a separate irreversible decision.
  if (actionable.length > 1) {
    throw new RemediationRefused(
      `Refusing to execute ${actionable.length} relations in one run. Remediate one at a ` +
        'time, with --relation, and verify between each.'
    );
  }

  const relations: RelationExecution[] = [];

  for (const relation of actionable) {
    const execution: RelationExecution = {
      key: relation.key,
      executed: [],
      rowsRemediated: 0,
      batches: 0,
    };
    relations.push(execution);

    for (const statement of relation.statements) {
      // A dry run issues nothing at all, not even the read-only count: the point of the
      // dry run is that it is inert, and "it only ran the safe ones" is a claim someone
      // then has to verify. Counting is available through `countOrphans` above.
      if (!apply) continue;
      options.onStatement?.(statement, relation.key);

      if (statement.batched) {
        let affected = 0;
        do {
          const result = await runner.query<unknown>(statement.sql);
          affected = rowCount(result);
          execution.rowsRemediated += affected;
          execution.batches += 1;
          if (execution.batches >= maxBatches) {
            throw new Error(
              `${relation.key}: batched statement still affecting rows after ${maxBatches} ` +
                'batches. Stopping rather than looping.'
            );
          }
        } while (affected > 0);
      } else if (statement.kind === 'add-constraint') {
        execution.lockAttempts = await runWithLockRetry(
          runner,
          statement.sql,
          relation.key,
          options.lockRetries ?? DEFAULT_LOCK_RETRIES,
          options.onLockTimeout
        );
      } else {
        await runner.query<unknown>(statement.sql);
      }
      execution.executed.push(statement);
    }
  }

  return { applied: apply, relations };
}

/** Postgres raises this when `lock_timeout` expires while waiting for a lock. */
export const LOCK_NOT_AVAILABLE = '55P03';

/** `current transaction is aborted, commands ignored until end of transaction block`. */
export const IN_FAILED_SQL_TRANSACTION = '25P02';

/**
 * Return the session to a usable state after a statement inside an explicit transaction
 * failed.
 *
 * Errors from the ROLLBACK itself are swallowed on purpose: if there is no open
 * transaction Postgres emits a warning and succeeds, and if the connection is genuinely
 * gone then the original error is the one worth reporting, not this one.
 */
async function rollbackQuietly(runner: CatalogQueryRunner): Promise<void> {
  try {
    await runner.query<unknown>('ROLLBACK;');
  } catch {
    // Deliberately ignored — see above.
  }
}

function sqlState(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * Run `ADD CONSTRAINT` under its bounded lock wait, retrying when the wait expires.
 *
 * A `lock_timeout` expiry is not a failure of the change — it means the table was busy and
 * the attempt cost nothing, which is exactly the outcome the bounded wait was added to
 * produce. Retrying is therefore correct, and it is what makes the short timeout usable:
 * without a retry, bounding the wait would just convert a stall into a failed run.
 *
 * 🔴 ONLY 55P03 IS RETRIED. Every other error — a constraint violation, a missing table,
 * a permissions problem — is rethrown untouched. Retrying an error whose cause has not
 * gone away turns one clear failure into several confusing ones, and this statement runs
 * after rows have already been deleted, so the operator needs the real error.
 */
async function runWithLockRetry(
  runner: CatalogQueryRunner,
  sql: string,
  key: string,
  maxAttempts: number,
  onLockTimeout?: (attempt: number, key: string) => void
): Promise<number> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runner.query<unknown>(sql);
      return attempt;
    } catch (error) {
      // 🔴 ROLLBACK FIRST, BEFORE LOOKING AT THE ERROR AT ALL.
      //
      // The statement is `BEGIN; SET LOCAL lock_timeout = …; ALTER …; COMMIT;`. Under the
      // simple query protocol a failure aborts the rest of the string, so when the ALTER
      // times out the COMMIT never runs and the session is left in an aborted transaction
      // block. Every subsequent statement on that connection then fails with 25P02
      // (`current transaction is aborted`) — including the retry, which therefore sees
      // 25P02 instead of 55P03, is judged non-retryable, and rethrows. The bounded lock
      // wait converted a stall into a failed run, and poisoned the connection for the rest
      // of the campaign, with an operator-facing error that mentions nothing about locks.
      //
      // This is why the recovery is unconditional and comes before `sqlState`: the session
      // has to be usable again whether or not this error turns out to be retryable, since
      // the caller may go on to use the same client for something else.
      await rollbackQuietly(runner);
      if (sqlState(error) !== LOCK_NOT_AVAILABLE) throw error;
      if (attempt >= maxAttempts) {
        throw new Error(
          `${key}: ADD CONSTRAINT could not acquire its locks within the lock timeout after ` +
            `${maxAttempts} attempts. The table is busy; nothing was changed by this ` +
            'statement. Retry later — the orphan cleanup that ran before it is already ' +
            'durable, and re-planning will pick up from here.'
        );
      }
      onLockTimeout?.(attempt, key);
    }
  }
}

/**
 * Rows affected by a statement.
 *
 * node-postgres reports this as `rowCount`, which is not part of the structural
 * `CatalogQueryRunner` interface the drift detector defines. Read defensively: a driver
 * that does not report it must not read as "0 rows affected", because 0 is the batch
 * loop's termination condition and would end the loop after one pass with the work
 * undone and no error.
 */
function rowCount(result: unknown): number {
  if (typeof result !== 'object' || result === null || !('rowCount' in result)) {
    throw new Error(
      'The query runner did not report rowCount. The batch loop terminates on a zero row ' +
        'count, so a missing one would silently stop after a single batch.'
    );
  }
  const value = (result as { rowCount: unknown }).rowCount;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`The query runner reported a non-numeric rowCount: ${String(value)}`);
  }
  return value;
}

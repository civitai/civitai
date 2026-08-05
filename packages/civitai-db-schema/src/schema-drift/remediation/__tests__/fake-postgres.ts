import type { CatalogQueryRunner } from '../../catalog';

/**
 * A query runner that models Postgres TRANSACTION STATE.
 *
 * 🔴 WHY THIS EXISTS. The previous fake was a stateless function that threw a canned error
 * and returned `{rows: [], rowCount}` for everything else. It modelled no session state, so
 * a whole class of defect was **inexpressible** in it — and one duly shipped: the
 * `ADD CONSTRAINT` statement is `BEGIN; SET LOCAL …; ALTER …; COMMIT;`, and when the ALTER
 * failed, the COMMIT never ran, leaving the session in an aborted transaction. Every later
 * statement returned 25P02, so the lock retry saw 25P02 instead of 55P03, judged it
 * non-retryable, and rethrew — and the connection stayed poisoned for the rest of the
 * campaign.
 *
 * Every component was tested and every mutation of the source was killed. The defect lived
 * in the SEAM between the tool and a real connection, which no test owned. **No mutation of
 * the source could have exposed it, because the fake could not represent the failure.** It
 * was found by driving a real database.
 *
 * So this fake pins a RELATIONSHIP — client state across a failed statement — rather than a
 * component in isolation. The behaviours it reproduces, all load-bearing:
 *
 *   - A multi-statement string executes sequentially and **stops at the first failure**;
 *     the remainder (here, the `COMMIT`) never runs. That is the simple query protocol.
 *   - A statement failing inside an explicit transaction marks it ABORTED.
 *   - While aborted, every statement except `COMMIT`/`ROLLBACK` fails with 25P02.
 *   - `COMMIT` on an aborted transaction behaves as a rollback and clears the state, as
 *     Postgres does.
 *   - `ROLLBACK` always clears the state.
 *
 * Two known simplifications, both unreachable for the statements this module emits and
 * both loud rather than silent if they ever are reached. Recorded rather than engineered
 * around: splitting on `;` would mis-parse a statement containing a literal semicolon (in
 * a string literal or a dollar-quoted body), and a multi-statement string returns one
 * result object rather than the array node-postgres gives — so a caller that started
 * reading `result[1].rows` would get `undefined`, not a wrong row.
 */
export class FakePostgres implements CatalogQueryRunner {
  /** Every statement received, in order, including transaction control. */
  readonly statements: string[] = [];
  /** Statements that actually EXECUTED — excludes those skipped after a failure. */
  readonly executed: string[] = [];

  private inTransaction = false;
  private aborted = false;

  /**
   * @param failures Predicates that make a statement fail, paired with the SQLSTATE to
   *   raise. Consulted in order; each entry may fire a limited number of times so a test
   *   can model "fails twice, then succeeds".
   */
  constructor(
    private readonly failures: Array<{
      match: (sql: string) => boolean;
      code: string;
      times?: number;
    }> = [],
    private readonly rowCounts: number[] = []
  ) {}

  /** True when the session is stuck in a failed transaction, as Postgres would be. */
  get isPoisoned(): boolean {
    return this.aborted;
  }

  get isInTransaction(): boolean {
    return this.inTransaction;
  }

  async query<R>(text: string): Promise<{ rows: R[] }> {
    this.statements.push(text);
    let rowCount = 0;

    // The simple query protocol executes a multi-statement string in order and abandons
    // the rest on the first error. Splitting on `;` is crude but faithful for the
    // statements this module emits, none of which contain a literal semicolon.
    const parts = text
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const part of parts) {
      const upper = part.toUpperCase();

      // 🔴 The failure predicates are consulted BEFORE the transaction-control shortcut.
      //
      // They used to be consulted after, which meant a `ROLLBACK` could never be made to
      // fail — so `rollbackQuietly`'s swallow branch, the whole reason that `try`/`catch`
      // exists, had no possible coverage: deleting the `catch` survived the suite. That is
      // the same shape as the defect this fake was built for, one layer in — a branch the
      // instrument could not express. The connection-genuinely-gone case is now reachable.
      const control = upper === 'ROLLBACK' || upper === 'COMMIT' || upper === 'BEGIN';
      const failure = this.failures.find((f) => f.match(part) && (f.times ?? Infinity) > 0);
      if (failure && (control || !this.aborted)) {
        if (failure.times !== undefined) failure.times -= 1;
        // A failing ROLLBACK models a dead connection: the session state is unknowable, so
        // it is left as-is rather than optimistically cleared.
        if (this.inTransaction && !control) this.aborted = true;
        throw Object.assign(new Error(`fake failure ${failure.code}`), { code: failure.code });
      }

      if (upper === 'ROLLBACK') {
        this.inTransaction = false;
        this.aborted = false;
        this.executed.push(part);
        continue;
      }
      if (upper === 'COMMIT') {
        // Postgres treats COMMIT on an aborted transaction as a rollback rather than an
        // error, so it clears the state either way.
        this.inTransaction = false;
        this.aborted = false;
        this.executed.push(part);
        continue;
      }
      if (this.aborted) {
        throw Object.assign(
          new Error(
            'current transaction is aborted, commands ignored until end of transaction block'
          ),
          { code: '25P02' }
        );
      }
      if (upper === 'BEGIN') {
        this.inTransaction = true;
        this.executed.push(part);
        continue;
      }

      this.executed.push(part);
      if (this.rowCounts.length > 0 && /WITH doomed AS/i.test(part)) {
        rowCount = this.rowCounts.shift() ?? 0;
      }
    }

    return { rows: [], rowCount } as unknown as { rows: R[] };
  }
}

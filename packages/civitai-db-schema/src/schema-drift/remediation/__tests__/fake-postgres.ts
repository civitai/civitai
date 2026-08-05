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

      const failure = this.failures.find((f) => f.match(part) && (f.times ?? Infinity) > 0);
      if (failure) {
        if (failure.times !== undefined) failure.times -= 1;
        if (this.inTransaction) this.aborted = true;
        throw Object.assign(new Error(`fake failure ${failure.code}`), { code: failure.code });
      }

      this.executed.push(part);
      if (this.rowCounts.length > 0 && /WITH doomed AS/i.test(part)) {
        rowCount = this.rowCounts.shift() ?? 0;
      }
    }

    return { rows: [], rowCount } as unknown as { rows: R[] };
  }
}

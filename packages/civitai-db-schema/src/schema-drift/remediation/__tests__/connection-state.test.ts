import { describe, expect, it } from 'vitest';
import { IN_FAILED_SQL_TRANSACTION, LOCK_NOT_AVAILABLE, executePlan } from '../execute';
import { buildRemediationPlan } from '../plan';
import { catalogFrom, schemaFrom } from './helpers';
import { FakePostgres } from './fake-postgres';

/**
 * The seam between this tool and a real connection.
 *
 * These are not component tests. Each one pins a RELATIONSHIP — what the client's session
 * state is after a statement fails — which is the thing no isolated test owned, and the
 * thing a stateless throwing fake structurally could not express.
 */

const SCHEMA = `
model Child {
  id      Int    @id
  ownerId Int
  owner   Parent @relation(fields: [ownerId], references: [id], onDelete: Cascade)
}
model Parent {
  id Int @id
}
`;

function readyPlan(orphans = 0) {
  return buildRemediationPlan(
    schemaFrom(SCHEMA),
    catalogFrom({
      tables: ['Child', 'Parent'],
      columns: [
        ['Child', 'id', true],
        ['Child', 'ownerId', true],
        ['Parent', 'id', true],
      ],
      indexes: [['Child', 'ownerId']],
      uniqueIndexes: [['Parent', 'id']],
    }),
    { only: ['Child.ownerId'], orphanCounts: { 'Child.ownerId': orphans } }
  );
}

const isAlter = (sql: string) => /ADD CONSTRAINT/i.test(sql);

describe('the fake models Postgres transaction state (controls on the harness itself)', () => {
  it('POSITIVE control: a failure inside a transaction poisons the session', () => {
    const pg = new FakePostgres([{ match: isAlter, code: LOCK_NOT_AVAILABLE }]);
    return pg
      .query('BEGIN; ALTER TABLE "x" ADD CONSTRAINT "y" FOREIGN KEY ("a") REFERENCES "b"("c");')
      .catch(() => undefined)
      .then(() => {
        expect(pg.isPoisoned).toBe(true);
      });
  });

  it('POSITIVE control: a poisoned session rejects an unrelated statement with 25P02', async () => {
    const pg = new FakePostgres([{ match: isAlter, code: LOCK_NOT_AVAILABLE }]);
    await pg
      .query('BEGIN; ALTER TABLE "x" ADD CONSTRAINT "y" FOREIGN KEY ("a") REFERENCES "b"("c");')
      .catch(() => undefined);
    await expect(pg.query('SELECT 1')).rejects.toMatchObject({
      code: IN_FAILED_SQL_TRANSACTION,
    });
  });

  it('POSITIVE control: ROLLBACK clears it', async () => {
    const pg = new FakePostgres([{ match: isAlter, code: LOCK_NOT_AVAILABLE }]);
    await pg
      .query('BEGIN; ALTER TABLE "x" ADD CONSTRAINT "y" FOREIGN KEY ("a") REFERENCES "b"("c");')
      .catch(() => undefined);
    await pg.query('ROLLBACK;');
    expect(pg.isPoisoned).toBe(false);
    await expect(pg.query('SELECT 1')).resolves.toBeTruthy();
  });

  it('NEGATIVE control: a clean session is not poisoned and runs anything', async () => {
    const pg = new FakePostgres();
    await pg.query('BEGIN; SELECT 1; COMMIT;');
    expect(pg.isPoisoned).toBe(false);
    expect(pg.isInTransaction).toBe(false);
  });

  it('models the simple query protocol: the rest of the string is SKIPPED after a failure', async () => {
    // This is the specific behaviour that made the original defect possible — the COMMIT
    // never runs, which is why the session is left open and aborted.
    const pg = new FakePostgres([{ match: isAlter, code: LOCK_NOT_AVAILABLE }]);
    await pg
      .query(
        'BEGIN; ALTER TABLE "x" ADD CONSTRAINT "y" FOREIGN KEY ("a") REFERENCES "b"("c"); COMMIT;'
      )
      .catch(() => undefined);
    expect(pg.executed).toEqual(['BEGIN']);
    expect(pg.executed).not.toContain('COMMIT');
  });
});

describe('🔴 a lock timeout must not poison the connection', () => {
  it('issues a ROLLBACK after the failed ADD CONSTRAINT', async () => {
    const pg = new FakePostgres([{ match: isAlter, code: LOCK_NOT_AVAILABLE, times: 1 }]);
    await executePlan(pg, readyPlan(), { apply: true });
    expect(pg.statements.some((s) => /^ROLLBACK/i.test(s.trim()))).toBe(true);
  });

  it('leaves the session USABLE, not stuck in an aborted transaction', async () => {
    const pg = new FakePostgres([{ match: isAlter, code: LOCK_NOT_AVAILABLE, times: 1 }]);
    await executePlan(pg, readyPlan(), { apply: true });
    expect(pg.isPoisoned).toBe(false);
    await expect(pg.query('SELECT 1')).resolves.toBeTruthy();
  });

  it('ACTUALLY RETRIES — the second attempt sees the real error, not 25P02', async () => {
    // The heart of it. Without the ROLLBACK the retry received 25P02, judged it
    // non-retryable and rethrew, so `lockAttempts` never got past 1 and the whole bounded
    // wait was inert.
    const pg = new FakePostgres([{ match: isAlter, code: LOCK_NOT_AVAILABLE, times: 2 }]);
    const result = await executePlan(pg, readyPlan(), { apply: true });
    expect(result.relations[0].lockAttempts).toBe(3);
  });

  it('reports the LOCK error, not "current transaction is aborted", when it gives up', async () => {
    // The operator-facing half: after exhausting the budget the message has to name the
    // lock, because this runs after the orphan DELETE has already committed.
    const pg = new FakePostgres([{ match: isAlter, code: LOCK_NOT_AVAILABLE }]);
    await expect(executePlan(pg, readyPlan(), { apply: true, lockRetries: 2 })).rejects.toThrow(
      /could not acquire its locks/
    );
  });

  it('recovers the session even when the error is NOT retryable', async () => {
    // A constraint violation aborts the transaction just as a lock timeout does. The
    // recovery is unconditional for that reason: the caller may reuse the client.
    const pg = new FakePostgres([{ match: isAlter, code: '23503' }]);
    await expect(executePlan(pg, readyPlan(), { apply: true })).rejects.toThrow();
    expect(pg.isPoisoned).toBe(false);
  });

  it('still surfaces the original error verbatim after recovering', async () => {
    const pg = new FakePostgres([{ match: isAlter, code: '23503' }]);
    await expect(executePlan(pg, readyPlan(), { apply: true })).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('NEGATIVE control: no ROLLBACK is issued when nothing fails', async () => {
    // Otherwise "a ROLLBACK appeared" would be satisfied by a runner that always rolls
    // back, which would be its own defect.
    const pg = new FakePostgres();
    await executePlan(pg, readyPlan(), { apply: true });
    expect(pg.statements.some((s) => /^ROLLBACK/i.test(s.trim()))).toBe(false);
  });
});

describe('an unmet prerequisite blocks BOTH paths identically', () => {
  // The resume path used to hardcode `needs-validation` regardless of prerequisites, so
  // `executePlan`'s not-ready net could not see it: the same relation with the same unmet
  // prerequisite was REFUSED on the ordinary path and EXECUTED, DELETE batch included, on
  // the resume path.
  function planNoCount(validated: boolean | undefined) {
    return buildRemediationPlan(
      schemaFrom(SCHEMA),
      catalogFrom({
        tables: ['Child', 'Parent'],
        columns: [
          ['Child', 'id', true],
          ['Child', 'ownerId', true],
          ['Parent', 'id', true],
        ],
        indexes: [['Child', 'ownerId']],
        uniqueIndexes: [['Parent', 'id']],
        foreignKeys:
          validated === undefined
            ? []
            : [
                {
                  name: 'Child_ownerId_fkey',
                  table: 'Child',
                  columns: ['ownerId'],
                  refTable: 'Parent',
                  validated,
                },
              ],
      }),
      { only: ['Child.ownerId'] } // no orphanCounts -> prerequisite unmet on both paths
    );
  }

  it('blocks the ORDINARY path', () => {
    expect(planNoCount(undefined).relations[0].outcome).toBe('blocked');
  });

  it('blocks the RESUME path too, instead of reporting needs-validation', () => {
    expect(planNoCount(false).relations[0].outcome).toBe('blocked');
  });

  it('executePlan refuses either of them', async () => {
    for (const plan of [planNoCount(undefined), planNoCount(false)]) {
      const pg = new FakePostgres();
      await expect(executePlan(pg, plan, { apply: true })).rejects.toThrow(/not ready|unmet/i);
      expect(pg.statements).toEqual([]);
    }
  });

  it('executePlan refuses on the PREREQUISITE itself, not only on the outcome label', async () => {
    // The invariant is asserted independently of whichever branch computed the outcome,
    // because two separate places derive it and one had already got it wrong.
    const plan = planNoCount(false);
    const forged = {
      ...plan,
      relations: [{ ...plan.relations[0], outcome: 'needs-validation' as const }],
    };
    const pg = new FakePostgres();
    await expect(executePlan(pg, forged, { apply: true })).rejects.toThrow(
      /unmet prerequisite is not executable/
    );
    expect(pg.statements).toEqual([]);
  });

  it('POSITIVE control: with the count supplied, both paths become executable', () => {
    const measured = buildRemediationPlan(
      schemaFrom(SCHEMA),
      catalogFrom({
        tables: ['Child', 'Parent'],
        columns: [
          ['Child', 'id', true],
          ['Child', 'ownerId', true],
          ['Parent', 'id', true],
        ],
        indexes: [['Child', 'ownerId']],
        uniqueIndexes: [['Parent', 'id']],
      }),
      { only: ['Child.ownerId'], orphanCounts: { 'Child.ownerId': 0 } }
    );
    expect(measured.relations[0].outcome).toBe('ready');
  });
});

import { describe, expect, it } from 'vitest';
import type { CatalogQueryRunner } from '../../catalog';
import { RemediationRefused, countOrphans, executePlan } from '../execute';
import { buildRemediationPlan } from '../plan';
import type { RemediationPlan } from '../types';
import { catalogFrom, schemaFrom } from './helpers';

/**
 * A query runner that records instead of executing.
 *
 * Its own control is `refuses to run when the driver does not report rowCount` below: a
 * fake whose `rowCount` was always 0 would make the batch loop terminate after one pass in
 * every test here, and every one of them would still be green.
 */
class RecordingRunner implements CatalogQueryRunner {
  readonly statements: string[] = [];

  /**
   * `rowCounts` feeds the BATCHED statement only.
   *
   * A fake that popped one entry per statement would hand the batch loop whatever was left
   * after the count and the two backup statements had eaten the front of the queue — which
   * is exactly what this fake did on its first draft: the loop saw 0 on its first pass,
   * ran once, and `expected 1 to be 4` was the only reason anyone noticed. The setup, not
   * the code under test, was wrong; a less specific assertion would have passed.
   */
  constructor(private readonly rowCounts: number[] = []) {}

  async query<R>(text: string): Promise<{ rows: R[] }> {
    this.statements.push(text);
    const batched = text.includes('WITH doomed AS');
    const rowCount = batched && this.rowCounts.length > 0 ? this.rowCounts.shift() ?? 0 : 0;
    return { rows: [], rowCount } as unknown as { rows: R[] };
  }
}

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

function catalog() {
  return catalogFrom({
    tables: ['Child', 'Parent'],
    columns: [
      ['Child', 'id', true],
      ['Child', 'ownerId', true],
      ['Parent', 'id', true],
    ],
    indexes: [['Child', 'ownerId']],
  });
}

function readyPlan(orphans = 7): RemediationPlan {
  return buildRemediationPlan(schemaFrom(SCHEMA), catalog(), {
    only: ['Child.ownerId'],
    orphanCounts: { 'Child.ownerId': orphans },
  });
}

describe('the dry run is inert', () => {
  it('issues NOTHING without apply — not even the read-only count', () => {
    // "It only ran the safe ones" is a claim someone then has to verify. A dry run that
    // issues nothing needs no such claim.
    const runner = new RecordingRunner();
    return executePlan(runner, readyPlan()).then((result) => {
      expect(runner.statements).toEqual([]);
      expect(result.applied).toBe(false);
      expect(result.relations[0].executed).toEqual([]);
    });
  });

  it('POSITIVE control: the same plan and runner DO issue statements with apply', () => {
    // Without this, the empty array above is indistinguishable from a plan wired to
    // nothing, or from a runner that never records.
    const runner = new RecordingRunner([3, 0]);
    return executePlan(runner, readyPlan(), { apply: true }).then(() => {
      expect(runner.statements.length).toBeGreaterThan(0);
    });
  });
});

describe('what apply actually issues', () => {
  it('runs the statements in order: count, backup schema, backup table, batch, add, validate', () => {
    const runner = new RecordingRunner([5, 0]);
    return executePlan(runner, readyPlan(), { apply: true }).then((result) => {
      expect(result.relations[0].executed.map((s) => s.kind)).toEqual([
        'count-orphans',
        'create-backup-schema',
        'create-backup-table',
        'remediate-batch',
        'add-constraint',
        'validate-constraint',
      ]);
    });
  });

  it('creates the backup BEFORE the statement that changes rows', () => {
    const runner = new RecordingRunner([1, 0]);
    return executePlan(runner, readyPlan(), { apply: true }).then(() => {
      const backupAt = runner.statements.findIndex((s) =>
        s.startsWith('CREATE TABLE IF NOT EXISTS')
      );
      const mutateAt = runner.statements.findIndex((s) => s.includes('DELETE FROM'));
      expect(backupAt).toBeGreaterThanOrEqual(0);
      expect(mutateAt).toBeGreaterThanOrEqual(0);
      expect(backupAt).toBeLessThan(mutateAt);
    });
  });

  it('adds the constraint NOT VALID before validating it, as two statements', () => {
    const runner = new RecordingRunner([1, 0]);
    return executePlan(runner, readyPlan(), { apply: true }).then(() => {
      const addAt = runner.statements.findIndex((s) => s.includes('NOT VALID'));
      const validateAt = runner.statements.findIndex((s) => s.includes('VALIDATE CONSTRAINT'));
      expect(addAt).toBeGreaterThanOrEqual(0);
      expect(validateAt).toBeGreaterThan(addAt);
      expect(runner.statements[addAt]).not.toContain('VALIDATE CONSTRAINT');
    });
  });

  it('repeats the batched statement until it affects no rows, and sums what it moved', () => {
    const runner = new RecordingRunner([5000, 5000, 137, 0]);
    return executePlan(runner, readyPlan(10137), { apply: true }).then((result) => {
      expect(result.relations[0].batches).toBe(4);
      expect(result.relations[0].rowsRemediated).toBe(10137);
    });
  });

  it('stops rather than looping forever when a batch never drains', () => {
    const runner = new RecordingRunner(Array(50).fill(5000));
    return expect(executePlan(runner, readyPlan(), { apply: true, maxBatches: 5 })).rejects.toThrow(
      /still affecting rows after 5 batches/
    );
  });
});

describe('execution refuses', () => {
  it('a plan with a relation that is not ready', async () => {
    // Same schema, no index in the catalog -> blocked.
    const plan = buildRemediationPlan(
      schemaFrom(SCHEMA),
      catalogFrom({
        tables: ['Child', 'Parent'],
        columns: [
          ['Child', 'id', true],
          ['Child', 'ownerId', true],
          ['Parent', 'id', true],
        ],
        indexes: [['Child', 'id']],
      }),
      { only: ['Child.ownerId'], orphanCounts: { 'Child.ownerId': 1 } }
    );
    const runner = new RecordingRunner();
    await expect(executePlan(runner, plan, { apply: true })).rejects.toThrow(RemediationRefused);
    await expect(executePlan(runner, plan, { apply: true })).rejects.toThrow(
      /Child\.ownerId \(blocked\)/
    );
    expect(runner.statements).toEqual([]);
  });

  it('more than one relation in a single run', async () => {
    const source = `
model A {
  id  Int @id
  pid Int
  p   P   @relation(fields: [pid], references: [id], onDelete: Cascade)
}
model B {
  id  Int @id
  pid Int
  p   P   @relation(fields: [pid], references: [id], onDelete: Cascade)
}
model P {
  id Int @id
}
`;
    const plan = buildRemediationPlan(
      schemaFrom(source),
      catalogFrom({
        tables: ['A', 'B', 'P'],
        columns: [
          ['A', 'id', true],
          ['A', 'pid', true],
          ['B', 'id', true],
          ['B', 'pid', true],
          ['P', 'id', true],
        ],
        indexes: [
          ['A', 'pid'],
          ['B', 'pid'],
        ],
      }),
      { orphanCounts: { 'A.pid': 1, 'B.pid': 1 } }
    );
    const runner = new RecordingRunner();
    await expect(executePlan(runner, plan, { apply: true })).rejects.toThrow(
      /Refusing to execute 2 relations in one run/
    );
    expect(runner.statements).toEqual([]);
  });

  it('a plan whose selectors matched nothing', async () => {
    const plan = buildRemediationPlan(schemaFrom(SCHEMA), catalog(), {
      only: ['Chidl.ownreId'],
    });
    const runner = new RecordingRunner();
    await expect(executePlan(runner, plan, { apply: true })).rejects.toThrow(
      /matched nothing: Chidl\.ownreId/
    );
    expect(runner.statements).toEqual([]);
  });

  it('a plan with nothing actionable at all', async () => {
    const plan = buildRemediationPlan(
      schemaFrom(SCHEMA),
      catalogFrom({
        tables: ['Child', 'Parent'],
        columns: [
          ['Child', 'id', true],
          ['Child', 'ownerId', true],
          ['Parent', 'id', true],
        ],
        indexes: [['Child', 'ownerId']],
        foreignKeys: [
          { name: 'Child_ownerId_fkey', table: 'Child', columns: ['ownerId'], refTable: 'Parent' },
        ],
      }),
      { only: ['Child.ownerId'] }
    );
    const runner = new RecordingRunner();
    await expect(executePlan(runner, plan, { apply: true })).rejects.toThrow(
      /no actionable relation/
    );
  });

  it('a driver that does not report rowCount', async () => {
    // 0 is the batch loop's termination condition, so a driver that reports nothing would
    // otherwise read as "0 rows affected" and stop after one batch with the work undone.
    const silent: CatalogQueryRunner = {
      async query<R>(): Promise<{ rows: R[] }> {
        return { rows: [] as R[] };
      },
    };
    await expect(executePlan(silent, readyPlan(), { apply: true })).rejects.toThrow(
      /did not report rowCount/
    );
  });
});

describe('countOrphans', () => {
  const target = readyPlan().relations[0];

  it('reads the bigint count that node-postgres hands back as a STRING', async () => {
    const runner: CatalogQueryRunner = {
      async query<R>(): Promise<{ rows: R[] }> {
        return { rows: [{ orphans: '13037' }] as unknown as R[] };
      },
    };
    expect(await countOrphans(runner, target, 'fk_remediation_backup', 5000)).toBe(13037);
  });

  it('accepts a real number too', async () => {
    const runner: CatalogQueryRunner = {
      async query<R>(): Promise<{ rows: R[] }> {
        return { rows: [{ orphans: 0 }] as unknown as R[] };
      },
    };
    expect(await countOrphans(runner, target, 'fk_remediation_backup', 5000)).toBe(0);
  });

  it('throws rather than returning NaN when the value is not a number', async () => {
    // NaN comparisons are all false, so `count > 0` would read as "no orphans" and the
    // plan would skip the remediation pass entirely.
    const runner: CatalogQueryRunner = {
      async query<R>(): Promise<{ rows: R[] }> {
        return { rows: [{ orphans: 'lots' }] as unknown as R[] };
      },
    };
    await expect(countOrphans(runner, target, 'fk_remediation_backup', 5000)).rejects.toThrow(
      /was not a number/
    );
  });

  it('throws when the count query returned no row', async () => {
    const runner: CatalogQueryRunner = {
      async query<R>(): Promise<{ rows: R[] }> {
        return { rows: [] as R[] };
      },
    };
    await expect(countOrphans(runner, target, 'fk_remediation_backup', 5000)).rejects.toThrow(
      /returned no row/
    );
  });

  it('issues a read-only SELECT and nothing else', async () => {
    const runner = new RecordingRunner();
    await countOrphans(
      { query: (t) => runner.query(t) } as CatalogQueryRunner,
      target,
      'fk_remediation_backup',
      5000
    ).catch(() => undefined);
    expect(runner.statements).toHaveLength(1);
    expect(runner.statements[0].startsWith('SELECT count(*)')).toBe(true);
  });
});

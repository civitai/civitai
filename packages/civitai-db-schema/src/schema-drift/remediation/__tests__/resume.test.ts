import { describe, expect, it } from 'vitest';
import type { CatalogQueryRunner } from '../../catalog';
import { LOCK_NOT_AVAILABLE, RemediationRefused, executePlan } from '../execute';
import { buildRemediationPlan } from '../plan';
import { quoteInterval } from '../sql';
import { catalogFrom, relation, schemaFrom } from './helpers';

/**
 * The half-applied-constraint state, and the bounded lock wait.
 *
 * 🔴 WHY THIS FILE EXISTS. `ADD CONSTRAINT` has no `IF NOT EXISTS` in Postgres and these
 * statements autocommit, so a run that dies between `ADD CONSTRAINT ... NOT VALID` and
 * `VALIDATE CONSTRAINT` leaves a constraint that is PRESENT and only half-enforcing. Any
 * catalog read filtering on `contype = 'f'` alone reports it as an ordinary foreign key —
 * so the relation came back `satisfied`, execution refused with "no actionable relation",
 * and the campaign could never finish it. The drift detector called it clean throughout.
 *
 * That is the expected outcome rather than a rare one: `VALIDATE CONSTRAINT` scans the
 * whole table, and a statement-timeout ceiling applies, so validation is expected to be
 * killed on the large tables in this backlog.
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

function catalogWith(validated: boolean | null | undefined) {
  return catalogFrom({
    tables: ['Child', 'Parent'],
    columns: [
      ['Child', 'id', true],
      ['Child', 'ownerId', true],
      ['Parent', 'id', true],
    ],
    indexes: [['Child', 'ownerId']],
    uniqueIndexes: [['Parent', 'id']],
    foreignKeys: [
      {
        name: 'Child_ownerId_fkey',
        table: 'Child',
        columns: ['ownerId'],
        refTable: 'Parent',
        validated,
      },
    ],
  });
}

function planWith(validated: boolean | null | undefined, orphans = 0) {
  return buildRemediationPlan(schemaFrom(SCHEMA), catalogWith(validated), {
    only: ['Child.ownerId'],
    orphanCounts: { 'Child.ownerId': orphans },
  });
}

describe('a constraint that exists is THREE states, not two', () => {
  it('validated=true is satisfied, with nothing to do', () => {
    const target = relation(planWith(true), 'Child.ownerId');
    expect(target.constraintValidity).toBe('validated');
    expect(target.outcome).toBe('satisfied');
    expect(target.statements).toEqual([]);
    expect(target.prerequisites).toEqual([]);
  });

  it('🔴 validated=false is NEEDS-VALIDATION, not satisfied', () => {
    // The whole finding. Before `convalidated` was read, this case was indistinguishable
    // from the one above and the relation was stranded permanently.
    const target = relation(planWith(false), 'Child.ownerId');
    expect(target.constraintValidity).toBe('not-valid');
    expect(target.outcome).toBe('needs-validation');
  });

  it('does NOT reissue ADD CONSTRAINT on the resume path', () => {
    // There is no ADD CONSTRAINT ... IF NOT EXISTS; reissuing it would fail the run.
    const kinds = relation(planWith(false), 'Child.ownerId').statements.map((s) => s.kind);
    expect(kinds).toContain('validate-constraint');
    expect(kinds).not.toContain('add-constraint');
  });

  it('re-runs orphan remediation on resume when orphans remain', () => {
    // A validation that failed for a reason OTHER than a timeout means orphans are still
    // there, and the remediation predicate is idempotent, so re-running it is correct.
    const kinds = relation(planWith(false, 12), 'Child.ownerId').statements.map((s) => s.kind);
    expect(kinds).toEqual([
      'count-orphans',
      'create-backup-schema',
      'create-backup-table',
      'remediate-batch',
      'validate-constraint',
    ]);
  });

  it('validated=null is UNKNOWN and says so, rather than reading as validated', () => {
    // A catalog captured without `convalidated` cannot tell the two apart. Reporting a
    // reassuring "satisfied" with no caveat is how a half-applied constraint stays hidden.
    const target = relation(planWith(null), 'Child.ownerId');
    expect(target.constraintValidity).toBe('unknown');
    expect(target.prerequisites.map((p) => p.code)).toContain('constraint-validity-unknown');
  });

  it('counts needs-validation separately from satisfied', () => {
    expect(planWith(false).counts.needsValidation).toBe(1);
    expect(planWith(false).counts.satisfied).toBe(0);
    // Positive control on that pair: the same plan shape with a validated constraint moves
    // both numbers the other way.
    expect(planWith(true).counts.needsValidation).toBe(0);
    expect(planWith(true).counts.satisfied).toBe(1);
  });

  it('EXECUTES a needs-validation plan instead of refusing it as unactionable', async () => {
    const issued: string[] = [];
    const runner: CatalogQueryRunner = {
      async query<R>(text: string): Promise<{ rows: R[] }> {
        issued.push(text);
        return { rows: [], rowCount: 0 } as unknown as { rows: R[] };
      },
    };
    await executePlan(runner, planWith(false), { apply: true });
    expect(issued.some((s) => s.includes('VALIDATE CONSTRAINT'))).toBe(true);
    expect(issued.some((s) => s.includes('ADD CONSTRAINT'))).toBe(false);
  });

  it('still refuses a plan whose only relation is genuinely satisfied', async () => {
    // The guard that used to swallow the resume case must still catch the real one.
    const runner: CatalogQueryRunner = {
      async query<R>(): Promise<{ rows: R[] }> {
        return { rows: [], rowCount: 0 } as unknown as { rows: R[] };
      },
    };
    await expect(executePlan(runner, planWith(true), { apply: true })).rejects.toThrow(
      /no actionable relation/
    );
  });
});

describe('🔴 the resume path does not bypass the refusals that still apply', () => {
  // The resume branch returns before the main refusal block, so anything that still
  // matters once a constraint exists has to be re-checked there. Found while re-reading
  // the branch after the audit round, not by the audit.

  it('refuses to validate a NOT VALID constraint on an EXCLUDED relation', () => {
    const excluded = `
model TagsOnImageNew {
  imageId Int
  tagId   Int
  image   Image @relation(fields: [imageId], references: [id], onDelete: Cascade)
}
model Image {
  id Int @id
}
`;
    const plan = buildRemediationPlan(
      schemaFrom(excluded),
      catalogFrom({
        tables: ['TagsOnImageNew', 'Image'],
        columns: [
          ['TagsOnImageNew', 'imageId', true],
          ['TagsOnImageNew', 'tagId', true],
          ['Image', 'id', true],
        ],
        indexes: [['TagsOnImageNew', 'imageId']],
        uniqueIndexes: [['Image', 'id']],
        foreignKeys: [
          {
            name: 'TagsOnImageNew_imageId_fkey',
            table: 'TagsOnImageNew',
            columns: ['imageId'],
            refTable: 'Image',
            validated: false,
          },
        ],
      }),
      { orphanCounts: { 'TagsOnImageNew.imageId': 3 } }
    );
    const target = relation(plan, 'TagsOnImageNew.imageId');
    expect(target.outcome).toBe('refused');
    expect(target.refusals.map((r) => r.code)).toContain('excluded');
    // Finishing the validation would complete a constraint the list says must not exist.
    expect(target.statements.every((s) => s.writes === false)).toBe(true);
  });

  it('refuses to resume a SetNull relation whose column is NOT NULL', () => {
    // Reachable on real data: `ChallengeEvent.createdById` declares SetNull over a NOT
    // NULL column, so a resume would emit an UPDATE ... SET NULL that cannot succeed —
    // part-way through a campaign, after rows had already been touched.
    const setNull = `
model Child {
  id      Int     @id
  ownerId Int?
  owner   Parent? @relation(fields: [ownerId], references: [id], onDelete: SetNull)
}
model Parent {
  id Int @id
}
`;
    const plan = buildRemediationPlan(
      schemaFrom(setNull),
      catalogFrom({
        tables: ['Child', 'Parent'],
        columns: [
          ['Child', 'id', true],
          ['Child', 'ownerId', true], // NOT NULL, contradicting the declaration
          ['Parent', 'id', true],
        ],
        indexes: [['Child', 'ownerId']],
        uniqueIndexes: [['Parent', 'id']],
        foreignKeys: [
          {
            name: 'Child_ownerId_fkey',
            table: 'Child',
            columns: ['ownerId'],
            refTable: 'Parent',
            validated: false,
          },
        ],
      }),
      { orphanCounts: { 'Child.ownerId': 5 } }
    );
    const target = relation(plan, 'Child.ownerId');
    expect(target.outcome).toBe('refused');
    expect(target.refusals.map((r) => r.code)).toContain('set-null-on-not-null-column');
    expect(target.statements.every((s) => s.writes === false)).toBe(true);
  });

  it('POSITIVE control: an ordinary relation still resumes', () => {
    // Without this, the two refusals above could be a resume path that refuses everything.
    expect(relation(planWith(false), 'Child.ownerId').outcome).toBe('needs-validation');
  });
});

describe('the bounded lock wait on ADD CONSTRAINT', () => {
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
      uniqueIndexes: [['Parent', 'id']],
    }),
    { only: ['Child.ownerId'], orphanCounts: { 'Child.ownerId': 0 } }
  );

  it('wraps the ALTER in a transaction with SET LOCAL lock_timeout', () => {
    // ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY takes ACCESS EXCLUSIVE on the referencing
    // table and SHARE ROW EXCLUSIVE on the REFERENCED one. Cheap as NOT VALID makes the
    // statement, it still has to acquire those locks — so on a hot table an unbounded wait
    // queues every subsequent query behind it. LOCAL keeps the setting off the pooled
    // connection once the transaction ends.
    const add = relation(plan, 'Child.ownerId').statements.find((s) => s.kind === 'add-constraint');
    expect(add?.sql).toContain('BEGIN;');
    expect(add?.sql).toContain("SET LOCAL lock_timeout = '3s'");
    expect(add?.sql).toContain('COMMIT;');
  });

  it('honours a configured lock timeout', () => {
    const custom = buildRemediationPlan(
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
      { only: ['Child.ownerId'], orphanCounts: { 'Child.ownerId': 0 }, lockTimeout: '250ms' }
    );
    const add = relation(custom, 'Child.ownerId').statements.find(
      (s) => s.kind === 'add-constraint'
    );
    expect(add?.sql).toContain("SET LOCAL lock_timeout = '250ms'");
  });

  it('rejects a lock timeout that is not an interval literal', () => {
    // It reaches a SET, which takes no bound parameter, so it is the one caller-supplied
    // string that would otherwise be interpolated into SQL unquoted.
    expect(() => quoteInterval("3s'; DROP TABLE x; --")).toThrow(/Invalid lock timeout/);
    expect(() => quoteInterval('forever')).toThrow(/Invalid lock timeout/);
    expect(quoteInterval('3s')).toBe("'3s'");
    expect(quoteInterval('500ms')).toBe("'500ms'");
  });

  it('RETRIES ADD CONSTRAINT when the lock wait expires, then succeeds', async () => {
    // A lock_timeout expiry means the table was busy and the attempt changed nothing —
    // which is the outcome the bound exists to produce. Without a retry, bounding the wait
    // would just convert a stall into a failed run.
    let attempts = 0;
    const runner: CatalogQueryRunner = {
      async query<R>(text: string): Promise<{ rows: R[] }> {
        if (text.includes('ADD CONSTRAINT')) {
          attempts += 1;
          if (attempts < 3) throw Object.assign(new Error('lock timeout'), { code: '55P03' });
        }
        return { rows: [], rowCount: 0 } as unknown as { rows: R[] };
      },
    };
    const result = await executePlan(runner, plan, { apply: true });
    expect(attempts).toBe(3);
    expect(result.relations[0].lockAttempts).toBe(3);
  });

  it('gives up after the retry budget rather than looping', async () => {
    const runner: CatalogQueryRunner = {
      async query<R>(text: string): Promise<{ rows: R[] }> {
        if (text.includes('ADD CONSTRAINT')) {
          throw Object.assign(new Error('lock timeout'), { code: LOCK_NOT_AVAILABLE });
        }
        return { rows: [], rowCount: 0 } as unknown as { rows: R[] };
      },
    };
    await expect(executePlan(runner, plan, { apply: true, lockRetries: 2 })).rejects.toThrow(
      /could not acquire its locks .* after 2 attempts/
    );
  });

  it('🔴 does NOT retry an error that is not a lock timeout', async () => {
    // Retrying an error whose cause has not gone away turns one clear failure into several
    // confusing ones — and this statement runs after rows have already been deleted, so
    // the operator needs the real error, unmodified.
    let attempts = 0;
    const runner: CatalogQueryRunner = {
      async query<R>(text: string): Promise<{ rows: R[] }> {
        if (text.includes('ADD CONSTRAINT')) {
          attempts += 1;
          throw Object.assign(new Error('violates foreign key constraint'), { code: '23503' });
        }
        return { rows: [], rowCount: 0 } as unknown as { rows: R[] };
      },
    };
    await expect(executePlan(runner, plan, { apply: true })).rejects.toThrow(
      /violates foreign key constraint/
    );
    expect(attempts).toBe(1);
  });
});

describe('the referenced side must be unique', () => {
  it('refuses when the referenced columns carry no unique index', async () => {
    // Postgres rejects such a foreign key with SQLSTATE 42830 — at ADD CONSTRAINT, which
    // in this plan is AFTER the orphan rows have been deleted.
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
      }),
      { orphanCounts: { 'Child.ownerId': 1 } }
    );
    const target = relation(plan, 'Child.ownerId');
    expect(target.refusals.map((r) => r.code)).toContain('referenced-columns-not-unique');
    expect(target.outcome).toBe('refused');
    expect(target.statements.every((s) => s.writes === false)).toBe(true);
  });

  it('POSITIVE control: the same relation is fine once the unique index is there', () => {
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
        uniqueIndexes: [['Parent', 'id']],
      }),
      { orphanCounts: { 'Child.ownerId': 1 } }
    );
    expect(relation(plan, 'Child.ownerId').outcome).toBe('ready');
  });
});

describe('the exclusion list aborts the plan when it stops matching', () => {
  it('refuses to plan at all rather than silently not excluding', () => {
    // Fails CLOSED: a key that no longer resolves is a protection that has switched itself
    // off, and the relation would otherwise be planned as an ordinary Cascade DELETE.
    const withRenamedColumn = `
model TagsOnImageNew {
  image_id Int
  tagId    Int
  image    Image @relation(fields: [image_id], references: [id], onDelete: Cascade)
}
model Image {
  id Int @id
}
`;
    expect(() =>
      buildRemediationPlan(
        schemaFrom(withRenamedColumn),
        catalogFrom({ tables: ['TagsOnImageNew', 'Image'] }),
        {}
      )
    ).toThrow(/TagsOnImageNew\.imageId/);
  });
});

describe('the backup INSERT names its columns', () => {
  it('refuses to build a statement without the catalog column list', async () => {
    // `INSERT ... SELECT t.*` into a backup table left by an earlier run with a different
    // shape either errors on the count or writes each value into its neighbour's column.
    // Naming the columns makes a stale backup fail loudly instead.
    const { deleteOrphanBatchSql } = await import('../sql');
    expect(() =>
      deleteOrphanBatchSql({
        table: 'T',
        columns: ['c'],
        refTable: 'R',
        refColumns: ['id'],
        constraintName: 'T_c_fkey',
        backupSchema: 'b',
        backupTable: 'T_c_orphans',
        batchSize: 10,
      })
    ).toThrow(/No column list/);
  });
});

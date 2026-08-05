import { describe, expect, it } from 'vitest';
import type { ParsedSchema, ReferentialAction } from '../../types';
import { buildRemediationPlan, strategyForAction } from '../plan';
import {
  catalogFrom,
  countDeletes,
  countUpdates,
  planSql,
  refusalCodes,
  refusalMessage,
  relation,
  schemaFrom,
  writingSql,
} from './helpers';

/**
 * Baseline: one `Cascade` relation, indexed, on tables that exist.
 *
 * Every case below is this with ONE thing changed, so the refusal it produces is
 * attributable. The baseline itself is asserted `ready` first — a fixture that was already
 * refused for an unrelated reason would make every "it refuses" assertion below pass for
 * the wrong reason.
 */
const CASCADE_SCHEMA = `
model Child {
  id      Int    @id
  ownerId Int
  owner   Parent @relation(fields: [ownerId], references: [id], onDelete: Cascade)
}
model Parent {
  id Int @id
}
`;

const SETNULL_SCHEMA = `
model Child {
  id      Int     @id
  ownerId Int?
  owner   Parent? @relation(fields: [ownerId], references: [id], onDelete: SetNull)
}
model Parent {
  id Int @id
}
`;

function baseCatalog(overrides: Parameters<typeof catalogFrom>[0] = {}) {
  return catalogFrom({
    tables: ['Child', 'Parent'],
    columns: [
      ['Child', 'id', true],
      ['Child', 'ownerId', true],
      ['Parent', 'id', true],
    ],
    indexes: [['Child', 'ownerId']],
    ...overrides,
  });
}

function nullableCatalog(overrides: Parameters<typeof catalogFrom>[0] = {}) {
  return baseCatalog({
    columns: [
      ['Child', 'id', true],
      ['Child', 'ownerId', false],
      ['Parent', 'id', true],
    ],
    ...overrides,
  });
}

const COUNTS = { 'Child.ownerId': 4 };

describe('strategyForAction — the entire action-awareness of the runner', () => {
  // Pinned literally. Deriving these from the implementation would assert only that the
  // switch is a switch.
  it('maps Cascade to a DELETE of the orphan rows', () => {
    expect(strategyForAction('Cascade')).toBe('delete-orphans');
  });
  it('maps SetNull to an UPDATE that clears the reference', () => {
    expect(strategyForAction('SetNull')).toBe('null-orphans');
  });
  it.each(['NoAction', 'Restrict', 'SetDefault'])('has no strategy for %s', (action) => {
    expect(strategyForAction(action)).toBeNull();
  });
  it('has no strategy for a value that is not a referential action at all', () => {
    expect(strategyForAction('Frobnicate')).toBeNull();
  });
});

describe('the baseline fixture is actually plannable', () => {
  it('is READY, so every refusal below is attributable to the one thing that changed', () => {
    const plan = buildRemediationPlan(schemaFrom(CASCADE_SCHEMA), baseCatalog(), {
      orphanCounts: COUNTS,
    });
    expect(relation(plan, 'Child.ownerId').outcome).toBe('ready');
    expect(refusalCodes(plan, 'Child.ownerId')).toEqual([]);
    expect(relation(plan, 'Child.ownerId').prerequisites).toEqual([]);
  });

  it('is READY for the SetNull variant too', () => {
    const plan = buildRemediationPlan(schemaFrom(SETNULL_SCHEMA), nullableCatalog(), {
      orphanCounts: COUNTS,
    });
    expect(relation(plan, 'Child.ownerId').outcome).toBe('ready');
    expect(refusalCodes(plan, 'Child.ownerId')).toEqual([]);
  });
});

describe('the strategy is derived per relation, never from a flag', () => {
  it('Cascade emits a batched DELETE and no UPDATE', () => {
    const plan = buildRemediationPlan(schemaFrom(CASCADE_SCHEMA), baseCatalog(), {
      orphanCounts: COUNTS,
    });
    const sql = planSql(plan);
    expect(countDeletes(sql)).toBe(1);
    expect(countUpdates(sql)).toBe(0);
    expect(relation(plan, 'Child.ownerId').strategy).toBe('delete-orphans');
  });

  it('SetNull emits a batched UPDATE and no DELETE', () => {
    const plan = buildRemediationPlan(schemaFrom(SETNULL_SCHEMA), nullableCatalog(), {
      orphanCounts: COUNTS,
    });
    const sql = planSql(plan);
    expect(countUpdates(sql)).toBe(1);
    expect(countDeletes(sql)).toBe(0);
    expect(relation(plan, 'Child.ownerId').strategy).toBe('null-orphans');
    expect(sql).toContain('SET "ownerId" = NULL');
  });

  it('writes the DECLARED action into the constraint, not a hardcoded CASCADE', () => {
    const plan = buildRemediationPlan(schemaFrom(SETNULL_SCHEMA), nullableCatalog(), {
      orphanCounts: COUNTS,
    });
    expect(planSql(plan)).toContain('ON UPDATE CASCADE ON DELETE SET NULL');
    expect(planSql(plan)).not.toContain('ON DELETE CASCADE');
  });

  it('skips the remediation batch entirely when there are no orphans', () => {
    const plan = buildRemediationPlan(schemaFrom(CASCADE_SCHEMA), baseCatalog(), {
      orphanCounts: { 'Child.ownerId': 0 },
    });
    const kinds = relation(plan, 'Child.ownerId').statements.map((s) => s.kind);
    expect(kinds).toEqual(['count-orphans', 'add-constraint', 'validate-constraint']);
    expect(countDeletes(planSql(plan))).toBe(0);
  });

  it('batches at the configured size, and defaults to 5000', () => {
    const dflt = buildRemediationPlan(schemaFrom(CASCADE_SCHEMA), baseCatalog(), {
      orphanCounts: COUNTS,
    });
    expect(planSql(dflt)).toContain('LIMIT 5000');
    const sized = buildRemediationPlan(schemaFrom(CASCADE_SCHEMA), baseCatalog(), {
      orphanCounts: COUNTS,
      batchSize: 250,
    });
    expect(planSql(sized)).toContain('LIMIT 250');
    expect(planSql(sized)).not.toContain('LIMIT 5000');
  });
});

describe('refusals — each asserted by its own code and message', () => {
  it('[set-null-on-not-null-column] refuses SetNull against a NOT NULL column', () => {
    // The baseline catalog has ownerId NOT NULL; only the schema's action changes.
    const plan = buildRemediationPlan(schemaFrom(SETNULL_SCHEMA), baseCatalog(), {
      orphanCounts: COUNTS,
    });
    expect(relation(plan, 'Child.ownerId').outcome).toBe('refused');
    expect(refusalCodes(plan, 'Child.ownerId')).toEqual(['set-null-on-not-null-column']);
    expect(refusalMessage(plan, 'Child.ownerId', 'set-null-on-not-null-column')).toContain(
      'the DECLARATION is wrong, not the data'
    );
    expect(writingSql(plan)).toBe('');
  });

  it.each([
    ['NoAction', 'action-forbids-mutation'],
    ['Restrict', 'action-forbids-mutation'],
  ] as const)('[%s] refuses with %s and mutates nothing', (action, code) => {
    const source = CASCADE_SCHEMA.replace('onDelete: Cascade', `onDelete: ${action}`);
    const plan = buildRemediationPlan(schemaFrom(source), baseCatalog(), { orphanCounts: COUNTS });
    expect(relation(plan, 'Child.ownerId').outcome).toBe('refused');
    expect(refusalCodes(plan, 'Child.ownerId')).toEqual([code]);
    expect(refusalMessage(plan, 'Child.ownerId', code)).toContain('should be REJECTED');
    expect(writingSql(plan)).toBe('');
    expect(relation(plan, 'Child.ownerId').strategy).toBeNull();
  });

  it('[unknown-action] refuses SetDefault — a real action with no implemented strategy', () => {
    const source = CASCADE_SCHEMA.replace('onDelete: Cascade', 'onDelete: SetDefault');
    const plan = buildRemediationPlan(schemaFrom(source), baseCatalog(), { orphanCounts: COUNTS });
    expect(refusalCodes(plan, 'Child.ownerId')).toEqual(['unknown-action']);
    expect(refusalMessage(plan, 'Child.ownerId', 'unknown-action')).toContain(
      'implemented in this runner'
    );
    expect(writingSql(plan)).toBe('');
  });

  it('[unknown-action] refuses a value that is not a referential action at all', () => {
    // The parser rejects an unrecognised action, so this state can only arrive from a
    // caller building a schema by hand — which is exactly the fail-closed case: the
    // planner must not assume a strategy for something it cannot name.
    const schema: ParsedSchema = {
      models: [
        {
          name: 'Child',
          table: 'Child',
          ignored: false,
          fields: [
            {
              name: 'id',
              column: 'id',
              type: 'Int',
              optional: false,
              list: false,
              scalar: true,
              unique: false,
            },
            {
              name: 'ownerId',
              column: 'ownerId',
              type: 'Int',
              optional: false,
              list: false,
              scalar: true,
              unique: false,
            },
          ],
          uniques: [],
          relations: [
            {
              model: 'Child',
              field: 'owner',
              targetModel: 'Parent',
              fields: ['ownerId'],
              references: ['id'],
              onDelete: 'Frobnicate' as unknown as ReferentialAction,
              onUpdate: 'Cascade',
              onDeleteExplicit: true,
              onUpdateExplicit: false,
              optional: false,
            },
          ],
        },
        { name: 'Parent', table: 'Parent', ignored: false, fields: [], uniques: [], relations: [] },
      ],
    };
    const plan = buildRemediationPlan(schema, baseCatalog(), { orphanCounts: COUNTS });
    expect(refusalCodes(plan, 'Child.ownerId')).toEqual(['unknown-action']);
    expect(refusalMessage(plan, 'Child.ownerId', 'unknown-action')).toContain(
      'not a Prisma referential action'
    );
    expect(writingSql(plan)).toBe('');
  });

  it('[table-not-in-catalog] refuses when the referencing table is absent', () => {
    const plan = buildRemediationPlan(
      schemaFrom(CASCADE_SCHEMA),
      catalogFrom({
        tables: ['Parent'],
        columns: [
          ['Child', 'id', true],
          ['Child', 'ownerId', true],
          ['Parent', 'id', true],
        ],
        indexes: [['Child', 'ownerId']],
      }),
      { orphanCounts: COUNTS }
    );
    expect(refusalCodes(plan, 'Child.ownerId')).toEqual(['table-not-in-catalog']);
    expect(refusalMessage(plan, 'Child.ownerId', 'table-not-in-catalog')).toContain(
      'not an ordinary table'
    );
  });

  it('[referenced-table-not-in-catalog] refuses when REFERENCES would not resolve', () => {
    const plan = buildRemediationPlan(
      schemaFrom(CASCADE_SCHEMA),
      catalogFrom({
        tables: ['Child'],
        columns: [
          ['Child', 'id', true],
          ['Child', 'ownerId', true],
        ],
        indexes: [['Child', 'ownerId']],
      }),
      { orphanCounts: COUNTS }
    );
    expect(refusalCodes(plan, 'Child.ownerId')).toEqual(['referenced-table-not-in-catalog']);
    expect(refusalMessage(plan, 'Child.ownerId', 'referenced-table-not-in-catalog')).toContain(
      'would not resolve'
    );
  });

  it('[column-not-in-catalog] refuses when the referencing column is absent', () => {
    const plan = buildRemediationPlan(
      schemaFrom(CASCADE_SCHEMA),
      catalogFrom({
        tables: ['Child', 'Parent'],
        columns: [
          ['Child', 'id', true],
          ['Parent', 'id', true],
        ],
        indexes: [['Child', 'ownerId']],
      }),
      { orphanCounts: COUNTS }
    );
    expect(refusalCodes(plan, 'Child.ownerId')).toEqual(['column-not-in-catalog']);
    expect(refusalMessage(plan, 'Child.ownerId', 'column-not-in-catalog')).toContain(
      'SET NULL guard could not be evaluated'
    );
  });

  it('[constraint-name-taken] refuses when the conventional name is used by other columns', () => {
    const plan = buildRemediationPlan(
      schemaFrom(CASCADE_SCHEMA),
      baseCatalog({
        foreignKeys: [
          {
            name: 'Child_ownerId_fkey',
            table: 'Child',
            columns: ['id'],
            refTable: 'Parent',
          },
        ],
      }),
      { orphanCounts: COUNTS }
    );
    expect(refusalCodes(plan, 'Child.ownerId')).toEqual(['constraint-name-taken']);
    expect(refusalMessage(plan, 'Child.ownerId', 'constraint-name-taken')).toContain(
      'unfindable by its conventional name'
    );
  });

  it('[identifier-too-long] refuses rather than let Postgres truncate silently', () => {
    // "<52 chars>_ownerId_orphans" is 68 bytes; the constraint name is 65.
    const long = 'C'.repeat(52);
    const source = CASCADE_SCHEMA.replace(/Child/g, long);
    const plan = buildRemediationPlan(
      schemaFrom(source),
      catalogFrom({
        tables: [long, 'Parent'],
        columns: [
          [long, 'id', true],
          [long, 'ownerId', true],
          ['Parent', 'id', true],
        ],
        indexes: [[long, 'ownerId']],
      }),
      { orphanCounts: { [`${long}.ownerId`]: 1 } }
    );
    expect(refusalCodes(plan, `${long}.ownerId`)).toEqual(['identifier-too-long']);
    expect(refusalMessage(plan, `${long}.ownerId`, 'identifier-too-long')).toContain('63-byte');
  });

  it('accumulates every applicable refusal instead of stopping at the first', () => {
    // A short-circuiting planner would report only one of these, which would make the
    // other guard unreachable for this input and therefore untestable.
    const plan = buildRemediationPlan(
      schemaFrom(CASCADE_SCHEMA.replace('onDelete: Cascade', 'onDelete: Restrict')),
      catalogFrom({ tables: ['Parent'], columns: [['Parent', 'id', true]] }),
      { orphanCounts: COUNTS }
    );
    expect(refusalCodes(plan, 'Child.ownerId').sort()).toEqual([
      'action-forbids-mutation',
      'column-not-in-catalog',
      'table-not-in-catalog',
    ]);
  });

  it('shows a refused relation the read-only count and nothing else', () => {
    const plan = buildRemediationPlan(schemaFrom(SETNULL_SCHEMA), baseCatalog(), {
      orphanCounts: COUNTS,
    });
    const statements = relation(plan, 'Child.ownerId').statements;
    expect(statements.map((s) => s.kind)).toEqual(['count-orphans']);
    expect(statements.every((s) => s.writes === false)).toBe(true);
  });
});

describe('the index prerequisite', () => {
  it('blocks with [missing-index] and the CREATE INDEX CONCURRENTLY to run first', () => {
    const plan = buildRemediationPlan(
      schemaFrom(CASCADE_SCHEMA),
      baseCatalog({ indexes: [['Child', 'id']] }),
      { orphanCounts: COUNTS }
    );
    const target = relation(plan, 'Child.ownerId');
    expect(target.outcome).toBe('blocked');
    expect(target.indexCoverage).toBe('not-covered');
    const prerequisite = target.prerequisites.find((p) => p.code === 'missing-index');
    expect(prerequisite?.sql).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "Child_ownerId_idx"\n  ON "Child" ("ownerId");'
    );
  });

  it('requires a LEADING-column index, not merely a mention of the column', () => {
    // This is `ImageEngagement`: a unique index on (userId, imageId) does nothing for a
    // delete cascading on imageId. A membership test would call this covered.
    const plan = buildRemediationPlan(
      schemaFrom(CASCADE_SCHEMA),
      baseCatalog({ indexes: [['Child', 'id', 'ownerId']] }),
      { orphanCounts: COUNTS }
    );
    expect(relation(plan, 'Child.ownerId').indexCoverage).toBe('not-covered');
  });

  it('accepts an index whose LEADING column is the referencing column', () => {
    const plan = buildRemediationPlan(
      schemaFrom(CASCADE_SCHEMA),
      baseCatalog({ indexes: [['Child', 'ownerId', 'id']] }),
      { orphanCounts: COUNTS }
    );
    expect(relation(plan, 'Child.ownerId').indexCoverage).toBe('covered');
    expect(relation(plan, 'Child.ownerId').outcome).toBe('ready');
  });

  it('accepts a UNIQUE index as coverage — a unique index is an index', () => {
    const plan = buildRemediationPlan(
      schemaFrom(CASCADE_SCHEMA),
      catalogFrom({
        tables: ['Child', 'Parent'],
        columns: [
          ['Child', 'id', true],
          ['Child', 'ownerId', true],
          ['Parent', 'id', true],
        ],
        uniqueIndexes: [['Child', 'ownerId', 'id']],
      }),
      { orphanCounts: COUNTS }
    );
    expect(relation(plan, 'Child.ownerId').indexCoverage).toBe('covered');
  });

  it('reports [index-coverage-unknown] — NOT "not-covered" — when the catalog has no index list', () => {
    // The distinction the plan exists to preserve: a catalog captured without index data
    // cannot tell "there is no index" from "we did not look". Collapsing the two would
    // either block every relation or wave every relation through.
    const plan = buildRemediationPlan(
      schemaFrom(CASCADE_SCHEMA),
      catalogFrom({
        tables: ['Child', 'Parent'],
        columns: [
          ['Child', 'id', true],
          ['Child', 'ownerId', true],
          ['Parent', 'id', true],
        ],
      }),
      { orphanCounts: COUNTS }
    );
    const target = relation(plan, 'Child.ownerId');
    expect(target.indexCoverage).toBe('unknown');
    expect(target.outcome).toBe('blocked');
    expect(target.prerequisites.map((p) => p.code)).toContain('index-coverage-unknown');
  });

  it('applies the index requirement to SetNull too, not only to Cascade', () => {
    // `Collection.imageId` is SetNull over 16.9M rows with no index on imageId. A parent
    // delete has to FIND the referencing rows to null them, exactly as it does to delete
    // them, so restricting this check to Cascade would leave the largest case uncovered.
    const plan = buildRemediationPlan(
      schemaFrom(SETNULL_SCHEMA),
      nullableCatalog({ indexes: [['Child', 'id']] }),
      { orphanCounts: COUNTS }
    );
    expect(relation(plan, 'Child.ownerId').outcome).toBe('blocked');
    expect(relation(plan, 'Child.ownerId').prerequisites.map((p) => p.code)).toContain(
      'missing-index'
    );
  });
});

describe('plan-level guards', () => {
  it('reports a selector that matched no relation instead of planning nothing', () => {
    const plan = buildRemediationPlan(schemaFrom(CASCADE_SCHEMA), baseCatalog(), {
      only: ['Child.ownerId', 'Chidl.ownreId'],
    });
    expect(plan.unmatchedSelectors).toEqual(['Chidl.ownreId']);
    expect(plan.counts.relationsConsidered).toBe(1);
  });

  it('marks a relation whose foreign key already exists as satisfied, with no statements', () => {
    const plan = buildRemediationPlan(
      schemaFrom(CASCADE_SCHEMA),
      baseCatalog({
        foreignKeys: [
          { name: 'Child_ownerId_fkey', table: 'Child', columns: ['ownerId'], refTable: 'Parent' },
        ],
      }),
      { orphanCounts: COUNTS }
    );
    const target = relation(plan, 'Child.ownerId');
    expect(target.outcome).toBe('satisfied');
    expect(target.statements).toEqual([]);
    expect(writingSql(plan)).toBe('');
  });

  it('blocks on [orphan-count-not-measured] when no count was supplied', () => {
    const plan = buildRemediationPlan(schemaFrom(CASCADE_SCHEMA), baseCatalog(), {});
    const target = relation(plan, 'Child.ownerId');
    expect(target.orphanCount).toBeNull();
    expect(target.outcome).toBe('blocked');
    expect(target.prerequisites.map((p) => p.code)).toEqual(['orphan-count-not-measured']);
  });

  it('treats a measured zero as measured, not as missing', () => {
    // `orphanCounts: { key: 0 }` must not read as absent. A `?? null` on a falsy 0 would
    // block every already-clean relation and be indistinguishable from never counting.
    const plan = buildRemediationPlan(schemaFrom(CASCADE_SCHEMA), baseCatalog(), {
      orphanCounts: { 'Child.ownerId': 0 },
    });
    expect(relation(plan, 'Child.ownerId').orphanCount).toBe(0);
    expect(relation(plan, 'Child.ownerId').outcome).toBe('ready');
  });

  it('skips @@ignore models entirely', () => {
    const source = `
model Child {
  id      Int    @id
  ownerId Int
  owner   Parent @relation(fields: [ownerId], references: [id], onDelete: Cascade)

  @@ignore
}
model Parent {
  id Int @id
}
`;
    const plan = buildRemediationPlan(schemaFrom(source), baseCatalog(), {});
    expect(plan.relations).toEqual([]);
    expect(plan.counts.relationsConsidered).toBe(0);
  });
});

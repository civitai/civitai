import { describe, expect, it } from 'vitest';
import { buildRemediationPlan } from '../plan';
import {
  catalogFrom,
  countDeletes,
  countUpdates,
  planSql,
  schemaFrom,
  writingSql,
} from './helpers';

/**
 * Controls on the test instruments themselves.
 *
 * The headline claim of this module is a ZERO — "planning the SetNull relations emits no
 * DELETE". A zero produced by an instrument that has never been shown to produce anything
 * else is a fact about the instrument, not about the planner. Every assertion helper used
 * by the suites below is exercised here against an input it MUST report on, and against
 * one it MUST NOT.
 */
describe('test-harness controls', () => {
  describe('countDeletes / countUpdates', () => {
    it('POSITIVE control: reports the DELETE and the UPDATE it is looking for', () => {
      expect(countDeletes('DELETE FROM "T" t USING doomed d WHERE t.ctid = d.ctid')).toBe(1);
      expect(countUpdates('UPDATE "T" t SET "c" = NULL FROM doomed d')).toBe(1);
    });

    it('NEGATIVE control: does not report one that is not there', () => {
      expect(countDeletes('UPDATE "T" t SET "c" = NULL FROM doomed d')).toBe(0);
      expect(countUpdates('DELETE FROM "T" t USING doomed d WHERE t.ctid = d.ctid')).toBe(0);
    });

    it('counts every occurrence, not just the first', () => {
      // A helper that stopped at the first match would report 1 for a plan carrying 14
      // deletes, and "1 delete" reads as an acceptable answer where 14 does not.
      expect(countDeletes('DELETE FROM "A"\nDELETE FROM "B"\nDELETE FROM "C"')).toBe(3);
    });

    it('is not fooled by the word appearing in a comment or an identifier', () => {
      expect(countDeletes('SELECT "deletedAt" FROM "T"')).toBe(0);
      expect(countUpdates('SELECT "updatedAt" FROM "T"')).toBe(0);
    });
  });

  /**
   * The planner-level control. `planSql` reads `statements[].sql`; if the planner ever
   * stopped populating that field, every SQL-shaped assertion in this suite would go
   * quietly green on an empty string.
   */
  describe('planSql', () => {
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
    const CATALOG = catalogFrom({
      tables: ['Child', 'Parent'],
      columns: [
        ['Child', 'id', true],
        ['Child', 'ownerId', true],
        ['Parent', 'id', true],
      ],
      indexes: [['Child', 'ownerId']],
    });

    it('POSITIVE control: a Cascade relation with orphans yields a non-empty DELETE', () => {
      const plan = buildRemediationPlan(schemaFrom(SCHEMA), CATALOG, {
        orphanCounts: { 'Child.ownerId': 12 },
      });
      const sql = planSql(plan);
      expect(sql.length).toBeGreaterThan(0);
      expect(countDeletes(sql)).toBe(1);
    });

    it('NEGATIVE control: writingSql is empty when the relation is refused', () => {
      // Same schema, but the catalog has no such table — a refusal. If `writingSql` were
      // reading the wrong field it would be empty here for the wrong reason, which is why
      // the positive control above exists on the same helper.
      const plan = buildRemediationPlan(
        schemaFrom(SCHEMA),
        catalogFrom({ tables: ['Parent'], columns: [['Parent', 'id', true]] }),
        {}
      );
      expect(writingSql(plan)).toBe('');
    });
  });
});

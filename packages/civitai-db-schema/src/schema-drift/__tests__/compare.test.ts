import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertCatalogSanity, compareSchemaToCatalog } from '../compare';
import { parsePrismaSchema } from '../parse-prisma-schema';
import type { DbCatalog, DriftFinding, DriftKind, ParsedSchema } from '../types';

const here = fileURLToPath(new URL('.', import.meta.url));

function loadCatalog(name: string): DbCatalog {
  return JSON.parse(readFileSync(join(here, `fixtures/${name}`), 'utf8')) as DbCatalog;
}

const schema: ParsedSchema = parsePrismaSchema(
  readFileSync(join(here, 'fixtures/fixture.prisma'), 'utf8')
);

function ids(findings: DriftFinding[], kind: DriftKind): string[] {
  return findings
    .filter((f) => f.kind === kind)
    .map((f) => `${f.table}.${f.columns.join('+')}`)
    .sort();
}

describe('compareSchemaToCatalog', () => {
  describe('aligned schema and catalog', () => {
    const report = compareSchemaToCatalog(schema, loadCatalog('catalog-aligned.json'));

    it('reports no drift', () => {
      expect(report.findings).toEqual([]);
    });

    // A zero from a detector that checked nothing looks exactly like a zero from a clean
    // database. These counts are the positive control on the run above: they prove the
    // comparison actually visited the relations, columns and unique declarations whose
    // cleanliness the empty finding list is claiming.
    it('actually checked something (positive control on the zero above)', () => {
      expect(report.counts.relationsChecked).toBe(4);
      expect(report.counts.columnsChecked).toBeGreaterThan(15);
      expect(report.counts.uniqueDeclarationsChecked).toBe(3);
      expect(report.counts.referentialActionUnknown).toBe(0);
    });

    it('skips models Prisma does not manage, and their relations', () => {
      expect(report.counts.declaredRelations).toBe(6);
      expect(report.counts.relationsSkipped).toBe(2);
      expect(report.skippedModels.map((s) => s.model).sort()).toEqual([
        'LegacyThing',
        'ReportView',
      ]);
      // LegacyThing's table IS in the catalog: @@ignore alone is what skips it.
      expect(report.skippedModels.find((s) => s.model === 'LegacyThing')?.reason).toMatch(
        /@@ignore/
      );
      expect(report.skippedModels.find((s) => s.model === 'ReportView')?.reason).toMatch(
        /not an ordinary table/
      );
    });

    it('matches a composite foreign key on non-id columns', () => {
      // ProjectSlot -> Project(projectId, position). If the differ hardcoded `id`, or
      // matched columns as an unordered set, this pair would not line up.
      expect(ids(report.findings, 'missing-foreign-key')).toEqual([]);
      expect(report.counts.missingForeignKeys).toBe(0);
    });
  });

  describe('drifted catalog', () => {
    const report = compareSchemaToCatalog(schema, loadCatalog('catalog-drifted.json'));

    it('reports the missing foreign key', () => {
      expect(ids(report.findings, 'missing-foreign-key')).toEqual(['Comment.postId']);
      expect(report.counts.missingForeignKeys).toBe(1);
    });

    it('reports a present-but-wrong referential action in both directions', () => {
      expect(ids(report.findings, 'referential-action')).toEqual([
        'Comment.authorId',
        'posts.authorId',
      ]);
      const onDelete = report.findings.find(
        (f) => f.kind === 'referential-action' && f.table === 'posts'
      );
      // The schema writes no onDelete on a REQUIRED relation, so it declares Restrict.
      expect(onDelete?.declared).toContain('ON DELETE Restrict');
      expect(onDelete?.actual).toContain('ON DELETE Cascade');
      expect(onDelete?.detail).toMatch(/required relation to Restrict/);

      const onUpdate = report.findings.find(
        (f) => f.kind === 'referential-action' && f.table === 'Comment'
      );
      expect(onUpdate?.declared).toContain('ON UPDATE Cascade');
      expect(onUpdate?.actual).toContain('ON UPDATE NoAction');
      expect(report.counts.referentialActionDrifts).toBe(2);
    });

    it('does not report an OPTIONAL relation whose database action is SetNull', () => {
      // Comment.author is optional with no onDelete: Prisma declares SetNull, and the
      // drifted catalog has SetNull. A differ that assumed the default were Cascade would
      // raise a finding here.
      const onDeleteMismatch = report.findings.filter(
        (f) => f.kind === 'referential-action' && f.detail?.includes('ON DELETE')
      );
      expect(onDeleteMismatch.map((f) => f.table)).toEqual(['posts']);
    });

    it('reports nullability drift in both directions', () => {
      expect(ids(report.findings, 'nullability')).toEqual(['Author.name', 'posts.title']);
      const optionalButNotNull = report.findings.find(
        (f) => f.kind === 'nullability' && f.table === 'Author'
      );
      expect(optionalButNotNull).toMatchObject({ declared: 'optional', actual: 'NOT NULL' });
      const requiredButNullable = report.findings.find(
        (f) => f.kind === 'nullability' && f.table === 'posts'
      );
      expect(requiredButNullable).toMatchObject({ declared: 'required', actual: 'NULLABLE' });
      expect(report.counts.nullabilityDrifts).toBe(2);
    });

    it('reports the missing unique index', () => {
      expect(ids(report.findings, 'uniqueness')).toEqual(['Project.projectId+position']);
      expect(report.counts.uniquenessDrifts).toBe(1);
    });

    it('finds every seeded defect and nothing else', () => {
      expect(report.findings).toHaveLength(6);
    });
  });

  // The detector has to be watched reporting a defect it was not reporting a moment
  // earlier. Without this, an empty finding list is indistinguishable from a detector
  // wired to nothing.
  describe('negative control: remove one foreign key from an aligned catalog', () => {
    let catalog: DbCatalog;

    beforeEach(() => {
      catalog = loadCatalog('catalog-aligned.json');
    });

    it('is silent before the removal and reports exactly the removed key after', () => {
      const before = compareSchemaToCatalog(schema, catalog);
      expect(ids(before.findings, 'missing-foreign-key')).toEqual([]);

      const removed = catalog.foreignKeys.find(
        (fk) => fk.name === 'ProjectSlot_projectId_position_fkey'
      );
      expect(removed, 'fixture must contain the key this control removes').toBeDefined();
      catalog.foreignKeys = catalog.foreignKeys.filter((fk) => fk !== removed);

      const after = compareSchemaToCatalog(schema, catalog);
      expect(ids(after.findings, 'missing-foreign-key')).toEqual([
        'ProjectSlot.projectId+position',
      ]);
      expect(after.counts.missingForeignKeys).toBe(1);
      // Nothing else moved: the removal is the only difference between the two runs.
      expect(after.counts.relationsChecked).toBe(before.counts.relationsChecked);
      expect(after.counts.nullabilityDrifts).toBe(before.counts.nullabilityDrifts);
    });

    it('reports a foreign key whose columns are in the wrong order', () => {
      // Same two columns, reversed. Postgres treats (position, projectId) as a different
      // constraint from (projectId, position), so an unordered match would call this clean.
      const fk = catalog.foreignKeys.find((f) => f.table === 'ProjectSlot');
      expect(fk).toBeDefined();
      fk!.columns = [...fk!.columns].reverse();

      const after = compareSchemaToCatalog(schema, catalog);
      expect(ids(after.findings, 'missing-foreign-key')).toEqual([
        'ProjectSlot.projectId+position',
      ]);
    });

    it('reports a unique index that became partial (dropped upstream by the catalog read)', () => {
      catalog.uniqueIndexes = catalog.uniqueIndexes.filter(
        (u) => !(u.table === 'Author' && u.columns[0] === 'email')
      );
      const after = compareSchemaToCatalog(schema, catalog);
      expect(ids(after.findings, 'uniqueness')).toEqual(['Author.email']);
    });

    it('reports a column that flipped nullability', () => {
      const column = catalog.columns.find((c) => c.table === 'posts' && c.column === 'archived');
      expect(column).toBeDefined();
      column!.notNull = true;
      const after = compareSchemaToCatalog(schema, catalog);
      expect(ids(after.findings, 'nullability')).toEqual(['posts.archived']);
    });
  });

  describe('catalog with no referential-action data', () => {
    it('skips the action check rather than guessing, and says how many it skipped', () => {
      const catalog = loadCatalog('catalog-aligned.json');
      for (const fk of catalog.foreignKeys) {
        fk.onDelete = null;
        fk.onUpdate = null;
      }
      const report = compareSchemaToCatalog(schema, catalog);
      expect(report.counts.referentialActionDrifts).toBe(0);
      expect(report.counts.referentialActionUnknown).toBe(4);
      expect(report.findings).toEqual([]);
    });
  });
});

describe('assertCatalogSanity', () => {
  function columns(count: number, notNull: (i: number) => boolean) {
    return Array.from({ length: count }, (_, i) => ({
      table: 't',
      column: `c${i}`,
      notNull: notNull(i),
    }));
  }

  const base: Omit<DbCatalog, 'columns'> = {
    tables: ['t'],
    foreignKeys: [],
    uniqueIndexes: [],
  };

  it('accepts a catalog with a mix of nullable and non-nullable columns', () => {
    expect(() =>
      assertCatalogSanity({ ...base, columns: columns(100, (i) => i % 2 === 0) })
    ).not.toThrow();
  });

  // This is the shape a `SELECT a.attnotnull notnull` read produces: NOTNULL is a reserved
  // word, the expression parses as the postfix IS NOT NULL operator, and every row comes
  // back true. It fabricated 626 one-directional findings before it was caught.
  it('rejects a catalog where every column reads NOT NULL', () => {
    expect(() => assertCatalogSanity({ ...base, columns: columns(100, () => true) })).toThrow(
      /Catalog read looks broken/
    );
  });

  it('rejects a catalog where every column reads nullable', () => {
    expect(() => assertCatalogSanity({ ...base, columns: columns(100, () => false) })).toThrow(
      /Catalog read looks broken/
    );
  });

  it('stays quiet on a catalog too small to conclude anything from', () => {
    expect(() => assertCatalogSanity({ ...base, columns: columns(3, () => true) })).not.toThrow();
  });
});

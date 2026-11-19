import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assessCoverage, compareSchemaToCatalog } from '../compare';
import { extractMigrationTables } from '../migration-tables';
import { parsePrismaSchema } from '../parse-prisma-schema';
import { buildScope, comparedTables, formatScope, verifyScope } from '../scope';
import type { DbCatalog, DriftFinding, ParsedSchema } from '../types';

const here = fileURLToPath(new URL('.', import.meta.url));

function loadCatalog(name: string): DbCatalog {
  return JSON.parse(readFileSync(join(here, `fixtures/${name}`), 'utf8')) as DbCatalog;
}

const schema: ParsedSchema = parsePrismaSchema(
  readFileSync(join(here, 'fixtures/fixture.prisma'), 'utf8')
);

/**
 * `catalog-drifted.json` seeds drift on FOUR tables — `Comment` (a missing foreign key and an
 * ON UPDATE mismatch), `posts` (an ON DELETE mismatch, a nullability flip, a missing column),
 * `Author` (a nullability flip) and `Project` (a missing unique index). That is what makes it
 * the right fixture for scoping: there is drift both INSIDE and OUTSIDE any one-table scope,
 * so "included" and "excluded" are both observable rather than one of them being vacuous.
 */
const drifted = loadCatalog('catalog-drifted.json');

function ids(findings: DriftFinding[]): string[] {
  return findings.map((f) => `${f.kind} ${f.table}.${f.columns.join('+')}`).sort();
}

describe('compareSchemaToCatalog with a table scope', () => {
  const unscoped = compareSchemaToCatalog(schema, drifted);
  const scoped = compareSchemaToCatalog(schema, drifted, { tables: new Set(['Comment']) });

  // Positive control on every exclusion assertion below. If the fixture had no drift outside
  // `Comment`, "excludes the other tables" would pass with the filter deleted.
  it('the unscoped run has drift on tables outside the scope (control)', () => {
    const outside = unscoped.findings.filter((f) => f.table !== 'Comment');
    expect(new Set(outside.map((f) => f.table))).toEqual(new Set(['posts', 'Author', 'Project']));
  });

  // Pinned as a literal, not derived from the unscoped run. Kills a filter that DROPS
  // EVERYTHING (this list would be empty) and one that is a NO-OP (it would carry the
  // `posts`, `Author` and `Project` findings too).
  it('includes exactly the requested table’s findings', () => {
    expect(ids(scoped.findings)).toEqual([
      'missing-foreign-key Comment.postId',
      'referential-action Comment.authorId',
    ]);
  });

  it('excludes every finding on an unrelated table', () => {
    expect(scoped.findings.filter((f) => f.table !== 'Comment')).toEqual([]);
  });

  // The counters must describe the scope too, or a scoped report carries the whole schema's
  // coverage as its positive control. `Comment` has two owning relations and four scalar columns.
  it('counts only what it checked inside the scope', () => {
    expect(scoped.counts.declaredRelations).toBe(2);
    expect(scoped.counts.relationsChecked).toBe(2);
    expect(scoped.counts.columnsChecked).toBe(4);
    expect(unscoped.counts.relationsChecked).toBeGreaterThan(scoped.counts.relationsChecked);
    expect(scoped.skippedModels).toEqual([]);
    expect(assessCoverage(scoped)).toEqual([]);
  });

  // The documented rule: a finding belongs to the table it is ON — for a foreign key, the
  // REFERENCING table. `Comment.authorId` and `posts.authorId` both reference `Author` and both
  // carry drift, and neither is in an `Author`-scoped report.
  it('attributes a foreign-key finding to the referencing table, not the referenced one', () => {
    const author = compareSchemaToCatalog(schema, drifted, { tables: new Set(['Author']) });
    expect(ids(author.findings)).toEqual(['nullability Author.name']);
    // and the two it excluded really are relations onto Author with drift (control)
    expect(
      unscoped.findings
        .filter((f) => f.kind === 'referential-action' && f.detail?.includes('authorId'))
        .map((f) => f.table)
        .sort()
    ).toEqual(['Comment', 'posts']);
  });

  it('still names a relation’s referenced table when that table is out of scope', () => {
    const missing = scoped.findings.find((f) => f.kind === 'missing-foreign-key');
    expect(missing?.declared).toMatch(/^FOREIGN KEY -> posts\(id\)/);
  });

  it('a scope that names two tables reports both, and only both', () => {
    const two = compareSchemaToCatalog(schema, drifted, {
      tables: new Set(['Comment', 'Project']),
    });
    expect(ids(two.findings)).toEqual([
      'missing-foreign-key Comment.postId',
      'referential-action Comment.authorId',
      'uniqueness Project.projectId+position',
    ]);
  });
});

describe('verifyScope', () => {
  const scopeOf = (tables: string[], sql?: string) =>
    buildScope({
      tables,
      migrations: sql ? [{ path: 'm.sql', result: extractMigrationTables(sql) }] : [],
      allowUnparsed: false,
    });

  it('accepts tables both the schema and the catalog have', () => {
    expect(verifyScope(scopeOf(['Comment', 'posts']), schema, drifted)).toEqual([]);
  });

  // The failure a filter alone would have: a name matching no model filters everything out and
  // prints a clean report.
  it('rejects a table no model maps to', () => {
    const problems = verifyScope(scopeOf(['Nope']), schema, drifted);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/"Nope" is in the scope but no model in the schema maps to it/);
    expect(problems[1]).toMatch(/"Nope" .*not an ordinary table in this catalog/);
  });

  it('rejects the Prisma model NAME when the table is mapped to another name', () => {
    // `Post` is @@map("posts"). Scopes name TABLES, as the catalog does.
    expect(verifyScope(scopeOf(['Post']), schema, drifted)[0]).toMatch(/no model .* maps to it/);
  });

  it('rejects a table the schema declares but the catalog does not have (a view)', () => {
    const problems = verifyScope(scopeOf(['report_view']), schema, drifted);
    expect(problems).toEqual([expect.stringMatching(/"report_view" .*not an ordinary table/)]);
  });

  it('rejects a table whose model carries @@ignore', () => {
    expect(verifyScope(scopeOf(['LegacyThing']), schema, drifted)).toEqual([
      expect.stringMatching(/carries @@ignore/),
    ]);
  });

  it('rejects an empty scope', () => {
    expect(verifyScope(scopeOf([], 'ALTER TYPE "X" ADD VALUE \'Y\';'), schema, drifted)).toEqual([
      expect.stringMatching(/the scope is empty/),
    ]);
  });

  it('checks a dropped table is absent from both sides', () => {
    // Dropped in the migration but still in the catalog and the schema: not applied.
    const stillThere = verifyScope(scopeOf([], 'DROP TABLE "Comment";'), schema, drifted);
    expect(stillThere).toEqual([
      expect.stringMatching(/"Comment" is dropped .* still in this catalog/),
      expect.stringMatching(/"Comment" is dropped .* the schema still declares it/),
    ]);
    // Genuinely gone: no problem, and nothing to compare.
    const gone = scopeOf([], 'DROP TABLE IF EXISTS "OldThing";');
    expect(verifyScope(gone, schema, drifted)).toEqual([]);
    expect(comparedTables(gone).size).toBe(0);
  });
});

describe('buildScope', () => {
  it('records where every table came from, and --tables wins over a drop', () => {
    const scope = buildScope({
      tables: ['Author', 'Gone'],
      migrations: [
        {
          path: 'prisma/migrations/x/migration.sql',
          result: extractMigrationTables(
            'CREATE INDEX "i" ON "Comment" ("text"); DROP TABLE "Gone"; ' +
              'ALTER TABLE "Comment" ADD CONSTRAINT "c" FOREIGN KEY ("postId") REFERENCES "posts"("id");'
          ),
        },
      ],
      allowUnparsed: false,
    });
    expect(scope.tables.map((t) => [t.table, t.expect])).toEqual([
      ['Author', 'present'],
      ['Comment', 'present'],
      ['Gone', 'present'],
      ['posts', 'present'],
    ]);
    const comment = scope.tables.find((t) => t.table === 'Comment');
    expect(comment?.origins).toEqual([
      {
        kind: 'migration',
        path: 'prisma/migrations/x/migration.sql',
        via: ['CREATE INDEX', 'ALTER TABLE'],
        action: 'present',
      },
    ]);
    expect(scope.tables.find((t) => t.table === 'Gone')?.origins.map((o) => o.kind)).toEqual([
      'migration',
      'flag',
    ]);
  });

  it('prints the exact table set and each table’s source in the header', () => {
    const scope = buildScope({
      tables: ['Author'],
      migrations: [
        {
          path: 'm.sql',
          result: extractMigrationTables('CREATE INDEX "i" ON "Comment" ("text");'),
        },
      ],
      allowUnparsed: false,
    });
    const header = formatScope(scope);
    expect(header).toMatch(
      /^Scope: 2 table\(s\) compared — findings on every other table are EXCLUDED/
    );
    expect(header).toMatch(/ {2}Author {3}<- --tables\n/);
    expect(header).toMatch(/ {2}Comment {2}<- m\.sql \(CREATE INDEX\)\n/);
    expect(header).toMatch(
      /m\.sql: 1 statement\(s\) — 1 read for tables, 0 touch no table, 0 NOT CLASSIFIED/
    );
  });
});

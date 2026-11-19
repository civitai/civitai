import { readFileSync } from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { importersOf, srcImports } from './import-ledger';

/**
 * Who may decide a collection read, and who may read the per-source import grants it rests on.
 * The decision is one predicate (`data-read-grant.ts`); a second module reading the grant row
 * would be a second statement of the rule, free to disagree with the first. These cases parse
 * every import in src and fail when either set GROWS or SHRINKS.
 */

const GRANT_SERVICE = 'server/services/apps/storage-import-grant.service';
const ROUTER = 'server/routers/blocks.router.ts';
/** The one router procedure allowed to read the grant rule: the consent listing the UI shows. */
const LISTING_PROCEDURE = 'getStorageImports';

describe('the collection-read predicate and the import grants it reads', () => {
  it('decideCollectionRead is imported by the document-store resolver only', () => {
    expect(importersOf('server/services/apps/data-read-grant', 'decideCollectionRead')).toEqual([
      'server/services/apps/doc-store-access.ts',
    ]);
  });

  it('no production module builds its own predicate (with its own run gate)', () => {
    expect(
      importersOf('server/services/apps/data-read-grant', 'createCollectionReadDecider')
    ).toEqual([]);
  });

  it('getStorageImportGrant is imported by the predicate and the router only', () => {
    expect(importersOf(GRANT_SERVICE, 'getStorageImportGrant')).toEqual([
      ROUTER,
      'server/services/apps/data-read-grant.ts',
    ]);
  });

  it('importGrantCovers is imported by the predicate and the router only', () => {
    expect(importersOf(GRANT_SERVICE, 'importGrantCovers')).toEqual([
      ROUTER,
      'server/services/apps/data-read-grant.ts',
    ]);
  });

  it(`the router uses the grant rule in ${LISTING_PROCEDURE} only, and never reads one grant row`, () => {
    // The router imports the service with `import()`, which the import ledger counts as every
    // name: so where the router USES each name is pinned here, by AST identifier.
    const file = path.resolve(__dirname, '../../../..', ROUTER);
    const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    // Each use, as the chain of named properties it sits in (the router's procedures are
    // properties of the object passed to `router`).
    const uses: Record<string, string[][]> = { importGrantCovers: [], getStorageImportGrant: [] };
    const visit = (node: ts.Node, chain: string[]) => {
      const inside =
        ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)
          ? [...chain, node.name.text]
          : chain;
      if (ts.isIdentifier(node) && node.text in uses) uses[node.text].push(chain);
      ts.forEachChild(node, (child) => visit(child, inside));
    };
    visit(src, []);
    // The destructuring from `import()` and the call: both inside the listing procedure.
    expect(uses.importGrantCovers.length).toBeGreaterThanOrEqual(2);
    expect(
      uses.importGrantCovers.filter((chain) => !chain.includes(LISTING_PROCEDURE)),
      `importGrantCovers used in blocks.router.ts outside ${LISTING_PROCEDURE}`
    ).toEqual([]);
    expect(uses.getStorageImportGrant).toEqual([]);
  });

  it('POSITIVE CONTROL: the ledger sees the router import the grant service', () => {
    // A green set above must not be a parser that found nothing.
    expect(srcImports().length).toBeGreaterThan(1000);
    expect(
      srcImports().some((u) => u.file === ROUTER && u.module === GRANT_SERVICE && u.names === 'all')
    ).toBe(true);
  });
});

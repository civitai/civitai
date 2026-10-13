import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { BLOCK_TOKEN_QUERY_PROCEDURES } from '~/shared/constants/block-token-transport.constants';

/**
 * `BLOCK_TOKEN_QUERY_PROCEDURES` drives three things — POST-only routing in the browser link, a
 * forced `no-store` on the server, and the GET counter — so a token-bearing query missing from
 * it silently gets none of them. This derives the population from the routers and compares it to
 * the constant AS A SET, failing in both directions: a new token-bearing query must be added, and
 * an entry whose procedure moved, was renamed or became a mutation must be removed.
 *
 * The population: every `.query(` in `src/server/routers/**` whose builder chain has an
 * `.input(…)` carrying a `blockToken` field — written inline, or through a schema identifier
 * declared in the same file whose initializer carries it (followed transitively).
 *
 * LIMITS, stated because they are open:
 *   - A token-carrying schema IMPORTED from another module is not followed. Every token schema
 *     today is file-local (`blockTokenInput`) or inline.
 *   - The field must be spelled `blockToken` — the repo-wide convention for block tokens.
 *   - Router variable → path prefix is the `ROUTER_PREFIXES` table below, not derived from
 *     `src/server/routers/index.ts`. A token-bearing query under a router variable missing from
 *     the table fails the test rather than being skipped.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROUTERS_DIR = path.join(REPO_ROOT, 'src/server/routers');

/** Router variable → its tRPC path prefix (`appRouter` key, plus sub-router key). */
const ROUTER_PREFIXES: Record<string, string> = {
  appsStorageRouter: 'apps.storage',
  appsSharedRouter: 'apps.shared',
  blocksRouter: 'blocks',
};

type Found = { router: string; proc: string; file: string };

/** Derive the token-bearing queries in one source text (driven directly by the controls below). */
function deriveTokenQueries(fileName: string, text: string): Found[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);

  // Same-file `const|let|var` declarations, by name → initializer node.
  const decls = new Map<string, ts.Node>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      decls.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const carriesToken = (node: ts.Node, seen: Set<string>): boolean => {
    let hit = false;
    const visit = (n: ts.Node) => {
      if (hit) return;
      if (
        (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
        ts.isIdentifier(n.name) &&
        n.name.text === 'blockToken'
      ) {
        hit = true;
        return;
      }
      if (ts.isIdentifier(n) && decls.has(n.text) && !seen.has(n.text)) {
        seen.add(n.text);
        if (carriesToken(decls.get(n.text)!, seen)) {
          hit = true;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return hit;
  };

  const found: Found[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'query'
    ) {
      // Walk the builder chain below `.query(` for `.input(arg)` calls.
      let receiver: ts.Expression = node.expression.expression;
      let tokenInput = false;
      while (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
        if (receiver.expression.name.text === 'input' && receiver.arguments[0]) {
          if (carriesToken(receiver.arguments[0], new Set())) tokenInput = true;
        }
        receiver = receiver.expression.expression;
      }
      if (tokenInput) {
        const prop = node.parent;
        const obj = prop?.parent;
        const routerCall = obj?.parent;
        const decl = routerCall?.parent;
        expect(
          prop && ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name),
          `${fileName}: a token-bearing .query( is not a named router property`
        ).toBe(true);
        expect(
          decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name),
          `${fileName}: a token-bearing .query( is not inside \`const X = router({…})\``
        ).toBe(true);
        found.push({
          router: ((decl as ts.VariableDeclaration).name as ts.Identifier).text,
          proc: ((prop as ts.PropertyAssignment).name as ts.Identifier).text,
          file: fileName,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function routerFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routerFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('BLOCK_TOKEN_QUERY_PROCEDURES matches the routers', () => {
  const files = routerFiles(ROUTERS_DIR);
  const found = files.flatMap((file) =>
    deriveTokenQueries(path.relative(REPO_ROOT, file), fs.readFileSync(file, 'utf8'))
  );

  it('reads the routers at all (positive control on the file walk)', () => {
    // 100+ router files today; a broken walk reads zero and every set comparison below would
    // then be about an empty population.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('blocks.router.ts'))).toBe(true);
  });

  it('every token-bearing query sits under a router with a known path prefix', () => {
    const unmapped = found.filter((f) => !(f.router in ROUTER_PREFIXES));
    expect(unmapped).toEqual([]);
  });

  it('the derived population equals the constant, in both directions', () => {
    const derived = new Set(found.map((f) => `${ROUTER_PREFIXES[f.router]}.${f.proc}`));
    expect([...derived].sort()).toEqual([...BLOCK_TOKEN_QUERY_PROCEDURES].sort());
  });

  // ── Controls on the derivation itself ────────────────────────────────────────────────────

  it('CONTROL: finds an inline token, a same-file schema, and a transitive schema', () => {
    const src = `
      const base = z.object({ blockToken: z.string() });
      const derivedSchema = base.extend({ key: z.string() });
      export const blocksRouter = router({
        inline: publicProcedure.input(z.object({ blockToken: z.string() })).query(() => 1),
        viaSchema: publicProcedure.input(base.merge(other)).query(() => 1),
        transitive: publicProcedure.use(mw).input(derivedSchema).query(() => 1),
        noToken: publicProcedure.input(z.object({ id: z.number() })).query(() => 1),
        mutation: publicProcedure.input(base).mutation(() => 1),
      });`;
    expect(deriveTokenQueries('fixture.ts', src).map((f) => f.proc)).toEqual([
      'inline',
      'viaSchema',
      'transitive',
    ]);
  });

  it('CONTROL: a token-bearing query under an unknown router is reported, not dropped', () => {
    const src = `export const someNewRouter = router({
      read: publicProcedure.input(z.object({ blockToken: z.string() })).query(() => 1),
    });`;
    expect(deriveTokenQueries('fixture.ts', src)).toEqual([
      { router: 'someNewRouter', proc: 'read', file: 'fixture.ts' },
    ]);
  });
});

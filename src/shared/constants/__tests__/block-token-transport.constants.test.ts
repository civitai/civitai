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
 * `.input(…)` carrying a `blockToken` field — written inline, or through a schema identifier,
 * followed transitively through same-file declarations AND named imports from repo modules
 * (`~/…` or relative). Several token schemas already live outside the routers (e.g.
 * `buzz.schema.ts`); they feed mutations today, and following imports is what makes a future
 * `.query(` built on one of them visible here. A builder chain that starts at a pre-built
 * procedure constant (`const p = publicProcedure.input(schema)`; `x: p.query(…)`) is followed
 * into that constant's initializer too.
 *
 * Fail-closed where the walk cannot read THE SCHEMA ITSELF: if an identifier that is the `.input`
 * argument's own schema (see `schemaRootIdentifiers`) is imported from a repo module whose
 * declaration cannot be found (a re-export, a `function`, a default or namespace import), it is
 * reported in `unresolved` and fails the test, rather than being scored as carrying no token.
 *
 * LIMITS, stated because they are open:
 *   - The field must be spelled `blockToken` — the repo-wide convention for block tokens.
 *   - Imports from packages (`zod`, `@civitai/…`) are not followed.
 *   - Identifiers NESTED inside a schema (a field's helper, an enum) are followed best-effort: one
 *     that does not resolve is skipped silently. A `blockToken` field reached only through such a
 *     helper would be missed.
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
type ModuleInfo = {
  sf: ts.SourceFile;
  decls: Map<string, ts.Node>;
  imports: Map<string, { specifier: string; imported: string }>;
};

/** Resolve a repo-module specifier (`~/…` or relative) to a file, or null for a package. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('~/')) base = path.join(REPO_ROOT, 'src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return base; // unresolvable repo module: the caller reports it
}

function parseModule(fileName: string, text: string): ModuleInfo {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const decls = new Map<string, ts.Node>();
  const imports = new Map<string, { specifier: string; imported: string }>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      decls.set(node.name.text, node.initializer);
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const el of node.importClause.namedBindings.elements) {
        imports.set(el.name.text, {
          specifier: node.moduleSpecifier.text,
          imported: (el.propertyName ?? el.name).text,
        });
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  return { sf, decls, imports };
}

const moduleCache = new Map<string, ModuleInfo | null>();
function loadModule(file: string): ModuleInfo | null {
  if (!moduleCache.has(file)) {
    moduleCache.set(
      file,
      fs.existsSync(file) ? parseModule(file, fs.readFileSync(file, 'utf8')) : null
    );
  }
  return moduleCache.get(file) ?? null;
}

/**
 * The identifiers that ARE the schema passed to `.input(…)`: the root of its method chain
 * (`base` in `base.extend({…})`) plus bare identifier arguments to that chain's calls (`other` in
 * `base.merge(other)`). These must resolve; identifiers nested deeper (enum values, helpers inside
 * field definitions) are followed best-effort only, because the transitive graph reaches far
 * outside schema code and most of it is not declared as a `const`.
 */
function schemaRootIdentifiers(expr: ts.Expression): string[] {
  const ids: string[] = [];
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(cur)) {
      for (const a of cur.arguments) if (ts.isIdentifier(a)) ids.push(a.text);
      cur = cur.expression;
    } else if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    } else {
      if (ts.isIdentifier(cur)) ids.push(cur.text);
      return ids;
    }
  }
}

/** Derive the token-bearing queries in one source text (driven directly by the controls below). */
function deriveTokenQueries(
  fileName: string,
  text: string
): { found: Found[]; unresolved: string[] } {
  const root = parseModule(path.resolve(REPO_ROOT, fileName), text);
  const unresolved: string[] = [];

  /** Look an identifier up in `mod`: same-file declaration, else a followed named import. */
  const lookup = (
    mod: ModuleInfo,
    name: string,
    report = false
  ): { mod: ModuleInfo; node: ts.Node } | null => {
    const local = mod.decls.get(name);
    if (local) return { mod, node: local };
    const imp = mod.imports.get(name);
    if (!imp) return null;
    const file = resolveSpecifier(mod.sf.fileName, imp.specifier);
    if (file === null) return null; // a package import
    const target = loadModule(file);
    const node = target?.decls.get(imp.imported);
    if (!target || !node) {
      if (report)
        unresolved.push(
          `${path.relative(REPO_ROOT, mod.sf.fileName)}: ${name} from ${imp.specifier}`
        );
      return null;
    }
    return { mod: target, node };
  };

  const carriesToken = (node: ts.Node, mod: ModuleInfo, seen: Set<string>): boolean => {
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
      // An identifier that is a member NAME (`z.string`, `.merge`) names no declaration.
      const isMemberName =
        ts.isIdentifier(n) && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n;
      if (ts.isIdentifier(n) && !isMemberName) {
        const key = `${mod.sf.fileName}#${n.text}`;
        if (!seen.has(key)) {
          seen.add(key);
          const target = lookup(mod, n.text);
          if (target && carriesToken(target.node, target.mod, seen)) {
            hit = true;
            return;
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return hit;
  };

  /** Whether a builder chain (the receiver of `.query`) has an `.input(…)` carrying a token. */
  const chainHasTokenInput = (start: ts.Expression, mod: ModuleInfo, seen: Set<string>) => {
    let receiver: ts.Expression = start;
    for (;;) {
      if (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
        if (receiver.expression.name.text === 'input' && receiver.arguments[0]) {
          const arg = receiver.arguments[0];
          // The schema's own identifiers must resolve (fail-closed); deeper ones are best-effort.
          for (const id of schemaRootIdentifiers(arg)) lookup(mod, id, true);
          if (carriesToken(arg, mod, new Set())) return true;
        }
        receiver = receiver.expression.expression;
        continue;
      }
      // A pre-built procedure constant: follow it into its initializer.
      if (ts.isIdentifier(receiver)) {
        const key = `${mod.sf.fileName}#chain:${receiver.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        const target = lookup(mod, receiver.text);
        if (target && ts.isExpression(target.node)) {
          return chainHasTokenInput(target.node as ts.Expression, target.mod, seen);
        }
      }
      return false;
    }
  };

  const found: Found[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'query' &&
      chainHasTokenInput(node.expression.expression, root, new Set())
    ) {
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
    ts.forEachChild(node, visit);
  };
  visit(root.sf);
  return { found, unresolved };
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
  const results = files.map((file) =>
    deriveTokenQueries(path.relative(REPO_ROOT, file), fs.readFileSync(file, 'utf8'))
  );
  const found = results.flatMap((r) => r.found);
  const unresolved = results.flatMap((r) => r.unresolved);

  it('reads the routers at all (positive control on the file walk)', () => {
    // 100+ router files today; a broken walk reads zero and every set comparison below would
    // then be about an empty population.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('blocks.router.ts'))).toBe(true);
  });

  it('every imported identifier the walk reaches resolves (unreadable is not "no token")', () => {
    expect([...new Set(unresolved)].sort()).toEqual([]);
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
    const { found: f, unresolved: u } = deriveTokenQueries('src/server/routers/fixture.ts', src);
    expect(f.map((x) => x.proc)).toEqual(['inline', 'viaSchema', 'transitive']);
    expect(u).toEqual([]);
  });

  it('CONTROL: follows a token schema IMPORTED from another repo module', () => {
    // A real token schema that lives outside the routers (it feeds a mutation in production).
    const src = `
      import { getMyBuzzAccountsInput, getMyBuzzTransactionsInput as renamed } from '~/server/schema/buzz.schema';
      export const blocksRouter = router({
        imported: publicProcedure.input(getMyBuzzAccountsInput).query(() => 1),
        importedRenamed: publicProcedure.input(renamed.extend({})).query(() => 1),
      });`;
    const { found: f } = deriveTokenQueries('src/server/routers/fixture.ts', src);
    expect(f.map((x) => x.proc)).toEqual(['imported', 'importedRenamed']);
  });

  it('CONTROL: follows a pre-built procedure constant into its .input(…)', () => {
    const src = `
      const tokenProc = publicProcedure.input(z.object({ blockToken: z.string() }));
      export const blocksRouter = router({
        prebuilt: tokenProc.query(() => 1),
        prebuiltChained: tokenProc.use(mw).query(() => 1),
      });`;
    const { found: f } = deriveTokenQueries('src/server/routers/fixture.ts', src);
    expect(f.map((x) => x.proc)).toEqual(['prebuilt', 'prebuiltChained']);
  });

  it('CONTROL: an import from a repo module the walk cannot read is reported, not dropped', () => {
    const src = `
      import { notDeclaredThere } from '~/server/schema/buzz.schema';
      export const blocksRouter = router({
        read: publicProcedure.input(notDeclaredThere).query(() => 1),
      });`;
    const { unresolved: u } = deriveTokenQueries('src/server/routers/fixture.ts', src);
    expect(u).toEqual([
      'src/server/routers/fixture.ts: notDeclaredThere from ~/server/schema/buzz.schema',
    ]);
  });

  it('CONTROL: a token-bearing query under an unknown router is reported, not dropped', () => {
    const src = `export const someNewRouter = router({
      read: publicProcedure.input(z.object({ blockToken: z.string() })).query(() => 1),
    });`;
    expect(deriveTokenQueries('src/server/routers/fixture.ts', src).found).toEqual([
      { router: 'someNewRouter', proc: 'read', file: 'src/server/routers/fixture.ts' },
    ]);
  });
});

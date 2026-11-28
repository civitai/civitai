import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every block REST route under `src/pages/api/v1/blocks` passes `allowOpaqueOrigin: true` to
 * `withBlockScope`, unless it is listed in `EXEMPT` with the reason it must refuse an opaque
 * origin.
 *
 * The bug this pins: unverified App Blocks run in an iframe sandboxed without
 * `allow-same-origin`, so every `fetch` they make sends `Origin: null`. A route without the
 * opt-in answers that caller with no CORS headers (the preflight falls through to the handler and
 * 405s), so the browser throws `TypeError: Failed to fetch` in the frame. `blocks/me` shipped
 * without it while every sibling had it, so `app.site.get('blocks/me')` failed for every
 * unverified app and every App Assistant preview ("Couldn't load your Civitai avatar"). The
 * endpoint tests replace `withBlockScope` with a passthrough, so no behaviour test can see a
 * route that forgot the option; this reads the option off each route's syntax tree instead.
 *
 * The opt-in is safe only where the Bearer block JWT is the sole credential (see
 * `WithBlockScopeOpts.allowOpaqueOrigin`). A route that authorizes with an ambient cookie must
 * not take it: list it in `EXEMPT` and say so.
 */
const EXEMPT: Record<string, string> = {};

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BLOCKS_DIR = path.join(REPO_ROOT, 'src/pages/api/v1/blocks');
const WRAPPER = 'withBlockScope';
const WRAPPER_MODULE = '~/server/middleware/block-scope.middleware';

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * What `source` does with the wrapper: `null` when it never imports it, otherwise one verdict
 * per call (`'opaque-ok'` or why not). A file that imports the wrapper and never calls it gets a
 * single `'imported but never called'` verdict, so a call shape this parser misses fails loudly
 * instead of dropping the route from the ledger.
 */
function wrapperCallVerdicts(fileName: string, source: string): string[] | null {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const localNames = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (statement.moduleSpecifier.text !== WRAPPER_MODULE) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === WRAPPER)
        localNames.add(element.name.text);
    }
  }
  if (localNames.size === 0) return null;

  const verdicts: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      localNames.has(node.expression.text)
    ) {
      verdicts.push(optionsVerdict(node.arguments[1]));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return verdicts.length > 0 ? verdicts : ['imported but never called'];
}

function optionsVerdict(options: ts.Expression | undefined): string {
  if (!options) return 'no options argument';
  if (!ts.isObjectLiteralExpression(options)) return 'options are not an object literal';
  const prop = options.properties.find(
    (p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'allowOpaqueOrigin'
  );
  if (!prop) return 'no allowOpaqueOrigin';
  if (!ts.isPropertyAssignment(prop) || prop.initializer.kind !== ts.SyntaxKind.TrueKeyword) {
    return 'allowOpaqueOrigin is not the literal true';
  }
  return 'opaque-ok';
}

describe('wrapperCallVerdicts', () => {
  const imp = `import { withBlockScope } from '${WRAPPER_MODULE}';\n`;
  const classify = (source: string) => wrapperCallVerdicts('route.ts', source);

  it('accepts a call that opts in', () => {
    expect(
      classify(
        `${imp}export default withBlockScope(h, { endpoint: 'me', allowOpaqueOrigin: true });`
      )
    ).toEqual(['opaque-ok']);
  });

  it('follows an aliased import', () => {
    expect(
      classify(
        `import { withBlockScope as wrap } from '${WRAPPER_MODULE}';\nexport default wrap(h, { allowOpaqueOrigin: true });`
      )
    ).toEqual(['opaque-ok']);
  });

  it.each([
    [
      'a call without the option (blocks/me before the fix)',
      `${imp}export default withBlockScope(h, { endpoint: 'me', requiredScope: 'user:read:self' });`,
      ['no allowOpaqueOrigin'],
    ],
    [
      'the option set false',
      `${imp}export default withBlockScope(h, { allowOpaqueOrigin: false });`,
      ['allowOpaqueOrigin is not the literal true'],
    ],
    [
      'a shorthand property',
      `${imp}const allowOpaqueOrigin = true;\nexport default withBlockScope(h, { allowOpaqueOrigin });`,
      ['allowOpaqueOrigin is not the literal true'],
    ],
    [
      'options through a variable',
      `${imp}const o = { allowOpaqueOrigin: true };\nexport default withBlockScope(h, o);`,
      ['options are not an object literal'],
    ],
    ['no options argument', `${imp}export default withBlockScope(h);`, ['no options argument']],
    ['an import that is never called', `${imp}export default h;`, ['imported but never called']],
    [
      'one good and one bad call in a file',
      `${imp}export const a = withBlockScope(h, { allowOpaqueOrigin: true });\nexport default withBlockScope(h, {});`,
      ['opaque-ok', 'no allowOpaqueOrigin'],
    ],
  ])('reports %s', (_label, source, expected) => {
    expect(classify(source)).toEqual(expected);
  });

  it('ignores a file that does not import the wrapper', () => {
    expect(classify(`// withBlockScope(h, {})\nexport default h;`)).toBeNull();
  });
});

describe('block REST routes under /api/v1/blocks', () => {
  const routes = routeFiles(BLOCKS_DIR)
    .map((file) => ({
      route: path
        .relative(BLOCKS_DIR, file)
        .replace(/\\/g, '/')
        .replace(/\.tsx?$/, ''),
      verdicts: wrapperCallVerdicts(file, fs.readFileSync(file, 'utf8')),
    }))
    .filter((r): r is { route: string; verdicts: string[] } => r.verdicts !== null);

  // An empty or narrowed walk would pass the ledger below with nothing in it.
  it('finds the wrapped routes', () => {
    expect(routes.length).toBeGreaterThan(30);
    const names = routes.map((r) => r.route);
    expect(names).toContain('me');
    expect(names).toContain('models');
  });

  it('all opt into allowOpaqueOrigin, except the listed exemptions', () => {
    const refusing = routes
      .filter((r) => !(r.route in EXEMPT) && r.verdicts.some((v) => v !== 'opaque-ok'))
      .map((r) => `${r.route}: ${r.verdicts.filter((v) => v !== 'opaque-ok').join(', ')}`)
      .sort();
    expect(refusing).toEqual([]);
  });

  it('lists only exemptions that are wrapped routes still without the option', () => {
    const stale = Object.keys(EXEMPT).filter((route) => {
      const found = routes.find((r) => r.route === route);
      return !found || found.verdicts.every((v) => v === 'opaque-ok');
    });
    expect(stale).toEqual([]);
  });
});

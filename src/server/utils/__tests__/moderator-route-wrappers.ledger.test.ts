import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every route under `src/pages/api/mod` must default-export a call to one of the wrappers below,
 * imported from the module that defines it. `ModEndpoint` and `defineModeratorEndpoint` apply the
 * moderator credential rule (pinned in
 * `src/server/__tests__/moderator-rest-wrappers.credential-requirements.test.ts`);
 * `WebhookEndpoint` takes the service token instead of a user credential, so its routes are
 * listed by name.
 */
const WRAPPERS: Record<string, string> = {
  ModEndpoint: '~/server/utils/endpoint-helpers',
  WebhookEndpoint: '~/server/utils/endpoint-helpers',
  defineModeratorEndpoint: '~/server/utils/moderator-endpoint',
};

const WEBHOOK_ROUTES = [
  'action-report',
  'adjust-tag-level',
  'ban-user',
  'custom-challenge',
  'daily-challenge/backfill-theme-elements',
  'daily-challenge/cycle',
  'daily-challenge/re-review',
  'enable-stripe-connect',
  'enable-tipalti',
  'flip-phases',
  'mark-poi-images-search',
  'mod-rules',
  'mute-user-pending-review',
  'new-order/manage-queue',
  'overturn-user-mute',
  'remove-all-content',
  'remove-images',
  'remove-placement',
  'reprocess-buzz-purchases',
  'reset-bank',
  'reset-user-subscription-caches',
  'restore-images',
  'send-mod-notification',
  'set-rewards-eligibility',
  'update-image-flag',
  'withdraw-from-bank',
];

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MOD_ROUTES = path.join(REPO_ROOT, 'src/pages/api/mod');

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** The wrapper a route's default export calls, or a description of what it exports instead. */
function defaultExportWrapper(fileName: string, source: string): string {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  const imported = new Map<string, string>();
  let exported: ts.Expression | undefined;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          // Keyed by the local name, valued by the exported one, so an alias cannot pose as a wrapper.
          imported.set(
            element.name.text,
            `${(element.propertyName ?? element.name).text}@${statement.moduleSpecifier.text}`
          );
        }
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      exported = statement.expression;
    }
  }

  if (!exported) return 'no default export assignment';
  if (!ts.isCallExpression(exported) || !ts.isIdentifier(exported.expression)) {
    return `default export is not a wrapper call: ${exported.getText().slice(0, 40)}`;
  }
  const callee = exported.expression.text;
  const origin = imported.get(callee);
  if (!origin) return `${callee} (not a named import)`;
  const [name, module] = origin.split('@');
  return WRAPPERS[name] === module ? name : `${callee} (${origin})`;
}

describe('defaultExportWrapper', () => {
  const classify = (source: string) => defaultExportWrapper('route.ts', source);

  it.each([
    ['ModEndpoint', '~/server/utils/endpoint-helpers'],
    ['WebhookEndpoint', '~/server/utils/endpoint-helpers'],
    ['defineModeratorEndpoint', '~/server/utils/moderator-endpoint'],
  ])('names %s imported from its module', (name, module) => {
    expect(classify(`import { ${name} } from '${module}';\nexport default ${name}({});`)).toBe(
      name
    );
  });

  it.each([
    [
      'another wrapper',
      `import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';\nexport default AuthedEndpoint(async () => {});`,
      'AuthedEndpoint (AuthedEndpoint@~/server/utils/endpoint-helpers)',
    ],
    [
      'another wrapper aliased to an allowed name',
      `import { AuthedEndpoint as ModEndpoint } from '~/server/utils/endpoint-helpers';\nexport default ModEndpoint(async () => {});`,
      'ModEndpoint (AuthedEndpoint@~/server/utils/endpoint-helpers)',
    ],
    [
      'an allowed name from another module',
      `import { ModEndpoint } from './local';\nexport default ModEndpoint(async () => {});`,
      'ModEndpoint (ModEndpoint@./local)',
    ],
    [
      'a locally declared function with an allowed name',
      `const ModEndpoint = (h: unknown) => h;\nexport default ModEndpoint(async () => {});`,
      'ModEndpoint (not a named import)',
    ],
    [
      'a bare handler',
      `export default async function handler() {}`,
      'no default export assignment',
    ],
    [
      'a wrapper call exported through a variable',
      `import { ModEndpoint } from '~/server/utils/endpoint-helpers';\nconst handler = ModEndpoint(async () => {});\nexport default handler;`,
      'default export is not a wrapper call: handler',
    ],
    ['no default export', `export const config = {};`, 'no default export assignment'],
  ])('does not accept %s', (_label, source, expected) => {
    expect(classify(source)).toBe(expected);
  });
});

describe('routes under src/pages/api/mod', () => {
  const files = routeFiles(MOD_ROUTES);
  const wrappers = files.map((file) => ({
    route: path.relative(MOD_ROUTES, file).replace(/\\/g, '/').replace(/\.ts$/, ''),
    wrapper: defaultExportWrapper(file, fs.readFileSync(file, 'utf8')),
  }));
  const routesOn = (name: string) =>
    wrappers
      .filter((w) => w.wrapper === name)
      .map((w) => w.route)
      .sort();

  // An empty walk would pass the membership check below with nothing in it.
  it('finds routes on both moderator wrappers', () => {
    expect(routesOn('ModEndpoint').length).toBeGreaterThan(5);
    expect(routesOn('defineModeratorEndpoint').length).toBeGreaterThan(5);
  });

  it('all default-export a moderator or webhook wrapper', () => {
    expect(wrappers.filter((w) => !(w.wrapper in WRAPPERS))).toEqual([]);
  });

  it('keeps the service-token routes to the listed set', () => {
    expect(routesOn('WebhookEndpoint')).toEqual(WEBHOOK_ROUTES);
  });
});

/**
 * Routes elsewhere under `src/pages/api` that read `isModerator` outside the wrappers above, in the
 * route file or in the module its default export comes from. A read is the identifier or a string
 * element access (`x['isModerator']`); a check under another name, or one further down the import
 * graph, is not seen. Each route found must be listed here.
 *
 * - `full credential`: a moderator-only route; it must call `requireFullScopeSession`.
 * - every other entry names why moderator status there is not a moderator-only gate.
 */
const FULL_CREDENTIAL = 'full credential';
const OUTSIDE_WRAPPERS: Record<string, string> = {
  'media/ingest/[mediaId]': FULL_CREDENTIAL,
  'testing/model3d-seed': FULL_CREDENTIAL,
  'download/attachments/[fileId]': 'file access check that also admits owners and public files',
  'download/training/[modelVersionId]': 'owner-or-moderator access to training data',
  'v1/announcements/index': 'owner-or-moderator edit of a creator announcement',
  'v1/block-tokens/index': 'install token mint; moderators may mint for model slots',
  'v1/blocks/collections/[id]/index': 'collection permission check for the block subject',
  'v1/me': 'reports the flag',
  'v1/model-versions/[id]': 'moderators also see unpublished versions',
  'v1/model-versions/bust-cache': 'owner-or-moderator cache bust; owners bust their own versions',
  'v1/model-versions/early-access': 'owner-or-moderator early-access settings',
  'v1/model-versions/mini/[id]': 'moderators also see unpublished versions',
  'v1/permissions/check': 'entity access check that also admits owners and public entities',
};

/**
 * Gated to App Blocks authors and called by the App Blocks CLI with an OAuth token carrying the
 * opt-in `AppBlocksSubmit` scope, so they take that token rather than the moderator credential
 * rule. Documented in `docs/auth/oauth-developer-docs.md`.
 */
const APP_BLOCKS_CLI_ROUTES = [
  'v1/blocks/dev-token',
  'v1/blocks/submissions',
  'v1/blocks/submit-version',
  'v1/blocks/withdraw',
];

const API_ROUTES = path.join(REPO_ROOT, 'src/pages/api');
const routeName = (file: string) =>
  path
    .relative(API_ROUTES, file)
    .replace(/\\/g, '/')
    .replace(/\.tsx?$/, '');

function parse(fileName: string, source: string) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
}

/** Whether the code reads the `isModerator` flag: the identifier or a string element access. */
function readsModeratorFlag(fileName: string, source: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      (ts.isIdentifier(node) && node.text === 'isModerator') ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'isModerator')
    )
      found = true;
    else ts.forEachChild(node, visit);
  };
  visit(parse(fileName, source));
  return found;
}

/** A `~/` or relative module specifier as a file under `root`, or undefined for a package. */
function resolveModule(root: string, fromFile: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith('~/')) base = path.join(root, 'src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return undefined;
  return ['.ts', '.tsx', '/index.ts', '/index.tsx']
    .map((ext) => base + ext)
    .find((candidate) => fs.existsSync(candidate));
}

/** The module a file's default export is imported or re-exported from, if it is one. */
function defaultExportOrigin(root: string, file: string, source: string): string | undefined {
  const tree = parse(file, source);
  const importedFrom = new Map<string, string>();
  let origin: string | undefined;
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const specifier = statement.moduleSpecifier.text;
      if (clause?.name) importedFrom.set(clause.name.text, specifier);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) importedFrom.set(element.name.text, specifier);
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some((e) => e.name.text === 'default')
    )
      origin = statement.moduleSpecifier.text;
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      let expression = statement.expression;
      while (ts.isCallExpression(expression) || ts.isParenthesizedExpression(expression))
        expression = ts.isCallExpression(expression)
          ? expression.arguments[0] ?? expression.expression
          : expression.expression;
      if (ts.isIdentifier(expression)) origin = importedFrom.get(expression.text);
    }
  }
  return origin && resolveModule(root, file, origin);
}

/** Whether a route, or the module its default export comes from, reads the moderator flag. */
function routeReadsModeratorFlag(root: string, file: string): boolean {
  const source = fs.readFileSync(file, 'utf8');
  if (readsModeratorFlag(file, source)) return true;
  const origin = defaultExportOrigin(root, file, source);
  return !!origin && readsModeratorFlag(origin, fs.readFileSync(origin, 'utf8'));
}

/** Whether the code names `name` anywhere; comments are not part of the tree. */
function namesIdentifier(fileName: string, source: string, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(parse(fileName, source));
  return found;
}

/** Whether the code calls `name` imported from `module`. */
function callsImported(fileName: string, source: string, name: string, module: string): boolean {
  const file = parse(fileName, source);
  const local = file.statements
    .filter(ts.isImportDeclaration)
    .filter((s) => ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === module)
    .flatMap((s) => {
      const bindings = s.importClause?.namedBindings;
      return bindings && ts.isNamedImports(bindings) ? [...bindings.elements] : [];
    })
    .find((e) => (e.propertyName ?? e.name).text === name)?.name.text;
  if (!local) return false;
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === local
    )
      found = true;
    else ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('routeReadsModeratorFlag', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moderator-route-ledger-'));
  const write = (relative: string, source: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  };
  const gate = 'export function handler(s: any) { if (!s?.user?.isModerator) throw 0; }\n';
  write('src/server/gated.ts', `${gate}export default handler;\n`);
  write('src/server/open.ts', 'export default function handler() {}\n');

  it.each([
    ['an identifier read in the route', 'export default (s: any) => s.user.isModerator;'],
    [
      'a bracket-string read in the route',
      `export default (s: any) => (s?.user as any)?.['isModerator'];`,
    ],
    [
      'a double-quoted bracket read in the route',
      'export default (s: any) => s.user["isModerator"];',
    ],
    ['a default re-export of a gated module', "export { default } from '~/server/gated';"],
    ['a named re-export as default', "export { handler as default } from '~/server/gated';"],
    [
      'a default export of an imported gated handler',
      "import { handler } from '~/server/gated';\nexport default handler;",
    ],
    [
      'a wrapped imported gated handler',
      "import { handler } from '../../server/gated';\nexport default withAxiom(handler);",
    ],
  ])('sees %s', (_label, source) => {
    expect(routeReadsModeratorFlag(root, write('src/pages/api/route.ts', source))).toBe(true);
  });

  it.each([
    ['a comment', '// user.isModerator\nexport default () => null;'],
    ['a re-export of a module without the read', "export { default } from '~/server/open';"],
    ['a package import', "import handler from 'next';\nexport default handler;"],
  ])('does not see %s', (_label, source) => {
    expect(routeReadsModeratorFlag(root, write('src/pages/api/route.ts', source))).toBe(false);
  });
});

describe('namesIdentifier and callsImported', () => {
  it('see code and not comments', () => {
    expect(namesIdentifier('a.ts', 'const ok = user.isModerator;', 'isModerator')).toBe(true);
    expect(namesIdentifier('a.ts', 'f({ isModerator });', 'isModerator')).toBe(true);
    expect(namesIdentifier('a.ts', '// user.isModerator\n/* isModerator */', 'isModerator')).toBe(
      false
    );
  });

  it('find a call only to the imported function', () => {
    const imported = `import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';`;
    const check = (src: string) =>
      callsImported(
        'a.ts',
        src,
        'requireFullScopeSession',
        '~/server/utils/require-full-scope-session'
      );
    expect(check(`${imported}\nif (!requireFullScopeSession(req, res)) return;`)).toBe(true);
    expect(check(`${imported}\n// requireFullScopeSession(req, res)`)).toBe(false);
    expect(check(`const requireFullScopeSession = () => true;\nrequireFullScopeSession();`)).toBe(
      false
    );
  });
});

describe('routes under src/pages/api outside the moderator wrappers', () => {
  const files = routeFiles(API_ROUTES).filter((f) => /\.tsx?$/.test(f));
  const sources = new Map(files.map((f) => [routeName(f), fs.readFileSync(f, 'utf8')]));
  const outsideWrappers = files
    .filter((file) => !(defaultExportWrapper(file, sources.get(routeName(file)) ?? '') in WRAPPERS))
    .filter((file) => routeReadsModeratorFlag(REPO_ROOT, file))
    .map(routeName)
    .sort();

  it('walks the api tree', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('follows a default export to the module it comes from', () => {
    const route = path.join(API_ROUTES, 'internal/game-frame/reports/index.ts');
    expect(defaultExportOrigin(REPO_ROOT, route, fs.readFileSync(route, 'utf8'))).toBe(
      path.join(REPO_ROOT, 'src/server/game-frame/report-endpoints.ts')
    );
  });

  it('that read isModerator are each classified', () => {
    expect(outsideWrappers).toEqual(Object.keys(OUTSIDE_WRAPPERS).sort());
  });

  it.each(
    Object.entries(OUTSIDE_WRAPPERS)
      .filter(([, kind]) => kind === FULL_CREDENTIAL)
      .map(([route]) => route)
  )('%s applies the moderator credential rule', (route) => {
    expect(
      callsImported(
        route,
        sources.get(route) ?? '',
        'requireFullScopeSession',
        '~/server/utils/require-full-scope-session'
      )
    ).toBe(true);
  });

  it.each(APP_BLOCKS_CLI_ROUTES)('%s is an App Blocks CLI route', (route) => {
    const source = sources.get(route) ?? '';
    expect(source).not.toBe('');
    expect(namesIdentifier(route, source, 'AppBlocksSubmit')).toBe(true);
  });
});

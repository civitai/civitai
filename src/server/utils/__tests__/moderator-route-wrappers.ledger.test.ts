import fs from 'fs';
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

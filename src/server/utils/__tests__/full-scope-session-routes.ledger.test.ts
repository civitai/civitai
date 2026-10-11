import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every page under `src/pages` that calls `requireFullScopeSession` (imported from its own
 * module), listed by name. The list fails when a route gains or loses the call, so a change to
 * which routes require a full-access session has to be made here on purpose. Per-route
 * behaviour is pinned in `src/server/__tests__/credential-minting-routes-session-scope.test.ts`,
 * `src/server/__tests__/block-tokens-session-scope.test.ts` and
 * `src/server/__tests__/freshdesk-sso-session-scope.test.ts`.
 */
const EXPECTED = [
  'src/pages/api/auth/freshdesk.ts',
  'src/pages/api/media/ingest/[mediaId].ts',
  'src/pages/api/testing/model3d-seed.ts',
  'src/pages/api/training-studio/host.ts',
  'src/pages/api/user/orchestrator-key.ts',
  'src/pages/api/v1/block-tokens/index.ts',
];

const GUARD = 'requireFullScopeSession';
const GUARD_MODULE = '~/server/utils/require-full-scope-session';
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** True when the file calls the guard through a binding imported from the guard's module. */
function callsGuard(fileName: string, source: string): boolean {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const localNames = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    if (statement.moduleSpecifier.text !== GUARD_MODULE) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === GUARD) localNames.add(element.name.text);
    }
  }
  if (!localNames.size) return false;

  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      localNames.has(node.expression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function scan() {
  const files = sourceFiles(path.join(REPO_ROOT, 'src/pages'));
  const guarded = files
    .filter((f) => callsGuard(f, fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(REPO_ROOT, f).replace(/\\/g, '/'))
    .sort();
  return { scanned: files.length, guarded };
}

describe('routes that require a full-access session', () => {
  it('scanned the pages tree', () => {
    expect(scan().scanned).toBeGreaterThan(500);
  });

  it('matches the ledger exactly', () => {
    expect(scan().guarded).toEqual(EXPECTED);
  });

  it('recognises a call only through the guard module import', () => {
    const imported = `import { ${GUARD} } from '${GUARD_MODULE}';\n${GUARD}(req, res);`;
    const aliased = `import { ${GUARD} as gate } from '${GUARD_MODULE}';\ngate(req, res);`;
    const otherModule = `import { ${GUARD} } from '~/elsewhere';\n${GUARD}(req, res);`;
    const importedOnly = `import { ${GUARD} } from '${GUARD_MODULE}';\n// ${GUARD}(req, res);`;
    expect(callsGuard('a.ts', imported)).toBe(true);
    expect(callsGuard('b.ts', aliased)).toBe(true);
    expect(callsGuard('c.ts', otherModule)).toBe(false);
    expect(callsGuard('d.ts', importedOnly)).toBe(false);
  });
});

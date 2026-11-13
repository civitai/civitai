import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * THE GENERATION ENTRY-POINT LEDGER. The global generation kill switch (disabled / memberOnly) is
 * applied per entry point, not inside `generateFromGraph`:
 *
 *   - `generateFromGraph` is called directly only by the onsite tRPC procedure, which applies
 *     `assertGenerationStatusAllows`, and by `submitPresetImageGen`.
 *   - `submitPresetImageGen` applies it for every preset surface (PRESET_ENFORCE_GENERATION_STATUS).
 *
 * So a NEW caller of either function is a new generation entry point whose kill-switch handling
 * nobody has decided. This pins the set of callers, by file and enclosing function, and fails when
 * it grows or shrinks: adding a caller means classifying it here (and, for a direct
 * `generateFromGraph` caller, applying the switch).
 *
 * What counts, from the parse (so a name in a comment, a string or a type never does): every VALUE
 * reference to either function's identifier — a call, and also an alias (`const f = …`), a
 * `.call(…)` or a parenthesized call, each of which is a reference to the name — plus a call
 * through a property (`mod.generateFromGraph(…)`). An import or destructure that renames either
 * function is refused outright, since the scan matches names. Not seen: a property READ that is
 * not called on the spot (`const f = mod.generateFromGraph`).
 */

const SRC = path.resolve(__dirname, '../../..');
const TARGETS = ['generateFromGraph', 'submitPresetImageGen'] as const;
type Target = (typeof TARGETS)[number];

/** `<file>::<enclosing function>` → number of uses, per target. */
const LEDGER: Record<Target, Record<string, number>> = {
  generateFromGraph: {
    // Onsite / API generation: applies the kill switch itself before this call.
    'server/routers/orchestrator.router.ts::generateFromGraph': 1,
    // Every preset surface: applies the kill switch itself before this call.
    'server/services/orchestrator/preset-image-gen.service.ts::submitPresetImageGen': 1,
  },
  submitPresetImageGen: {
    'server/jobs/process-enqueued-comic-panels.ts::processEnqueuedComicPanelsJob': 1,
    'server/routers/comics.router.ts::submitComicGeneration': 1,
    'server/routers/orchestrator.router.ts::iterateGenerate': 1,
    'server/services/article-reframe.service.ts::submitArticleReframe': 1,
    'server/services/remix-app-run.service.ts::advance': 1,
    'server/services/remix-app.service.ts::runRemixApp': 1,
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The nearest enclosing named function: a function or method declaration, or a property or
 * variable holding a function (directly, or through a wrapper call such as `createJob(…)` or a
 * tRPC builder chain). A local like `const result = await …` is not an owner.
 */
function ownerOf(node: ts.Node): string {
  let crossedFunction = false;
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
      return n.name.getText();
    }
    if (
      crossedFunction &&
      (ts.isPropertyAssignment(n) || ts.isVariableDeclaration(n)) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))
    ) {
      return n.name.text;
    }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) crossedFunction = true;
  }
  return '<module>';
}

const isTarget = (name: string): name is Target => (TARGETS as readonly string[]).includes(name);

/** Whether this identifier is a use of the function, not a declaration, key, import or type. */
function isUse(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
    return ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
  }
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)) {
    return false;
  }
  for (let n: ts.Node | undefined = parent; n; n = n.parent) {
    if (ts.isTypeNode(n)) return false;
  }
  return true;
}

/** Called inside the tests: a throw at collection time would drop the file's tests silently. */
function scan() {
  const found: Record<Target, Record<string, number>> = {
    generateFromGraph: {},
    submitPresetImageGen: {},
  };
  const renamed: string[] = [];
  for (const file of walk(SRC)) {
    const source = fs.readFileSync(file, 'utf8');
    if (!TARGETS.some((t) => source.includes(t))) continue;
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && isTarget(node.text) && isUse(node)) {
        const key = `${rel}::${ownerOf(node)}`;
        const bucket = found[node.text];
        bucket[key] = (bucket[key] ?? 0) + 1;
      }
      if (
        (ts.isImportSpecifier(node) || ts.isBindingElement(node)) &&
        node.propertyName &&
        ts.isIdentifier(node.propertyName) &&
        isTarget(node.propertyName.text) &&
        ts.isIdentifier(node.name) &&
        node.name.text !== node.propertyName.text
      ) {
        renamed.push(`${rel}: ${node.propertyName.text} as ${node.name.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { found, renamed };
}

describe('no-unclassified-generation-entry', () => {
  it.each(TARGETS)('the callers of %s are exactly the ledger', (target) => {
    expect(scan().found[target]).toEqual(LEDGER[target]);
  });

  it('no module renames either function on import', () => {
    expect(scan().renamed).toEqual([]);
  });
});

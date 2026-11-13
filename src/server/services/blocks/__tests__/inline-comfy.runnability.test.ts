import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `checkInlineComfyGraph` (civitai-app-starters#774): the one place an inline
 * `customComfy` graph is checked for runnability before any spend. The refusal
 * and accept cases are proved through the router and the REST routes
 * (`blocks.router.workflow.test.ts`, `workflows-controls-seam.test.ts`); this file
 * pins what those cannot: WHO runs it. The set of call sites is exact, so a new
 * path that accepts an inline graph without the check, or a removed call, goes
 * red here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CALLER LEDGER. Every non-test call of `checkInlineComfyGraph`, by
// `<file>:<enclosing function>`, compared EXACTLY: it fails when a caller is
// added, removed or moved. Any other use of the name (passed as a value, an
// aliased import) is reported as UNREADABLE rather than scored as no call.
// ─────────────────────────────────────────────────────────────────────────────

const LEDGER = [
  'src/server/routers/blocks.router.ts:estimateCustomComfyWorkflow',
  'src/server/routers/blocks.router.ts:submitCustomComfyWorkflow',
];

const CHECK = 'checkInlineComfyGraph';
const DEFINING_FILE = 'src/server/services/blocks/inline-comfy.service.ts';
/** The router's narrowing to the inline arm: every function that does it must run the check. */
const NARROW = 'isInlineComfyBody';

const repoRoot = path.resolve(__dirname, '../../../../..');

function isTestPath(rel: string) {
  return rel.includes('/__tests__/') || rel.startsWith('src/tests/') || /\.test\.tsx?$/.test(rel);
}

function walk(dir: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
}

function enclosingFunctionName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
      return n.name.getText();
    }
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isVariableDeclaration(n.parent)
    ) {
      return n.parent.name.getText();
    }
  }
  return '<module>';
}

type Scan = { calls: string[]; unreadable: string[]; filesWithName: string[] };

function scan(name: string): Scan {
  const files: string[] = [];
  walk(path.join(repoRoot, 'src'), files);
  const calls: string[] = [];
  const unreadable: string[] = [];
  const filesWithName: string[] = [];
  for (const full of files) {
    const rel = path.relative(repoRoot, full).split(path.sep).join('/');
    if (isTestPath(rel)) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (!text.includes(name)) continue;
    filesWithName.push(rel);
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === name) {
        const parent = node.parent;
        const isDeclarationName =
          (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) &&
          parent.name === node;
        const isPlainImport =
          ts.isImportSpecifier(parent) && !parent.propertyName && parent.name === node;
        if (ts.isCallExpression(parent) && parent.expression === node) {
          calls.push(`${rel}:${enclosingFunctionName(node)}`);
        } else if (!isDeclarationName && !isPlainImport) {
          unreadable.push(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { calls: [...new Set(calls)].sort(), unreadable, filesWithName };
}

describe('checkInlineComfyGraph caller ledger', () => {
  const result = scan(CHECK);

  it('the scan reads the defining file (positive control: it can see the name at all)', () => {
    expect(result.filesWithName).toContain(DEFINING_FILE);
  });

  it('every use of the name is a readable direct call', () => {
    expect(result.unreadable).toEqual([]);
  });

  it('the callers are exactly the inline estimate and the inline submit', () => {
    expect(result.calls).toEqual([...LEDGER].sort());
  });

  // The seam: the ledger above is only complete if no OTHER function narrows a
  // body to the inline arm. Every function that calls the router's inline
  // narrowing must also be a caller of the check.
  it('every function that narrows a body to the inline arm also runs the check', () => {
    const narrowing = scan(NARROW);
    expect(narrowing.calls.length).toBeGreaterThan(0);
    expect(narrowing.unreadable).toEqual([]);
    for (const site of narrowing.calls) expect(LEDGER).toContain(site);
  });
});

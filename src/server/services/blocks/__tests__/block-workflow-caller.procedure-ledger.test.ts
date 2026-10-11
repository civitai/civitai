import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Which `blocksRouter` procedures are reached through `blockWorkflowCaller`
 * (`src/server/services/blocks/block-workflow-rest.ts`), the server-side tRPC caller the
 * block REST routes use.
 *
 * That caller fills `ctx.user` from the block token's own subject, with no API key, so it
 * is not a browser session. Procedures that require a real browser session, and check that
 * the session user is the token's subject, must never be reached through it: these
 * procedures require a real browser session; this helper has none.
 *
 * A RELATIONSHIP, NOT A COUNT. The ledger below is every (route file → procedures) pair,
 * DERIVED from the source and compared exactly, so it fails when a call is added, removed or
 * moved. A new route through the helper gets looked at by whoever adds it.
 *
 * Every use of `blockWorkflowCaller` must have the one readable shape
 * `const caller = await blockWorkflowCaller(req, res)`, and every use of that variable must
 * be `caller.<procedure>(…)`. Anything else is reported as UNREADABLE rather than scored as
 * "calls nothing", because a population the scan cannot read must not pass as empty.
 * An aliased import (`import { blockWorkflowCaller as x }`) is followed under its local
 * name, and the defining file is scanned like any other, its own declaration excepted.
 */

const SESSION_BOUND_PROCEDURES = [
  'createPostFromApp',
  'previewPostFromApp',
  'publishGenerationOutputs',
];

const LEDGER: Record<string, string[]> = {
  'src/pages/api/v1/blocks/workflows/cancel.ts': ['cancelWorkflow'],
  'src/pages/api/v1/blocks/workflows/estimate.ts': ['estimateWorkflow'],
  'src/pages/api/v1/blocks/workflows/poll.ts': ['pollWorkflow'],
  'src/pages/api/v1/blocks/workflows/query.ts': ['queryAppWorkflows'],
  'src/pages/api/v1/blocks/workflows/submit.ts': ['submitWorkflow'],
};

const repoRoot = path.resolve(__dirname, '../../../../..');
const HELPER = 'blockWorkflowCaller';
const DEFINING_FILE = 'src/server/services/blocks/block-workflow-rest.ts';
const ROUTER_FILE = 'src/server/routers/blocks.router.ts';

function isTestPath(rel: string) {
  return (
    rel.includes('/__tests__/') ||
    rel.startsWith('src/tests/') ||
    /\.(test|spec)\.tsx?$/.test(rel) ||
    /\.browser\.test\.tsx?$/.test(rel)
  );
}

function walk(dir: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
}

type Scan = { calls: Record<string, string[]>; unreadable: string[]; filesScanned: number };

function scanSources(): Scan {
  const files: string[] = [];
  walk(path.join(repoRoot, 'src'), files);
  const calls: Record<string, string[]> = {};
  const unreadable: string[] = [];

  for (const full of files) {
    const rel = path.relative(repoRoot, full).split(path.sep).join('/');
    // The DEFINING file is scanned too: a wrapper exported from it is a route to the
    // helper like any other. Only the helper's own declaration name is exempt.
    if (isTestPath(rel)) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (!text.includes(HELPER)) continue;

    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    const callerVars = new Set<string>();
    const procs = new Set<string>();

    const where = (node: ts.Node) =>
      `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

    // Local names the helper is bound to in this file: its own name, plus the local name of
    // any `import { blockWorkflowCaller as other }`.
    const helperNames = new Set<string>([HELPER]);
    const collectAliases = (node: ts.Node) => {
      if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === HELPER) {
        helperNames.add(node.name.text);
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(sf);

    // Pass 1: every mention of the helper must be an import or `const x = await helper(…)`.
    // Any other shape — a namespace access, a destructured dynamic import, a re-export, a
    // string key, a call not bound to a const — is UNREADABLE.
    const visitHelper = (node: ts.Node) => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        node.text === HELPER
      ) {
        unreadable.push(`${where(node)} — ${HELPER} named in a string`);
      }
      if (ts.isIdentifier(node) && helperNames.has(node.text)) {
        const p = node.parent;
        const isImport = ts.isImportSpecifier(p);
        const isOwnDeclaration =
          rel === DEFINING_FILE &&
          node.text === HELPER &&
          ts.isFunctionDeclaration(p) &&
          p.name === node;
        if (isOwnDeclaration) {
          ts.forEachChild(node, visitHelper);
          return;
        }
        const call = ts.isCallExpression(p) && p.expression === node ? p : undefined;
        const awaited = call && ts.isAwaitExpression(call.parent) ? call.parent : undefined;
        const decl =
          awaited && ts.isVariableDeclaration(awaited.parent) ? awaited.parent : undefined;
        if (decl && ts.isIdentifier(decl.name)) callerVars.add(decl.name.text);
        else if (!isImport)
          unreadable.push(`${where(node)} — ${HELPER} used outside the readable shape`);
      }
      ts.forEachChild(node, visitHelper);
    };
    visitHelper(sf);

    // Pass 2: every reference to a caller variable must be `caller.<proc>(…)`.
    const visitCaller = (node: ts.Node) => {
      if (ts.isIdentifier(node) && callerVars.has(node.text)) {
        const p = node.parent;
        const isDeclName = ts.isVariableDeclaration(p) && p.name === node;
        const access = ts.isPropertyAccessExpression(p) && p.expression === node ? p : undefined;
        const invoked =
          access && ts.isCallExpression(access.parent) && access.parent.expression === access;
        if (invoked) procs.add(access.name.text);
        else if (!isDeclName)
          unreadable.push(`${where(node)} — caller used other than caller.<proc>(…)`);
      }
      ts.forEachChild(node, visitCaller);
    };
    visitCaller(sf);

    if (callerVars.size === 0 && procs.size === 0) continue;
    calls[rel] = [...procs].sort();
  }
  return { calls, unreadable, filesScanned: files.length };
}

/** `  name: someProcedure` declarations in the blocks router → builder name. */
function routerBuilders(): Record<string, string> {
  const text = fs.readFileSync(path.join(repoRoot, ROUTER_FILE), 'utf8');
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^ {2}([A-Za-z0-9_]+): ([A-Za-z0-9_]*[Pp]rocedure)\b/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

const scan = scanSources();
const builders = routerBuilders();

describe('blockWorkflowCaller — the procedures reached through it', () => {
  it('scanned the source tree (positive control: the walk saw files and found the routes)', () => {
    expect(scan.filesScanned).toBeGreaterThan(1000);
    expect(Object.keys(scan.calls).length).toBeGreaterThan(0);
  });

  it('every use of the helper and of its caller is readable', () => {
    expect(scan.unreadable).toEqual([]);
  });

  it('matches the ledger exactly — a call added, removed or moved fails here', () => {
    expect(scan.calls).toEqual(LEDGER);
  });

  it('never reaches a procedure that requires a real browser session', () => {
    const reached = Object.entries(scan.calls).flatMap(([file, procs]) =>
      procs.filter((p) => SESSION_BOUND_PROCEDURES.includes(p)).map((p) => `${file} → ${p}`)
    );
    expect(reached).toEqual([]);
  });

  it('the session-bound list names real protectedProcedures (so it cannot rot into a no-op)', () => {
    for (const proc of SESSION_BOUND_PROCEDURES) {
      expect(builders[proc], proc).toBe('protectedProcedure');
    }
  });

  it('reaches only publicProcedures — a NEW session-requiring procedure is caught too', () => {
    const notPublic = Object.values(scan.calls)
      .flat()
      .filter((p) => builders[p] !== 'publicProcedure');
    expect(notPublic).toEqual([]);
  });
});

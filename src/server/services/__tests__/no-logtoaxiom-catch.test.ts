import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `logToAxiom` never rejects (pinned by `packages/civitai-axiom/src/__tests__/logToAxiom.test.ts`),
 * so a `.catch` or `await` on it is dead code.
 *
 * 🔴 A RATCHET: the ledgers below may only shrink. A new site fails the test, and so does a
 * removed one until its entry is deleted.
 *
 * Not seen: a call through a renamed alias, or one first stored in a variable.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__mocks__']);
// Build output is skipped only directly under a package root (a directory with a package.json):
// a `build/` or `dist/` anywhere else, such as src/tests/build/, is source.
const BUILD_OUTPUT_DIRS = new Set(['dist', 'build', '.svelte-kit']);
const isBuildOutput = (parent: string, name: string) =>
  BUILD_OUTPUT_DIRS.has(name) && fs.existsSync(path.join(parent, 'package.json'));

type Counts = { catch: number; await: number };

/**
 * FROZEN RESIDUAL. These files belong to areas frozen for automated changes (the generator and its
 * orchestrator plumbing), so the codemod did not touch them. Their owner removes these; delete
 * the entry when they go.
 */
const FROZEN_BASELINE: Record<string, Counts> = {
  'src/pages/api/orchestrator/getConsumerBlobUploadUrl.ts': { catch: 1, await: 0 },
  'src/server/http/orchestrator/orchestrator.caller.ts': { catch: 1, await: 0 },
  'src/server/jobs/sync-generator-loaded-resources.ts': { catch: 1, await: 0 },
  'src/server/orchestrator/get-orchestrator-token.ts': { catch: 2, await: 0 },
  'src/server/routers/orchestrator.router.ts': { catch: 2, await: 0 },
  'src/server/services/generation-input-urls.ts': { catch: 2, await: 0 },
  'src/server/services/orchestrator/assert-workflow-owner.ts': { catch: 1, await: 0 },
  'src/server/services/orchestrator/civitai.ts': { catch: 1, await: 0 },
  'src/server/services/orchestrator/handlers/polyGen.handler.ts': { catch: 5, await: 0 },
  'src/server/services/orchestrator/legacy-metadata-mapper.ts': { catch: 2, await: 0 },
  'src/server/services/orchestrator/models.ts': { catch: 5, await: 0 },
  'src/server/services/orchestrator/orchestration-new.service.ts': { catch: 2, await: 0 },
  'src/server/services/orchestrator/orchestrator.service.ts': { catch: 4, await: 0 },
  'src/server/services/orchestrator/promptAuditing.ts': { catch: 3, await: 0 },
  'src/server/services/orchestrator/remix-provenance.ts': { catch: 1, await: 0 },
  'src/server/services/orchestrator/training/publish-from-workflow.ts': { catch: 1, await: 0 },
  'src/server/services/orchestrator/training/studio-dataset-archive.service.ts': {
    catch: 2,
    await: 1,
  },
  'src/server/services/orchestrator/training/training-canary.ts': { catch: 2, await: 0 },
  'src/server/services/orchestrator/training/training-state.ts': { catch: 3, await: 0 },
  'src/server/services/orchestrator/training/training-trigger-word-check.ts': {
    catch: 3,
    await: 0,
  },
  'src/server/services/orchestrator/training/training.orch.ts': { catch: 2, await: 0 },
};

/**
 * NOT A SWALLOW, LEFT FOR A HUMAN. These `.catch(handleLogError)` handlers log, so the codemod
 * left them rather than judge them. The handler is unreachable (the call never rejects), so
 * removing it changes nothing; it is kept apart from the frozen residual so the decision stays
 * visible. Delete the entry when the `.catch` goes.
 */
const NON_SWALLOW_HANDLERS: Record<string, Counts> = {
  'src/server/controllers/model-file.controller.ts': { catch: 1, await: 0 },
  'src/server/services/bounty-entry-file-check.service.ts': { catch: 5, await: 0 },
  'src/server/utils/model-file-url-bound.ts': { catch: 2, await: 0 },
};

const unparen = (n: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
};

function isLogToAxiomCall(n: ts.Expression): boolean {
  n = unparen(n);
  if (!ts.isCallExpression(n)) return false;
  const callee = n.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'logToAxiom';
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'logToAxiom';
  return false;
}

function isCatchOnLogToAxiom(n: ts.Expression): boolean {
  n = unparen(n);
  return (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === 'catch' &&
    isLogToAxiomCall(n.expression.expression)
  );
}

/** Count the `.catch`/`await` sites on logToAxiom in one source text. */
function scanSource(fileName: string, source: string): Counts {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const counts: Counts = { catch: 0, await: 0 };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isCatchOnLogToAxiom(node)) counts.catch++;
    if (
      ts.isAwaitExpression(node) &&
      (isLogToAxiomCall(node.expression) || isCatchOnLogToAxiom(node.expression))
    )
      counts.await++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return counts;
}

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !isBuildOutput(dir, entry.name)) walk(full, out);
    } else if (
      /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name) &&
      !/\.d\.ts$/.test(entry.name) &&
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
}

function scanRepo(): Record<string, Counts> {
  const files: string[] = [];
  for (const root of ROOTS) walk(path.join(REPO_ROOT, root), files);
  const found: Record<string, Counts> = {};
  for (const abs of files) {
    const source = fs.readFileSync(abs, 'utf8');
    if (!source.includes('logToAxiom')) continue;
    const counts = scanSource(abs, source);
    if (counts.catch || counts.await) {
      found[path.relative(REPO_ROOT, abs).replace(/\\/g, '/')] = counts;
    }
  }
  return found;
}

const MESSAGE =
  'logToAxiom never rejects: drop the `.catch(...)` / `await` and just call it ' +
  '(see src/server/services/__tests__/no-logtoaxiom-catch.test.ts). ' +
  'If a site was removed, delete its ledger entry.';

describe('no-logtoaxiom-catch', () => {
  it('the detector sees what it must and nothing else (positive and negative control)', () => {
    const sample = [
      'logToAxiom({ a: 1 }).catch(() => {});',
      'await logToAxiom({ a: 2 });',
      'await logToAxiom({ a: 3 }).catch(() => undefined);',
      'void logger.logToAxiom({ a: 4 }).catch(handleLogError);',
      '(logToAxiom({ a: 5 })).catch(() => null);',
      // Not sites: another promise's catch, a bare call, a string, a comment.
      'doWork().then(() => logToAxiom({ b: 1 })).catch(() => {});',
      'logToAxiom({ b: 2 });',
      "const s = 'logToAxiom({}).catch(() => {})';",
      '// await logToAxiom({ b: 3 }).catch(() => {});',
    ].join('\n');
    expect(scanSource('sample.ts', `async function f() {\n${sample}\n}`)).toEqual({
      catch: 4,
      await: 2,
    });
  });

  it('skips build output only at a package root, so a nested build/ is still scanned', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-logtoaxiom-catch-'));
    try {
      const files = [
        'package.json',
        'build/a.ts',
        'dist/b.ts',
        '.svelte-kit/c.ts',
        'src/tests/build/d.ts',
        'src/dist/e.ts',
      ];
      for (const rel of files) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), '');
      }
      const out: string[] = [];
      walk(root, out);
      expect(out.map((f) => path.relative(root, f).replace(/\\/g, '/')).sort()).toEqual([
        'src/dist/e.ts',
        'src/tests/build/d.ts',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('no `.catch`/`await` on logToAxiom outside the ledger', () => {
    const found = scanRepo();
    const expected = { ...FROZEN_BASELINE, ...NON_SWALLOW_HANDLERS };
    // The ledger is a population of known positives, so a detector gone blind turns every entry
    // stale and fails below rather than passing on an empty scan.
    expect(Object.keys(found).length, 'the scan found no sites at all').toBeGreaterThan(0);
    expect(found, MESSAGE).toEqual(expected);
  });

  it('the two ledgers do not overlap', () => {
    const both = Object.keys(FROZEN_BASELINE).filter((f) => f in NON_SWALLOW_HANDLERS);
    expect(both).toEqual([]);
  });
});

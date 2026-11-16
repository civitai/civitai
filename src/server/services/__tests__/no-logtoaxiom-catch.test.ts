import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `logToAxiom` NEVER REJECTS, so nothing should `.catch` or `await` it.
 *
 * `packages/civitai-axiom/src/client.ts` writes the stderr line synchronously, contains the Axiom
 * dual-write and does not wait for it (pinned by `packages/civitai-axiom/src/__tests__/logToAxiom.test.ts`).
 * A `.catch(() => {})` on the call is unreachable, and an `await` buys nothing but a yield. Both
 * were on ~1,350 call sites; every copy taught the next author that a blanket promise-swallow is
 * the house style, and that idiom then spread to promises where it hides real failures.
 * `scripts/codemod-logtoaxiom-no-catch.mjs` removed them.
 *
 * What counts, from the parse (so a comment or a string never does), in every non-test source file
 * under `src/`, `apps/` and `packages/`:
 *   - `.catch(...)` whose receiver is directly a `logToAxiom(...)` or `<x>.logToAxiom(...)` call,
 *     whatever the handler;
 *   - `await` on such a call, directly or through such a `.catch`.
 * Not seen: a call through a renamed alias, or one that is first stored in a variable.
 *
 * 🔴 A RATCHET, NOT A RULE: the sites below are pinned by file and count, and the test fails when
 * the set GROWS (a new `.catch`/`await`: just call `logToAxiom(...)`) or SHRINKS (a site was
 * removed: delete its entry, so the ledger cannot keep a slot open for a new one).
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__mocks__', 'dist', 'build', '.svelte-kit']);

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
  'src/server/services/orchestrator/training/training-trigger-word-check.ts': { catch: 3, await: 0 },
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
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
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

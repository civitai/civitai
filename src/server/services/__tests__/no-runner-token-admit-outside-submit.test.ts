import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * A recipe-runner block token may only submit a workflow. `verifyBlockToken` refuses it unless
 * the caller opts in with `admitRunner`, and only `submitWorkflow` does. Every non-test line
 * naming `admitRunner` is counted here per file, so a second admitter in another spelling (a
 * const, a spread) changes a count. A flipped default on an existing line does not: the verifier
 * and pollWorkflow tests catch that. Widening what a runner token can do is a design change:
 * make it there first, then update this list.
 */
const LEDGER: Record<string, number> = {
  // the claim doc, the option type, the refusal
  'src/server/middleware/block-scope.middleware.ts': 3,
  // the wrapper's parameter (one line) and pass-through, the resolver option and pass-through
  'src/server/services/blocks/block-bridge-auth.service.ts': 4,
  'src/server/routers/apps-shared.router.ts': 1,
  'src/server/services/apps/app-storage.service.ts': 1,
  // submitWorkflow, the one admitter
  'src/server/routers/blocks.router.ts': 1,
};

function mentions(): Record<string, number> {
  const out = execFileSync(
    'git',
    ['grep', '--untracked', '-c', 'admitRunner', '--', 'src', 'packages', 'apps'],
    { encoding: 'utf8' }
  );
  const counts: Record<string, number> = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const at = line.lastIndexOf(':');
    const file = line.slice(0, at);
    if (/(\.test\.|__tests__\/)/.test(file)) continue;
    counts[file] = Number(line.slice(at + 1));
  }
  return counts;
}

describe('runner block tokens are admitted only by submitWorkflow', () => {
  it('every non-test mention of admitRunner is in the ledger, at its count', () => {
    expect(mentions()).toEqual(LEDGER);
  });

  it('the one admitter is inside the submitWorkflow procedure', () => {
    const src = readFileSync('src/server/routers/blocks.router.ts', 'utf8');
    const start = src.indexOf('  submitWorkflow: publicProcedure');
    expect(start).toBeGreaterThan(-1);
    const rest = src.slice(start + 1);
    const nextProc = rest.search(/\n {2}\w+: \w+Procedure\b/);
    expect(nextProc).toBeGreaterThan(-1);
    expect(rest.slice(0, nextProc)).toMatch(/admitRunner: true/);
  });
});

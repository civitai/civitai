import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * A recipe-runner OAuth token (`RunnerMint`) resolves to no bearer session unless the caller
 * passes `allowRunnerMint`, which only a runner mint path may do. Every non-test line
 * naming `allowRunnerMint` is counted here per file, so a new caller changes a count. Letting a
 * runner token authenticate anywhere else is a design change: make it there first, then here.
 */
const LEDGER: Record<string, number> = {
  // the option type and the refusal
  'src/server/auth/bearer-token.ts': 2,
  // the block-token mint's runner path
  'src/server/services/blocks/runner-mint-handler.ts': 1,
};

function mentions(): Record<string, number> {
  const out = execFileSync(
    'git',
    ['grep', '--untracked', '-c', 'allowRunnerMint', '--', 'src', 'packages', 'apps'],
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

describe('runner tokens authenticate only where a runner mint path opts in', () => {
  it('every non-test line naming allowRunnerMint is in the ledger, at its count', () => {
    expect(mentions()).toEqual(LEDGER);
  });
});

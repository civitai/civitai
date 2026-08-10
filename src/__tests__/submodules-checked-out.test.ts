import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A missing submodule does not turn this suite RED. It makes ~70 suites VANISH.
 *
 * `event-engine-common` is a git submodule, and `git worktree add` does not
 * check submodules out. Without it, every file whose module graph reaches
 * `~/server/services/image.service.ts` (and friends) fails to RESOLVE, so those
 * files fail to LOAD. A file that fails to load collects **0 tests**: it
 * contributes nothing to the failed-TEST count, and it silently subtracts its
 * whole contents from the passed-TEST count.
 *
 * Measured on this repo (2026-08-10, same commit, same machine, only the
 * submodule differing):
 *
 *   submodule ABSENT   73 files failed | 818 passed  ->  12,782 tests passed
 *                      72 of those 73 files collected ZERO tests, and the run
 *                      reported **0 failed tests**.
 *   submodule PRESENT  891 files passed              ->  13,753 tests passed
 *
 * So the absent case hides 971 tests behind a summary whose failed-test count
 * is zero. Anyone reading "0 failing tests", or diffing passed-test totals
 * against a remembered number, is reading a number that means nothing — and a
 * reassuring zero is exactly what a probe wired to nothing produces.
 *
 * CI is not exposed to this (it checks out with `submodules: true`); local
 * worktrees are, which is where most runs actually happen. The repo's guidance
 * has documented the trap in prose since #3567, and it was walked into anyway,
 * because prose cannot fail. This file can.
 *
 * It deliberately imports NOTHING from the submodule — a guard that fails to
 * load for the very reason it exists to report is not a guard.
 *
 * Fix when this goes red:
 *     git submodule update --init --recursive
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const GITMODULES = path.join(REPO_ROOT, '.gitmodules');

/**
 * The submodule paths git itself is configured to have, read from `.gitmodules`
 * rather than hardcoded. Deriving the population from the source of truth means
 * a submodule added later is covered without anyone remembering to come here.
 */
function declaredSubmodulePaths(): string[] {
  const text = readFileSync(GITMODULES, 'utf8');
  return [...text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((m) => m[1]);
}

const DECLARED = declaredSubmodulePaths();

describe('git submodules are checked out', () => {
  /**
   * Positive control. `it.each` over an empty array generates zero cases and
   * reports green, so a `.gitmodules` that stopped parsing would turn the check
   * below into a vacuous pass — the same failure shape this file exists to
   * catch, one level up.
   */
  it('reads at least one submodule out of .gitmodules (positive control)', () => {
    expect(existsSync(GITMODULES)).toBe(true);
    expect(DECLARED.length).toBeGreaterThan(0);
    // Named explicitly: this is the one whose absence removes ~971 tests. If it
    // is ever renamed or removed, this line is where that decision surfaces.
    expect(DECLARED).toContain('event-engine-common');
  });

  it.each(DECLARED)('`%s` is checked out and non-empty', (rel) => {
    const abs = path.join(REPO_ROOT, rel);

    expect(
      existsSync(abs),
      `submodule "${rel}" is not checked out. Suites that import through it will ` +
        `collect 0 tests instead of failing, so the run's failed-test count will ` +
        `read 0 while hundreds of tests silently do not run. ` +
        `Fix: git submodule update --init --recursive`
    ).toBe(true);

    expect(statSync(abs).isDirectory(), `submodule "${rel}" exists but is not a directory`).toBe(
      true
    );

    // An empty directory is what an uninitialised submodule leaves behind, and
    // it passes an existence check. The gitlink placeholder is a directory too.
    expect(
      readdirSync(abs).length,
      `submodule "${rel}" is present but EMPTY — an uninitialised gitlink. ` +
        `Fix: git submodule update --init --recursive`
    ).toBeGreaterThan(0);
  });

  /**
   * The specific entry points the failing imports resolved through. Directory
   * non-emptiness alone would pass on a partial checkout, and a partial
   * checkout produces the identical vanish-without-failing symptom.
   */
  it.each([
    'event-engine-common/index.ts',
    'event-engine-common/feeds',
    'event-engine-common/services',
  ])('`%s` resolves', (rel) => {
    expect(
      existsSync(path.join(REPO_ROOT, rel)),
      `"${rel}" is missing. Fix: git submodule update --init --recursive`
    ).toBe(true);
  });
});

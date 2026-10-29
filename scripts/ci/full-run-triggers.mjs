// Shared by the two PR-scoped CI selectors in .github/workflows/lint.yml: lint-targets.mjs (which
// files ESLint/Prettier check) and unit-targets.mjs (which unit test files run). Each narrows a PR
// run to what the PR touched, and each must fall back to everything when the PR changes something
// that moves results for files it did NOT touch. The dependency set and the workflow itself are
// that for both, so the list lives here once; each script adds its own tool-specific triggers.

import { execFileSync } from 'node:child_process';

export const DEPENDENCY_TRIGGERS = [
  /^package\.json$/, // tool versions, pnpm overrides
  /^pnpm-lock\.yaml$/, // resolved versions of the same
  /^packages\/[^/]+\/package\.json$/,
  /^\.github\/workflows\/lint\.yml$/,
];

export const matchesAny = (patterns, file) => patterns.some((re) => re.test(file));

/**
 * Paths changed on `<baseRef>...HEAD`: the PR's own changes since it left the base.
 * --no-renames: with rename detection a moved file is listed under its NEW path only, so moving a
 * trigger file away would hide it.
 */
export function changedFiles(baseRef, cwd = process.cwd()) {
  return execFileSync('git', ['diff', '--name-only', '--no-renames', `${baseRef}...HEAD`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
}

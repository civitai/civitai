/**
 * Guard proofs for `scripts/ci/assert-apps-paths-filter.mjs`, which keeps the `paths:` filter of
 * `.github/workflows/apps.yml` in step with what the app suites read.
 *
 * Each derivation is driven against a throwaway repo where the right answer is known, and each is
 * shown to go red when the filter lacks the input, so a scan that silently finds nothing cannot
 * pass here. The last case runs it against this repo, which is the check that matters on `main`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { checkAppsPathsFilter, globToRegExp } from '../ci/assert-apps-paths-filter.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const BASE_PATHS = ['apps/**', 'packages/**', '.github/workflows/apps.yml', 'vitest.config.mts'];

function makeRepo(files: Record<string, string>, paths: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'apps-paths-filter-'));
  roots.push(root);
  const workflow = [
    'on:',
    '  pull_request:',
    '    paths:',
    ...paths.map((p) => `      - '${p}'`),
    'jobs:',
    '  apps:',
    '    steps:',
    '      - name: Tests',
    '        run: pnpm run test:apps:run',
  ].join('\n');
  const all: Record<string, string> = {
    '.github/workflows/apps.yml': workflow,
    'package.json': JSON.stringify({ scripts: { 'test:apps:run': 'node scripts/run-apps.mjs' } }),
    'vitest.config.mts': '',
    'scripts/run-apps.mjs': '',
    'apps/a/src/x.test.ts': '',
    'packages/p/index.ts': '',
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const PASSING = [...BASE_PATHS, 'scripts/run-apps.mjs'];

describe('assert-apps-paths-filter', () => {
  it('passes when the filter covers every derived input', () => {
    const result = checkAppsPathsFilter(makeRepo({}, PASSING));
    expect(result.uncovered).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.negated).toEqual([]);
  });

  it('requires a root file an app test reads through a ../ path', () => {
    const files = {
      'src/copy.ts': '',
      'apps/a/src/lib/t.test.ts': "new URL('../../../../src/copy.ts', import.meta.url)",
    };
    expect(checkAppsPathsFilter(makeRepo(files, PASSING)).uncovered).toEqual([
      'src/copy.ts (read by apps/a/src/lib/t.test.ts)',
    ]);
    expect(checkAppsPathsFilter(makeRepo(files, [...PASSING, 'src/copy.ts'])).uncovered).toEqual(
      []
    );
  });

  it('requires a directory an app test reads as the whole tree under it', () => {
    const files = {
      'db/init/01.sql': '',
      'apps/a/src/t.test.ts': "new URL('../../../db/init/', import.meta.url)",
    };
    expect(checkAppsPathsFilter(makeRepo(files, PASSING)).uncovered).toEqual([
      'db/init/** (read by apps/a/src/t.test.ts)',
    ]);
    expect(checkAppsPathsFilter(makeRepo(files, [...PASSING, 'db/**'])).uncovered).toEqual([]);
  });

  it('does not require a path an app names inside apps/ or packages/', () => {
    const files = { 'apps/a/src/t.test.ts': "import x from '../../../packages/p/index.ts';" };
    expect(checkAppsPathsFilter(makeRepo(files, PASSING)).uncovered).toEqual([]);
  });

  it('follows the root vitest config through its relative imports', () => {
    const files = {
      'vitest.config.mts': "import a from './scripts/a.mjs';",
      'scripts/a.mjs': "export { b } from './nested/b.mjs';",
      'scripts/nested/b.mjs': '',
    };
    expect(checkAppsPathsFilter(makeRepo(files, PASSING)).uncovered).toEqual([
      'scripts/a.mjs (loaded with the root vitest config)',
      'scripts/nested/b.mjs (loaded with the root vitest config)',
    ]);
  });

  it('follows `pnpm run` and `pnpm install` hooks to the scripts they run', () => {
    const files = {
      'package.json': JSON.stringify({
        scripts: {
          'test:apps:run': 'pnpm run inner',
          inner: 'node scripts/inner.mjs --x',
          postinstall: 'node scripts/gen.js',
        },
      }),
      'scripts/inner.mjs': '',
      'scripts/gen.js': '',
      '.github/workflows/apps.yml': [
        'on:',
        '  pull_request:',
        '    paths:',
        ...BASE_PATHS.map((p) => `      - '${p}'`),
        'jobs:',
        '  apps:',
        '    steps:',
        '      - name: Install',
        '        run: pnpm install --frozen-lockfile',
        '      - name: Tests',
        '        run: pnpm run test:apps:run',
      ].join('\n'),
    };
    expect(checkAppsPathsFilter(makeRepo(files, BASE_PATHS)).uncovered).toEqual([
      'scripts/gen.js (run by step "Install")',
      'scripts/inner.mjs (run by step "Tests")',
    ]);
  });

  it('reports a filter entry that matches nothing on disk', () => {
    expect(checkAppsPathsFilter(makeRepo({}, [...PASSING, 'gone/**'])).stale).toEqual(['gone/**']);
  });

  it('matches globs the way GitHub does: * stays within a segment, ** crosses them', () => {
    expect(globToRegExp('scripts/*.mjs').test('scripts/a.mjs')).toBe(true);
    expect(globToRegExp('scripts/*.mjs').test('scripts/ci/a.mjs')).toBe(false);
    expect(globToRegExp('apps/**').test('apps/a/src/x.ts')).toBe(true);
    expect(globToRegExp('package.json').test('apps/a/package.json')).toBe(false);
    expect(() => globToRegExp('src/{a,b}.ts')).toThrow(/unsupported glob/);
  });

  it('passes on this repository', () => {
    expect(checkAppsPathsFilter(REPO)).toEqual({
      negated: [],
      uncovered: [],
      stale: [],
      staleExemptions: [],
    });
  });
});

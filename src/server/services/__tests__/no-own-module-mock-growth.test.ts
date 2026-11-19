import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Ratchet: no test file may `vi.mock` more of this repo's own modules than its entry in
 * own-module-mock-baseline.json (no entry = none). Only `BOUNDARY` modules are exempt. The
 * baseline only goes down: a file that drops mocks fails until its entry is lowered.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BASELINE_PATH = path.join(REPO_ROOT, 'src/__tests__/mocks/own-module-mock-baseline.json');

const BOUNDARY = [
  'src/env/',
  'src/server/db/',
  'src/server/redis/',
  'src/server/clickhouse/',
  'src/server/meilisearch/',
  'src/server/prom/',
  'src/server/logging/',
  'src/server/flipt/',
  'src/utils/s3-',
];

const MOCK_CALL = /\bvi\s*\.\s*(?:do)?[mM]ock\(\s*(['"`])([^'"`]+)\1/g;

function ownModuleMocks(file: string): string[] {
  const code = fs
    .readFileSync(path.join(REPO_ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const own: string[] = [];
  for (const [, , specifier] of code.matchAll(MOCK_CALL)) {
    let target: string;
    if (specifier.startsWith('~/')) target = 'src/' + specifier.slice(2);
    else if (specifier.startsWith('.'))
      target = path
        .relative(REPO_ROOT, path.resolve(REPO_ROOT, path.dirname(file), specifier))
        .split(path.sep)
        .join('/');
    else continue;
    if (!BOUNDARY.some((b) => target.startsWith(b))) own.push(specifier);
  }
  return own;
}

// Called inside the tests: a throw at collection time would silently drop the guard from a run.
function scan() {
  const files = fs
    .globSync(['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.{ts,mts}'], { cwd: REPO_ROOT })
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => fs.statSync(path.join(REPO_ROOT, f)).isFile());
  const actual = new Map<string, string[]>();
  for (const file of files) {
    const own = ownModuleMocks(file);
    if (own.length) actual.set(file, own);
  }
  const baseline: Record<string, number> = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  return { files, actual, baseline };
}

describe('own-module vi.mock ratchet', () => {
  it('scans the real suite', () => {
    const { files, actual } = scan();
    expect(files.length).toBeGreaterThan(5000);
    expect(actual.size).toBeGreaterThan(0);
  });

  it('no test file mocks more of its own modules than its baseline', () => {
    const { actual, baseline } = scan();
    const grown = [...actual]
      .filter(([file, own]) => own.length > (baseline[file] ?? 0))
      .map(
        ([file, own]) =>
          `  ${file}: ${own.length} (baseline ${baseline[file] ?? 0})\n    ${own.join('\n    ')}`
      );
    if (grown.length)
      throw new Error(
        `Own-module vi.mock calls grew in ${grown.length} file(s). Mock only a process boundary ` +
          `(${BOUNDARY.join(', ')}); otherwise test the rule as a function of its inputs or pass ` +
          `the dependency in (.claude/rules/testing.md). Don't raise the baseline.\n\n` +
          grown.join('\n')
      );
  });

  it('has a baseline no looser than the files', () => {
    const { actual, baseline } = scan();
    const stale = Object.entries(baseline)
      .filter(([file, count]) => (actual.get(file)?.length ?? 0) < count)
      .map(([file]) => {
        const now = actual.get(file)?.length ?? 0;
        return now ? `  "${file}": ${now}` : `  remove "${file}"`;
      });
    expect(
      stale,
      `Mocks went away: lower these entries in src/__tests__/mocks/own-module-mock-baseline.json`
    ).toEqual([]);
  });
});

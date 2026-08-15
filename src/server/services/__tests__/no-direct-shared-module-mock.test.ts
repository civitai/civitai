import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { globSync } from 'fs';
import { describe, expect, it } from 'vitest';

/**
 * A test file must not `vi.mock` a shared infra module that has a canonical mock.
 *
 * With `isolate: false` an ordinary source module that imports one of these is evaluated
 * ONCE per worker and captures its bindings then. A per-file `vi.mock` therefore freezes
 * that one file's mock shape into every later file in the same worker — which is why a
 * file with no `vi.mock` at all can fail with `No "safeError" export is defined on the
 * mock`. One canonical registration in src/__tests__/setup.ts removes the question; a
 * single hold-out re-poisons the worker.
 *
 * So this is a RATCHET, not a snapshot. The allowlist is the set of files not yet
 * migrated, it may only shrink, and its length is the migration's progress.
 *
 * See docs/testing/shared-module-mocks.md and
 * scripts/test-perf/codemod-shared-mocks.mjs.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'src/__tests__/mocks/direct-mock-allowlist.json');

const CANONICAL_SPECIFIERS = [
  '~/server/db/client',
  '~/server/redis/client',
  '~/server/logging/client',
];

/** `vi.mock('<spec>'` in either quote style. Deliberately textual: this runs over ~1,000
 * files on every `test:lint-rules`, and a parse of each is not worth the seconds. A
 * false positive is a commented-out mock, which is still worth deleting. */
const mockPattern = (spec: string) =>
  new RegExp(`vi\\.mock\\(\\s*['"\`]${spec.replace(/[/~]/g, (c) => `\\${c}`)}['"\`]`);

function findOffenders() {
  const files = globSync('src/**/*.test.ts', { cwd: REPO_ROOT });
  const offenders: Record<string, string[]> = {};
  for (const rel of files) {
    const file = rel.replace(/\\/g, '/');
    // The canonical mocks' own tests necessarily talk about these specifiers.
    if (file.startsWith('src/__tests__/mocks/')) continue;
    const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const hit = CANONICAL_SPECIFIERS.filter((spec) => mockPattern(spec).test(src));
    if (hit.length) offenders[file] = hit;
  }
  return offenders;
}

const allowlist: string[] = existsSync(ALLOWLIST_PATH)
  ? JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')).files
  : [];

describe('no-direct-shared-module-mock', () => {
  const offenders = findOffenders();

  it('adds no new direct mock of a canonical shared module', () => {
    const added = Object.keys(offenders).filter((f) => !allowlist.includes(f));
    expect(
      added,
      'These files mock a module that has a canonical mock. Use it instead — see ' +
        'docs/testing/shared-module-mocks.md — or run ' +
        '`node scripts/test-perf/codemod-shared-mocks.mjs --write <file>`.'
    ).toEqual([]);
  });

  it('keeps the allowlist honest — a migrated file must be removed from it', () => {
    // Without this the list would stop being a progress bar: entries for files that no
    // longer mock anything would pad the count and hide the remaining work.
    const stale = allowlist.filter((f) => !offenders[f]);
    expect(
      stale,
      'These files no longer mock a canonical module. Remove them from ' +
        'src/__tests__/mocks/direct-mock-allowlist.json.'
    ).toEqual([]);
  });
});

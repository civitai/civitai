import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { globSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_SPECIFIERS,
  PENDING_SPECIFIERS,
  mockPattern,
} from '~/__tests__/mocks/guarded-specifiers';

/**
 * A test file must not `vi.mock` a shared module that has a canonical mock.
 *
 * With `isolate: false` an ordinary source module that imports a mocked module is evaluated
 * ONCE per worker and captures its bindings then. A per-file `vi.mock` therefore freezes
 * that one file's mock shape into every later file in the same worker — which is why a file
 * with no `vi.mock` at all can fail with `No "safeError" export is defined on the mock`. One
 * canonical registration in src/__tests__/setup.ts removes the question; a single hold-out
 * re-poisons the worker.
 *
 * So this is a RATCHET, not a snapshot, and it fails in BOTH directions. The second
 * direction is the one that gets left out of allowlists, and it is the one that has already
 * caught something real: a merge resolution correctly took both sides of a conflict, leaving
 * three migrated files still claiming an exemption. That was the only failure in a
 * 16,806-test run, hours after the code was written, in files neither branch's author was
 * looking at — the case review does not cover.
 *
 * PENDING specifiers are counted, not enforced. See guarded-specifiers.ts for why, and for
 * why a zero here would not be enough to flip the flag.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'src/__tests__/mocks/direct-mock-allowlist.json');

function scan() {
  const files = globSync('src/**/*.test.ts', { cwd: REPO_ROOT });
  const canonical: Record<string, string[]> = {};
  const pending: Record<string, string[]> = {};
  for (const rel of files) {
    const file = rel.replace(/\\/g, '/');
    // The canonical mocks' own tests necessarily talk about these specifiers.
    if (file.startsWith('src/__tests__/mocks/')) continue;
    const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const hitCanonical = CANONICAL_SPECIFIERS.filter((s) => mockPattern(s).test(src));
    const hitPending = PENDING_SPECIFIERS.filter((s) => mockPattern(s).test(src));
    if (hitCanonical.length) canonical[file] = hitCanonical;
    if (hitPending.length) pending[file] = hitPending;
  }
  return { canonical, pending };
}

const allowlist = existsSync(ALLOWLIST_PATH)
  ? JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
  : { files: [], pendingFiles: [] };

describe('no-direct-shared-module-mock', () => {
  const { canonical, pending } = scan();

  it('adds no new direct mock of a module that has a canonical mock', () => {
    const added = Object.keys(canonical).filter((f) => !(allowlist.files ?? []).includes(f));
    expect(
      added,
      'These files mock a module that has a canonical mock. Use it instead — see ' +
        'docs/testing/shared-module-mocks.md — or run ' +
        '`node scripts/test-perf/codemod-shared-mocks.mjs --write <file>`.'
    ).toEqual([]);
  });

  it('keeps the allowlist honest — a migrated file must be removed from it', () => {
    // Without this the list would stop being a progress bar: entries for files that no
    // longer mock anything would pad the count and hide the remaining work. This is the
    // direction that caught the merge resolution.
    const stale = (allowlist.files ?? []).filter((f: string) => !canonical[f]);
    expect(
      stale,
      'These files no longer mock a canonical module. Regenerate with ' +
        '`node scripts/test-perf/gen-mock-allowlist.mjs`.'
    ).toEqual([]);
  });

  it('keeps the PENDING count current, so the remaining scope is never understated', () => {
    // Counted, not enforced — but the recorded count has to match reality, or the dashboard
    // reports a finish line that does not exist.
    expect(Object.keys(pending).length).toBe((allowlist.pendingFiles ?? []).length);
  });
});

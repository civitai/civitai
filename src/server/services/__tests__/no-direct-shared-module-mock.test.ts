import { readFileSync, existsSync, statSync } from 'fs';
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

/**
 * 🔴 Called from INSIDE the tests, never at module scope.
 *
 * It used to run in the `describe` body, so anything it threw was a COLLECTION failure: the
 * file contributed zero tests, the suite's failure count did not move, and the guard was
 * absent from every full-suite run while passing whenever invoked as a named file — which is
 * how it was checked all day. A control that is present and inert is worse than one that is
 * missing, because the reviewer stops looking. Thrown from inside a test, the same fault is a
 * red test with a stack.
 */
function scan() {
  // `{ts,tsx}` so a `.browser.test.tsx` cannot add a direct mock the guard is structurally
  // unable to see. Detection only — the codemod stays `.ts`, since the canonical mocks are
  // proven on node-project tests and browser mode is unvalidated. (donovan's finding.)
  const files = globSync('src/**/*.test.{ts,tsx}', { cwd: REPO_ROOT });
  const canonical: Record<string, string[]> = {};
  const pending: Record<string, string[]> = {};
  let scanned = 0;
  for (const rel of files) {
    const file = rel.replace(/\\/g, '/');
    // The canonical mocks' own tests necessarily talk about these specifiers.
    if (file.startsWith('src/__tests__/mocks/')) continue;
    // A full-suite run can create directories under `src/` while this walk is happening, and
    // one whose name matches the glob reaches `readFileSync` as EISDIR. Skip anything that is
    // not a regular file rather than assuming the walk only ever yields files.
    const abs = path.join(REPO_ROOT, rel);
    if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
    scanned++;
    const src = readFileSync(abs, 'utf8');
    const hitCanonical = CANONICAL_SPECIFIERS.filter((s) => mockPattern(s).test(src));
    const hitPending = PENDING_SPECIFIERS.filter((s) => mockPattern(s).test(src));
    if (hitCanonical.length) canonical[file] = hitCanonical;
    if (hitPending.length) pending[file] = hitPending;
  }
  return { canonical, pending, scanned };
}

// Parsed lazily, for the same reason `scan()` is called inside the tests rather than at module
// scope: this file is a generated 500+ entry JSON that conflicts on every parallel branch, so a
// bad merge resolution is the realistic path to malformed content. A throw here would collect
// ZERO tests and report no failures — the guard would vanish from the run rather than fail it.
// A missing file already fails closed (empty list => every direct mock is unallowlisted => red).
let allowlistCache: { files: string[]; pendingFiles: string[] } | undefined;
function readAllowlist() {
  if (allowlistCache) return allowlistCache;
  if (!existsSync(ALLOWLIST_PATH)) return (allowlistCache = { files: [], pendingFiles: [] });
  allowlistCache = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  return allowlistCache!;
}

describe('no-direct-shared-module-mock', () => {
  // POSITIVE CONTROL. Everything below is a claim about a set of files; if the walk returns
  // nothing, or a fraction of the tree, every one of those claims is vacuously true and the
  // guard reports success while checking nothing. The floor is well under the real count
  // (~1,200) so ordinary growth never trips it.
  it('actually scanned the test tree', () => {
    const { scanned } = scan();
    expect(scanned).toBeGreaterThan(800);
  });

  it('adds no new direct mock of a module that has a canonical mock', () => {
    const { canonical } = scan();
    const added = Object.keys(canonical).filter((f) => !(readAllowlist().files ?? []).includes(f));
    expect(
      added,
      'These files mock a module that has a canonical mock. Use it instead — see ' +
        'docs/testing/shared-module-mocks.md — or run ' +
        '`node scripts/test-perf/codemod-shared-mocks.mjs --write <file>`.'
    ).toEqual([]);
  });

  it('keeps the allowlist honest — a migrated file must be removed from it', () => {
    const { canonical } = scan();
    // Without this the list would stop being a progress bar: entries for files that no
    // longer mock anything would pad the count and hide the remaining work. This is the
    // direction that caught the merge resolution.
    const stale = (readAllowlist().files ?? []).filter((f: string) => !canonical[f]);
    expect(
      stale,
      'These files no longer mock a canonical module. Regenerate with ' +
        '`node scripts/test-perf/gen-mock-allowlist.mjs`.'
    ).toEqual([]);
  });

  it('keeps the PENDING count current, so the remaining scope is never understated', () => {
    const { pending } = scan();
    // Counted, not enforced — but the recorded count has to match reality, or the dashboard
    // reports a finish line that does not exist.
    expect(Object.keys(pending).length).toBe((readAllowlist().pendingFiles ?? []).length);
  });
});

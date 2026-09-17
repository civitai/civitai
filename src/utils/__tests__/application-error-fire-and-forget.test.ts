import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { reportApplicationError } from '~/utils/application-error';

/**
 * TWO CONTRACTS ON THE CLIENT-ERROR REPORTING PATH: the terminating `.catch`, and the ledger of
 * who is allowed to skip it.
 *
 * `reportApplicationError` is the one module permitted to fetch the reporting endpoint, because it
 * is where the terminating `.catch` lives — every call site is a `catch` block or a React error
 * boundary, the place a rejected promise does the most damage. Asserting that contract on the
 * helper alone would say nothing about a module that fetches the endpoint itself: the behavioural
 * cases would stay green while an unprotected raw `fetch` sat next to them. This ledger is what
 * makes the contract cover the population — it pins the caller set and fails when it GROWS.
 *
 * WHAT WAS REMOVED FROM THIS FILE, AND WHY: a set of cases asserting that a 429 resolves rather
 * than throwing. They were added alongside a per-IP rate limiter this endpoint no longer has, and
 * they would not have been worth keeping even if it did — their fixture installed a `fetch` double
 * that RESOLVES by construction, so "a 429 resolves" asserted only that a resolving mock resolves.
 * The property was supplied by the fixture, not by the code under test.
 *
 * WHAT SURVIVES THAT, AND WHY IT IS DIFFERENT: the single case below, on a REJECTING `fetch`. Its
 * fixture supplies a rejection, not a resolution, so the fulfilment it asserts can only come from
 * the terminating `.catch` in the helper. Removing that `.catch` turns this case red — watched,
 * not assumed: it fails as `expected 'rejected' to be 'fulfilled'`. That is the whole reason it is
 * here, and the only thing separating it from the vacuous shape of the cases described above.
 */

// ── The terminating catch: a real network rejection never reaches the caller ──

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('reportApplicationError — the terminating catch', () => {
  it('even a real NETWORK failure is swallowed by the terminating catch', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const settled = await Promise.allSettled([reportApplicationError(new Error('boom'))]);
    expect(settled[0].status).toBe('fulfilled');
    expect((settled[0] as PromiseFulfilledResult<undefined>).value).toBeUndefined();
  });
});

// ── The ledger: who may call this endpoint ───────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/** A call that reaches the reporting endpoint's URL, in either quote style. */
const ENDPOINT_CALL = /fetch\(\s*['"`]\/api\/application-error['"`]/;

/**
 * Comments are removed before matching, and that is not cosmetic: `src/pages/_error.tsx`
 * DISCUSSES `fetch('/api/application-error')` in a doc comment while calling the helper, so a
 * raw text scan reports it as a direct caller. A ledger that flags prose is a ledger that gets
 * an entry added to quiet it, and the entry then licenses a real raw call in that file.
 *
 * The strip is deliberately simple (block comments, then whole-line `//`), which is sound in
 * the direction that matters: it can only ever remove text, so it cannot manufacture a caller.
 * It could in principle hide one written inside a string literal that looks like a comment —
 * the negative control below is what keeps the matcher's ability to fire under test.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The complete set of modules under `src/**` permitted to fetch the endpoint
 * directly. Everything else must route through `reportApplicationError`, which
 * is where the terminating `.catch` lives.
 */
const ALLOWED_DIRECT_CALLERS = ['utils/application-error.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !/\.d\.ts$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The comparison as a FUNCTION over a file set, so the control below can feed it
 * a known-bad set and watch it go red. An assertion written inline can only ever
 * run against reality, which is exactly the arrangement in which "it passed" and
 * "it never looked" are indistinguishable.
 */
function directCallersIn(fileSet: string[]): string[] {
  return fileSet
    .filter((f) => ENDPOINT_CALL.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(SRC_ROOT, f).split(path.sep).join('/'))
    .sort();
}

describe('every caller of /api/application-error goes through the fire-and-forget helper', () => {
  const files = walk(SRC_ROOT);

  it('POSITIVE CONTROL: the walk sees a non-trivial tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('POSITIVE CONTROL: the matcher CAN match — it finds the helper itself', () => {
    // A zero from a pattern nobody has watched match is not evidence of absence.
    expect(directCallersIn(files)).toContain('utils/application-error.ts');
  });

  it('NEGATIVE CONTROL: an unprotected raw call WOULD be reported', () => {
    // Planted OUTSIDE the repo tree: a control file written into `src/` is a
    // shared-tree mutation that another worker's walk can observe, and one left
    // behind by a crashed run is a stray source file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-error-ledger-'));
    const planted = path.join(dir, 'raw-caller.ts');
    fs.writeFileSync(planted, `fetch('/api/application-error', { method: 'POST' });\n`);
    try {
      expect(directCallersIn([planted])).toHaveLength(1);
      // And it survives the comment strip, so the strip is not what makes the
      // real ledger clean.
      expect(directCallersIn([...files, planted]).length).toBe(directCallersIn(files).length + 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NEGATIVE CONTROL: a file that only MENTIONS the endpoint in prose is not a caller', () => {
    // The specific false positive this guard was built with: `src/pages/_error.tsx`
    // discusses the call in a doc comment.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-error-ledger-'));
    const planted = path.join(dir, 'prose.ts');
    fs.writeFileSync(planted, `/**\n * \`fetch('/api/application-error')\` needs a URL.\n */\n`);
    try {
      expect(directCallersIn([planted])).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the ledger matches EXACTLY — no module fetches the endpoint on its own', () => {
    expect(directCallersIn(files)).toEqual([...ALLOWED_DIRECT_CALLERS].sort());
  });
});

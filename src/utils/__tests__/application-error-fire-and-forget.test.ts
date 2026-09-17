import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { reportApplicationError } from '~/utils/application-error';

/**
 * The FIRE-AND-FORGET contract on the client-error reporting path.
 *
 * Why it is pinned here and now: `/api/application-error` gained a per-IP rate
 * limit, so it can answer **429** to a caller that previously only ever saw 200
 * or 400. Every call site is a `catch` block or a React error boundary — the
 * place a thrown or rejected promise does the most damage — so the new status
 * must be as invisible to the client as the old ones are.
 *
 * TWO INDEPENDENT REASONS IT IS INVISIBLE, and the test asserts BOTH, because
 * either alone would be enough and relying on the unstated one is how this
 * regresses:
 *
 *  1. `fetch` RESOLVES on a 4xx. It rejects only on a network-level failure, so
 *     a 429 arrives as an ordinary `Response` and no rejection exists to handle.
 *     This is the reason that holds for any caller, `.catch` or not.
 *  2. `reportApplicationError` terminates its promise with `.catch`, so even a
 *     real network failure resolves to `undefined` rather than surfacing.
 *
 * 🔴 THE LEDGER AT THE BOTTOM IS WHAT MAKES THE TWO ABOVE COVER THE POPULATION.
 * Asserting the contract on this helper says nothing about a call site that
 * fetches the endpoint itself — the behavioural cases would stay green while an
 * unprotected raw `fetch` sat next to them. The ledger pins that the helper is
 * the ONLY module in `src/**` that calls this endpoint, and fails when that set
 * grows.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** A `Response`-shaped resolution, which is what `fetch` yields for any status. */
function respondWith(status: number) {
  const fetchMock = vi.fn(async () => ({ ok: status < 400, status } as unknown as Response));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('reportApplicationError — a rate-limited response cannot reach the caller', () => {
  it('POSITIVE CONTROL: the helper really does call fetch', async () => {
    // Without this, every "it did not throw" below is satisfied by a helper that
    // never ran — the reassuring-zero shape, where nothing happening and nothing
    // going wrong are indistinguishable.
    const fetchMock = respondWith(200);
    await reportApplicationError(new Error('boom'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/application-error');
  });

  it('429 resolves rather than throwing', async () => {
    respondWith(429);
    await expect(reportApplicationError(new Error('boom'))).resolves.not.toThrow();
  });

  it('429 produces no unhandled rejection — the promise settles fulfilled', async () => {
    respondWith(429);
    const settled = await Promise.allSettled([reportApplicationError(new Error('boom'))]);
    expect(settled[0].status).toBe('fulfilled');
  });

  it('the pre-existing 400 behaves identically, so 429 introduces no new shape', async () => {
    // The comparison is the point: if a 429 were special, it would differ from a
    // status this path has always been able to return.
    respondWith(400);
    const four00 = await Promise.allSettled([reportApplicationError(new Error('boom'))]);
    respondWith(429);
    const four29 = await Promise.allSettled([reportApplicationError(new Error('boom'))]);
    expect(four29[0].status).toBe(four00[0].status);
  });

  it('even a real NETWORK failure is swallowed by the terminating catch', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const settled = await Promise.allSettled([reportApplicationError(new Error('boom'))]);
    expect(settled[0].status).toBe('fulfilled');
    expect((settled[0] as PromiseFulfilledResult<undefined>).value).toBeUndefined();
  });

  it('NEGATIVE CONTROL: the harness CAN observe a rejection when one exists', async () => {
    // Proves the `allSettled` assertions above are capable of reporting
    // 'rejected'. Without it, every one of them could be green because the
    // instrument only ever says 'fulfilled'.
    const settled = await Promise.allSettled([Promise.reject(new Error('x'))]);
    expect(settled[0].status).toBe('rejected');
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

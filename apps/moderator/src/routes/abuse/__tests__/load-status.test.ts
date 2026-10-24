import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The list page's failure-state discrimination.
 *
 * 🔴 Every branch here answers the same question for an operator — "why is this page empty?" — and a
 * wrong answer sends them somewhere useless. The two that matter most are indistinguishable without
 * the pg code: `42P01` means the DDL was never applied, `42501` means it was applied BY THE WRONG
 * ROLE (the natural `psql -U postgres` shortcut, against an app that connects as `internal_tools`).
 * Both leave a page with no rows, and merging them into "could not reach the database" describes a
 * database the app is connected to.
 *
 * These are the only tests over a route load in this app; the pages themselves are still unrendered.
 */

const { getAbuseRuns, getAbuseDetectors } = vi.hoisted(() => ({
  getAbuseRuns: vi.fn(),
  getAbuseDetectors: vi.fn(),
}));

vi.mock('$lib/server/abuse-detection.service', () => ({ getAbuseRuns, getAbuseDetectors }));

// 🔴 Required, and the failure it prevents is a COLLECTION error, not a red assertion: `+page.server`
// → `$lib/server/query` → `users.service` (for MAX_INT4) → `$lib/server/db`, which demands
// `DATABASE_REPLICA_URL` at module scope. `vitest.config.ts` withholds that variable ON PURPOSE so a
// suite forgetting this mock throws on import rather than connecting to whatever it points at — do
// not "fix" it by adding the variable. Unmocked, this file reports `Tests 93 passed (93)` while
// `Test Files 1 failed` carries the truth.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { load } = await import('../+page.server');

// The real `load` only reads `url`; SvelteKit's event carries far more, hence the cast.
const run = () =>
  (load as unknown as (e: { url: URL }) => Promise<{ status: string }>)({
    url: new URL('https://moderator.example/abuse'),
  });

beforeEach(() => {
  getAbuseRuns.mockReset();
  getAbuseDetectors.mockReset();
  getAbuseDetectors.mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('abuse list load — failure states', () => {
  it('reports ok when the read succeeds', async () => {
    getAbuseRuns.mockResolvedValue([]);
    await expect(run()).resolves.toMatchObject({ status: 'ok' });
  });

  it.each([
    ['42P01', 'no-schema'],
    ['42501', 'no-grant'],
  ])('maps pg %s to %s', async (code, status) => {
    getAbuseRuns.mockRejectedValue(Object.assign(new Error('pg'), { code }));
    await expect(run()).resolves.toMatchObject({ status });
  });

  it('reports not-configured when the connection string is missing', async () => {
    // The message `getModeratorDb()` throws — matched on the variable name, so this stays true if
    // the client is ever repointed at the other key (they resolve to one instance today).
    getAbuseRuns.mockRejectedValue(new Error('RETOOL_DATABASE_URL is not configured'));
    await expect(run()).resolves.toMatchObject({ status: 'not-configured' });
  });

  it('falls back to unreachable for anything else', async () => {
    getAbuseRuns.mockRejectedValue(Object.assign(new Error('boom'), { code: '57P01' }));
    await expect(run()).resolves.toMatchObject({ status: 'unreachable' });
  });

  it('never throws — the page renders its own explanation instead of a 500', async () => {
    getAbuseRuns.mockRejectedValue(new Error('anything'));
    await expect(run()).resolves.toMatchObject({ runs: [], detectors: [] });
  });
});

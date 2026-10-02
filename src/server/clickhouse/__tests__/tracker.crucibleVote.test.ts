import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `Tracker.crucibleVote()` — the WIRE payload, against the real ClickHouse columns.
 *
 * 🔴 WHY THIS FILE EXISTS. `send()` POSTs the tracked object verbatim to
 * `/track/<table>`; nothing in this repo maps keys to column names. So a column whose
 * name differs from its payload key is not a style difference — the value never lands.
 * `crucible_votes` shipped with snake_case columns (`crucible_id`, `created_at`, …)
 * against a camelCase payload, and because ClickHouse drops unknown JSON keys rather
 * than rejecting the row, every vote would have been written as a row of zeros with
 * no error anywhere.
 *
 * The expectations below are literal strings, taken from `SHOW CREATE TABLE
 * crucible_votes`. They read the payload from nowhere, so renaming a key in
 * `tracker.ts` — or a column, without matching it here — fails this file.
 */

vi.mock('~/env/other', () => ({ isProd: false, isDev: true }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

import { Tracker } from '../client';

/** Exactly the columns of `crucible_votes`, written as literals on purpose. */
const CRUCIBLE_VOTES_COLUMNS = [
  'userId',
  'crucibleId',
  'winnerEntryId',
  'loserEntryId',
  'createdAt',
] as const;

function lastFetchBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  const [, init] = call as [string, { body: string }];
  return JSON.parse(init.body);
}

async function emit(fetchMock: ReturnType<typeof vi.fn>) {
  const tracker = new Tracker(undefined, undefined, { user: { id: 555 } } as never);
  await tracker.crucibleVote({ crucibleId: 7, winnerEntryId: 11, loserEntryId: 12 });
  await new Promise((r) => setImmediate(r));
  return lastFetchBody(fetchMock);
}

describe('Tracker.crucibleVote wire payload', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('POSTs to the crucible_votes table', async () => {
    await emit(fetchMock);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/\/track\/crucible_votes$/);
  });

  it('sends exactly the columns crucible_votes has, and no others', async () => {
    const body = await emit(fetchMock);
    expect(Object.keys(body).sort()).toEqual([...CRUCIBLE_VOTES_COLUMNS].sort());
  });

  it('carries the vote and the voter', async () => {
    const body = await emit(fetchMock);
    expect(body).toMatchObject({
      userId: 555,
      crucibleId: 7,
      winnerEntryId: 11,
      loserEntryId: 12,
    });
    expect(typeof body.createdAt).toBe('string');
  });

  it('omits ip and userAgent — a vote is not an attribution surface', async () => {
    const body = await emit(fetchMock);
    expect(body).not.toHaveProperty('ip');
    expect(body).not.toHaveProperty('userAgent');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBuzzClient } from './client';

// The reward cap-release path passes `{ timeoutMs, retries: 0 }` to a read that otherwise
// has no deadline and retries every error class four times, inside a mutation a user is
// waiting on. The app-side suite mocks this whole module, so nothing there can see whether
// those options reach `fetch` at all - which is what this file is for.
//
// `opts?.retries ?? retries` is the line that matters most: written with `||` instead, a
// literal 0 would fall through to the client default and silently restore the old budget.

const ENDPOINT = 'http://buzz.test';

describe('per-call read options reach the transport', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ok = () => ({
    ok: true,
    status: 200,
    json: async () => ({ date: '2026-09-21T10:00:00Z' }),
  });

  it('attaches an abort signal when a timeout is given, and none when it is not', async () => {
    const client = createBuzzClient({ endpoint: ENDPOINT });
    fetchMock.mockResolvedValue(ok());

    await client.getTransactionByExternalId('abc', { timeoutMs: 1000, retries: 0 });
    await client.getTransactionByExternalId('abc');

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[1][1]?.signal).toBeUndefined();
  });

  it('makes exactly one attempt for retries: 0, and the default four without it', async () => {
    const client = createBuzzClient({ endpoint: ENDPOINT });
    fetchMock.mockRejectedValue(new Error('buzz is unwell'));

    await expect(
      client.getTransactionByExternalId('abc', { timeoutMs: 1000, retries: 0 })
    ).rejects.toThrow('buzz is unwell');
    // One, not zero: `retries` counts retries, so 0 still sends the request once.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    await expect(client.getTransactionByExternalId('abc')).rejects.toThrow('buzz is unwell');
    // The budget a caller passing nothing still gets - the number the bound exists to avoid.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('keeps allow404 when per-call options are passed', async () => {
    const client = createBuzzClient({ endpoint: ENDPOINT });
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

    // A caller's options are spread AFTER `allow404`, so they cannot displace it: a missing
    // transaction has to resolve to null rather than throw, or the cap-release path reads a
    // 404 as an error and stops distinguishing "never paid" from "paid earlier".
    await expect(
      client.getTransactionByExternalId('abc', { timeoutMs: 1000, retries: 0 })
    ).resolves.toBeNull();
  });
});

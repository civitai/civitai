import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBuzzClient } from './client';

// The reward cap-release path passes `{ timeoutMs, retries: 0 }` to a read inside a mutation a
// user is waiting on, tighter than the client's read defaults. The app-side suite mocks this whole module, so nothing there can see whether
// those options reach `fetch` at all - which is what this file is for.
//
// `opts?.retries ?? retries` is the line that matters most: written with `||` instead, a
// literal 0 would fall through to the client default and silently replace the caller's budget.

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

  it('attaches an abort signal with or without a per-call timeout, and none when switched off', async () => {
    const client = createBuzzClient({ endpoint: ENDPOINT });
    fetchMock.mockResolvedValue(ok());

    await client.getTransactionByExternalId('abc', { timeoutMs: 1000, retries: 0 });
    await client.getTransactionByExternalId('abc');
    vi.stubEnv('BUZZ_CLIENT_UNBOUNDED', 'true');
    try {
      await client.getTransactionByExternalId('abc');
    } finally {
      vi.unstubAllEnvs();
    }

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    // The default read bound: a caller passing nothing still gets a deadline.
    expect(fetchMock.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
    // The off-switch removes the default deadline.
    expect(fetchMock.mock.calls[2][1]?.signal).toBeUndefined();
  });

  it('makes exactly one attempt for retries: 0, and the default two without it', async () => {
    const client = createBuzzClient({ endpoint: ENDPOINT });
    fetchMock.mockRejectedValue(new Error('buzz is unwell'));

    await expect(
      client.getTransactionByExternalId('abc', { timeoutMs: 1000, retries: 0 })
    ).rejects.toThrow('buzz is unwell');
    // One, not zero: `retries` counts retries, so 0 still sends the request once.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    await expect(client.getTransactionByExternalId('abc')).rejects.toThrow('buzz is unwell');
    // The read default: one retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Creator Services reads the prefix listing while holding an auto-renewing lock.
  it('passes read options through on the multi-transaction listing', async () => {
    const client = createBuzzClient({ endpoint: ENDPOINT });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });

    await client.listMultiTransactions({ externalTransactionIdPrefix: 'p' }, { timeoutMs: 1000 });
    await client.listMultiTransactions({ externalTransactionIdPrefix: 'p' });

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
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

// A write the client stops waiting for has an unknown outcome: the service may still commit it,
// and a caller that reads the throw as "not charged" lets the user pay again. So writes carry no
// client deadline unless a caller asks for one.
describe('writes wait for the outcome by default', () => {
  const fetchMock = vi.fn();
  const tx = { fromAccountId: 1, toAccountId: 2, amount: 5, externalTransactionId: 'k-1' };
  const multi = {
    fromAccountTypes: ['yellow' as const],
    fromAccountId: 1,
    toAccountId: 0,
    amount: 5,
    externalTransactionIdPrefix: 'p-1',
  };
  const signalOf = (call: number) => fetchMock.mock.calls[call][1]?.signal;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends single, multi and refund writes with no abort signal when no options are passed', async () => {
    const client = createBuzzClient({ endpoint: ENDPOINT });

    await client.createTransaction(tx);
    await client.createMultiTransaction(multi);
    await client.refundMultiTransaction({ externalTransactionIdPrefix: 'p-1' });
    await client.refundTransaction('tx-1');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of [0, 1, 2, 3]) expect(signalOf(call)).toBeUndefined();
  });

  it('bounds a write when the caller asks, per call or on the client', async () => {
    await createBuzzClient({ endpoint: ENDPOINT }).createTransaction(tx, { timeoutMs: 1000 });
    const bounded = createBuzzClient({ endpoint: ENDPOINT, transactionTimeoutMs: 1000 });
    await bounded.createTransaction(tx);
    await bounded.createMultiTransaction(multi);

    for (const call of [0, 1, 2]) expect(signalOf(call)).toBeInstanceOf(AbortSignal);
  });

  it('reads keep their default bound on the same client whose writes have none', async () => {
    const client = createBuzzClient({ endpoint: ENDPOINT });
    await client.getAccount(1);
    await client.createTransaction(tx);

    expect(signalOf(0)).toBeInstanceOf(AbortSignal);
    expect(signalOf(1)).toBeUndefined();
  });

  it('sends a batch write with no abort signal when no options are passed', async () => {
    await createBuzzClient({ endpoint: ENDPOINT }).createTransactions([tx]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signalOf(0)).toBeUndefined();
  });

  it('bounds a batch write when the caller asks, per call or on the client', async () => {
    await createBuzzClient({ endpoint: ENDPOINT }).createTransactions([tx], { timeoutMs: 1000 });
    await createBuzzClient({ endpoint: ENDPOINT, transactionTimeoutMs: 1000 }).createTransactions([
      tx,
    ]);

    for (const call of [0, 1]) expect(signalOf(call)).toBeInstanceOf(AbortSignal);
  });
});

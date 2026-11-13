// vitest is the workspace root's dev dependency; package test files run from the root suite.
// eslint-disable-next-line import/no-extraneous-dependencies
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuzzApiError, createBuzzClient } from './client';

// A 409 on a refund carries the refunds that already exist, and that body is the only way a
// caller can tell which legs are still owed. These pin that the client keeps a 4xx body on the
// error, survives any body it cannot read, and changes nothing a caller already relied on.

const ENDPOINT = 'http://buzz.test';

const failing = (status: number, body: string | (() => Promise<string>)) => ({
  ok: false,
  status,
  statusText: 'Nope',
  text: typeof body === 'function' ? body : async () => body,
});

/** The error the client throws for one failing response, with no retries. */
async function errorFor(response: ReturnType<typeof failing>) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  const client = createBuzzClient({ endpoint: ENDPOINT, retries: 0 });
  const error = await client.refundMultiTransaction({ externalTransactionIdPrefix: 'p' }).then(
    () => null,
    (e: unknown) => e
  );
  return { error: error as BuzzApiError, fetchMock };
}

describe('BuzzApiError body', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a JSON 4xx body, parsed', async () => {
    const refunds = { refundedTransactions: [{ originalTransactionId: 'a' }] };
    const { error } = await errorFor(failing(409, JSON.stringify(refunds)));
    expect(error).toBeInstanceOf(BuzzApiError);
    expect(error.body).toEqual(refunds);
  });

  // The refund race 409 is a bare JSON string, not an object; it must come back as that string.
  it('keeps a bare JSON string body as the string', async () => {
    const { error } = await errorFor(
      failing(409, JSON.stringify('One or more refund transactions already exist'))
    );
    expect(error.body).toBe('One or more refund transactions already exist');
  });

  it('keeps a non-JSON 4xx body as text', async () => {
    const { error } = await errorFor(failing(400, 'Insufficient funds'));
    expect(error.body).toBe('Insufficient funds');
  });

  it('reports an empty body as absent', async () => {
    const { error } = await errorFor(failing(409, ''));
    expect(error.body).toBeUndefined();
  });

  it('reports a body that cannot be read as absent, and still throws the status', async () => {
    const { error } = await errorFor(
      failing(409, async () => {
        throw new Error('stream already consumed');
      })
    );
    expect(error).toBeInstanceOf(BuzzApiError);
    expect(error.status).toBe(409);
    expect(error.body).toBeUndefined();
  });

  it('does not read a 5xx body', async () => {
    const text = vi.fn(async () => '{"secret":"stack trace"}');
    const { error } = await errorFor({ ...failing(500, ''), text });
    expect(error.status).toBe(500);
    expect(error.body).toBeUndefined();
    expect(text).not.toHaveBeenCalled();
  });

  it('keeps the message and status existing callers see', async () => {
    const { error } = await errorFor(failing(409, '{"a":1}'));
    expect(error.message).toBe('[@civitai/buzz] request failed: 409 Nope');
    expect(error.status).toBe(409);
    expect(error.statusText).toBe('Nope');
  });

  // Errors are serialised into logs and some responses; the ledger body must not ride along.
  it('keeps the body out of anything that serialises the error', async () => {
    const { error } = await errorFor(failing(409, '{"existingRefunds":["refund-1"]}'));
    expect(error.body).toEqual({ existingRefunds: ['refund-1'] });
    expect(JSON.stringify(error)).not.toContain('existingRefunds');
    expect(JSON.stringify({ wrapped: { cause: error } })).not.toContain('existingRefunds');
  });

  it('hands mapError the error with its body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failing(409, '{"a":1}')));
    const mapError = vi.fn((error: BuzzApiError) => new Error(`mapped ${error.status}`));
    const client = createBuzzClient({ endpoint: ENDPOINT, retries: 0, mapError });
    await expect(
      client.refundMultiTransaction({ externalTransactionIdPrefix: 'p' })
    ).rejects.toThrow('mapped 409');
    expect(mapError.mock.calls[0][0].body).toEqual({ a: 1 });
  });
});

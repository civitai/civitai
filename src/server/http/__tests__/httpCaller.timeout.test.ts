import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import { settleOrHung, startHungHttpServer } from '~/server/utils/__tests__/hung-http-server';

// Every HttpCaller subclass (the payment vendors, the support desk, the reporting API, the
// orchestrator v1 client) reaches the network through these four methods. Against a dependency that
// accepts the connection and never answers, a call must come back as `{ ok: false }` inside the
// caller's own timeout, whatever state the feature-flag client is in, so it can never park a request.
//
// The flag values are keyed by their literal names: they are a contract with the flag state, which
// lives outside this repo.
const flags = vi.hoisted(() => ({ values: new Map<string, boolean | null>() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: (flag: string) => (flags.values.has(flag) ? flags.values.get(flag) : null),
}));
vi.mock('~/server/utils/errorHandling', () => ({ handleLogError: () => undefined }));

import { HttpCaller } from '~/server/http/httpCaller';

class TestCaller extends HttpCaller {
  constructor(baseUrl: string) {
    super(baseUrl, { timeout: 300 });
  }
}

let server: Awaited<ReturnType<typeof startHungHttpServer>>;
beforeAll(async () => {
  server = await startHungHttpServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => flags.values.clear());

// 300 ms timeout + 500 ms slack. A call still pending at this point is hung.
const BUDGET_MS = 800;

describe('HttpCaller against a server that never responds', () => {
  it.each([
    ['the flag client is uninitialised (every flag reads null)', [] as [string, boolean][]],
    [
      'the retired opt-in flag reads false',
      [['hot-path-fetch-timeouts', false]] as [string, boolean][],
    ],
    ['the off-switch reads false', [['outbound-fetch-timeouts-off', false]] as [string, boolean][]],
  ])('GET resolves { ok: false } within its timeout when %s', async (_label, entries) => {
    for (const [k, v] of entries) flags.values.set(k, v);
    const caller = new TestCaller(server.url);

    const started = Date.now();
    const result = await settleOrHung(caller.get('/anything'), BUDGET_MS);

    expect(result).not.toBe('hung');
    expect(result).toMatchObject({ ok: false });
    expect(Date.now() - started).toBeLessThan(BUDGET_MS);
    // The request really reached the stalled server: the timeout is what ended it.
    expect(server.requests()).toBeGreaterThan(0);
  });

  it('POST, PUT and DELETE are bounded too', async () => {
    const caller = new TestCaller(server.url);
    const results = await Promise.all([
      settleOrHung(caller.post('/p', { payload: { a: 1 } }), BUDGET_MS),
      settleOrHung(caller.put('/p', { payload: { a: 1 } }), BUDGET_MS),
      settleOrHung(caller.delete('/p'), BUDGET_MS),
    ]);
    for (const r of results) expect(r).toMatchObject({ ok: false });
  });

  it('the off-switch set to true removes the timeout (operator escape hatch)', async () => {
    flags.values.set('outbound-fetch-timeouts-off', true);
    const caller = new TestCaller(server.url);
    const pending = caller.get('/anything');
    // Well past the 300 ms timeout, the call is still waiting on the server.
    expect(await settleOrHung(pending, 1_000)).toBe('hung');
    // Let the dangling request end with the server, so it cannot leak into later files.
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import { settleOrHung, startHungHttpServer } from './hung-http-server';

// `outboundFetch` is the bounded replacement for a bare server-side `fetch`. Its contract, against a
// dependency that accepts the connection and never answers: the call rejects within its timeout,
// a caller's own signal still works, and only an explicit off-switch removes the deadline.
const flags = vi.hoisted(() => ({ values: new Map<string, boolean | null>() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: (flag: string) => (flags.values.has(flag) ? flags.values.get(flag) : null),
}));

import { outboundFetch } from '~/server/utils/fetch-timeout';

let server: Awaited<ReturnType<typeof startHungHttpServer>>;
beforeAll(async () => {
  server = await startHungHttpServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => flags.values.clear());

const settledAs = async (p: Promise<unknown>, ms: number) => {
  const r = await settleOrHung(
    p.then(
      () => 'resolved' as const,
      (e: Error) => e.name
    ),
    ms
  );
  return r;
};

describe('outboundFetch against a server that never responds', () => {
  it('rejects with a TimeoutError within its timeout when the flag client is uninitialised', async () => {
    const started = Date.now();
    expect(await settledAs(outboundFetch(server.url, { timeoutMs: 250 }), 750)).toBe(
      'TimeoutError'
    );
    expect(Date.now() - started).toBeLessThan(750);
  });

  it("a caller's own signal still aborts the request first", async () => {
    const controller = new AbortController();
    const call = outboundFetch(server.url, { timeoutMs: 5_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await settledAs(call, 750)).toBe('AbortError');
  });

  it('the timeout still applies when the caller passes a signal that never fires', async () => {
    const controller = new AbortController();
    const call = outboundFetch(server.url, { timeoutMs: 250, signal: controller.signal });
    expect(await settledAs(call, 750)).toBe('TimeoutError');
  });

  it('only the off-switch set to true removes the deadline', async () => {
    flags.values.set('outbound-fetch-timeouts-off', true);
    expect(await settledAs(outboundFetch(server.url, { timeoutMs: 250 }), 1_000)).toBe('hung');
  });
});

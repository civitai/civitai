import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The layout load awaits this on every navigation. Against a real local server that accepts the
// connection and never answers, the header must give up and render without the balance quickly.

const env: Record<string, string> = {};
vi.mock('$env/dynamic/private', () => ({ env }));

let server: Server;
let hits = 0;
beforeAll(async () => {
  server = createServer(() => {
    hits++; // never answer
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  env.BUZZ_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('header balance', () => {
  it('resolves to null in under 2s when the buzz service hangs, after one attempt', async () => {
    const { getSpendableBuzz } = await import('$lib/server/buzz');

    const started = Date.now();
    await expect(getSpendableBuzz(1)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(hits).toBe(1);
  }, 15_000);
});

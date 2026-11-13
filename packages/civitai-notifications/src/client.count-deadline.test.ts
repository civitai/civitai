import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNotificationsClient, NotificationsClientError } from './client';

// The unread count feeds a badge polled on every signed-in page, and the caller degrades to "no badge" on
// failure. So with a notifications app that accepts the connection and never answers, the count must give
// up fast and once, not after the default 10 s x 3 attempts that the write routes keep.

let server: Server;
let endpoint: string;
let requests = 0;

beforeAll(async () => {
  server = createServer(() => {
    requests++; // accept, never respond
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  requests = 0;
});

describe('countNotifications against a server that never answers', () => {
  it('rejects in under 2 s with the default config, after a single attempt', async () => {
    const client = createNotificationsClient({ endpoint, retryBaseMs: 0 });
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      client.countNotifications({ userId: 1, unread: true }).then(
        () => 'resolved' as const,
        (err: unknown) => err
      ),
      new Promise<'hung'>((r) => (timer = setTimeout(() => r('hung'), 2000))),
    ]);
    clearTimeout(timer);

    expect(outcome).toBeInstanceOf(NotificationsClientError);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(requests).toBe(1);
  });
});

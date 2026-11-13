import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotificationsClient, NotificationsClientError } from './client';

// The unread count feeds the bell badge, and the caller degrades a failure to "no badge" for the whole page
// load (it is fetched once, not polled). So the count gives up fast — two 1.5 s attempts, not the default
// 10 s x 3 the write routes keep — but does retry once, so a single blip doesn't zero the badge.

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
  it('rejects in under 4 s with the default config, after two attempts', async () => {
    const client = createNotificationsClient({ endpoint, retryBaseMs: 0 });
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      client.countNotifications({ userId: 1, unread: true }).then(
        () => 'resolved' as const,
        (err: unknown) => err
      ),
      new Promise<'hung'>((r) => (timer = setTimeout(() => r('hung'), 4000))),
    ]);
    clearTimeout(timer);

    expect(outcome).toBeInstanceOf(NotificationsClientError);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(requests).toBe(2);
  });

  it('returns the count when the first attempt fails and the retry succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ category: 'Comment', count: 4 }]), { status: 200 })
      );
    const client = createNotificationsClient({ endpoint, retryBaseMs: 0, fetch: fetchMock });
    expect(await client.countNotifications({ userId: 1, unread: true })).toEqual([
      { category: 'Comment', count: 4 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

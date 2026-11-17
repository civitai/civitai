import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNotificationsClient,
  NotificationsClientError,
  type NotificationsClientConfig,
} from './client';
import { createNotificationPendingRow } from './schema';

const validRow = {
  key: 'new-comment:model:123',
  type: 'new-comment',
  category: 'Comment' as const,
  details: { modelId: 123 },
  userIds: [1, 2],
};

// A client bound to a mock fetch + a default endpoint, with retry backoff zeroed so tests don't sleep.
function client(config: NotificationsClientConfig) {
  return createNotificationsClient({
    endpoint: 'http://127.0.0.1:9',
    retryBaseMs: 0,
    ...config,
  });
}

describe('createNotificationPendingRow', () => {
  it('accepts a userIds row', () => {
    expect(createNotificationPendingRow.parse(validRow)).toMatchObject({ key: validRow.key });
  });

  it('rejects an unknown category', () => {
    expect(() => createNotificationPendingRow.parse({ ...validRow, category: 'Nope' })).toThrow();
  });
});

describe('createNotification', () => {
  it('POSTs the validated body to `${endpoint}/notifications` with the bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    await createNotificationsClient({
      endpoint: 'http://127.0.0.1:9/',
      token: 'secret',
      fetch: fetchMock,
    }).createNotification(validRow);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9/notifications');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer secret');
    expect(JSON.parse(init.body)).toMatchObject({ key: validRow.key, category: 'Comment' });
  });

  it('does NOT retry a 4xx (bad payload / auth) — one attempt, then throws', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(client({ fetch: fetchMock }).createNotification(validRow)).rejects.toBeInstanceOf(
      NotificationsClientError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 503, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    await client({ fetch: fetchMock }).createNotification(validRow);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries transport errors up to the limit, then throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      client({ fetch: fetchMock, retries: 2 }).createNotification(validRow)
    ).rejects.toBeInstanceOf(NotificationsClientError);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('throws when no endpoint is configured', async () => {
    const prev = process.env.NOTIFICATIONS_ENDPOINT;
    delete process.env.NOTIFICATIONS_ENDPOINT;
    await expect(
      createNotificationsClient({ fetch: vi.fn() }).createNotification(validRow)
    ).rejects.toBeInstanceOf(NotificationsClientError);
    if (prev !== undefined) process.env.NOTIFICATIONS_ENDPOINT = prev;
  });
});

describe('read wrappers', () => {
  it('queryNotifications parses base rows (coercing createdAt to a Date)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 5,
            type: 'new-comment',
            category: 'Comment',
            details: { modelId: 1 },
            createdAt: '2026-07-01T00:00:00.000Z',
            read: false,
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const rows = await client({ fetch: fetchMock }).queryNotifications({ userId: 1, limit: 10 });
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:9/notifications/query');
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it('countNotifications parses category counts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ category: 'Comment', count: 3 }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const counts = await client({ fetch: fetchMock }).countNotifications({
      userId: 1,
      unread: true,
    });
    expect(counts).toEqual([{ category: 'Comment', count: 3 }]);
  });

  it('countNotifications keeps the floor flag on a capped count', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ category: 'Update', count: '10001', floor: true }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const counts = await client({ fetch: fetchMock }).countNotifications({
      userId: 1,
      unread: true,
    });
    expect(counts).toEqual([{ category: 'Update', count: 10001, floor: true }]);
  });
});

describe('onFailure sink', () => {
  it('reports ONCE on the final failure (after retries), with path/status/attempts', async () => {
    const failures: any[] = [];
    const fetchMock = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));

    await expect(
      client({
        fetch: fetchMock,
        retries: 2,
        onFailure: (f) => failures.push(f),
      }).createNotification(validRow)
    ).rejects.toBeInstanceOf(NotificationsClientError);

    expect(failures).toHaveLength(1); // one event, not one-per-attempt
    expect(failures[0]).toMatchObject({
      path: '/notifications',
      status: 503,
      retryable: true,
      attempts: 3,
    });
  });

  it('reports a 4xx immediately (attempts=1, retryable=false)', async () => {
    const failures: any[] = [];
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad', { status: 400 }));

    await expect(
      client({ fetch: fetchMock, onFailure: (f) => failures.push(f) }).createNotification(validRow)
    ).rejects.toBeInstanceOf(NotificationsClientError);

    expect(failures).toEqual([
      expect.objectContaining({
        path: '/notifications',
        status: 400,
        retryable: false,
        attempts: 1,
      }),
    ]);
  });

  it('does NOT report on success', async () => {
    const failures: any[] = [];
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    await client({ fetch: fetchMock, onFailure: (f) => failures.push(f) }).createNotification(
      validRow
    );
    expect(failures).toHaveLength(0);
  });

  it('a throwing onFailure never masks the request error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad', { status: 400 }));
    await expect(
      client({
        fetch: fetchMock,
        onFailure: () => {
          throw new Error('logger boom');
        },
      }).createNotification(validRow)
    ).rejects.toBeInstanceOf(NotificationsClientError);
  });
});

describe('createNotificationsBulk', () => {
  const row = (i: number) => ({
    key: `k:${i}`,
    type: 'new-comment',
    category: 'Comment' as const,
    users: [i],
    details: {},
  });

  it('chunks into ≤1000-row POSTs (2500 rows → 3 requests of 1000/1000/500)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const rows = Array.from({ length: 2500 }, (_, i) => row(i));

    await client({ fetch: fetchMock }).createNotificationsBulk(rows);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sizes = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).length);
    expect(sizes).toEqual([1000, 1000, 500]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:9/notifications/bulk');
  });

  it('sends nothing for an empty array', async () => {
    const fetchMock = vi.fn();
    await client({ fetch: fetchMock }).createNotificationsBulk([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendSystemNotices', () => {
  const input = {
    sendId: 'refund-b1',
    type: 'system-message' as const,
    message: 'Refunded {amount} Buzz',
    recipients: [{ userId: 1, params: { amount: '10' } }],
    sentBy: 'test',
    reason: 'hq:test',
  };
  const ok = () =>
    new Response(JSON.stringify({ sendId: 'refund-b1', mode: 'dry-run', counts: { queued: 1 } }), {
      status: 200,
    });

  it('posts a dry run by default with the notices token, never the producer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    const res = await client({
      fetch: fetchMock,
      token: 'producer',
      noticesToken: 'notices',
    }).sendSystemNotices(input);
    expect(res.counts.queued).toBe(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9/notifications/notices');
    expect(init.headers.authorization).toBe('Bearer notices');
    expect(JSON.parse(init.body).mode).toBe('dry-run');
  });

  it('sends no Authorization header when no notices token is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await client({ fetch: fetchMock, token: 'producer' }).sendSystemNotices(input);
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBeUndefined();
  });

  it('rejects a template mismatch before any request', async () => {
    const fetchMock = vi.fn();
    await expect(
      client({ fetch: fetchMock, noticesToken: 'n' }).sendSystemNotices({
        ...input,
        recipients: [{ userId: 1, params: {} }],
      })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry a 429 or a 5xx (the caller re-runs; the route is idempotent per sendId)', async () => {
    for (const status of [429, 500]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status }));
      await expect(
        client({ fetch: fetchMock, noticesToken: 'n' }).sendSystemNotices({
          ...input,
          mode: 'send',
        })
      ).rejects.toMatchObject({ status });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('getSystemNoticeSend returns null on 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    expect(
      await client({ fetch: fetchMock, noticesToken: 'n' }).getSystemNoticeSend('x')
    ).toBeNull();
  });
});

describe('test-run endpoint guard', () => {
  // A developer shell may export the opt-in; these cases assume it is off unless they set it.
  beforeEach(() => vi.stubEnv('CIVITAI_NOTIFICATIONS_ALLOW_REMOTE_IN_TEST', ''));
  afterEach(() => vi.unstubAllEnvs());

  const ok = () => vi.fn().mockResolvedValue(new Response(null, { status: 202 }));

  it('refuses a remote endpoint under a test runner, before any request', async () => {
    const fetchMock = ok();
    const onFailure = vi.fn();
    await expect(
      client({
        endpoint: 'https://notifications.example.com',
        fetch: fetchMock,
        onFailure,
      }).createNotification(validRow)
    ).rejects.toThrow(/CIVITAI_NOTIFICATIONS_ALLOW_REMOTE_IN_TEST/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ attempts: 0 }));
  });

  it.each(['http://localhost@notifications.example.com', 'http://localhost.example.com'])(
    'refuses %s (hostname is parsed, not prefix-matched)',
    async (endpoint) => {
      const fetchMock = ok();
      await expect(
        client({ endpoint, fetch: fetchMock }).createNotification(validRow)
      ).rejects.toThrow(NotificationsClientError);
      expect(fetchMock).toHaveBeenCalledTimes(0);
    }
  );

  it('refuses a remote endpoint when only NODE_ENV=test marks the run', async () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'test');
    const fetchMock = ok();
    await expect(
      client({
        endpoint: 'https://notifications.example.com',
        fetch: fetchMock,
      }).createNotification(validRow)
    ).rejects.toThrow(NotificationsClientError);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('refuses a remote endpoint when only VITEST marks the run', async () => {
    vi.stubEnv('VITEST', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    const fetchMock = ok();
    await expect(
      client({
        endpoint: 'https://notifications.example.com',
        fetch: fetchMock,
      }).createNotification(validRow)
    ).rejects.toThrow(NotificationsClientError);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('does not echo an unparseable endpoint (it may carry credentials)', async () => {
    await expect(
      client({ endpoint: 'http://user:secret@notif:99999', fetch: ok() }).createNotification(
        validRow
      )
    ).rejects.toThrow(/^(?!.*secret).*\(unparseable\)/);
  });

  it('does not follow a redirect from a loopback endpoint', async () => {
    const servers: Server[] = [];
    const listen = (handler: Parameters<typeof createServer>[1]) =>
      new Promise<number>((resolve) => {
        const server = createServer(handler);
        servers.push(server);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      });
    let targetHits = 0;
    try {
      const targetPort = await listen((_req, res) => {
        targetHits++;
        res.writeHead(202).end();
      });
      const stubPort = await listen((_req, res) => {
        res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/elsewhere` }).end();
      });
      await expect(
        client({
          endpoint: `http://127.0.0.1:${stubPort}`,
          fetch: globalThis.fetch,
          retries: 0,
        }).createNotification(validRow)
      ).rejects.toThrow(NotificationsClientError);
      expect(targetHits).toBe(0);
    } finally {
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    }
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:9', 'http://[::1]:8080'])(
    'allows loopback %s under a test runner',
    async (endpoint) => {
      const fetchMock = ok();
      await client({ endpoint, fetch: fetchMock }).createNotification(validRow);
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  );

  it('allows a remote endpoint outside a test runner', async () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    const fetchMock = ok();
    await client({
      endpoint: 'https://notifications.example.com',
      fetch: fetchMock,
    }).createNotification(validRow);
    expect(fetchMock.mock.calls[0][0]).toBe('https://notifications.example.com/notifications');
  });

  it('allows a remote endpoint under a test runner only with the explicit opt-in set to 1', async () => {
    vi.stubEnv('CIVITAI_NOTIFICATIONS_ALLOW_REMOTE_IN_TEST', 'true');
    const refused = ok();
    await expect(
      client({ endpoint: 'https://notifications.example.com', fetch: refused }).createNotification(
        validRow
      )
    ).rejects.toThrow(NotificationsClientError);
    expect(refused).toHaveBeenCalledTimes(0);

    vi.stubEnv('CIVITAI_NOTIFICATIONS_ALLOW_REMOTE_IN_TEST', '1');
    const allowed = ok();
    await client({
      endpoint: 'https://notifications.example.com',
      fetch: allowed,
    }).createNotification(validRow);
    expect(allowed).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from 'vitest';
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
  return createNotificationsClient({ endpoint: 'http://notif.internal', retryBaseMs: 0, ...config });
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
      endpoint: 'http://notif.internal/',
      token: 'secret',
      fetch: fetchMock,
    }).createNotification(validRow);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://notif.internal/notifications');
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
    expect(fetchMock.mock.calls[0][0]).toBe('http://notif.internal/notifications/query');
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it('countNotifications parses category counts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ category: 'Comment', count: 3 }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const counts = await client({ fetch: fetchMock }).countNotifications({ userId: 1, unread: true });
    expect(counts).toEqual([{ category: 'Comment', count: 3 }]);
  });
});

describe('onFailure sink', () => {
  it('reports ONCE on the final failure (after retries), with path/status/attempts', async () => {
    const failures: any[] = [];
    const fetchMock = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));

    await expect(
      client({ fetch: fetchMock, retries: 2, onFailure: (f) => failures.push(f) }).createNotification(
        validRow
      )
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
      expect.objectContaining({ path: '/notifications', status: 400, retryable: false, attempts: 1 }),
    ]);
  });

  it('does NOT report on success', async () => {
    const failures: any[] = [];
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    await client({ fetch: fetchMock, onFailure: (f) => failures.push(f) }).createNotification(validRow);
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
    expect(fetchMock.mock.calls[0][0]).toBe('http://notif.internal/notifications/bulk');
  });

  it('sends nothing for an empty array', async () => {
    const fetchMock = vi.fn();
    await client({ fetch: fetchMock }).createNotificationsBulk([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

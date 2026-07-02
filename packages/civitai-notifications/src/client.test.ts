import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countNotifications,
  createNotification,
  createNotificationsBulk,
  NotificationsClientError,
  queryNotifications,
  setNotificationsFailureLogger,
} from './client';
import { createNotificationPendingRow } from './schema';

const validRow = {
  key: 'new-comment:model:123',
  type: 'new-comment',
  category: 'Comment' as const,
  details: { modelId: 123 },
  userIds: [1, 2],
};

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
    await createNotification(validRow, {
      endpoint: 'http://notif.internal/',
      token: 'secret',
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://notif.internal/notifications');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer secret');
    expect(JSON.parse(init.body)).toMatchObject({ key: validRow.key, category: 'Comment' });
  });

  it('throws NotificationsClientError on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(
      createNotification(validRow, { endpoint: 'http://notif.internal', fetch: fetchMock })
    ).rejects.toBeInstanceOf(NotificationsClientError);
  });

  it('does NOT retry a 4xx (bad payload / auth) — one attempt, then throws', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(
      createNotification(validRow, { endpoint: 'http://notif.internal', fetch: fetchMock, retryBaseMs: 0 })
    ).rejects.toBeInstanceOf(NotificationsClientError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 503, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    await createNotification(validRow, {
      endpoint: 'http://notif.internal',
      fetch: fetchMock,
      retryBaseMs: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries transport errors up to the limit, then throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      createNotification(validRow, {
        endpoint: 'http://notif.internal',
        fetch: fetchMock,
        retries: 2,
        retryBaseMs: 0,
      })
    ).rejects.toBeInstanceOf(NotificationsClientError);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('throws when no endpoint is configured', async () => {
    const prev = process.env.NOTIFICATIONS_ENDPOINT;
    delete process.env.NOTIFICATIONS_ENDPOINT;
    await expect(createNotification(validRow, { fetch: vi.fn() })).rejects.toBeInstanceOf(
      NotificationsClientError
    );
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
    const rows = await queryNotifications(
      { userId: 1, limit: 10 },
      { endpoint: 'http://notif.internal', fetch: fetchMock }
    );
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
    const counts = await countNotifications(
      { userId: 1, unread: true },
      { endpoint: 'http://notif.internal', fetch: fetchMock }
    );
    expect(counts).toEqual([{ category: 'Comment', count: 3 }]);
  });
});

describe('setNotificationsFailureLogger', () => {
  afterEach(() => setNotificationsFailureLogger(undefined));

  it('reports ONCE on the final failure (after retries), with path/status/attempts', async () => {
    const failures: any[] = [];
    setNotificationsFailureLogger((f) => failures.push(f));
    const fetchMock = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));

    await expect(
      createNotification(validRow, {
        endpoint: 'http://notif.internal',
        fetch: fetchMock,
        retries: 2,
        retryBaseMs: 0,
      })
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
    setNotificationsFailureLogger((f) => failures.push(f));
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad', { status: 400 }));

    await expect(
      createNotification(validRow, { endpoint: 'http://notif.internal', fetch: fetchMock, retryBaseMs: 0 })
    ).rejects.toBeInstanceOf(NotificationsClientError);

    expect(failures).toEqual([
      expect.objectContaining({ path: '/notifications', status: 400, retryable: false, attempts: 1 }),
    ]);
  });

  it('does NOT report on success', async () => {
    const failures: any[] = [];
    setNotificationsFailureLogger((f) => failures.push(f));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    await createNotification(validRow, { endpoint: 'http://notif.internal', fetch: fetchMock });
    expect(failures).toHaveLength(0);
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

    await createNotificationsBulk(rows, { endpoint: 'http://notif.internal', fetch: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sizes = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).length);
    expect(sizes).toEqual([1000, 1000, 500]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://notif.internal/notifications/bulk');
  });

  it('sends nothing for an empty array', async () => {
    const fetchMock = vi.fn();
    await createNotificationsBulk([], { endpoint: 'http://notif.internal', fetch: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

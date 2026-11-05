import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
}));

// The real package client over a fake fetch, so the 404 below is the one an old notifications
// app (no mark-read-by-key route) actually produces.
vi.mock('~/server/notifications/client', async () => {
  const { createNotificationsClient } = await import('@civitai/notifications');
  return {
    notifications: createNotificationsClient({
      endpoint: 'http://127.0.0.1:1',
      token: 't',
      fetch: h.fetch as unknown as typeof fetch,
      retries: 0,
    }),
  };
});

import { markImageMilestonesRead } from '~/server/services/notification.service';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => h.fetch.mockReset());

describe('markImageMilestonesRead', () => {
  it("asks for the caller's every milestone key on that image and returns what was cleared", async () => {
    h.fetch.mockResolvedValue(json(200, [{ category: 'Milestone', count: '2' }]));

    const cleared = await markImageMilestonesRead({ userId: 7, imageId: 42 });

    expect(cleared).toEqual([{ category: 'Milestone', count: 2 }]);
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:1/notifications/mark-read-by-key');
    expect(JSON.parse(init.body as string)).toEqual({
      userId: 7,
      keys: [5, 10, 20, 50, 100].map((n) => `image-reaction-milestone:42:${n}`),
    });
  });

  it('clears nothing, without throwing, against a notifications app that predates the route', async () => {
    h.fetch.mockResolvedValue(
      json(404, { message: 'Route POST:/notifications/mark-read-by-key not found' })
    );

    await expect(markImageMilestonesRead({ userId: 7, imageId: 42 })).resolves.toEqual([]);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});

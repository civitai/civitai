import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
}));

// The real monolith client (src/server/notifications/client.ts) over a fake fetch, so a failure takes
// the same onFailure -> logToAxiom path production does.
vi.mock('~/env/server', () => ({
  env: {
    LOGGING: [] as string[],
    NOTIFICATIONS_ENDPOINT: 'http://127.0.0.1:1',
    NOTIFICATIONS_TOKEN: 't',
  },
}));
vi.mock('~/server/notifications/client', (importOriginal) => importOriginal());

import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { markImageMilestonesRead } from '~/server/services/notification.service';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const failureLogs = () =>
  (loggingMock.logToAxiom.mock.calls as [{ name?: string }][]).filter(
    ([log]) => log?.name === 'notifications-request-failed'
  );

beforeEach(() => {
  h.fetch.mockReset();
  loggingMock.logToAxiom.mockClear();
  vi.stubGlobal('fetch', h.fetch);
});
afterEach(() => vi.unstubAllGlobals());

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
    expect(failureLogs()).toHaveLength(0);
  });

  it('clears nothing, without throwing, against a notifications app that predates the route', async () => {
    h.fetch.mockResolvedValue(
      json(404, { message: 'Route POST:/notifications/mark-read-by-key not found' })
    );

    await expect(markImageMilestonesRead({ userId: 7, imageId: 42 })).resolves.toEqual([]);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  // An outage must not break the badge, but it must still surface: absorbing it here is safe only
  // because the shared client has already logged it. Don't add a second log in the service.
  it('returns [] on a 5xx, and the outage is logged once as notifications-request-failed', async () => {
    h.fetch.mockResolvedValue(json(500, { message: 'boom' }));

    await expect(markImageMilestonesRead({ userId: 7, imageId: 42 })).resolves.toEqual([]);
    expect(failureLogs()).toHaveLength(1);
    expect(failureLogs()[0][0]).toMatchObject({
      path: '/notifications/mark-read-by-key',
      status: 500,
    });
  });
});

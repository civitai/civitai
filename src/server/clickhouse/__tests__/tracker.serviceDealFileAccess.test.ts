import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/env/other', () => ({ isProd: false, isDev: true }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

import { Tracker } from '../client';

describe('Tracker.serviceDealFileAccess', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("writes the caller's own user id, not the session's, and no ip or user agent", async () => {
    // The moderator app calls with its own credential; the session here is not the moderator.
    const tracker = new Tracker(undefined, undefined, { user: { id: 555 } } as never);
    await tracker.serviceDealFileAccess({
      dealId: 7,
      fileId: 70,
      userId: 2,
      role: 'Buyer',
      kind: 'Download',
    });
    await new Promise((r) => setImmediate(r));

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('http://tracker.test/track/serviceDealFileAccess');
    expect(JSON.parse(init.body)).toEqual({
      dealId: 7,
      fileId: 70,
      userId: 2,
      role: 'Buyer',
      kind: 'Download',
      time: expect.any(String),
    });
  });

  it('rejects when the row could not be delivered, if asked to wait', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'nats timeout' });
    const tracker = new Tracker(undefined, undefined, null);
    await expect(
      tracker.serviceDealFileAccess(
        { dealId: 7, fileId: 70, userId: 2, role: 'Buyer', kind: 'Download' },
        { awaitDelivery: true }
      )
    ).rejects.toThrow();
  });
});

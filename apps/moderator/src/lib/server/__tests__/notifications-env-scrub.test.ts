import { afterEach, describe, expect, it, vi } from 'vitest';

import { getNotifications } from '../notifications';

// 🔴 Do not delete: pins the scrub in src/test/env.mock.ts that keeps a shell's real notifications
// credentials from turning a test run into real notifications.
describe('a moderator test cannot reach the notifications service', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('finds no endpoint even when the shell exported one', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    const row = { type: 'test', key: 'k', category: 'System', userId: 2, details: {} } as never;
    await expect(getNotifications().createNotification(row)).rejects.toThrow(
      /No notifications endpoint configured/
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

import { createNotificationsClient } from '@civitai/notifications';
import { describe, expect, it, vi } from 'vitest';

import { notifications } from '~/server/notifications/client';
import {
  takeUnmockedNotificationCalls,
  UnmockedNotificationsCallError,
} from '~/__tests__/mocks/notifications-client.mock';

const row = { type: 'test', key: 'k', category: 'System', userId: 2, details: {} } as never;

// 🔴 Do not delete. A test run from a shell holding real notifications credentials once sent
// real notifications to fixture user ids; these pin the two setup.ts guards that stop it.
describe('no unit test can reach the notifications service', () => {
  it('the app client is a stub that refuses every call unless the file mocks it', async () => {
    await expect(notifications.createNotification(row)).rejects.toBeInstanceOf(
      UnmockedNotificationsCallError
    );
    // Drained so setup's afterEach, which fails the test on any recorded call, passes here.
    expect(takeUnmockedNotificationCalls()).toEqual(['createNotification']);
  });

  it('a client built from the package finds no endpoint in the environment', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    await expect(createNotificationsClient({ fetch }).createNotification(row)).rejects.toThrow(
      /No notifications endpoint configured/
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

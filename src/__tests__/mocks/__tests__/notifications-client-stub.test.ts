import { createNotificationsClient } from '@civitai/notifications';
import { describe, expect, it, vi } from 'vitest';

import { notifications } from '~/server/notifications/client';
import {
  takeUnmockedNotificationCalls,
  UnmockedNotificationsCallError,
} from '~/__tests__/mocks/notifications-client.mock';

const row = { type: 'test', key: 'k', category: 'System', userId: 2, details: {} } as never;

// 🔴 Do not delete: these pin the setup.ts guards that keep a shell's real notifications
// credentials from turning a test run into real notifications.
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

describe('an un-mocked notifications call', () => {
  // setup.ts's afterEach must turn a swallowed call into a failure; `fails` inverts that.
  it.fails('fails the test even when the caller swallows the error', async () => {
    await notifications.createNotification(row).catch(() => undefined);
  });
});

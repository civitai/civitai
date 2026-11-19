import { vi } from 'vitest';

/**
 * The stand-in for `~/server/notifications/client`, registered for every unit test file in
 * setup.ts. A test must never reach the real notifications service: the real client falls
 * back to `process.env.NOTIFICATIONS_ENDPOINT`/`NOTIFICATIONS_TOKEN`, so a run from a shell
 * holding real credentials would create real notifications (and emails) for fixture user ids.
 *
 * Every method rejects with `UnmockedNotificationsCallError` and records the call, and setup.ts
 * fails the test that made it. A test that expects notifications mocks the module itself
 * (`vi.mock('~/server/notifications/client', …)`), which replaces this stub for that file.
 */
export class UnmockedNotificationsCallError extends Error {
  constructor(method: string) {
    super(
      `Un-mocked notifications client call in a test: notifications.${method}(). ` +
        `Tests must never reach the notifications service; mock '~/server/notifications/client' in this file.`
    );
    this.name = 'UnmockedNotificationsCallError';
  }
}

/** Calls that reached the stub since the last `takeUnmockedNotificationCalls()`. */
const unmockedCalls: string[] = [];

export function takeUnmockedNotificationCalls() {
  return unmockedCalls.splice(0);
}

// Kept in step with createNotificationsClient (packages/civitai-notifications/src/client.ts);
// a method missing here reads as `undefined is not a function`, which still fails loudly.
const METHODS = [
  'createNotification',
  'createNotificationsBulk',
  'queryNotifications',
  'countNotifications',
  'markNotificationsRead',
  'markNotificationsReadByKeys',
  'notificationExists',
  'cleanupNotifications',
  'sendSystemNotices',
  'getSystemNoticeSend',
] as const;

export function createNotificationsClientStub() {
  return Object.fromEntries(
    METHODS.map((method) => [
      method,
      vi.fn(async () => {
        unmockedCalls.push(method);
        throw new UnmockedNotificationsCallError(method);
      }),
    ])
  );
}

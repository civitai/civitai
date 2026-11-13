import { NotificationsClientError } from '@civitai/notifications';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NotificationsClient from '~/server/notifications/client';

/**
 * A send that fails is logged and swallowed for every caller, except one that has to know: the
 * review release marks a review announced only when its notification went out.
 */

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('~/server/notifications/client', async (importOriginal) => {
  const actual = await importOriginal<typeof NotificationsClient>();
  return {
    ...actual,
    notifications: new Proxy(actual.notifications, {
      get: (target, key) =>
        key === 'createNotification' ? send : Reflect.get(target, key as never),
    }),
  };
});

const { createNotification } = await import('~/server/services/notification.service');

const row = {
  type: 'new-review',
  key: 'new-review:1:2',
  category: 'Update',
  userId: 3,
  details: {},
};

beforeEach(() => {
  send.mockReset();
});

describe('createNotification when the send fails', () => {
  it.each([
    ['the notifications service refuses it', new NotificationsClientError('503', 503, true)],
    ['the request throws', new Error('socket hang up')],
  ])('swallows it by default (%s)', async (_label, error) => {
    send.mockRejectedValueOnce(error);

    await expect(createNotification(row as never)).resolves.toBeUndefined();
  });

  it.each([
    ['the notifications service refuses it', new NotificationsClientError('503', 503, true)],
    ['the request throws', new Error('socket hang up')],
  ])('rethrows it to a caller that asks (%s)', async (_label, error) => {
    send.mockRejectedValueOnce(error);

    await expect(createNotification(row as never, { throwOnError: true })).rejects.toBe(error);
  });
});

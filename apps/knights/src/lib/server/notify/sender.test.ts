import { describe, expect, it, vi } from 'vitest';
import { NotificationsClientError } from '@civitai/notifications';
import { BatchRejected, type NotificationBatch } from './notify.service';
import { clientConfig, makeSendBatch } from './sender';

const batch: NotificationBatch = {
  kind: 'new-images',
  type: 'knights-new-images',
  key: 'k',
  userIds: [1, 2],
};

describe('makeSendBatch', () => {
  it('posts one bulk row for the batch', async () => {
    const post = vi.fn(async () => undefined);

    await makeSendBatch(post)(batch);

    expect(post).toHaveBeenCalledWith([
      { key: 'k', type: 'knights-new-images', category: 'Other', users: [1, 2], details: {} },
    ]);
  });

  it('rejects a payload that fails the schema before anything is sent', async () => {
    const post = vi.fn();

    await expect(makeSendBatch(post)({ ...batch, key: undefined as never })).rejects.toBeInstanceOf(
      BatchRejected
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('reports a refusal as not accepted', async () => {
    const post = vi.fn().mockRejectedValue(new NotificationsClientError('slow down', 429, true));

    await expect(makeSendBatch(post)(batch)).rejects.toBeInstanceOf(BatchRejected);
  });

  it('lets a timeout through unchanged, because the batch may have been saved', async () => {
    const timeout = new NotificationsClientError('aborted', undefined, true);
    const post = vi.fn().mockRejectedValue(timeout);

    await expect(makeSendBatch(post)(batch)).rejects.toBe(timeout);
  });
});

describe('clientConfig', () => {
  it('never retries inside the client, so the error that comes back is the only attempt', () => {
    expect(
      clientConfig({ NOTIFICATIONS_ENDPOINT: 'http://x', NOTIFICATIONS_TOKEN: 't' }).retries
    ).toBe(0);
  });
});

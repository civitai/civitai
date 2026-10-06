import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isValidElement } from 'react';
import type * as Notifications from '~/utils/notifications';
import { showCreatePostError } from '~/components/Post/showCreatePostError';
import { CacheTTL } from '~/server/common/constants';
import { postRateLimits } from '~/server/schema/post.schema';

const showErrorNotification = vi.hoisted(() => vi.fn());

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showErrorNotification,
}));

const dailyRefusal = postRateLimits.find((rule) => rule.period === CacheTTL.day)?.errorMessage;
const clampRefusal = postRateLimits.find((rule) => rule.period !== CacheTTL.day)?.errorMessage;

beforeEach(() => showErrorNotification.mockClear());

describe('showCreatePostError', () => {
  it('links the daily limit to the journey and keeps the notification open', () => {
    expect(dailyRefusal).toBeDefined();
    showCreatePostError(dailyRefusal as string);

    const [args] = showErrorNotification.mock.calls[0];
    expect(args.title).toBe('Failed to create post');
    expect(args.autoClose).toBe(false);
    expect(isValidElement(args.reason)).toBe(true);
  });

  it('leaves every other error as it was', () => {
    expect(clampRefusal).toBeDefined();
    showCreatePostError(clampRefusal as string, 'Failed to create review post');

    const [args] = showErrorNotification.mock.calls[0];
    expect(args).toMatchObject({ title: 'Failed to create review post' });
    expect(args.autoClose).toBeUndefined();
    expect(args.reason).toBeUndefined();
    expect(args.error.message).toBe(clampRefusal);
  });
});

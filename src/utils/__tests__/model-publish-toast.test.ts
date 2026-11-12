import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Notifications from '~/utils/notifications';

const { showSuccessNotification } = vi.hoisted(() => ({ showSuccessNotification: vi.fn() }));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showSuccessNotification,
}));

import { notifyIfPublishHeld } from '~/utils/model-publish-toast';

beforeEach(() => vi.clearAllMocks());

describe('notifyIfPublishHeld', () => {
  it('tells the owner a waiting publish is being checked, and reports it as not published', () => {
    expect(notifyIfPublishHeld({ status: 'Draft' as never, prePublishGate: 'pending' })).toBe(true);
    expect(showSuccessNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Checking your model' })
    );
  });

  it('tells the owner a held publish is with a moderator, even on a live model', () => {
    expect(notifyIfPublishHeld({ status: 'Published' as never, prePublishGate: 'held' })).toBe(
      true
    );
    expect(showSuccessNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Submitted for review' })
    );
  });

  it('says nothing about an ordinary publish (control)', () => {
    expect(notifyIfPublishHeld({ status: 'Published' as never })).toBe(false);
    expect(showSuccessNotification).not.toHaveBeenCalled();
  });
});

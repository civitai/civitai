import { describe, it, expect } from 'vitest';
import { creatorAnnouncementNotifications } from '../creator-announcement.notifications';
import { notificationCategoryTypes } from '~/server/notifications/utils.notifications';

const processor = creatorAnnouncementNotifications['creator-announcement'];

describe('creator announcements do not fan out as notifications', () => {
  // send-notifications guards on `if (query)` — re-adding prepareQuery silently restores the fan-out.
  it('has no fan-out query', () => {
    expect(processor.prepareQuery).toBeUndefined();
  });

  it('is absent from the notification settings page', () => {
    const types = Object.values(notificationCategoryTypes)
      .flat()
      .map((entry) => entry.type);

    expect(types).not.toContain('creator-announcement');
    // A control: the list is populated, so the assertion above is not passing on an empty array.
    expect(types.length).toBeGreaterThan(0);
  });
});

describe('already-delivered notifications still render', () => {
  it('builds a message and a url from stored details', () => {
    const message = processor.prepareMessage({
      type: 'creator-announcement',
      details: { username: 'alice', title: 'New LoRA', announcementId: 42 },
    });

    expect(message?.message).toBe('alice made an announcement: New LoRA. Check it out.');
    expect(message?.url).toBe('/user/alice?announcement=42');
  });
});

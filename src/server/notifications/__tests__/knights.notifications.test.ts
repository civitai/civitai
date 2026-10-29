import { describe, expect, it } from 'vitest';
import { deriveNotificationSettings } from '~/components/Notifications/useNotificationSettings';
import { knightsNewOrderNotifications } from '~/server/notifications/new-order.notifications';
import {
  isOptInNotification,
  notificationCategoryTypes,
  notificationTypes,
} from '~/server/notifications/utils.notifications';

const TYPES = ['knights-verdicts-in', 'knights-streak-ends-soon', 'knights-new-images'];
const SECTION = 'Knights of New Order';

describe('Knights daily-loop notifications', () => {
  it('lists the three types together under the game section, each opt-in', () => {
    const group = notificationCategoryTypes[SECTION] ?? [];

    expect(group.map((s) => s.type).sort()).toEqual([...TYPES].sort());
    expect(group.every((s) => s.optIn)).toBe(true);
    for (const type of TYPES) {
      expect(isOptInNotification(type)).toBe(true);
      // The bulk on/off toggles must never write the row that subscribes.
      expect(notificationTypes).not.toContain(type);
    }
  });

  it('keeps the game section visible although every type in it is opt-in', () => {
    expect(deriveNotificationSettings([]).hasCategory[SECTION]).toBe(true);
  });

  it('treats a settings row as subscribed, and no row as off', () => {
    const { notificationSettings } = deriveNotificationSettings([{ type: 'knights-new-images' }]);

    expect(notificationSettings['knights-new-images']).toBe(true);
    expect(notificationSettings['knights-verdicts-in']).toBe(false);
    expect(notificationSettings['knights-streak-ends-soon']).toBe(false);
  });

  it('does not let a subscription switch on the master notifications toggle', () => {
    const everything = deriveNotificationSettings([]);
    const subscribed = deriveNotificationSettings(TYPES.map((type) => ({ type })));

    expect(subscribed.hasNotifications).toBe(everything.hasNotifications);
  });

  it('links to the Knights app routes', () => {
    const open = (type: string) =>
      knightsNewOrderNotifications[type]!.prepareMessage({ type, details: {} });

    expect(open('knights-verdicts-in')?.url).toBe('https://knights.civitai.com/judgments');
    expect(open('knights-streak-ends-soon')?.url).toBe('https://knights.civitai.com/play');
    expect(open('knights-new-images')?.url).toBe('https://knights.civitai.com/play');
    expect(open('knights-new-images')?.target).toBe('_blank');
  });
});

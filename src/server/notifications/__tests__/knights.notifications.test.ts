import { describe, expect, it } from 'vitest';
import { knightsNewOrderNotifications } from '~/server/notifications/new-order.notifications';
import {
  isOptInNotification,
  notificationCategoryTypes,
  notificationTypes,
} from '~/server/notifications/utils.notifications';

const TYPES = ['knights-verdicts-in', 'knights-streak-ends-soon', 'knights-new-images'];
const SECTION = 'Knights of New Order';

describe('Knights daily-loop notifications', () => {
  it('lists the three types together under the game section, each on by default', () => {
    const group = notificationCategoryTypes[SECTION] ?? [];

    expect(group.map((s) => s.type).sort()).toEqual([...TYPES].sort());
    for (const type of TYPES) {
      // A settings row means off, written by the standard toggles (bulk ones included).
      expect(isOptInNotification(type)).toBe(false);
      expect(notificationTypes).toContain(type);
    }
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

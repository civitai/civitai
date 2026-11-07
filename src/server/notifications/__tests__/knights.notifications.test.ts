import { describe, expect, it } from 'vitest';
import { knightsNewOrderNotifications } from '~/server/notifications/new-order.notifications';
import {
  isOptInNotification,
  notificationCategoryTypes,
  notificationProcessors,
  notificationSectionTypes,
  notificationSettingGroups,
  notificationTypes,
} from '~/server/notifications/utils.notifications';

const TYPES = ['knights-verdicts-in', 'knights-streak-ends-soon', 'knights-new-images'];
const SECTION = 'Knights of New Order';

describe('Knights daily-loop notifications', () => {
  it('lists the three types together under the game section, each on by default', () => {
    const group = notificationSettingGroups[SECTION] ?? [];

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

  it('keeps sections apart from categories, and every other category as it was', () => {
    expect(Object.keys(notificationSectionTypes)).toEqual([SECTION]);
    expect(notificationCategoryTypes[SECTION]).toBeUndefined();
    for (const [category, types] of Object.entries(notificationCategoryTypes)) {
      expect(notificationSettingGroups[category]).toBe(types);
      // A category lists exactly the types registered in it that do not name a section.
      const registered = Object.entries(notificationProcessors)
        .filter(
          ([, p]) =>
            p.category === category && !p.section && (p.toggleable !== false || p.showCategory)
        )
        .map(([type]) => type);
      expect(types.map((t) => t.type).sort()).toEqual(registered.sort());
    }
  });

  it('lists every settable type in exactly one settings group', () => {
    const all = Object.values(notificationSettingGroups).flatMap((g) => g.map((t) => t.type));

    expect(new Set(all).size).toBe(all.length);
  });
});

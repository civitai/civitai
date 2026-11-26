import { describe, expect, it } from 'vitest';
import {
  appPlatformUpdateNotifications,
  type AppPlatformUpdateNotificationDetails,
} from '~/server/notifications/app-platform-update.notifications';
import { notificationProcessors } from '~/server/notifications/utils.notifications';
import { OWNER_SUBMISSIONS_URL } from '~/server/notifications/app-listing.notifications';

/**
 * The owner's notice of a staff platform update. Pinned as the whole string: the copy is the
 * product (who, that they are verified staff, why, and what happens next).
 */

type Def = (typeof appPlatformUpdateNotifications)['app-platform-update'];
const def = (appPlatformUpdateNotifications as Record<string, Def>)['app-platform-update'];

describe('app-platform-update', () => {
  it('is registered, not toggleable', () => {
    expect(notificationProcessors['app-platform-update']).toBe(def);
    expect(def.toggleable).toBe(false);
  });

  it('names the staff member, the app and the reason, and links the owner’s apps', () => {
    const details: AppPlatformUpdateNotificationDetails = {
      slug: 'pixel-garden',
      updateId: 'apu_01JABCDEFGHJKMNPQRSTVWXYZ0',
      byUsername: 'mod-ana',
      reason: 'Bump @civitai/app-sdk to 2.4.0.',
    };
    expect(def.prepareMessage({ details } as Parameters<Def['prepareMessage']>[0])).toEqual({
      message:
        'mod-ana (verified Civitai staff) pushed an update to your app "pixel-garden": ' +
        'Bump @civitai/app-sdk to 2.4.0. It is merged into your app the next time you pull it ' +
        'or open it in the App Assistant, if it applies cleanly.',
      url: OWNER_SUBMISSIONS_URL,
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  appPlatformUpdateNotifications,
  type AppPlatformUpdateNotificationDetails,
} from '~/server/notifications/app-platform-update.notifications';
import {
  appPlatformUpdateSubmitNotifications,
  type AppPlatformUpdateSubmittedNotificationDetails,
} from '~/server/notifications/app-platform-update-submit.notifications';
import { notificationProcessors } from '~/server/notifications/utils.notifications';
import { OWNER_SUBMISSIONS_URL } from '~/server/notifications/app-listing.notifications';

/**
 * The owner's notice of a staff platform update. Pinned as the whole string: the copy is the
 * product (who, that they are verified staff, why, and what happens next).
 */

type Def = (typeof appPlatformUpdateNotifications)['app-platform-update'];
const def = (appPlatformUpdateNotifications as Record<string, Def>)['app-platform-update'];
// The processor reads only `details`; the rest of a notification row is irrelevant here.
const asNotification = (details: AppPlatformUpdateNotificationDetails) =>
  ({ details } as unknown as Parameters<Def['prepareMessage']>[0]);

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
    expect(def.prepareMessage(asNotification(details))).toEqual({
      message:
        'mod-ana (verified Civitai staff) pushed an update to your app "pixel-garden": ' +
        'Bump @civitai/app-sdk to 2.4.0. It is merged into your app the next time you pull it ' +
        'or open it in the App Assistant, if it applies cleanly.',
      url: OWNER_SUBMISSIONS_URL,
    });
    // touchesManifest: false reads exactly as absent.
    expect(def.prepareMessage(asNotification({ ...details, touchesManifest: false }))).toEqual(
      def.prepareMessage(asNotification(details))
    );
  });

  it('says so when the update changes the manifest or a storage hook', () => {
    const details: AppPlatformUpdateNotificationDetails = {
      slug: 'pixel-garden',
      updateId: 'apu_01JABCDEFGHJKMNPQRSTVWXYZ0',
      byUsername: 'mod-ana',
      reason: 'Drop the unused storage scope.',
      touchesManifest: true,
    };
    expect(def.prepareMessage(asNotification(details))).toEqual({
      message:
        'mod-ana (verified Civitai staff) pushed an update to your app "pixel-garden": ' +
        "Drop the unused storage scope. It changes your app's manifest or a storage hook, which " +
        'decide what your app is allowed to do. It is merged into your app the next time you ' +
        'pull it or open it in the App Assistant, if it applies cleanly.',
      url: OWNER_SUBMISSIONS_URL,
    });
  });
});

describe('app-platform-update-submitted', () => {
  type SubmitDef = (typeof appPlatformUpdateSubmitNotifications)['app-platform-update-submitted'];
  const submitDef = (appPlatformUpdateSubmitNotifications as Record<string, SubmitDef>)[
    'app-platform-update-submitted'
  ];

  it('is registered, not toggleable', () => {
    expect(notificationProcessors['app-platform-update-submitted']).toBe(submitDef);
    expect(submitDef.toggleable).toBe(false);
  });

  it('names the staff member, the version, the app and the update, and links the owner’s apps', () => {
    const details: AppPlatformUpdateSubmittedNotificationDetails = {
      slug: 'pixel-garden',
      updateId: 'apu_01JABCDEFGHJKMNPQRSTVWXYZ0',
      publishRequestId: 'pubreq_01JABCDEFGHJKMNPQRSTVWXYZ0',
      version: '1.2.1',
      byUsername: 'mod-ana',
      reason: 'Bump @civitai/app-sdk to 2.4.0.',
    };
    expect(
      submitDef.prepareMessage({ details } as unknown as Parameters<SubmitDef['prepareMessage']>[0])
    ).toEqual({
      message:
        'mod-ana (verified Civitai staff) submitted version 1.2.1 of your app "pixel-garden" for ' +
        'review on your behalf: your approved version with their update (Bump @civitai/app-sdk ' +
        'to 2.4.0.). A moderator reviews it like any other submission. The update also stays on ' +
        'its branch and is merged into your app the next time you pull it or open it in the App ' +
        'Assistant.',
      url: OWNER_SUBMISSIONS_URL,
    });
  });
});

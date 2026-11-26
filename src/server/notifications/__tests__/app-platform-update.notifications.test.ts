import { describe, expect, it } from 'vitest';
import {
  appPlatformUpdateNotifications,
  type AppPlatformUpdateNotificationDetails,
} from '~/server/notifications/app-platform-update.notifications';
import {
  appPlatformUpdateSubmitNotifications,
  type AppPlatformUpdateReviewedNotificationDetails,
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
        'Assistant, unless this version is rejected: a rejection withdraws the update.',
      url: OWNER_SUBMISSIONS_URL,
    });
  });
});

/**
 * The OWNER's copy of a staff on-behalf submit's review outcome. The submitter (the moderator)
 * gets the ordinary `app-block-*`; these say whose submission it was. Pinned as whole strings.
 */
describe('app-platform-update-approved / -rejected (the owner’s review outcome)', () => {
  type ReviewedDef = (typeof appPlatformUpdateSubmitNotifications)['app-platform-update-approved'];
  const defs = appPlatformUpdateSubmitNotifications as Record<string, ReviewedDef>;
  const prepare = (type: string, details: AppPlatformUpdateReviewedNotificationDetails) => {
    const prepared = defs[type]!.prepareMessage({ details } as unknown as Parameters<
      ReviewedDef['prepareMessage']
    >[0]);
    if (!prepared) throw new Error(`${type} prepared no message`);
    return prepared;
  };
  const BASE: AppPlatformUpdateReviewedNotificationDetails = {
    slug: 'pixel-garden',
    name: 'Pixel Garden',
    version: '1.2.1',
    updateId: 'apu_01JABCDEFGHJKMNPQRSTVWXYZ0',
    byUsername: 'mod-ana',
    reviewerUserId: 31,
    actor: { username: 'reviewer_ada', deletedAt: null },
  };

  it('both are registered, not toggleable, and emailed', () => {
    for (const type of ['app-platform-update-approved', 'app-platform-update-rejected']) {
      expect(notificationProcessors[type as keyof typeof notificationProcessors]).toBe(defs[type]);
      expect(defs[type]!.toggleable).toBe(false);
      expect(defs[type]!.defaultEmail).toBe(true);
    }
  });

  it('approved: names the staff member and the version, links the run page when it can', () => {
    expect(
      prepare('app-platform-update-approved', {
        ...BASE,
        approvalNote: 'Thanks for the bump.',
        hasPage: true,
        canOpenRunPage: true,
      })
    ).toEqual({
      message:
        'Version 1.2.1 of your app "Pixel Garden", which mod-ana (verified Civitai staff) ' +
        'submitted on your behalf as a platform update, was approved and will be live in a few ' +
        'minutes. Note from the reviewer: Thanks for the bump.',
      url: '/apps/run/pixel-garden',
      byline: 'Reviewed by @reviewer_ada, Civitai App Review',
    });
    // No page: the owner's apps view, as the submitter's own copy falls back to.
    expect(prepare('app-platform-update-approved', BASE).url).toBe(OWNER_SUBMISSIONS_URL);
  });

  it('rejected: carries the reason, and falls back to the slug when the name is missing', () => {
    expect(
      prepare('app-platform-update-rejected', {
        ...BASE,
        name: null,
        reason: '  Breaks the gallery layout  ',
      })
    ).toEqual({
      message:
        'Version 1.2.1 of your app "pixel-garden", which mod-ana (verified Civitai staff) ' +
        'submitted on your behalf as a platform update, was not approved: Breaks the gallery layout',
      url: OWNER_SUBMISSIONS_URL,
      byline: 'Reviewed by @reviewer_ada, Civitai App Review',
    });
    expect(prepare('app-platform-update-rejected', BASE).message).toBe(
      'Version 1.2.1 of your app "Pixel Garden", which mod-ana (verified Civitai staff) ' +
        'submitted on your behalf as a platform update, was not approved.'
    );
  });

  it('rejected and the update withdrawn: says it will not be merged, after the reason', () => {
    expect(
      prepare('app-platform-update-rejected', {
        ...BASE,
        reason: 'Breaks the gallery layout',
        updateWithdrawn: true,
      })
    ).toEqual({
      message:
        'Version 1.2.1 of your app "Pixel Garden", which mod-ana (verified Civitai staff) ' +
        'submitted on your behalf as a platform update, was not approved: Breaks the gallery ' +
        'layout. The update was withdrawn and will not be merged into your app.',
      url: OWNER_SUBMISSIONS_URL,
      byline: 'Reviewed by @reviewer_ada, Civitai App Review',
    });
    // A reason that ends its own sentence gets no second full stop; no reason reads cleanly too.
    expect(
      prepare('app-platform-update-rejected', {
        ...BASE,
        reason: 'Breaks the gallery layout.',
        updateWithdrawn: true,
      }).message
    ).toBe(
      'Version 1.2.1 of your app "Pixel Garden", which mod-ana (verified Civitai staff) ' +
        'submitted on your behalf as a platform update, was not approved: Breaks the gallery ' +
        'layout. The update was withdrawn and will not be merged into your app.'
    );
    expect(
      prepare('app-platform-update-rejected', { ...BASE, updateWithdrawn: true }).message
    ).toBe(
      'Version 1.2.1 of your app "Pixel Garden", which mod-ana (verified Civitai staff) ' +
        'submitted on your behalf as a platform update, was not approved. The update was ' +
        'withdrawn and will not be merged into your app.'
    );
  });
});

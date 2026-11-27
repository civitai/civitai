import { describe, expect, it } from 'vitest';
import { emailNotificationTypes } from '@civitai/notifications/constants';
import { serviceDealNotificationTypes } from '~/server/notifications/creator-service.notifications';
import { DEFAULT_PUSH_TYPES } from '~/server/notifications/push.constants';
import {
  emailNotificationTypeList,
  isOptInNotification,
  notificationSettingGroups,
  systemEmailNotificationTypes,
} from '~/server/notifications/utils.notifications';

const dealTypes = Object.values(serviceDealNotificationTypes);
const sorted = (xs: readonly string[]) => [...xs].sort();

// The fan-out worker has no processor registry and gates email on the shared list alone. A type
// with `defaultEmail` missing from it never emails; a type on it without `defaultEmail` reaches the
// main app, which then refuses it — either way the settings page shows an Email box that lies.
describe('email notification types', () => {
  it("the worker's shared list is exactly the processors with defaultEmail", () => {
    expect(sorted(emailNotificationTypes)).toEqual(sorted(emailNotificationTypeList));
  });

  it('only the Creator Services deal and app-review notifications send email', () => {
    expect(sorted(emailNotificationTypeList)).toEqual(
      sorted([
        ...dealTypes,
        'app-block-approved',
        'app-block-rejected',
        'app-listing-rejected',
        'app-listing-reset-to-pending',
        'app-access-request-approved',
        'app-access-request-declined',
        'app-review-reply-to-moderator',
        'app-review-reply-to-developer',
      ])
    );
  });

  // Toggleable types get their Email box beside the on-site control; types with no on-site
  // toggle get an email-only box. One of the two, never neither and never both.
  it('every email type has exactly one email control the user can turn off', () => {
    const perTypeControls = new Set(
      Object.values(notificationSettingGroups).flatMap((rows) => rows.map((row) => row.type))
    );
    const emailOnlyControls = new Set(systemEmailNotificationTypes.map((row) => row.type));
    for (const type of emailNotificationTypeList) {
      expect(perTypeControls.has(type) !== emailOnlyControls.has(type), type).toBe(true);
      expect(isOptInNotification(type), type).toBe(false);
    }
  });
});

describe('push defaults', () => {
  it('a new push subscriber gets every deal notification by push', () => {
    expect(DEFAULT_PUSH_TYPES).toEqual(expect.arrayContaining(dealTypes));
  });

  it('keeps the push defaults that predate the deal notifications', () => {
    expect(DEFAULT_PUSH_TYPES).toEqual(
      expect.arrayContaining([
        'new-mention',
        'new-comment-reply',
        'new-comment-response',
        'tip-received',
      ])
    );
  });
});

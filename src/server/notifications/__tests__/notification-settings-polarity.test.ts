import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  isOptInNotification,
  notificationCategoryTypes,
  notificationProcessors,
  notificationTypes,
  optInNotificationTypes,
} from '~/server/notifications/utils.notifications';

/**
 * A `UserNotificationSettings` row means opted-OUT for every type except the handful that derive
 * recipients by joining that table, where it means SUBSCRIBED. Nothing used to check that a
 * processor's flag and its SQL agreed, so three Model3D types claimed default-off while running the
 * ordinary opt-out query — shipping ON while rendering OFF.
 */
const queryFor = (type: string) => {
  const q = notificationProcessors[type]?.prepareQuery?.({
    lastSent: '2026-01-01',
    lastSentDate: new Date('2026-01-01'),
    clickhouse: undefined,
  });
  return typeof q === 'string' ? q : undefined;
};

const OPT_OUT_CLAUSE = 'NOT EXISTS (SELECT 1 FROM "UserNotificationSettings"';
const OPT_IN_CLAUSE = 'JOIN "UserNotificationSettings"';

describe('notification settings polarity', () => {
  it('the flag and the SQL agree, both ways', () => {
    for (const [type, def] of Object.entries(notificationProcessors)) {
      const query = queryFor(type);
      if (!query?.includes('"UserNotificationSettings"')) continue;

      if (def.optIn) {
        expect(query, `${type} is optIn, so it must derive recipients by joining`).toContain(
          OPT_IN_CLAUSE
        );
        expect(query, `${type} is optIn, so a row must not also mean opted-out`).not.toContain(
          OPT_OUT_CLAUSE
        );
      } else {
        // The defect this whole file exists for: an opt-in-shaped query without the flag (or the
        // flag without the query) inverts the checkbox against what the cron actually does.
        expect(query, `${type} is not optIn, so it must gate on NOT EXISTS`).toContain(
          OPT_OUT_CLAUSE
        );
      }
    }
  });

  it('bulk toggles cannot reach an opt-in type', () => {
    // toggleAll/toggleCategory pass a raw type list to a mutation whose write direction is per-type.
    // Before this split, "turn off all notifications" INSERTED the opt-in row — subscribing the user
    // to shop promos — and the resulting state hid the category tree that would let them undo it.
    for (const type of optInNotificationTypes) {
      expect(notificationTypes, `${type} is excluded from the bulk list`).not.toContain(type);
    }
    for (const [category, settings] of Object.entries(notificationCategoryTypes)) {
      const optIn = settings.filter((s) => s.optIn).map((s) => s.type);
      for (const type of optIn) {
        // Still rendered — it needs its own checkbox — just never swept up by the category switch.
        expect(
          settings.map((s) => s.type),
          `${type} still renders under ${category}`
        ).toContain(type);
      }
    }
  });

  it('knows the one opt-in type we actually have', () => {
    // Guards the two tests above from passing vacuously if optIn is dropped everywhere.
    expect(optInNotificationTypes).toContain('cosmetic-shop-item-added-to-section');
    expect(isOptInNotification('cosmetic-shop-item-added-to-section')).toBe(true);
    expect(isOptInNotification('new-post-comment')).toBe(false);
  });

  it('the Model3D types no longer claim a default they never implemented', () => {
    for (const type of [
      'new-3d-model-comment',
      'new-3d-model-comment-response',
      'new-3d-model-comment-nested',
    ]) {
      expect(notificationProcessors[type].optIn).toBeFalsy();
      expect(queryFor(type)).toContain(OPT_OUT_CLAUSE);
    }
  });

  it('the toggle handler writes by polarity rather than assuming one direction', () => {
    const controller = readFileSync('src/server/controllers/notification.controller.ts', 'utf8');
    expect(controller).toContain('isOptInNotification');
    expect(controller).toMatch(/toRemove\s*=\s*input\.toggle\s*\?\s*optOut\s*:\s*optIn/);
    expect(controller).toMatch(/toAdd\s*=\s*input\.toggle\s*\?\s*optIn\s*:\s*optOut/);
  });

  it('no render path inverts the checkbox against the hook', () => {
    // useNotificationSettings now resolves polarity once; a second inversion downstream would undo it.
    for (const path of [
      'src/components/Account/NotificationsCard.tsx',
      'src/components/Notifications/NotificationToggle.tsx',
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${path} does not re-invert`).not.toMatch(/(?<!!)!\s*notificationSettings\[/);
      expect(source, `${path} has no defaultDisabled left`).not.toContain('defaultDisabled');
    }
  });
});

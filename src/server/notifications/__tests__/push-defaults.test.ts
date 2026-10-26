import { describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_TYPES } from '~/server/notifications/push.constants';
import {
  isOptInNotification,
  notificationProcessors,
} from '~/server/notifications/utils.notifications';

/**
 * DEFAULT_PUSH_TYPES (the processors with `defaultPush`) is materialized into UserPushSetting rows
 * at permission-grant time. A default on a type the user cannot toggle could never be removed, and
 * one on an opt-in type is a row fan-out never reaches.
 */
describe('DEFAULT_PUSH_TYPES', () => {
  it('every entry is a real notification type', () => {
    for (const type of DEFAULT_PUSH_TYPES) {
      expect(notificationProcessors[type], `${type} is not a registered processor`).toBeDefined();
    }
  });

  it('every entry is toggleable — a default the user cannot turn off is not a default', () => {
    for (const type of DEFAULT_PUSH_TYPES) {
      expect(
        notificationProcessors[type]?.toggleable,
        `${type} is not toggleable, so its push row could never be removed via the UI`
      ).not.toBe(false);
    }
  });

  it('no entry is opt-in — fan-out only reaches subscribers for those, so a default row is dead', () => {
    for (const type of DEFAULT_PUSH_TYPES) {
      expect(isOptInNotification(type), `${type} is opt-in`).toBe(false);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(DEFAULT_PUSH_TYPES).size).toBe(DEFAULT_PUSH_TYPES.length);
  });
});

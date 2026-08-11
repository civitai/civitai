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
// `prepareQuery` may be async — the five bounty processors, the four featured ones and one article
// processor all are. A sync-only reader silently skipped every one of them, so the contract below
// was never enforced on a third of the processors that touch the table.
const queryFor = async (type: string) => {
  const q = await notificationProcessors[type]?.prepareQuery?.({
    lastSent: '2026-01-01',
    lastSentDate: new Date('2026-01-01'),
    clickhouse: undefined,
  });
  return typeof q === 'string' ? q : undefined;
};

const OPT_OUT_CLAUSE = 'NOT EXISTS (SELECT 1 FROM "UserNotificationSettings"';
/** A LEFT JOIN would satisfy a bare `JOIN` substring test while restricting nothing. */
const DERIVES_RECIPIENTS = /(?<!LEFT )(?<!LEFT OUTER )JOIN "UserNotificationSettings"/;

describe('notification settings polarity', () => {
  it('the flag and the SQL agree, both ways', async () => {
    for (const [type, def] of Object.entries(notificationProcessors)) {
      const query = await queryFor(type);

      if (def.optIn) {
        // An opt-in type MUST have a query that derives recipients from the table. Without one, the
        // row still means opted-out server-side (or, on the event path, gets the subscriber dropped
        // by create.ts) while the UI renders it as subscribed — a perfect inversion. Asserted
        // unconditionally, so declaring the flag on a processor with no query at all fails here
        // rather than being skipped.
        expect(query, `${type} is optIn, so it must have a query`).toBeDefined();
        expect(query, `${type} is optIn, so it must derive recipients by joining`).toMatch(
          DERIVES_RECIPIENTS
        );
        expect(query, `${type} is optIn, so a row must not also mean opted-out`).not.toContain(
          OPT_OUT_CLAUSE
        );
      } else if (query?.includes('"UserNotificationSettings"')) {
        expect(query, `${type} is not optIn, so it must gate on NOT EXISTS`).toContain(
          OPT_OUT_CLAUSE
        );
        // ...and must not ALSO derive recipients from the table, which would make a row mean both.
        expect(query, `${type} is not optIn, so it must not derive recipients`).not.toMatch(
          DERIVES_RECIPIENTS
        );
      }
    }
  });

  it('actually reaches the async processors', async () => {
    // Guards the await above: if `prepareQuery` results stop resolving, the loop goes vacuous.
    expect(await queryFor('bounty-ending')).toContain('"UserNotificationSettings"');
  });

  it('the bulk "on" list cannot reach an opt-in type', () => {
    // toggleAll/toggleCategory pass a raw type list to a mutation whose write direction is per-type.
    // Before this split, "turn off all notifications" INSERTED the opt-in row — subscribing the user
    // to shop promos — and the resulting state hid the category tree that would let them undo it.
    // Turning everything ON adds this list, so an opt-in type here would subscribe by accident.
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

  it('the Model3D types no longer claim a default they never implemented', async () => {
    for (const type of [
      'new-3d-model-comment',
      'new-3d-model-comment-response',
      'new-3d-model-comment-nested',
    ]) {
      expect(notificationProcessors[type].optIn).toBeFalsy();
      expect(await queryFor(type)).toContain(OPT_OUT_CLAUSE);
    }
  });

  it('turning everything off unsubscribes opt-in types instead of stranding the user', () => {
    // The opposite direction from the test above. Opt-in types don't feed hasNotifications, so once
    // everything is off the category tree — and the only in-settings control — stops rendering. If
    // the bulk-off list skipped them, a user would keep receiving promos with no way back short of
    // the /shop bell.
    const card = readFileSync('src/components/Account/NotificationsCard.tsx', 'utf8');
    expect(card).toMatch(
      /toggle \? notificationTypes : \[\.\.\.notificationTypes, \.\.\.optInNotificationTypes\]/
    );
    expect(card).toMatch(/toggle === false \|\| !x\.optIn/);
  });

  it('the /shop bell asks for the state it is NOT in', () => {
    // `toggle` is the desired state, and `isEnabled` is the current one, so the bell must send the
    // negation. Passing `isEnabled` straight through is a no-op click in both directions; it only
    // worked on main because the old inverted `isEnabled` cancelled it out.
    const toggle = readFileSync('src/components/Notifications/NotificationToggle.tsx', 'utf8');
    expect(toggle).toMatch(/mutate\(\{\s*toggle:\s*!isEnabled/);
  });

  it('both toggle callers share one optimistic update', () => {
    // They used to hand-roll it separately; updating one left the /shop bell writing correctly to
    // the server while its own cache patch no-opped, so the control looked inert in both directions.
    for (const path of [
      'src/components/Account/NotificationsCard.tsx',
      'src/components/Notifications/NotificationToggle.tsx',
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${path} uses the shared hook`).toContain('useToggleNotificationSetting()');
      expect(source, `${path} does not hand-roll onMutate`).not.toContain('onMutate');
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

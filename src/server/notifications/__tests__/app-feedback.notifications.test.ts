import { describe, expect, it } from 'vitest';
import { NotificationCategory } from '~/server/common/enums';
import {
  APP_FEEDBACK_DIGEST_TYPE,
  APP_FEEDBACK_STATUS_TYPE,
  appFeedbackDigestQuery,
  appFeedbackInboxHref,
  appFeedbackNotifications,
  appFeedbackStatusKey,
  isReporterNotifiedOwnerStatus,
} from '~/server/notifications/app-feedback.notifications';
import {
  isOptInNotification,
  notificationCategoryTypes,
  notificationProcessors,
  notificationTypes,
} from '~/server/notifications/utils.notifications';
import { ownerVisibleWhere } from '~/server/services/blocks/app-feedback.service';
import { FEEDBACK_OWNER_STATUSES } from '~/shared/constants/feedback.constants';

/**
 * The two app-feedback notifications, as pure functions and as registered processors. Which ROWS
 * the digest picks is asserted against a real Postgres in `app-feedback-digest.behavior.test.ts`;
 * this file pins the literals — type names, keys, copy, URLs — and the registration that makes
 * them opt-out-able.
 *
 * Fixture values are distinct from each other and from every constant the assertions name.
 */

const LISTING_ID = 'apl_01JZFEEDBACK';
const APP_NAME = 'Pixel Forge';
const SLUG = 'pixel-forge';
const FEEDBACK_ID = 4242;

const render = (type: string, details: Record<string, unknown>) =>
  notificationProcessors[type].prepareMessage({ type, details });

/** Comment-stripped, whitespace-collapsed — a guard left behind as a comment does not count. */
const normalizeSql = (s: string) =>
  s
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trim())
    .filter(Boolean)
    .join('\n');

describe('registration — both types render a settings toggle, default ON', () => {
  it('both are registered under their literal type names', () => {
    expect(APP_FEEDBACK_DIGEST_TYPE).toBe('app-feedback-new');
    expect(APP_FEEDBACK_STATUS_TYPE).toBe('app-feedback-status');
    expect(Object.keys(appFeedbackNotifications).sort()).toEqual([
      'app-feedback-new',
      'app-feedback-status',
    ]);
    for (const type of ['app-feedback-new', 'app-feedback-status']) {
      expect(notificationProcessors[type], type).toBe(appFeedbackNotifications[type]);
    }
  });

  it('🔴 both are opt-OUT (on by default) and appear in the bulk on/off list', () => {
    // `notificationTypes` is exactly the toggleable, non-opt-in set: a type there renders a checkbox,
    // is on with no settings row, and is turned off by one. An opt-in type would ship OFF; a
    // `toggleable: false` one could not be turned off at all.
    for (const type of ['app-feedback-new', 'app-feedback-status']) {
      expect(notificationTypes, type).toContain(type);
      expect(isOptInNotification(type), type).toBe(false);
      expect(notificationProcessors[type].toggleable, type).not.toBe(false);
    }
  });

  it('each renders under its own category in the settings pane', () => {
    expect(appFeedbackNotifications['app-feedback-new'].category).toBe(
      NotificationCategory.Comment
    );
    expect(appFeedbackNotifications['app-feedback-status'].category).toBe(
      NotificationCategory.Update
    );
    expect(notificationCategoryTypes.Comment.map((t) => t.type)).toContain('app-feedback-new');
    expect(notificationCategoryTypes.Update.map((t) => t.type)).toContain('app-feedback-status');
  });

  it('only the digest is scheduled; the status change is emitted by the service', () => {
    expect(appFeedbackNotifications['app-feedback-new'].prepareQuery).toBeTypeOf('function');
    expect(appFeedbackNotifications['app-feedback-status'].prepareQuery).toBeUndefined();
  });
});

describe('owner digest — copy and destination', () => {
  it('counts the new messages and names the app (WHOLE strings)', () => {
    const one = render('app-feedback-new', {
      appListingId: LISTING_ID,
      appName: APP_NAME,
      count: 1,
    });
    expect(one?.message).toBe('1 new feedback message on "Pixel Forge"');
    const three = render('app-feedback-new', {
      appListingId: LISTING_ID,
      appName: APP_NAME,
      count: 3,
    });
    expect(three?.message).toBe('3 new feedback messages on "Pixel Forge"');
  });

  it('falls back to neutral copy when the name or the count is unusable', () => {
    expect(render('app-feedback-new', { appListingId: LISTING_ID, count: 2 })?.message).toBe(
      '2 new feedback messages on your app'
    );
    for (const count of [undefined, 0, -1, 1.5, '3']) {
      expect(
        render('app-feedback-new', { appListingId: LISTING_ID, appName: APP_NAME, count })?.message,
        String(count)
      ).toBe('New feedback on "Pixel Forge"');
    }
  });

  it("links the owner to the listing editor's feedback tab (WHOLE url)", () => {
    expect(appFeedbackInboxHref(LISTING_ID)).toBe(
      '/apps/listing/apl_01JZFEEDBACK/edit?tab=feedback'
    );
    expect(
      render('app-feedback-new', { appListingId: LISTING_ID, appName: APP_NAME, count: 1 })?.url
    ).toBe('/apps/listing/apl_01JZFEEDBACK/edit?tab=feedback');
  });

  it('a malformed row with no listing id links to the owner\'s apps, never to "undefined"', () => {
    expect(render('app-feedback-new', { appName: APP_NAME, count: 1 })?.url).toBe('/apps/build');
  });
});

describe('owner digest — the query', () => {
  const sql = normalizeSql(appFeedbackDigestQuery({ lastSent: '2026-10-20T00:00:00.000Z' }));

  it('is the whole statement it was reviewed as', () => {
    // Pinned WHOLE: a fragment assertion survives an appended `OR TRUE`, swapped arguments, or a
    // guard commented out (comments are stripped first). Which rows it returns is asserted by
    // executing it — see the behavior test.
    expect(sql).toMatchInlineSnapshot(`
      "WITH app_feedback_digest AS (
      SELECT
      CASE WHEN al.kind = 'onsite' THEN COALESCE(oc."userId", al."user_id") ELSE al."user_id" END "ownerId",
      al.id "appListingId",
      al.name "appName",
      date_trunc('day', f."createdAt") "bucket",
      COUNT(*)::int "count"
      FROM "Feedback" f
      JOIN "User" u ON u.id = f."userId"
      JOIN "app_listings" al ON al.id = f."appListingId"
      LEFT JOIN "app_blocks" ab ON ab.id = al."app_block_id"
      LEFT JOIN "OauthClient" oc ON oc.id = ab."app_id"
      WHERE f.area = 'app-block'
      AND f."hiddenFromOwnerAt" IS NULL
      AND u."bannedAt" IS NULL
      AND f."ownerStatus" IS NULL
      AND al."revision_of_id" IS NULL
      AND CASE WHEN al.kind = 'onsite' THEN COALESCE(oc."userId", al."user_id") ELSE al."user_id" END > 0
      AND f."userId" != CASE WHEN al.kind = 'onsite' THEN COALESCE(oc."userId", al."user_id") ELSE al."user_id" END
      AND NOT EXISTS (
      SELECT 1 FROM "UserEngagement" blk
      WHERE (blk."userId" = CASE WHEN al.kind = 'onsite' THEN COALESCE(oc."userId", al."user_id") ELSE al."user_id" END AND blk."targetUserId" = f."userId" AND blk.type IN ('Block', 'Hide'))
      OR (blk."userId" = f."userId" AND blk."targetUserId" = CASE WHEN al.kind = 'onsite' THEN COALESCE(oc."userId", al."user_id") ELSE al."user_id" END AND blk.type = 'Block')
      )
      AND date_trunc('day', f."createdAt") + INTERVAL '1 day' + INTERVAL '5 minutes' > '2026-10-20T00:00:00.000Z'::timestamp - INTERVAL '5 minutes'
      AND date_trunc('day', f."createdAt") + INTERVAL '1 day' + INTERVAL '5 minutes' <= (NOW() AT TIME ZONE 'UTC')
      AND f."createdAt" > (NOW() AT TIME ZONE 'UTC') - INTERVAL '7 days'
      GROUP BY 1, 2, 3, 4
      )
      SELECT
      concat('app-feedback-new:', "appListingId", ':', to_char("bucket", 'YYYY-MM-DD"T"HH24')) "key",
      "ownerId" "userId",
      'app-feedback-new' "type",
      JSONB_BUILD_OBJECT(
      'appListingId', "appListingId",
      'appName', "appName",
      'count', "count"
      ) "details"
      FROM app_feedback_digest
      WHERE
      NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'app-feedback-new');"
    `);
  });

  it('🔴 carries no feedback text and no reporter identity into the notification', () => {
    // A delivered notification is a copy nothing retracts, so a moderator's later hide or a ban
    // could not reach an excerpt or a username in it.
    expect(sql).not.toContain('f.message');
    expect(sql).not.toContain('context');
    expect(sql).not.toContain('username');
    expect(sql).not.toMatch(/'reporter|'userId'/);
  });

  it('🔴 agrees with the owner inbox on which rows the owner may see, and what "new" is', () => {
    // A LEDGER over `ownerVisibleWhere`, the inbox's rule set: each of its keys maps to the SQL that
    // enforces it here. A rule added to the inbox fails the key-set check until it is mapped (and
    // added to the digest); a rule removed fails it too. The digest is a copy nothing retracts, so
    // a row the inbox hides must never be counted in it.
    const where = ownerVisibleWhere('apl_ledger');
    const enforcedBy: Record<string, string> = {
      area: `f.area = 'app-block'`,
      appListingId: `JOIN "app_listings" al ON al.id = f."appListingId"`,
      hiddenFromOwnerAt: `f."hiddenFromOwnerAt" IS NULL`,
      user: `u."bannedAt" IS NULL`,
    };
    expect(Object.keys(where).sort()).toEqual(Object.keys(enforcedBy).sort());
    expect(where).toEqual({
      area: 'app-block',
      appListingId: 'apl_ledger',
      hiddenFromOwnerAt: null,
      user: { bannedAt: null },
    });
    for (const [key, fragment] of Object.entries(enforcedBy)) expect(sql, key).toContain(fragment);
    // "New" is the inbox's `ownerStatus IS NULL` alone — not narrowed by the abuse flag.
    expect(sql).toContain(`f."ownerStatus" IS NULL`);
    expect(sql).not.toContain('ownerFlaggedAt');
  });

  it('sets no dedupeKey — nothing else is sent for a digest bucket', () => {
    expect(sql).not.toContain('dedupeKey');
  });
});

describe('reporter status change', () => {
  it('only resolved and wont_fix notify — never acknowledged', () => {
    expect(FEEDBACK_OWNER_STATUSES.filter(isReporterNotifiedOwnerStatus)).toEqual([
      'resolved',
      'wont_fix',
    ]);
    expect(isReporterNotifiedOwnerStatus('acknowledged')).toBe(false);
  });

  it('keys one delivery per (feedback, status) — literal', () => {
    expect(appFeedbackStatusKey(FEEDBACK_ID, 'resolved')).toBe('app-feedback-status:4242:resolved');
    expect(appFeedbackStatusKey(FEEDBACK_ID, 'wont_fix')).toBe('app-feedback-status:4242:wont_fix');
  });

  it('names the app and the new status, not the developer (WHOLE strings)', () => {
    const base = { feedbackId: FEEDBACK_ID, appName: APP_NAME, appSlug: SLUG };
    expect(render('app-feedback-status', { ...base, ownerStatus: 'resolved' })).toEqual({
      message: 'The developer of "Pixel Forge" marked your feedback as resolved.',
      url: '/apps/store-preview/pixel-forge',
    });
    expect(render('app-feedback-status', { ...base, ownerStatus: 'wont_fix' })).toEqual({
      message: `The developer of "Pixel Forge" marked your feedback as won't fix.`,
      url: '/apps/store-preview/pixel-forge',
    });
  });

  it('renders nothing for a status it never sends, so a stray row cannot show a raw value', () => {
    for (const ownerStatus of ['acknowledged', 'toString', undefined, 'RESOLVED']) {
      expect(
        render('app-feedback-status', { feedbackId: FEEDBACK_ID, appName: APP_NAME, ownerStatus }),
        String(ownerStatus)
      ).toBeUndefined();
    }
  });

  it('degrades without a name or slug', () => {
    expect(
      render('app-feedback-status', { feedbackId: FEEDBACK_ID, ownerStatus: 'resolved' })
    ).toEqual({
      message: 'The developer of an app marked your feedback as resolved.',
      url: undefined,
    });
  });
});

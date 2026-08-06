import { describe, expect, it } from 'vitest';
import {
  CommentNotificationPriority,
  commentNotifications,
} from '~/server/notifications/comment.notifications';
import { NotificationCategory } from '~/server/common/enums';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

/**
 * `bountyEntry` had a `threadUrlMap` entry but no owner processor — the same gap posts had. A comment
 * on your bounty entry notified nobody unless you were already in the thread.
 */
describe('new-bounty-entry-comment', () => {
  const sql = () =>
    commentNotifications['new-bounty-entry-comment'].prepareQuery!({
      lastSent: '2026-01-01',
      lastSentDate: new Date('2026-01-01'),
      clickhouse: undefined,
    }) as string;

  it('notifies the entry owner off the bountyEntryId thread join', () => {
    expect(sql()).toContain(
      'JOIN "Thread" t ON t.id = c."threadId" AND t."bountyEntryId" IS NOT NULL'
    );
    expect(sql()).toContain('JOIN "BountyEntry" be ON be.id = t."bountyEntryId"');
    expect(sql()).toContain('be."userId" "ownerId"');
  });

  it('emits the detail keys prepareMessage reads, off the right rows', () => {
    expect(sql()).toContain(`'commentId', c.id`);
    expect(sql()).toContain('JOIN "User" u ON c."userId" = u.id');
    expect(sql()).toContain(`'bountyEntryId', be.id`);
    // The URL needs the parent bounty id, which only the Bounty join can supply.
    expect(sql()).toContain(`'bountyId', b.id`);
    expect(sql()).toContain('JOIN "Bounty" b ON b.id = be."bountyId"');
    expect(sql()).toContain(`'username', u.username`);
  });

  it('joins are inner, so a missing row drops the notification instead of NULLing it', () => {
    // Every `toContain('JOIN ...')` above is also a substring of `LEFT JOIN ...`. Widening the User
    // join would render "null commented on your entry…"; widening Bounty would produce
    // /bounties/null/entries/9. Both pass the assertions above.
    expect(sql()).not.toContain('LEFT JOIN');
  });

  it('skips self-comments, and orphaned entries whose owner was deleted', () => {
    expect(sql()).toContain('c."userId" != be."userId"');
    // BountyEntry."userId" is nullable — NULL > 0 is NULL, so this drops orphans too.
    expect(sql()).toContain('be."userId" > 0');
  });

  it('floors the lookback so it can never emit the 21k-comment backlog', () => {
    expect(sql()).toContain(`AND c."createdAt" > '2026-08-06'`);
    // A future floor would silently disable the processor rather than fail loudly.
    expect(new Date('2026-08-06').getTime()).toBeLessThan(Date.now());
    expect(sql()).toContain(`AND c."createdAt" > NOW() - INTERVAL '7 days'`);
    // Without this it re-selects every comment since the floor on every 1-minute tick.
    expect(sql()).toContain(`AND c."createdAt" > '2026-01-01'`);
  });

  it('honors the per-user opt-out row', () => {
    expect(sql()).toContain(
      `NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-bounty-entry-comment')`
    );
  });

  it('is registered and categorized so the settings UI can toggle it', () => {
    const def = notificationProcessors['new-bounty-entry-comment'];
    expect(def).toBeDefined();
    expect(def.category).toBe(NotificationCategory.Comment);
    expect(def.displayName).toBe('New comments on your bounty entries');
  });

  it('runs in the EntityOwner batch, behind the mention and reply processors', () => {
    // Shares the `comment:v2:<id>` dedupe key; a lower number would outrank new-mention.
    expect(commentNotifications['new-bounty-entry-comment'].priority).toBe(
      CommentNotificationPriority.EntityOwner
    );
  });

  it('links to the canonical entry URL rather than the redirect', () => {
    // threadUrlMap only gets the entry id, so it cannot build this URL — it emits the redirect form
    // instead. Linking canonically skips the hop.
    const message = notificationProcessors['new-bounty-entry-comment'].prepareMessage({
      type: 'new-bounty-entry-comment',
      details: {
        version: 2,
        bountyEntryId: 9,
        bountyId: 4,
        bountyTitle: 'Big Bounty',
        commentId: 42,
        username: 'someone',
      },
    });
    expect(message?.url).toBe('/bounties/4/entries/9?highlight=42');
    expect(message?.message).toBe('someone commented on your entry to the "Big Bounty" bounty');
  });
});

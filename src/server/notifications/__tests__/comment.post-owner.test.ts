import { describe, expect, it } from 'vitest';
import {
  CommentNotificationPriority,
  commentNotifications,
} from '~/server/notifications/comment.notifications';
import { NotificationCategory } from '~/server/common/enums';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

/**
 * Nothing joined `Thread."postId"`, so the first comment on your own post notified nobody while
 * replies inside that thread did — reported as patchy notifications rather than missing ones
 * (Freshdesk 68980). `bountyEntry` still has a `threadUrlMap` entry and no owner processor; that gap
 * is real but out of scope here.
 */
describe('new-post-comment', () => {
  const sql = () =>
    commentNotifications['new-post-comment'].prepareQuery!({
      lastSent: '2026-01-01',
      lastSentDate: new Date('2026-01-01'),
      clickhouse: undefined,
    }) as string;

  it('notifies the post owner off the postId thread join', () => {
    expect(sql()).toContain('JOIN "Thread" t ON t.id = c."threadId" AND t."postId" IS NOT NULL');
    expect(sql()).toContain('JOIN "Post" p ON p.id = t."postId"');
    expect(sql()).toContain('p."userId" "ownerId"');
  });

  it('emits the detail keys prepareMessage reads, off the right rows', () => {
    // The prepareMessage tests hand-build their details, so nothing else checks what the SQL puts in
    // them. Both of these are one-token copy-paste slips of exactly the kind cloning
    // new-image-comment invites, and both fail silently:
    //   'commentId', t.id  -> ?highlight=<threadId> matches nothing AND, because commentDedupeKey
    //                         reads details->>'commentId', the dedupe key goes thread-scoped, so the
    //                         second comment in a thread is suppressed as a duplicate of the first.
    //   JOIN "User" u ON p."userId" -> every message reads "<you> commented on your post".
    expect(sql()).toContain(`'commentId', c.id`);
    expect(sql()).toContain('JOIN "User" u ON c."userId" = u.id');
    expect(sql()).toContain(`'postId', p.id`);
    expect(sql()).toContain(`'postTitle', p.title`);
    expect(sql()).toContain(`'username', u.username`);
  });

  it('skips the owner commenting on their own post and system-owned posts', () => {
    expect(sql()).toContain('c."userId" != p."userId"');
    expect(sql()).toContain('p."userId" > 0');
  });

  it('floors the lookback so it can never emit the historical backlog', () => {
    // This type has no `last-sent-notification-*` cursor row until its first successful run, so it
    // inherits the job's global last-run — `new Date(0)` on a fresh DB, and stale by the outage
    // duration after any send-notifications outage. There are ~110k pre-launch post comments and the
    // unfloored query returns them in 2.6s, well under NOTIFICATION_QUERY_TIMEOUT_MS. The lastSent
    // bound alone does not stop that; only these floors do.
    expect(sql()).toContain(`AND c."createdAt" > '2026-08-06'`);
    // A floor set in the future would silently disable the processor forever rather than fail loudly.
    expect(new Date('2026-08-06').getTime()).toBeLessThan(Date.now());
    // Bounds the first batch even if the launch date goes stale before this merges.
    expect(sql()).toContain(`AND c."createdAt" > NOW() - INTERVAL '7 days'`);
  });

  it('still advances with the per-key cursor', () => {
    // Dropping this leaves every comment since the floor re-selected on every 1-minute tick. The
    // unique `key` suppresses the duplicates downstream, so the damage is silent: unbounded
    // PendingNotification churn and a seq scan that grows all week.
    expect(sql()).toContain(`AND c."createdAt" > '2026-01-01'`);
  });

  it('honors the per-user opt-out row', () => {
    expect(sql()).toContain(
      `NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-post-comment')`
    );
  });

  it('is registered in the processor list so the settings UI can toggle it', () => {
    expect(notificationProcessors['new-post-comment']).toBeDefined();
    // ⚠️ `defaultDisabled` IS A REMOVED CONCEPT — this line can only ever read `undefined`, so
    // `.toBeFalsy()` passes vacuously and proves nothing. `notification-settings-polarity.test.ts`
    // actively asserts no notification source contains the field. Left in place because removing
    // it is out of scope here, but do not copy it: the lever that decides whether the toggle
    // renders is `toggleable` (see `getNotificationTypes`, which skips
    // `toggleable === false && !showCategory`), and the way to assert it is against the OUTPUT —
    // `notificationCategoryTypes[category]` must contain the type. Done that way in
    // `comment.appListing-owner.test.ts`, where a `toggleable: false` mutant survived this shape.
    expect(notificationProcessors['new-post-comment'].defaultDisabled).toBeFalsy();
    expect(notificationProcessors['new-post-comment'].category).toBe(NotificationCategory.Comment);
  });

  it('runs in the EntityOwner batch, behind the mention and reply processors', () => {
    // All of these claim the same `comment:v2:<id>` dedupe key and the first to land wins. At any
    // lower number this would outrank new-mention and new-comment-reply for a comment that is also a
    // mention or a reply, and the post owner would get the blunter notification of the two — the
    // exact regression class the dedupe suite exists to prevent.
    expect(commentNotifications['new-post-comment'].priority).toBe(
      CommentNotificationPriority.EntityOwner
    );
  });

  it('links to the post with the comment highlighted', () => {
    const message = notificationProcessors['new-post-comment'].prepareMessage({
      type: 'new-post-comment',
      details: { version: 2, postId: 6, postTitle: 'My post', commentId: 42, username: 'someone' },
    });
    expect(message?.url).toBe('/posts/6?highlight=42');
    expect(message?.message).toBe('someone commented on your post: "My post"');
  });

  // Post title is `z.string().trim().nullish()`, so clearing it stores '' — not null. Both shapes are
  // untitled and neither may render `commented on your post: ""`.
  it.each([null, undefined, ''])(
    'renders an untitled post (%p) without an empty quoted title',
    (postTitle) => {
      const message = notificationProcessors['new-post-comment'].prepareMessage({
        type: 'new-post-comment',
        details: { version: 2, postId: 6, postTitle, commentId: 42, username: 'someone' },
      });
      expect(message?.message).toBe('someone commented on your post');
      expect(message?.url).toBe('/posts/6?highlight=42');
    }
  );

  it('names the model when an untitled gallery post would otherwise be indistinguishable', () => {
    const message = notificationProcessors['new-post-comment'].prepareMessage({
      type: 'new-post-comment',
      details: {
        version: 2,
        postId: 6,
        postTitle: null,
        modelName: 'My Model',
        commentId: 42,
        username: 'someone',
      },
    });
    expect(message?.message).toBe('someone commented on your post on the My Model model');
  });

  it('is labeled for posts in the notification settings list', () => {
    // The string users actually read when deciding what to turn off.
    expect(commentNotifications['new-post-comment'].displayName).toBe('New comments on your posts');
  });
});

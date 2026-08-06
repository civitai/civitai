import { describe, expect, it } from 'vitest';
import { commentNotifications } from '~/server/notifications/comment.notifications';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

/**
 * Posts were the one commentable entity with a `threadUrlMap` entry and no owner processor, so the
 * first comment on your own post notified nobody while replies inside that thread did — reported as
 * patchy notifications rather than missing ones (Freshdesk 68980).
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

  it('skips the owner commenting on their own post and system-owned posts', () => {
    expect(sql()).toContain('c."userId" != p."userId"');
    expect(sql()).toContain('p."userId" > 0');
  });

  it('honors the per-user opt-out row', () => {
    expect(sql()).toContain(
      `NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-post-comment')`
    );
  });

  it('is registered in the processor list so the settings UI can toggle it', () => {
    expect(notificationProcessors['new-post-comment']).toBeDefined();
    expect(notificationProcessors['new-post-comment'].defaultDisabled).toBeFalsy();
  });

  it('links to the post with the comment highlighted', () => {
    const message = notificationProcessors['new-post-comment'].prepareMessage({
      type: 'new-post-comment',
      details: { version: 2, postId: 6, postTitle: 'My post', commentId: 42, username: 'someone' },
    });
    expect(message?.url).toBe('/posts/6?highlight=42');
    expect(message?.message).toBe('someone commented on your post: "My post"');
  });

  it('renders an untitled post without an empty quoted title', () => {
    const message = notificationProcessors['new-post-comment'].prepareMessage({
      type: 'new-post-comment',
      details: { version: 2, postId: 6, postTitle: null, commentId: 42, username: 'someone' },
    });
    expect(message?.message).toBe('someone commented on your post');
  });
});

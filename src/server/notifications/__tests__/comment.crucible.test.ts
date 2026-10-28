import { describe, expect, it } from 'vitest';
import { commentNotifications, threadUrlMap } from '~/server/notifications/comment.notifications';
import { notBlockedBetween, notCommentMuted } from '~/server/notifications/base.notifications';
import { mentionNotifications } from '~/server/notifications/mention.notifications';

const sqlOf = (def: { prepareQuery?: (a: never) => unknown }) =>
  (def.prepareQuery as (a: { lastSent: string }) => string)({ lastSent: '2026-01-01' });

describe('crucible comment notifications', () => {
  it('links a crucible thread to its page', () => {
    expect(
      threadUrlMap({ threadType: 'crucible', threadParentId: 12, commentId: 5, threadId: 9 })
    ).toMatch(/^\/crucibles\/12\?/);
  });

  it('notifies the creator of a top-level crucible comment, never about their own comment', () => {
    const sql = sqlOf(commentNotifications['new-crucible-comment']);
    expect(sql).toContain(`c."entityType" = 'crucible'`);
    expect(sql).toContain('c."parentId" IS NULL');
    expect(sql).toContain('JOIN "Crucible" cr ON cr.id = c."entityId"');
    expect(sql).toContain('cr."userId" "ownerId"');
    expect(sql).toContain('c."userId" != cr."userId"');
    expect(sql).not.toContain('LEFT JOIN');
  });

  it('keeps the block and mute filters on the creator notification', () => {
    const sql = sqlOf(commentNotifications['new-crucible-comment']);
    expect(sql).toContain(notBlockedBetween('cr."userId"', 'c."userId"'));
    expect(sql).toContain(notCommentMuted('cr."userId"', 'c'));
  });

  it('deep-links the creator notification to the comment', () => {
    const msg = commentNotifications['new-crucible-comment'].prepareMessage({
      type: 'new-crucible-comment',
      details: { username: 'ann', crucibleName: 'Neon Duel', crucibleId: 12, commentId: 5 },
    } as never);
    expect(msg).toEqual({
      message: 'ann commented on your crucible: "Neon Duel"',
      url: '/crucibles/12?highlight=5',
    });
  });

  it('names the crucible only once its text has passed review, as the other crucible notifications do', () => {
    const sql = sqlOf(commentNotifications['new-crucible-comment']);
    expect(sql).toContain(
      `CASE WHEN cr.ingestion = 'Scanned' AND NOT cr."textNsfw" THEN cr.name END`
    );
    const msg = commentNotifications['new-crucible-comment'].prepareMessage({
      type: 'new-crucible-comment',
      details: { username: 'ann', crucibleName: null, crucibleId: 12, commentId: 5 },
    } as never);
    expect(msg?.message).toBe('ann commented on your crucible');
  });

  it.each([
    ['new-comment-reply', commentNotifications['new-comment-reply']],
    ['new-thread-response', commentNotifications['new-thread-response']],
    ['new-mention', mentionNotifications['new-mention']],
  ])('%s resolves a crucible comment instead of the dead "comment" fallback', (_, def) => {
    // The thread type is the entity type itself, so 'crucible' reaches threadUrlMap through the
    // CASE's ELSE arm. Only the types the map cannot take as-is are rewritten, and crucible is not
    // one of them.
    const sql = sqlOf(def);
    expect(sql).toContain(`ELSE c."entityType"::text`);
    expect(sql).not.toContain(`WHEN 'crucible' THEN`);
  });
});

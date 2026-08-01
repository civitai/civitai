import { describe, expect, it } from 'vitest';
import {
  CommentNotificationPriority,
  commentNotifications,
} from '~/server/notifications/comment.notifications';
import { mentionNotifications } from '~/server/notifications/mention.notifications';
import {
  notificationBatches,
  notificationProcessors,
} from '~/server/notifications/utils.notifications';

/**
 * One comment can satisfy several notification types at once — MNeMiC's report was a single reply
 * arriving three times (@mention + thread reply + comment on his model). Each processor emits its own
 * per-type `key`, so nothing collapsed them. They now also emit a shared `dedupeKey` scoped to the
 * SOURCE comment, which the notifications app enforces one-per-recipient.
 */

type Def = { prepareQuery?: (args: { lastSent: string }) => string; priority?: number };
const defs = { ...commentNotifications, ...mentionNotifications } as unknown as Record<string, Def>;

const sqlFor = (type: string) => defs[type].prepareQuery!({ lastSent: '2026-01-01' });

/** The types that fired for MNeMiC's one comment, plus the rest of the comment-derived family. */
const V2_TYPES = [
  'new-comment-reply',
  'new-review-response',
  'new-image-comment',
  'new-article-comment',
  'new-bounty-comment',
  'new-challenge-comment',
  'new-3d-model-comment',
  'new-3d-model-comment-response',
  'new-3d-model-comment-nested',
];
const V1_TYPES = ['new-comment', 'new-comment-response', 'new-comment-nested'];

describe('comment notifications — shared dedupe key', () => {
  it.each(V1_TYPES)('%s selects a v1-namespaced dedupeKey', (type) => {
    expect(sqlFor(type)).toContain(`concat('comment:v1:', details->>'commentId') "dedupeKey"`);
  });

  it.each(V2_TYPES)('%s selects a v2-namespaced dedupeKey', (type) => {
    expect(sqlFor(type)).toContain(`concat('comment:v2:', details->>'commentId') "dedupeKey"`);
  });

  it('new-thread-response picks its namespace from details.version (it UNIONs both tables)', () => {
    const sql = sqlFor('new-thread-response');
    expect(sql).toContain(
      `concat('comment:', case when details->>'version' is not null then 'v2:' else 'v1:' end, details->>'commentId') "dedupeKey"`
    );
  });

  it('the v1/v2 namespace is load-bearing — Comment and CommentV2 ids overlap', () => {
    // Same id, different table: these must NOT collide, or a legacy-comment notification would
    // suppress an unrelated CommentV2 one.
    expect(sqlFor('new-comment')).not.toContain(`'comment:v2:'`);
    expect(sqlFor('new-comment-reply')).not.toContain(`'comment:v1:'`);
  });

  it('new-mention dedupes comment mentions but leaves model-description mentions alone', () => {
    const sql = sqlFor('new-mention');
    // Comment mentions share the source event with the comment.notifications types...
    expect(sql).toContain(`case when details->>'mentionedIn' = 'comment' then`);
    // ...a mention in a model description has no commentId, so it must stay opted out (NULL).
    expect(sql).toContain(`details->>'commentId') end "dedupeKey"`);
  });

  it('every dedupeKey is derived from commentId only — never from the recipient or the type', () => {
    // A key that varied per user or per type would dedupe nothing; this is the whole mechanism.
    for (const type of [...V1_TYPES, ...V2_TYPES, 'new-thread-response']) {
      const dedupeExpr = sqlFor(type).match(/(concat\('comment:.*?) "dedupeKey"/s)?.[1];
      expect(dedupeExpr, `${type} selects a dedupeKey`).toBeDefined();
      expect(dedupeExpr).toContain(`details->>'commentId'`);
      expect(dedupeExpr).not.toContain('ownerId');
      expect(dedupeExpr).not.toContain('userId');
    }
  });
});

describe('comment notifications — priority decides which duplicate survives', () => {
  it('orders mention > direct response > thread response > entity owner', () => {
    const { Mention, DirectResponse, ThreadResponse, EntityOwner } = CommentNotificationPriority;
    expect(Mention).toBeLessThan(DirectResponse);
    expect(DirectResponse).toBeLessThan(ThreadResponse);
    expect(ThreadResponse).toBeLessThan(EntityOwner);
  });

  it('assigns the three types from the report in the order the user would want them', () => {
    // The exact trio in MNeMiC's screenshot, most-wanted first.
    expect(defs['new-mention'].priority).toBe(CommentNotificationPriority.Mention);
    expect(defs['new-thread-response'].priority).toBe(CommentNotificationPriority.ThreadResponse);
    expect(defs['new-comment-nested'].priority).toBe(CommentNotificationPriority.EntityOwner);
    expect(defs['new-mention'].priority!).toBeLessThan(defs['new-thread-response'].priority!);
    expect(defs['new-thread-response'].priority!).toBeLessThan(
      defs['new-comment-nested'].priority!
    );
  });

  it('every processor that emits a dedupeKey also declares a priority', () => {
    // Without one it lands in batch 0 and could beat the mention to the shared key.
    for (const [type, def] of Object.entries(defs)) {
      if (!def.prepareQuery?.({ lastSent: '2026-01-01' }).includes('"dedupeKey"')) continue;
      expect(def.priority, `${type} declares a priority`).toBeGreaterThan(0);
    }
  });

  it('batches run in numeric priority order, so a lower priority claims the key first', () => {
    const priorityOf = (type: string) => notificationProcessors[type]?.priority ?? 0;
    const batchIndex = (type: string) =>
      notificationBatches.findIndex((batch) => batch.some((n) => n.key === type));

    // Guards a lexicographic .sort(), which would order priority 10 ahead of priority 2.
    const seen = notificationBatches.map((batch) => batch[0]!.priority ?? 0);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));

    expect(batchIndex('new-mention')).toBeLessThan(batchIndex('new-thread-response'));
    expect(batchIndex('new-thread-response')).toBeLessThan(batchIndex('new-comment-nested'));
    expect(priorityOf('new-mention')).toBeLessThan(priorityOf('new-comment-nested'));
  });
});

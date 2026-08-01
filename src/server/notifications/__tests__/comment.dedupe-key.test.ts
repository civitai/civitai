import { describe, expect, it } from 'vitest';
import {
  CommentNotificationPriority,
  commentDedupeKeyByVersion,
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
    // A mention in a model description has no comment behind it, so it must stay opted out (NULL).
    expect(sql).toContain(`when details->>'mentionedIn' <> 'comment' then null`);
    // Comment mentions share the source event with the comment.notifications types.
    expect(sql).toContain(commentDedupeKeyByVersion);
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
    // Without one it lands in batch 0 and could beat the mention to the shared key. Iterate the FULL
    // registry, not just the comment family — a dedupe key added in any other file has the same problem.
    for (const [type, def] of Object.entries(notificationProcessors)) {
      const query = def.prepareQuery?.({
        lastSent: '2026-01-01',
        lastSentDate: new Date('2026-01-01'),
        clickhouse: undefined,
      });
      if (typeof query !== 'string' || !query.includes('"dedupeKey"')) continue;
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

/**
 * Claiming the dedupe key SUPPRESSES the other notifications for that comment, so a type that claims it
 * had better render. `NotificationList` drops any notification whose `prepareMessage` returns undefined,
 * and `threadUrlMap` returns undefined for a thread type it can't address — either one turns a
 * suppressed-but-working notification into a blank row or a dead link.
 */
describe('a type that claims the dedupe key must render', () => {
  const detailsFor = (type: string): Record<string, any>[] => {
    const base = { username: 'someone', commentId: 42 };
    switch (type) {
      case 'new-mention':
        return [
          // Only the shapes that still claim the key — see the CASE in new-mention's SQL.
          {
            ...base,
            mentionedIn: 'comment',
            version: 2,
            threadId: 7,
            threadType: 'model',
            threadParentId: 1,
          },
          {
            ...base,
            mentionedIn: 'comment',
            version: 2,
            threadId: 7,
            threadType: 'challenge',
            threadParentId: 1,
          },
          {
            ...base,
            mentionedIn: 'comment',
            version: 2,
            threadId: 7,
            threadType: 'model3d',
            threadParentId: 1,
          },
          {
            ...base,
            mentionedIn: 'comment',
            parentType: 'comment',
            parentId: 5,
            modelId: 1,
            modelName: 'M',
          },
        ];
      // Unions both comment tables, so it must render for both detail shapes.
      case 'new-thread-response':
        return [
          { ...base, version: 2, threadId: 7, threadType: 'model', threadParentId: 1 },
          { ...base, modelId: 1, modelName: 'M', parentId: 5, parentType: 'comment' },
        ];
      // CommentV2 only — its SQL always stamps version 2.
      case 'new-comment-reply':
        return [{ ...base, version: 2, threadId: 7, threadType: 'model', threadParentId: 1 }];
      case 'new-review-response':
        return [{ ...base, version: 2, reviewId: 3, modelId: 1, modelName: 'M' }];
      case 'new-image-comment':
        return [{ ...base, version: 2, imageId: 9, modelName: 'M', modelId: 1 }];
      case 'new-article-comment':
        return [{ ...base, version: 2, articleId: 4, articleTitle: 'A' }];
      case 'new-bounty-comment':
        return [{ ...base, version: 2, bountyId: 4, bountyTitle: 'B' }];
      case 'new-challenge-comment':
        return [{ ...base, version: 2, challengeId: 4, challengeTitle: 'C' }];
      case 'new-comment':
      case 'new-comment-response':
      case 'new-comment-nested':
        return [{ ...base, modelId: 1, modelName: 'M', parentId: 5, parentType: 'comment' }];
      default:
        return [{ ...base, version: 2, model3dId: 8, model3dName: '3D', parentId: 5 }];
    }
  };

  const claimants = Object.keys(defs).filter((type) =>
    defs[type].prepareQuery?.({ lastSent: '2026-01-01' }).includes('"dedupeKey"')
  );

  it.each(claimants)(
    '%s produces a message and a URL for every shape that claims the key',
    (type) => {
      for (const details of detailsFor(type)) {
        const msg = notificationProcessors[type].prepareMessage({ type, details });
        expect(msg, `${type} renders for ${JSON.stringify(details)}`).toBeDefined();
        expect(msg!.message).toBeTruthy();
        // A dead link is the failure mode threadUrlMap produces for an unhandled thread type.
        expect(msg!.url, `${type} has a URL for ${JSON.stringify(details)}`).toBeDefined();
      }
    }
  );

  it('new-mention does NOT claim the key for the shapes it cannot render', () => {
    const sql = defs['new-mention'].prepareQuery!({ lastSent: '2026-01-01' });
    // A model-description mention has no comment behind it.
    expect(sql).toContain(`when details->>'mentionedIn' <> 'comment' then null`);
    // The v2 'comment' fallback means threadUrlMap can't address the entity → dead link.
    expect(sql).toContain(`when details->>'threadType' <> 'comment' then`);
    // The v1 'review' shape makes prepareMessage return undefined → the row renders as nothing.
    expect(sql).toContain(`when details->>'parentType' = 'comment' then`);

    // Prove the bail-out those guards exist for is real, so this can't rot into a no-op.
    const mention = notificationProcessors['new-mention'];
    expect(
      mention.prepareMessage({
        type: 'new-mention',
        details: { mentionedIn: 'comment', parentType: 'review', username: 'x', commentId: 1 },
      })
    ).toBeUndefined();
  });

  it('new-mention resolves the same thread entities as the types it outranks', () => {
    // It suppresses new-thread-response, so anything that one can address, this one must address too.
    const mention = defs['new-mention'].prepareQuery!({ lastSent: '2026-01-01' });
    for (const entity of ['challengeId', 'model3dId']) {
      expect(mention, `new-mention resolves ${entity}`).toContain(`t."${entity}"`);
    }
    // ...and it skips appListing threads for the same reason the reply processors do.
    expect(mention).toContain('root."appListingId" IS NULL');
    expect(mention).toContain('t."appListingId" IS NULL');
  });
});

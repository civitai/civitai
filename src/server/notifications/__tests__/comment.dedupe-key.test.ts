import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  CommentNotificationPriority,
  commentDedupeKeyByShape,
  commentNotifications,
  v3EntityJoins,
  v3ThreadType,
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
  'new-review-response',
  'new-image-comment',
  'new-post-comment',
  'new-article-comment',
  'new-bounty-comment',
  'new-bounty-entry-comment',
  'new-challenge-comment',
  'new-crucible-comment',
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

  it.each(['new-thread-response', 'new-comment-reply'])(
    '%s picks its namespace from the detail shape (it can see model and other comments)',
    (type) => {
      expect(sqlFor(type)).toContain(commentDedupeKeyByShape);
    }
  );

  it('the v1/v2 namespace is load-bearing — rows written before the shared sequence overlap', () => {
    // A v1 comment's old id and a v2 comment's id can be the same number, and historical rows keep
    // their namespaced keys; these must NOT collide, or a model-comment notification would suppress
    // an unrelated one on another surface.
    expect(sqlFor('new-comment')).not.toContain(`'comment:v2:'`);
    expect(sqlFor('new-comment-nested')).not.toContain(`'comment:v2:'`);
  });

  it.each(['new-comment-reply', 'new-thread-response'])(
    '%s only claims the key for a thread threadUrlMap can address',
    (type) => {
      // Both fall back to threadType 'comment' for an entity threadUrlMap can't address
      // (model3dReview), which renders a dead link. Claiming there would suppress a working owner
      // notification — that is exactly how the mention/challenge regression got in.
      expect(sqlFor(type)).toContain(`when details->>'threadType' <> 'comment' then`);
      // Model comments have no threadType and build their URL from modelId, so they always claim.
      expect(sqlFor(type)).toContain(`when details->>'threadType' is null then`);
    }
  );

  it('new-comic-comment shares the key so it can claim the comic threads those two skip', () => {
    // Created inline in the router, not by a cron processor, so assert the call site directly.
    const router = readFileSync('src/server/routers/comics.router.ts', 'utf8');
    expect(router).toContain('dedupeKey: `comment:v2:${comment.id}`');
  });

  it('new-mention dedupes comment mentions but leaves model-description mentions alone', () => {
    const sql = sqlFor('new-mention');
    // A mention in a model description has no comment behind it, so it must stay opted out (NULL).
    expect(sql).toContain(`when details->>'mentionedIn' <> 'comment' then null`);
    // Comment mentions share the source event with the comment.notifications types.
    expect(sql).toContain(commentDedupeKeyByShape);
  });

  it.each([...V1_TYPES, ...V2_TYPES])(
    '%s stamps details.version 3, which routes the detail fetch to CommentV3',
    (type) => {
      // `comment.detail-fetcher.ts` registers itself for EVERY key in commentNotifications and
      // reads CommentV3 for all of them: a versionless row by `legacyV1Id`, a versioned one by
      // `id`. A processor that drops the version doesn't fail — it silently attaches a DIFFERENT
      // comment's body, avatar and username, or none. Nothing else guards it.
      expect(sqlFor(type)).toContain(`'version', 3`);
    }
  );

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

/**
 * `dedupeKey` collisions are guarded above; `key` collisions have the same blast radius and were not
 * guarded anywhere. `Notification.key` is UNIQUE, and the drain looks a key up and REUSES the stored
 * row's `type` and `details` rather than inserting. So two processors sharing a key prefix don't
 * error — one silently serves the other's message and URL to the wrong recipient.
 */
describe('every processor owns a distinct notification key namespace', () => {
  const keyPrefixes = Object.entries(notificationProcessors).flatMap(([type, def]) => {
    const query = def.prepareQuery?.({
      lastSent: '2026-01-01',
      lastSentDate: new Date('2026-01-01'),
      clickhouse: undefined,
    });
    if (typeof query !== 'string') return [];
    // The literal that opens the concat feeding the `key` column.
    const prefix = query
      .split('"key"')[0]
      ?.match(/concat\(\s*'([^']*)'/g)
      ?.pop()
      ?.match(/'([^']*)'/)?.[1];
    return prefix ? [{ type, prefix }] : [];
  });

  it('finds a key prefix for the comment-family processors it is meant to cover', () => {
    // Guards the extraction above from silently matching nothing and passing vacuously.
    const covered = keyPrefixes.map((k) => k.type);
    expect(covered).toContain('new-post-comment');
    expect(covered).toContain('new-image-comment');
    expect(keyPrefixes.length).toBeGreaterThan(10);
  });

  it('no processor can be confused for another by key', () => {
    for (const a of keyPrefixes) {
      for (const b of keyPrefixes) {
        if (a.type === b.type) continue;
        // Keys are prefix + id, so one prefix being a prefix of another is enough to collide.
        expect(
          a.prefix.startsWith(b.prefix),
          `${a.type} ("${a.prefix}") collides with ${b.type} ("${b.prefix}")`
        ).toBe(false);
      }
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
            version: 3,
            threadType: 'model',
            threadParentId: 1,
          },
          {
            ...base,
            mentionedIn: 'comment',
            version: 3,
            threadType: 'challenge',
            threadParentId: 1,
          },
          {
            ...base,
            mentionedIn: 'comment',
            version: 3,
            threadType: 'model3d',
            threadParentId: 1,
          },
          {
            ...base,
            mentionedIn: 'comment',
            version: 3,
            threadType: 'comicProject',
            threadParentId: 3314,
          },
          // App-store listing threads claim the key too now, and they are the one shape whose URL
          // comes from a joined SLUG rather than `threadParentId` — so `threadParentId` is null
          // here on purpose. A claimant that cannot render is the whole point of this suite.
          {
            ...base,
            mentionedIn: 'comment',
            version: 3,
            threadType: 'appListing',
            threadParentId: null,
            appListingSlug: 'pixel-forge',
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
      // Reads model and non-model comments, so it must render for both detail shapes.
      case 'new-thread-response':
        return [
          { ...base, version: 3, threadType: 'model', threadParentId: 1 },
          { ...base, version: 3, threadType: 'comicProject', threadParentId: 3314 },
          { ...base, version: 3, threadType: 'crucible', threadParentId: 12 },
          {
            ...base,
            version: 3,
            threadType: 'appListing',
            threadParentId: null,
            appListingSlug: 'pixel-forge',
          },
          { ...base, modelId: 1, modelName: 'M', parentId: 5, parentType: 'comment' },
        ];
      // Non-model comments only — always the thread-addressed shape.
      case 'new-comment-reply':
        return [
          { ...base, version: 3, threadType: 'model', threadParentId: 1 },
          { ...base, version: 3, threadType: 'comicProject', threadParentId: 3314 },
          { ...base, version: 3, threadType: 'crucible', threadParentId: 12 },
          {
            ...base,
            version: 3,
            threadType: 'appListing',
            threadParentId: null,
            appListingSlug: 'pixel-forge',
          },
        ];
      case 'new-review-response':
        return [{ ...base, version: 2, reviewId: 3, modelId: 1, modelName: 'M' }];
      case 'new-image-comment':
        return [{ ...base, version: 2, imageId: 9, modelName: 'M', modelId: 1 }];
      // Post.title is nullable, so both shapes have to render.
      case 'new-post-comment':
        return [
          { ...base, version: 2, postId: 6, postTitle: 'P' },
          { ...base, version: 2, postId: 6, postTitle: null },
        ];
      // SLUG-addressed, so its URL comes from `appListingSlug` rather than any id. Without this
      // case it falls to the `default:` model3d shape, carries no slug, and renders no URL —
      // which is precisely what this suite is here to catch.
      case 'new-app-listing-comment':
        return [{ ...base, version: 2, appListingSlug: 'pixel-forge', listingName: 'Pixel Forge' }];
      case 'new-article-comment':
        return [{ ...base, version: 2, articleId: 4, articleTitle: 'A' }];
      case 'new-bounty-comment':
        return [{ ...base, version: 2, bountyId: 4, bountyTitle: 'B' }];
      case 'new-bounty-entry-comment':
        return [{ ...base, version: 2, bountyEntryId: 9, bountyId: 4, bountyTitle: 'B' }];
      case 'new-challenge-comment':
        return [{ ...base, version: 2, challengeId: 4, challengeTitle: 'C' }];
      case 'new-crucible-comment':
        return [{ ...base, version: 2, crucibleId: 4, crucibleName: 'C' }];
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
    // It suppresses new-thread-response, so anything that one can address, this one must address
    // too. Both build the thread type and the slug from the same shared fragments, so parity is
    // asserted as both carrying them rather than per entity.
    const mention = defs['new-mention'].prepareQuery!({ lastSent: '2026-01-01' });
    const threadResponse = defs['new-thread-response'].prepareQuery!({ lastSent: '2026-01-01' });
    for (const sql of [mention, threadResponse]) {
      expect(sql).toContain(v3ThreadType('c'));
      expect(sql).toContain(v3EntityJoins('c'));
      expect(sql).toContain(`'appListingSlug', al.slug`);
    }
  });
});

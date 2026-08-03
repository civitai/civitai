import { describe, expect, it } from 'vitest';
import { commentNotifications, threadUrlMap } from '~/server/notifications/comment.notifications';

/**
 * App-store-listing (`appListing`) comment threads must NOT emit reply
 * notifications yet. The owner-facing `new-comment` processors are per-entity SQL
 * (no appListing branch → no rows → graceful). But the entity-AGNOSTIC reply
 * processors `new-comment-reply` + `new-thread-response` fire for a reply in ANY
 * CommentV2 thread — and for an appListing thread they'd resolve `threadParentId`
 * to NULL and `threadType` to the `'comment'` fallback, so `threadUrlMap` returns
 * `undefined` (a broken-link notification). appListing pages are addressed by SLUG
 * (not the id the notification query has), so a correct reply URL needs a slug
 * join — deferred. Until then we EXCLUDE appListing threads from both reply
 * processors via an `appListingId IS NULL` guard in their SQL.
 */

type Def = { prepareQuery: (args: { lastSent: string }) => string };
const defs = commentNotifications as unknown as Record<string, Def>;

describe('comment reply notifications — appListing exclusion', () => {
  it('root cause: threadUrlMap has no appListing entry → undefined URL for such a reply', () => {
    // The `'comment'`-fallback threadType an appListing thread would produce is not
    // in the map → undefined (a broken-link notification). This is WHY we exclude.
    expect(threadUrlMap({ threadType: 'comment', threadParentId: null })).toBeUndefined();
    expect(threadUrlMap({ threadType: 'appListing', threadParentId: 5 })).toBeUndefined();
    // Sanity: a handled type still resolves, so the exclusion is targeted.
    expect(threadUrlMap({ threadType: 'model', threadParentId: 5 })).toContain('/models/5');
  });

  it('new-comment-reply SQL excludes appListing threads (guard on the root thread)', () => {
    const sql = defs['new-comment-reply'].prepareQuery({ lastSent: '2026-01-01' });
    expect(sql).toContain('root."appListingId" IS NULL');
  });

  it('new-thread-response SQL excludes appListing threads (guard on BOTH root + immediate thread)', () => {
    const sql = defs['new-thread-response'].prepareQuery({ lastSent: '2026-01-01' });
    expect(sql).toContain('root."appListingId" IS NULL');
    expect(sql).toContain('t."appListingId" IS NULL');
  });
});

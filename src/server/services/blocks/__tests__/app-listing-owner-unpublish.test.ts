import { describe, expect, it, vi } from 'vitest';

import {
  isOwnerUnpublishAction,
  isOwnerUnpublishedListing,
  OWNER_UNPUBLISH_EVENT,
  readLastModerationAction,
} from '~/server/services/blocks/app-listing-owner-unpublish';

/**
 * The single spelling of "did the OWNER take this listing down, or did a MODERATOR?".
 *
 * `app_listings.status = 'removed'` cannot answer that — both writers produce it — so the
 * answer comes from the most-recent `AppListingModerationEvent`. This module is the one
 * place that question is asked; `republishOwnListing`'s go-live guard and the three author
 * edit paths in `offsite-listing.service` all read it from here.
 */

function fakeClient(row: { action: string } | null) {
  const findFirst = vi.fn(async (..._a: unknown[]) => row);
  return { client: { appListingModerationEvent: { findFirst } }, findFirst };
}

describe('isOwnerUnpublishAction', () => {
  it("the owner's own unpublish is the ONLY action that answers true", () => {
    expect(isOwnerUnpublishAction('owner-unpublish')).toBe(true);
  });

  it.each([
    'delist',
    'purge',
    'owner-republish',
    'relist',
    'approve',
    'reject',
    'reset-to-pending',
    'claim',
    // Near-misses that a substring/prefix test would wrongly admit.
    'owner-unpublished',
    'not-owner-unpublish',
    'OWNER-UNPUBLISH',
  ])('%s ⇒ false', (action) => {
    expect(isOwnerUnpublishAction(action)).toBe(false);
  });

  it('🔴 FAILS CLOSED on absence: null / undefined ⇒ false', () => {
    expect(isOwnerUnpublishAction(null)).toBe(false);
    expect(isOwnerUnpublishAction(undefined)).toBe(false);
  });

  it('names the action with the exported constant, so callers cannot re-spell it', () => {
    expect(OWNER_UNPUBLISH_EVENT).toBe('owner-unpublish');
  });
});

describe('readLastModerationAction', () => {
  it('🔴 orders newest-first with the id tiebreak and selects only `action`', async () => {
    // `createdAt` alone is not a total order — two events written in one transaction
    // share a timestamp, and without the id tiebreak "most recent" is whichever row the
    // planner returned first, which flips an owner capability on and off at random.
    const { client, findFirst } = fakeClient({ action: 'delist' });

    await readLastModerationAction(client, 'apl_x');

    expect(findFirst).toHaveBeenCalledWith({
      where: { appListingId: 'apl_x' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { action: true },
    });
  });

  it('returns the action, and null when the listing has no events', async () => {
    expect(await readLastModerationAction(fakeClient({ action: 'delist' }).client, 'apl_x')).toBe(
      'delist'
    );
    expect(await readLastModerationAction(fakeClient(null).client, 'apl_x')).toBeNull();
  });
});

describe('isOwnerUnpublishedListing', () => {
  it.each([
    ['owner-unpublish', true],
    ['delist', false],
    ['purge', false],
  ] as const)('last event %s ⇒ %s', async (action, expected) => {
    expect(await isOwnerUnpublishedListing(fakeClient({ action }).client, 'apl_x')).toBe(expected);
  });

  it('🔴 no events at all ⇒ false (a removal nothing proves the owner made)', async () => {
    expect(await isOwnerUnpublishedListing(fakeClient(null).client, 'apl_x')).toBe(false);
  });
});

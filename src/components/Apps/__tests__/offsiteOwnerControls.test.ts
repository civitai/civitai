import { describe, expect, it } from 'vitest';

import {
  OWNER_UNPUBLISH_ACTION,
  canOwnerRepublish,
  canOwnerUnpublish,
  ownerListingState,
  ownerStateChip,
} from '~/components/Apps/offsiteOwnerControls';
import { APP_LISTING_MODERATION_ACTIONS } from '~/server/schema/blocks/offsite-moderation.schema';

/**
 * W13 post-approval mgmt (Phase 3) — pure OWNER-control view model (the BLOCKING
 * gate for the load-bearing owner-hidden-vs-mod-removed distinction that gates the
 * Republish button; the browser-mode list test is report-only). Pins the
 * status/last-event → state matrix + the two capability predicates.
 */

describe('ownerListingState — classify a listing for owner controls', () => {
  it('an approved listing is LIVE (regardless of any last action)', () => {
    expect(ownerListingState({ listingStatus: 'approved', lastModerationAction: null })).toBe(
      'live'
    );
    expect(
      ownerListingState({ listingStatus: 'approved', lastModerationAction: 'owner-republish' })
    ).toBe('live');
  });

  it('a removed listing whose LAST event is owner-unpublish is OWNER-HIDDEN', () => {
    expect(
      ownerListingState({ listingStatus: 'removed', lastModerationAction: 'owner-unpublish' })
    ).toBe('owner-hidden');
  });

  it('a removed listing whose last event is a moderator delist is MOD-REMOVED', () => {
    expect(
      ownerListingState({ listingStatus: 'removed', lastModerationAction: 'delist' })
    ).toBe('mod-removed');
  });

  it('a removed listing with NO last event is MOD-REMOVED (fail-safe — no republish)', () => {
    expect(ownerListingState({ listingStatus: 'removed', lastModerationAction: null })).toBe(
      'mod-removed'
    );
    expect(
      ownerListingState({ listingStatus: 'removed', lastModerationAction: undefined })
    ).toBe('mod-removed');
  });

  it('any other listing status is INACTIVE (draft/pending/rejected/missing)', () => {
    for (const status of ['draft', 'pending', 'rejected', null, undefined]) {
      expect(ownerListingState({ listingStatus: status, lastModerationAction: null })).toBe(
        'inactive'
      );
    }
  });
});

describe('capability predicates', () => {
  it('unpublish is allowed ONLY on a live listing', () => {
    expect(canOwnerUnpublish('live')).toBe(true);
    expect(canOwnerUnpublish('owner-hidden')).toBe(false);
    expect(canOwnerUnpublish('mod-removed')).toBe(false);
    expect(canOwnerUnpublish('inactive')).toBe(false);
  });

  it('republish is allowed ONLY on an owner-hidden listing — NEVER a mod takedown', () => {
    expect(canOwnerRepublish('owner-hidden')).toBe(true);
    expect(canOwnerRepublish('mod-removed')).toBe(false);
    expect(canOwnerRepublish('live')).toBe(false);
    expect(canOwnerRepublish('inactive')).toBe(false);
  });
});

describe('ownerStateChip — the removed-listing badge override', () => {
  it('labels an owner-hidden listing "unpublished" and a mod-removed one distinctly', () => {
    expect(ownerStateChip('owner-hidden')).toEqual({ label: 'unpublished', color: 'gray' });
    expect(ownerStateChip('mod-removed')).toEqual({
      label: 'removed by a moderator',
      color: 'red',
    });
  });

  it('returns null for live/inactive (the caller keeps the request-status chip)', () => {
    expect(ownerStateChip('live')).toBeNull();
    expect(ownerStateChip('inactive')).toBeNull();
  });
});

describe('the owner-unpublish action agreement', () => {
  it('OWNER_UNPUBLISH_ACTION is a real moderation-event action in the shared taxonomy', () => {
    expect(APP_LISTING_MODERATION_ACTIONS).toContain(OWNER_UNPUBLISH_ACTION);
  });
});

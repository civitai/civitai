import { describe, expect, it } from 'vitest';

import {
  actionRequiresReason,
  isDestructiveListingModAction,
  listingKindChip,
  listingModActionLabel,
  listingModActions,
} from '~/components/Apps/appListingModerationTableView';

/**
 * W13 post-approval mgmt (P2) — the mod management-table action view model. The
 * blocking correctness gate for the KIND-AWARE per-row action set (the browser
 * suite is report-only). Pins: which actions each status offers, and that the
 * off-site-only actions (reset-to-pending / claim / purge / review) NEVER appear
 * on an on-site row while the dual-kind ones (hide / relist) do.
 */

describe('listingModActions — off-site rows', () => {
  it('pending (with a pending request) → Review only', () => {
    expect(listingModActions({ status: 'pending', kind: 'offsite', hasPendingRequest: true })).toEqual(
      ['review']
    );
  });

  it('approved → Reset to pending + Hide', () => {
    expect(
      listingModActions({ status: 'approved', kind: 'offsite', hasPendingRequest: false })
    ).toEqual(['reset-to-pending', 'hide']);
  });

  it('removed → Relist + Claim + Purge', () => {
    expect(
      listingModActions({ status: 'removed', kind: 'offsite', hasPendingRequest: false })
    ).toEqual(['relist', 'claim', 'purge']);
  });

  it('draft → no lifecycle action (unless a pending request offers Review)', () => {
    expect(listingModActions({ status: 'draft', kind: 'offsite', hasPendingRequest: false })).toEqual(
      []
    );
    expect(listingModActions({ status: 'draft', kind: 'offsite', hasPendingRequest: true })).toEqual(
      ['review']
    );
  });

  it('rejected → read-only', () => {
    expect(
      listingModActions({ status: 'rejected', kind: 'offsite', hasPendingRequest: false })
    ).toEqual([]);
  });
});

describe('listingModActions — on-site rows hide the off-site-only actions', () => {
  it('approved on-site → Hide ONLY (no reset-to-pending)', () => {
    expect(
      listingModActions({ status: 'approved', kind: 'onsite', hasPendingRequest: false })
    ).toEqual(['hide']);
  });

  it('removed on-site → Relist ONLY (no claim / purge)', () => {
    expect(
      listingModActions({ status: 'removed', kind: 'onsite', hasPendingRequest: false })
    ).toEqual(['relist']);
  });

  it('pending on-site → NO Review (approve/reject is off-site only; onsite uses its own queue)', () => {
    expect(
      listingModActions({ status: 'pending', kind: 'onsite', hasPendingRequest: true })
    ).toEqual([]);
  });
});

describe('action metadata', () => {
  it('only purge is destructive', () => {
    expect(isDestructiveListingModAction('purge')).toBe(true);
    for (const a of ['review', 'reset-to-pending', 'hide', 'relist', 'claim'] as const) {
      expect(isDestructiveListingModAction(a)).toBe(false);
    }
  });

  it('every action except review requires a reason', () => {
    expect(actionRequiresReason('review')).toBe(false);
    for (const a of ['reset-to-pending', 'hide', 'relist', 'claim', 'purge'] as const) {
      expect(actionRequiresReason(a)).toBe(true);
    }
  });

  it('labels each action', () => {
    expect(listingModActionLabel('review')).toBe('Review');
    expect(listingModActionLabel('reset-to-pending')).toBe('Reset to pending');
    expect(listingModActionLabel('hide')).toBe('Hide');
    expect(listingModActionLabel('relist')).toBe('Relist');
    expect(listingModActionLabel('claim')).toBe('Claim');
    expect(listingModActionLabel('purge')).toBe('Purge');
  });

  it('kind chip distinguishes external vs on-site', () => {
    expect(listingKindChip('offsite')).toEqual({ label: 'external', color: 'grape' });
    expect(listingKindChip('onsite')).toEqual({ label: 'on-site', color: 'blue' });
  });
});

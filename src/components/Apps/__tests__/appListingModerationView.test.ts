import { describe, expect, it } from 'vitest';

import {
  isDestructiveAction,
  listingStatusChip,
  moderationActionChip,
  reportActionLabel,
  reportRowActions,
  reportStatusChip,
  type ReportRowAction,
} from '~/components/Apps/appListingModerationView';
import { APP_LISTING_MODERATION_ACTIONS } from '~/server/schema/blocks/offsite-moderation.schema';

/**
 * W13 P3b PR3 — pure moderation VIEW MODEL (the blocking gate for the report-row
 * action set + the status/action chips; the browser-mode queue test is
 * report-only). Pins the state→action-set matrix + that every chip has a label.
 */

describe('reportRowActions — the per-row action set', () => {
  it('an APPROVED listing with a PENDING report offers delist + claim + resolve + dismiss', () => {
    expect(reportRowActions({ reportStatus: 'pending', listingStatus: 'approved' })).toEqual([
      'delist',
      'claim',
      'resolve',
      'dismiss',
    ]);
  });

  it('a REMOVED listing with a PENDING report offers relist + claim + purge + resolve + dismiss', () => {
    expect(reportRowActions({ reportStatus: 'pending', listingStatus: 'removed' })).toEqual([
      'relist',
      'claim',
      'purge',
      'resolve',
      'dismiss',
    ]);
  });

  it('a resolved/dismissed report offers NO report actions (only listing actions remain)', () => {
    expect(reportRowActions({ reportStatus: 'resolved', listingStatus: 'approved' })).toEqual([
      'delist',
      'claim',
    ]);
    expect(reportRowActions({ reportStatus: 'dismissed', listingStatus: 'removed' })).toEqual([
      'relist',
      'claim',
      'purge',
    ]);
  });

  it('claim is offered on BOTH an approved and a removed listing (a mod may reclaim either)', () => {
    expect(reportRowActions({ reportStatus: 'pending', listingStatus: 'approved' })).toContain(
      'claim'
    );
    expect(reportRowActions({ reportStatus: 'pending', listingStatus: 'removed' })).toContain(
      'claim'
    );
    // …but NOT on a gone/unknown-status listing (no listing-level actions at all).
    expect(reportRowActions({ reportStatus: 'pending', listingStatus: null })).not.toContain(
      'claim'
    );
  });

  it('purge is ONLY offered on a removed listing (never on an approved/live one)', () => {
    expect(reportRowActions({ reportStatus: 'pending', listingStatus: 'approved' })).not.toContain(
      'purge'
    );
    expect(reportRowActions({ reportStatus: 'pending', listingStatus: 'removed' })).toContain('purge');
  });

  it('a null/gone listing status yields no listing-level actions', () => {
    expect(reportRowActions({ reportStatus: 'pending', listingStatus: null })).toEqual([
      'resolve',
      'dismiss',
    ]);
    expect(reportRowActions({ reportStatus: 'resolved', listingStatus: undefined })).toEqual([]);
  });
});

describe('isDestructiveAction', () => {
  it('only purge is destructive', () => {
    expect(isDestructiveAction('purge')).toBe(true);
    for (const a of ['delist', 'relist', 'claim', 'resolve', 'dismiss'] as ReportRowAction[]) {
      expect(isDestructiveAction(a)).toBe(false);
    }
  });
});

describe('chips', () => {
  it('reportStatusChip covers every report status with a non-empty label', () => {
    for (const s of ['pending', 'resolved', 'dismissed']) {
      const chip = reportStatusChip(s);
      expect(chip.label.trim().length).toBeGreaterThan(0);
      expect(chip.color.trim().length).toBeGreaterThan(0);
    }
    // Unknown falls back to the raw value, never throws.
    expect(reportStatusChip('weird').label).toBe('weird');
  });

  it('listingStatusChip maps removed→Delisted and a null status→Gone', () => {
    expect(listingStatusChip('removed').label).toBe('Delisted');
    expect(listingStatusChip('approved').label).toBe('Live');
    expect(listingStatusChip(null).label).toBe('Gone');
    expect(listingStatusChip(undefined).label).toBe('Gone');
  });

  it('moderationActionChip has a label for EVERY schema action (no unlabeled event)', () => {
    for (const action of APP_LISTING_MODERATION_ACTIONS) {
      const chip = moderationActionChip(action);
      expect(chip.label.trim().length).toBeGreaterThan(0);
      // A real label, not the raw action key.
      expect(chip.label).not.toBe(action);
    }
  });
});

describe('reportActionLabel', () => {
  it('gives a distinct human label for each action', () => {
    const labels = (
      ['delist', 'relist', 'claim', 'purge', 'resolve', 'dismiss'] as ReportRowAction[]
    ).map(reportActionLabel);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) expect(l.trim().length).toBeGreaterThan(0);
  });
});

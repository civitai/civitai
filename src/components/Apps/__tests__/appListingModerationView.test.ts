import { describe, expect, it } from 'vitest';

import {
  isDestructiveAction,
  listingStatusChip,
  moderationActionChip,
  moderationHistoryTarget,
  offlineCutFailureNotice,
  reportActionLabel,
  reportRowActions,
  reportStatusChip,
  retryableOfflineCutEventId,
  type ReportRowAction,
} from '~/components/Apps/appListingModerationView';
import { APP_LISTING_MODERATION_ACTIONS } from '~/server/schema/blocks/offsite-moderation.schema';

/**
 * W13 P3b PR3 — pure moderation VIEW MODEL (the node-tier gate for the report-row
 * action set + the status/action chips). Pins the state→action-set matrix + that every chip has a
 * label.
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

  it('a RESOLVED report offers NO report actions (only listing actions remain)', () => {
    expect(reportRowActions({ reportStatus: 'resolved', listingStatus: 'approved' })).toEqual([
      'delist',
      'claim',
    ]);
    expect(reportRowActions({ reportStatus: 'resolved', listingStatus: 'removed' })).toEqual([
      'relist',
      'claim',
      'purge',
    ]);
  });

  it('🔴 a DISMISSED report offers nothing at all — not even the listing actions', () => {
    // Dismissed = "no action warranted"; Delist / Claim on that row was the bug.
    expect(reportRowActions({ reportStatus: 'dismissed', listingStatus: 'approved' })).toEqual([]);
    expect(reportRowActions({ reportStatus: 'dismissed', listingStatus: 'removed' })).toEqual([]);
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
    expect(reportRowActions({ reportStatus: 'pending', listingStatus: 'removed' })).toContain(
      'purge'
    );
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

describe('retryableOfflineCutEventId — where "Retry cut" is drawn', () => {
  const ev = (id: string, action: string) => ({ id, action });

  it('the newest cut event, when it is a failure', () => {
    expect(
      retryableOfflineCutEventId([
        ev('alme_3', 'offline-cut-failed'),
        ev('alme_2', 'delist'),
        ev('alme_1', 'offline-cut-failed'),
      ])
    ).toBe('alme_3');
  });

  it('a non-cut event newer than the failure does not hide it', () => {
    expect(
      retryableOfflineCutEventId([
        ev('alme_9', 'message-owner'),
        ev('alme_8', 'offline-cut-failed'),
      ])
    ).toBe('alme_8');
  });

  it('none once a later cut succeeded', () => {
    expect(
      retryableOfflineCutEventId([ev('alme_5', 'offline-cut'), ev('alme_4', 'offline-cut-failed')])
    ).toBeNull();
  });

  it('none without any failure', () => {
    expect(retryableOfflineCutEventId([ev('alme_1', 'delist')])).toBeNull();
    expect(retryableOfflineCutEventId([])).toBeNull();
  });
});

describe('offlineCutFailureNotice — the takedown toast', () => {
  const TAKEN = { appListingId: 'apl_taken_down', slug: 'taken-down-app' };

  it('warns only on an ATTEMPTED and FAILED cut, and its button targets the taken-down listing', () => {
    expect(
      offlineCutFailureNotice(
        { appListingId: 'apl_taken_down', status: 'removed', offlineCut: { outcome: 'failed' } },
        TAKEN
      )
    ).toEqual({
      title: 'Offline access not cut',
      message:
        "The listing is down, but the app's offline access could not be cut, so its users may stay signed in. Open its moderation history to retry.",
      historyFor: { appListingId: 'apl_taken_down', slug: 'taken-down-app' },
    });
  });

  it('🔴 the RESULT’s listing id wins over the caller’s, and then no stale slug is shown', () => {
    // A caller that passed the wrong listing (stale UI state) must not send the moderator to the
    // wrong history: the server's own id is the one whose cut failed.
    expect(
      offlineCutFailureNotice(
        { appListingId: 'apl_server_says', status: 'removed', offlineCut: { outcome: 'failed' } },
        TAKEN
      )?.historyFor
    ).toEqual({ appListingId: 'apl_server_says', slug: '' });
  });

  it('falls back to the caller’s listing when the result carries no id', () => {
    expect(
      offlineCutFailureNotice({ offlineCut: { outcome: 'failed' } }, TAKEN)?.historyFor
    ).toEqual(TAKEN);
  });

  it('silent on a successful cut, on no cut (flag off / nothing to cut), and on junk', () => {
    expect(
      offlineCutFailureNotice(
        {
          appListingId: 'apl_taken_down',
          status: 'removed',
          offlineCut: { outcome: 'cut', deleted: 2 },
        },
        TAKEN
      )
    ).toBeNull();
    expect(
      offlineCutFailureNotice({ appListingId: 'apl_taken_down', status: 'removed' }, TAKEN)
    ).toBeNull();
    expect(offlineCutFailureNotice(undefined, TAKEN)).toBeNull();
    expect(offlineCutFailureNotice('failed', TAKEN)).toBeNull();
  });

  it('both cut actions have a mod-history label', () => {
    expect(moderationActionChip('offline-cut')).toEqual({
      label: 'Offline access cut',
      color: 'gray',
    });
    expect(moderationActionChip('offline-cut-failed')).toEqual({
      label: 'Offline access cut failed',
      color: 'orange',
    });
  });
});

describe('moderationHistoryTarget — the "History" entry point (mod-only)', () => {
  const LISTING = { appListingId: 'apl_entry_9', slug: 'entry-app' };

  it('a moderator gets the listing’s history', () => {
    expect(moderationHistoryTarget({ isModerator: true }, LISTING)).toEqual({
      appListingId: 'apl_entry_9',
      slug: 'entry-app',
    });
  });

  it('🔴 a non-moderator, a signed-out viewer and an unknown moderator flag get NO entry point', () => {
    expect(moderationHistoryTarget({ isModerator: false }, LISTING)).toBeNull();
    expect(moderationHistoryTarget({}, LISTING)).toBeNull();
    expect(moderationHistoryTarget({ isModerator: null }, LISTING)).toBeNull();
    expect(moderationHistoryTarget(null, LISTING)).toBeNull();
    expect(moderationHistoryTarget(undefined, LISTING)).toBeNull();
  });

  it('no entry point without a listing id; a missing slug reads as empty', () => {
    expect(
      moderationHistoryTarget({ isModerator: true }, { appListingId: null, slug: 'x' })
    ).toBeNull();
    expect(
      moderationHistoryTarget({ isModerator: true }, { appListingId: '', slug: 'x' })
    ).toBeNull();
    expect(
      moderationHistoryTarget({ isModerator: true }, { appListingId: 'apl_entry_9', slug: null })
    ).toEqual({ appListingId: 'apl_entry_9', slug: '' });
  });
});

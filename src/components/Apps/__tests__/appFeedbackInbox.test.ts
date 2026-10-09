import { describe, expect, it } from 'vitest';

import {
  buildSetOwnerStatusInput,
  feedbackRowMeta,
  INBOX_EMPTY_MESSAGE,
  INBOX_FILTER_EMPTY_MESSAGE,
  INBOX_GENERIC_ERROR_MESSAGE,
  INBOX_NO_ACCESS_MESSAGE,
  INBOX_PRIVACY_NOTE,
  INBOX_STALE_MESSAGE,
  INBOX_STATUS_FILTERS,
  inboxActionError,
  inboxEmptyMessage,
  inboxStatusFilterInput,
  newFeedbackBadge,
  ownerStatusChoices,
  ownerStatusLabel,
  reporterLabel,
} from '~/components/Apps/appFeedbackInbox';
import { APP_FEEDBACK_PRIVATE_NOTICE } from '~/components/AppBlocks/appFeedbackChrome';

describe('ownerStatusChoices — the status control', () => {
  it('a NEW row offers all three developer statuses', () => {
    expect(ownerStatusChoices(null)).toEqual(['acknowledged', 'resolved', 'wont_fix']);
  });

  it('a set row offers the OTHER two, never the one it already has', () => {
    expect(ownerStatusChoices('acknowledged')).toEqual(['resolved', 'wont_fix']);
    expect(ownerStatusChoices('resolved')).toEqual(['acknowledged', 'wont_fix']);
    expect(ownerStatusChoices('wont_fix')).toEqual(['acknowledged', 'resolved']);
  });
});

describe('buildSetOwnerStatusInput — the write is scoped on what the owner last saw', () => {
  it('sends the row the owner SAW as `expectedOwnerStatus`, so a moved row is a CONFLICT', () => {
    expect(
      buildSetOwnerStatusInput('apl_7', { id: 41, ownerStatus: 'acknowledged' }, 'wont_fix')
    ).toEqual({
      id: 41,
      appListingId: 'apl_7',
      ownerStatus: 'wont_fix',
      expectedOwnerStatus: 'acknowledged',
    });
  });

  it('a NEW row is expected as `null`, not omitted', () => {
    const input = buildSetOwnerStatusInput('apl_8', { id: 3, ownerStatus: null }, 'resolved');
    expect(input).toEqual({
      id: 3,
      appListingId: 'apl_8',
      ownerStatus: 'resolved',
      expectedOwnerStatus: null,
    });
    expect('expectedOwnerStatus' in input).toBe(true);
  });
});

describe('inboxActionError — what a failed owner write tells the owner', () => {
  it('CONFLICT is "already changed — refresh", never the raw server text', () => {
    expect(
      inboxActionError({ message: 'This feedback has changed', data: { code: 'CONFLICT' } })
    ).toEqual({ kind: 'stale', message: INBOX_STALE_MESSAGE });
  });

  it('FORBIDDEN and UNAUTHORIZED both read as lost access', () => {
    expect(inboxActionError({ message: 'x', data: { code: 'FORBIDDEN' } })).toEqual({
      kind: 'no_access',
      message: INBOX_NO_ACCESS_MESSAGE,
    });
    expect(inboxActionError({ message: 'x', data: { code: 'UNAUTHORIZED' } })).toEqual({
      kind: 'no_access',
      message: INBOX_NO_ACCESS_MESSAGE,
    });
  });

  it('anything else, including a missing code, is the generic message', () => {
    for (const error of [
      { message: 'boom', data: { code: 'INTERNAL_SERVER_ERROR' } },
      { message: '[{"code":"too_small"}]', data: { code: 'BAD_REQUEST' } },
      { message: 'network', data: null },
      {},
    ]) {
      expect(inboxActionError(error)).toEqual({
        kind: 'other',
        message: INBOX_GENERIC_ERROR_MESSAGE,
      });
    }
  });

  it('the three messages are distinct', () => {
    expect(
      new Set([INBOX_STALE_MESSAGE, INBOX_NO_ACCESS_MESSAGE, INBOX_GENERIC_ERROR_MESSAGE]).size
    ).toBe(3);
  });
});

describe('newFeedbackBadge — the /apps/build count', () => {
  const counts = { apl_a: 2, apl_b: 7 };

  it('reads THIS row’s count and links to its Feedback tab', () => {
    expect(newFeedbackBadge(counts, { appListingId: 'apl_b', status: 'approved' })).toEqual({
      count: 7,
      label: '7 new feedback',
      href: '/apps/listing/apl_b/edit?tab=feedback',
    });
    expect(newFeedbackBadge(counts, { appListingId: 'apl_a', status: 'draft' })?.count).toBe(2);
  });

  it('no badge for a listing with no entry, a zero, or while the counts are unresolved', () => {
    expect(newFeedbackBadge(counts, { appListingId: 'apl_c', status: 'approved' })).toBeNull();
    expect(
      newFeedbackBadge({ apl_z: 0 }, { appListingId: 'apl_z', status: 'approved' })
    ).toBeNull();
    expect(newFeedbackBadge(undefined, { appListingId: 'apl_a', status: 'approved' })).toBeNull();
  });

  it('still shown on a REMOVED listing — the editor opens there and so does its Feedback tab', () => {
    expect(newFeedbackBadge(counts, { appListingId: 'apl_a', status: 'removed' })?.count).toBe(2);
  });

  it('no badge where the editor route does not open — the link would be a dead end', () => {
    expect(newFeedbackBadge(counts, { appListingId: 'apl_a', status: 'archived' })).toBeNull();
  });

  it('encodes the listing id in the href', () => {
    expect(newFeedbackBadge({ 'a/b': 1 }, { appListingId: 'a/b', status: 'approved' })?.href).toBe(
      '/apps/listing/a%2Fb/edit?tab=feedback'
    );
  });
});

describe('feedbackRowMeta — "version live when sent" and surface', () => {
  it('version, short sha and surface', () => {
    expect(
      feedbackRowMeta({
        appBlockVersion: '1.4.0',
        appBlockSha: '3f9c2ab81d0e',
        surface: 'page',
      })
    ).toEqual(['v1.4.0 (3f9c2ab)', 'App page']);
  });

  it('the model-slot surface has its own label', () => {
    expect(
      feedbackRowMeta({ appBlockVersion: '2.0.1', appBlockSha: null, surface: 'slot' })
    ).toEqual(['v2.0.1', 'Model page']);
  });

  it('a sha with no version still identifies the build', () => {
    expect(
      feedbackRowMeta({ appBlockVersion: null, appBlockSha: 'abcdef0123', surface: null })
    ).toEqual(['build abcdef0']);
  });

  it('nothing known → nothing rendered', () => {
    expect(feedbackRowMeta({ appBlockVersion: null, appBlockSha: null, surface: null })).toEqual(
      []
    );
  });
});

describe('labels and filters', () => {
  it('a NULL owner status is "New"', () => {
    expect(ownerStatusLabel(null)).toBe('New');
    expect(ownerStatusLabel('wont_fix')).toBe("Won't fix");
  });

  it('a deleted reporter reads as such', () => {
    expect(reporterLabel(null)).toBe('Deleted account');
    expect(reporterLabel('kai')).toBe('kai');
  });

  it('the filter set is All, New, then each status — `all` sends no filter', () => {
    expect(INBOX_STATUS_FILTERS.map((f) => f.value)).toEqual([
      'all',
      'new',
      'acknowledged',
      'resolved',
      'wont_fix',
    ]);
    expect(inboxStatusFilterInput('all')).toBeUndefined();
    expect(inboxStatusFilterInput('new')).toBe('new');
    expect(inboxStatusFilterInput('resolved')).toBe('resolved');
  });
});

describe('the copy owners read, pinned literally', () => {
  it('privacy, empty, stale and lost-access wording', () => {
    expect(INBOX_PRIVACY_NOTE).toBe(
      "Private feedback from people using this app. Only this app's developer, their collaborators and Civitai moderators can read it — it never appears on the app's page."
    );
    expect(INBOX_EMPTY_MESSAGE).toBe('No feedback to show right now.');
    expect(INBOX_STALE_MESSAGE).toBe('Someone already changed this feedback. Refresh to see it.');
    expect(INBOX_NO_ACCESS_MESSAGE).toBe("You no longer have access to this app's feedback.");
    expect(INBOX_FILTER_EMPTY_MESSAGE).toBe('No feedback with this status.');
    expect(INBOX_GENERIC_ERROR_MESSAGE).toBe('Something went wrong. Please try again.');
  });
});

describe('inboxEmptyMessage', () => {
  it('unfiltered: nothing left to show (the tab only exists once a row did)', () => {
    expect(inboxEmptyMessage('all')).toBe(INBOX_EMPTY_MESSAGE);
  });

  it('a filter that matches nothing says so', () => {
    expect(inboxEmptyMessage('resolved')).toBe(INBOX_FILTER_EMPTY_MESSAGE);
    expect(inboxEmptyMessage('new')).toBe(INBOX_FILTER_EMPTY_MESSAGE);
  });
});

describe('the sender and the developer are told the same readers', () => {
  it('the send dialog and the inbox name an identical audience', () => {
    // Pinned as a RELATIONSHIP across the two surfaces: extract the "Only <readers> can read"
    // clause from each and compare, so neither can be reworded to a different audience alone.
    const readers = (s: string) => s.match(/Only (.*?) can read/)?.[1];
    expect(readers(INBOX_PRIVACY_NOTE)).toBe(
      "this app's developer, their collaborators and Civitai moderators"
    );
    expect(readers(APP_FEEDBACK_PRIVATE_NOTICE)).toBe(readers(INBOX_PRIVACY_NOTE));
  });
});

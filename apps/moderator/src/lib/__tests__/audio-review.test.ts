import { describe, expect, it } from 'vitest';
import {
  checkState,
  dismissDecision,
  heldDecisions,
  heldDecisionsEnabled,
  lyricsHoldHref,
  ratingKeysEnabled,
  reportedOutcome,
  REPORTED_DECISIONS,
  isSongRatingLevel,
  reportedDecisionsEnabled,
  reportTimeSec,
  songReportReasons,
} from '$lib/audio-review';
import { offersImageFlags } from '$lib/music/song-card';

/** The rules Audio review's Reported tab decides in the browser (Music T10). */

describe('a report time in the song', () => {
  it('reads `details.timestampSec`, and reads anything malformed or absent as none', () => {
    expect(reportTimeSec({ timestampSec: 84 })).toBe(84);
    expect(reportTimeSec({ timestampSec: '12.5' })).toBe(12.5);
    expect(reportTimeSec({ timestampSec: 0 })).toBe(0);
    for (const details of [null, 'x', [], {}, { timestampSec: -1 }, { timestampSec: 'abc' }])
      expect(reportTimeSec(details)).toBeNull();
  });
});

describe('the decision keys on a reported song', () => {
  const live = { withheld: false, removed: false, removal: null };
  const removed = (
    blockedFor: string | null,
    ruleBlocked = false,
    needsReview: string | null = null
  ) => ({
    withheld: false,
    removed: true,
    removal: { blockedFor, ruleBlocked, needsReview },
  });
  /** The enabled keys by name, so a reordered tuple cannot pass. */
  const offered = (row: Parameters<typeof reportedDecisionsEnabled>[0], canAct = true) => {
    const enabled = reportedDecisionsEnabled(row, canAct);
    return REPORTED_DECISIONS.filter((_, i) => enabled[i]);
  };

  it('offers Dismiss, Remove song and Set rating on a live song, and Remove cover only with a cover to remove', () => {
    expect(offered(live)).toEqual(['dismiss', 'remove', 'rate']);
    expect(offered({ ...live, removableCoverId: 620 })).toEqual([
      'dismiss',
      'remove',
      'removeCover',
      'rate',
    ]);
    expect(dismissDecision(live)).toEqual({
      label: 'Dismiss reports',
      outcome: 'Reports dismissed',
    });
  });

  it('restores a rule-blocked song on dismissal, and can make it a moderator removal', () => {
    const row = removed('moderated', true);
    expect(offered(row)).toEqual(['dismiss', 'remove']);
    expect(dismissDecision(row).label).toBe('Restore and dismiss');
  });

  it('only closes the reports of a song a moderator removed', () => {
    const row = removed('moderated');
    expect(offered(row)).toEqual(['dismiss']);
    // Its cover is its own row, still removable while the song stays removed.
    expect(offered({ ...row, removableCoverId: 620 })).toEqual(['dismiss', 'removeCover']);
    expect(dismissDecision(row)).toEqual({
      label: 'Close reports',
      outcome: 'Closed: already removed',
    });
  });

  it('takes nothing on a song removed for CSAM or under CSAM review', () => {
    expect(offered(removed('CSAM'))).toEqual([]);
    expect(offered(removed(null, false, 'csam'))).toEqual([]);
    expect(offered({ ...removed('CSAM'), removableCoverId: 620 })).toEqual([]);
  });

  it('offers nothing on a withheld song, or without the grant', () => {
    expect(offered({ ...live, withheld: true, removableCoverId: 620 })).toEqual([]);
    expect(offered({ ...live, removableCoverId: 620 }, false)).toEqual([]);
  });

  it('shows what the writer did when it was not what was asked', () => {
    expect(
      reportedOutcome({ type: 'success', data: { alreadyRemoved: 'x' } }, 'Reports dismissed')
    ).toBe('Closed: already removed');
    expect(
      reportedOutcome({ type: 'success', data: { held: 'Held for confirmation.' } }, 'Song removed')
    ).toBe('Held for confirmation.');
    expect(reportedOutcome({ type: 'success', data: {} }, 'Song removed')).toBe('Song removed');
  });
});

describe('the rating keys', () => {
  it('skip the level the song already has', () => {
    expect(ratingKeysEnabled(2, true)).toEqual([true, false, true, true, true]);
    expect(ratingKeysEnabled(2, false).some(Boolean)).toBe(false);
  });
});

describe('a song rating', () => {
  it('is PG to XXX: Blocked is a removal, not a rating', () => {
    expect([1, 2, 4, 8, 16].every(isSongRatingLevel)).toBe(true);
    expect(isSongRatingLevel(0)).toBe(false);
  });
});

describe('Minor and POI', () => {
  it('are offered on images and videos and never on a song', () => {
    expect(offersImageFlags({ type: 'image' })).toBe(true);
    expect(offersImageFlags({ type: 'video' })).toBe(true);
    expect(offersImageFlags({ type: 'audio' })).toBe(false);
  });
});

describe('the list row and the checks card', () => {
  it('names the most reported reason first', () => {
    expect(
      songReportReasons([
        { label: 'Spam', also: 0 },
        { label: 'Harassment', also: 2 },
        { label: 'Spam', also: 0 },
      ])
    ).toEqual(['Harassment', 'Spam']);
  });
  it('shows a scan as passed, held, blocked, not finished or failed, and nothing more', () => {
    const scanned = { ingestion: 'Scanned', needsReview: null, blockedFor: null };
    expect(checkState(scanned)).toBe('passed');
    expect(checkState({ ...scanned, needsReview: 'csam' })).toBe('held');
    expect(checkState({ ...scanned, ingestion: 'Blocked', blockedFor: 'moderated' })).toBe(
      'blocked'
    );
    expect(checkState({ ...scanned, ingestion: 'Pending' })).toBe('pending');
    expect(checkState({ ...scanned, ingestion: 'Error' })).toBe('failed');
  });
});

describe('the decision keys on a held song', () => {
  const base = {
    withheld: false,
    removed: false,
    cover: { id: 9, url: 'c', flag: 'tag', nsfwLevel: 1 },
    removableCoverId: 9,
  };
  const lyrics = {
    ...base,
    kind: 'lyrics' as const,
    withheld: true,
    cover: null,
    removableCoverId: null,
  };

  it('offer a lyrics hold only the link to CSAM holds, and only with its grant', () => {
    expect(heldDecisions('lyrics')).toEqual(['openHold']);
    expect(heldDecisionsEnabled(lyrics, true, true)).toEqual([true]);
    expect(heldDecisionsEnabled(lyrics, true, false)).toEqual([false]);
    // The image moderation grant does not open it: the hold is decided in CSAM holds.
    expect(heldDecisionsEnabled(lyrics, false, true)).toEqual([true]);
  });

  it('offer a flagged cover Approve cover, Remove cover, Remove song and Set rating', () => {
    const cover = { ...base, kind: 'cover' as const };
    expect(heldDecisions('cover')).toEqual(['approveCover', 'removeCover', 'removeSong', 'rate']);
    expect(heldDecisionsEnabled(cover, true, false)).toEqual([true, true, true, true]);
    expect(heldDecisionsEnabled(cover, false, true)).toEqual([false, false, false, false]);
    // A removed song keeps only its cover's decisions.
    expect(heldDecisionsEnabled({ ...cover, removed: true }, true, false)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    // A cover removed on this page has nothing left to approve or remove.
    expect(
      heldDecisionsEnabled({ ...cover, cover: null, removableCoverId: null }, true, false)
    ).toEqual([false, false, true, true]);
  });

  it('offer a flagged song the Reported tab’s decisions with Approve song first', () => {
    const song = { ...base, kind: 'song' as const, cover: null };
    expect(heldDecisions('song')).toEqual(['approveSong', 'removeSong', 'removeCover', 'rate']);
    expect(heldDecisionsEnabled(song, true, false)).toEqual([true, true, true, true]);
    expect(heldDecisionsEnabled({ ...song, removableCoverId: null }, true, false)).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });

  it('offer a withheld cover or song nothing', () => {
    for (const kind of ['cover', 'song'] as const)
      expect(heldDecisionsEnabled({ ...base, kind, withheld: true }, true, true)).toEqual([
        false,
        false,
        false,
        false,
      ]);
  });

  it('link a lyrics hold to its pending hold in CSAM holds', () => {
    expect(lyricsHoldHref(701)).toBe('/csam/text-holds?entityType=TrackLyrics&q=701');
  });
});

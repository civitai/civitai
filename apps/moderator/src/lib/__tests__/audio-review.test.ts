import { describe, expect, it } from 'vitest';
import {
  checkState,
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
  const live = { withheld: false, ingestion: 'Scanned' };
  it('offers Dismiss, Remove song and Set rating, never Remove cover yet', () => {
    expect(reportedDecisionsEnabled(live, true)).toEqual([true, true, false, true]);
  });
  it('offers only Dismiss on a song already removed', () => {
    expect(reportedDecisionsEnabled({ ...live, ingestion: 'Blocked' }, true)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
  it('offers nothing on a withheld song, or without the grant', () => {
    expect(reportedDecisionsEnabled({ ...live, withheld: true }, true)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(reportedDecisionsEnabled(live, false).some(Boolean)).toBe(false);
  });
});

describe('a song rating', () => {
  it('is PG to XXX: Blocked is a removal, not a rating', () => {
    expect([1, 2, 4, 8, 16].every(isSongRatingLevel)).toBe(true);
    expect(isSongRatingLevel(32)).toBe(false);
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

import { describe, expect, it } from 'vitest';
import {
  developerTrackRecordView,
  formatDeveloperTrackRecord,
} from '~/components/Apps/developer-track-record';

/**
 * The track-record line beside the creator card on a listing page ("4 apps · 12 reviews"), and
 * the Official case: a listing marked Official is made by the Civitai team, so it shows the
 * Official badge there instead of a count.
 */

describe('formatDeveloperTrackRecord', () => {
  it('reads "<n> apps · <m> reviews", whole string', () => {
    expect(formatDeveloperTrackRecord({ appCount: 4, reviewCount: 12 })).toBe(
      '4 apps · 12 reviews'
    );
  });

  it('singular nouns at one, and a zero review count is still stated', () => {
    expect(formatDeveloperTrackRecord({ appCount: 1, reviewCount: 1 })).toBe('1 app · 1 review');
    expect(formatDeveloperTrackRecord({ appCount: 2, reviewCount: 0 })).toBe('2 apps · 0 reviews');
  });

  it('groups thousands', () => {
    expect(formatDeveloperTrackRecord({ appCount: 3, reviewCount: 1234 })).toBe(
      '3 apps · 1,234 reviews'
    );
  });
});

describe('🔴 developerTrackRecordView', () => {
  it('🔴 an Official listing shows the Official badge, never the count', () => {
    expect(
      developerTrackRecordView({ isOfficial: true, record: { appCount: 4, reviewCount: 12 } })
    ).toEqual({ kind: 'official' });
    // …including before (or without) a record.
    expect(developerTrackRecordView({ isOfficial: true, record: null })).toEqual({
      kind: 'official',
    });
  });

  it("any other listing shows its developer's record", () => {
    expect(
      developerTrackRecordView({ isOfficial: false, record: { appCount: 4, reviewCount: 12 } })
    ).toEqual({ kind: 'record', text: '4 apps · 12 reviews' });
  });

  it('no line while the record is unknown, or when nothing of theirs is visible', () => {
    expect(developerTrackRecordView({ isOfficial: false, record: null })).toBeNull();
    expect(developerTrackRecordView({ isOfficial: false, record: undefined })).toBeNull();
    expect(
      developerTrackRecordView({ isOfficial: false, record: { appCount: 0, reviewCount: 0 } })
    ).toBeNull();
  });
});

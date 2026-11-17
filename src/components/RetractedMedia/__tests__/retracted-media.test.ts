import { describe, expect, it } from 'vitest';
import { retractedMediaUrl } from '~/components/RetractedMedia/retracted-media';

describe('retractedMediaUrl', () => {
  it('sends a moderator to the storage route for a blocked image', () => {
    expect(retractedMediaUrl({ id: 7, ingestion: 'Blocked' }, { isModerator: true })).toBe(
      '/api/mod/retracted-media/7'
    );
  });

  it('keeps everyone else, and every other image, on the CDN', () => {
    expect(retractedMediaUrl({ id: 7, ingestion: 'Blocked' }, { isModerator: false })).toBeNull();
    expect(retractedMediaUrl({ id: 7, ingestion: 'Blocked' }, null)).toBeNull();
    expect(retractedMediaUrl({ id: 7, ingestion: 'Scanned' }, { isModerator: true })).toBeNull();
    expect(retractedMediaUrl({ id: 7 }, { isModerator: true })).toBeNull();
  });
});

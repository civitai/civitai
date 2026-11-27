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

  it('sends a moderator to the route for a scanned image only once the CDN has refused it', () => {
    const failed = { cdnFailed: true };
    expect(retractedMediaUrl({ id: 7, ingestion: 'Scanned' }, { isModerator: true }, failed)).toBe(
      '/api/mod/retracted-media/7'
    );
    expect(
      retractedMediaUrl({ id: 7, ingestion: 'Scanned' }, { isModerator: false }, failed)
    ).toBeNull();
    expect(
      retractedMediaUrl({ id: 7, ingestion: 'Pending' }, { isModerator: true }, failed)
    ).toBeNull();
  });

  it("sends an owner's blocked image that image.get marked to the owner route, for any viewer state", () => {
    const own = { id: 7, ingestion: 'Blocked', ownerRetractedMedia: true };
    expect(retractedMediaUrl(own, null)).toBe('/api/retracted-media/own/7');
    expect(retractedMediaUrl(own, { isModerator: false })).toBe('/api/retracted-media/own/7');
    expect(retractedMediaUrl({ ...own, ownerRetractedMedia: false }, null)).toBeNull();
  });
});

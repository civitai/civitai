import { describe, expect, it } from 'vitest';
import { getTagFeedHref } from '~/components/VotableTags/tagFeedHref';

describe('getTagFeedHref', () => {
  it('sends video tags to the videos feed', () => {
    expect(getTagFeedHref(5133, 'video')).toBe('/videos?tags=5133&view=feed');
  });

  it('sends image tags to the images feed', () => {
    expect(getTagFeedHref(5133, 'image')).toBe('/images?tags=5133&view=feed');
  });

  it('falls back to the images feed when the media type is unknown', () => {
    expect(getTagFeedHref(5133)).toBe('/images?tags=5133&view=feed');
    expect(getTagFeedHref(5133, 'audio')).toBe('/images?tags=5133&view=feed');
  });
});

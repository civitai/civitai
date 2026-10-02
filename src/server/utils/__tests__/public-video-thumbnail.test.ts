import { describe, expect, it } from 'vitest';
import { getPublicVideoThumbnail } from '~/server/utils/public-video-thumbnail';
import { MediaType } from '~/shared/utils/prisma/enums';

const video = {
  type: MediaType.video,
  url: 'video-uuid',
  width: 1280,
  height: 704,
  metadata: { width: 1280, height: 704, duration: 5 },
};

const customThumbnail = { url: 'thumb-uuid', width: 832, height: 1216, nsfwLevel: 1 };

describe('getPublicVideoThumbnail', () => {
  it('is null for anything that is not a video', () => {
    expect(
      getPublicVideoThumbnail({ image: { ...video, type: MediaType.image }, browsingLevel: 1 })
    ).toBeNull();
  });

  it('falls back to an extracted JPEG frame at the video’s own dimensions', () => {
    const thumbnail = getPublicVideoThumbnail({ image: video, browsingLevel: 1 });

    expect(thumbnail).toEqual({ url: expect.any(String), width: 1280, height: 704 });
    expect(thumbnail!.url).toMatch(
      /(^|\/)video-uuid\/anim=false,transcode=true,original=false\/video-uuid\.jpeg$/
    );
  });

  it('never asks for the original or an optimized variant — both serve a non-JPEG', () => {
    // original=true serves the MP4; optimized=true serves WebP for image thumbnails.
    const frame = getPublicVideoThumbnail({ image: video, browsingLevel: 1 })!.url;
    const custom = getPublicVideoThumbnail({
      image: video,
      customThumbnail,
      browsingLevel: 1,
    })!.url;

    for (const url of [frame, custom]) {
      expect(url).not.toContain('original=true');
      expect(url).not.toContain('optimized');
    }
  });

  it('skips into a long video the way the site’s poster does', () => {
    const thumbnail = getPublicVideoThumbnail({
      image: { ...video, metadata: { ...video.metadata, duration: 600, thumbnailFrame: 12 } },
      browsingLevel: 1,
    });

    expect(thumbnail!.url).toContain('skip=12');
  });

  it('prefers the uploader’s custom thumbnail when the browsing level allows it', () => {
    const thumbnail = getPublicVideoThumbnail({ image: video, customThumbnail, browsingLevel: 1 });

    expect(thumbnail).toEqual({ url: expect.any(String), width: 832, height: 1216 });
    expect(thumbnail!.url).toMatch(/(^|\/)thumb-uuid\/original=false\/thumb-uuid\.jpeg$/);
  });

  it('serves the frame instead of a custom thumbnail rated above the browsing level', () => {
    const thumbnail = getPublicVideoThumbnail({
      image: video,
      customThumbnail: { ...customThumbnail, nsfwLevel: 16 },
      browsingLevel: 1,
    });

    expect(thumbnail!.url).toMatch(/(^|\/)video-uuid\//);
    expect(thumbnail!.width).toBe(1280);
  });

  it('serves the frame instead of an unrated custom thumbnail', () => {
    const thumbnail = getPublicVideoThumbnail({
      image: video,
      customThumbnail: { ...customThumbnail, nsfwLevel: 0 },
      browsingLevel: 31,
    });

    expect(thumbnail!.url).toMatch(/(^|\/)video-uuid\//);
  });
});

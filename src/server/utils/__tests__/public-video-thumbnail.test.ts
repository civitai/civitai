import { describe, expect, it } from 'vitest';
import { getPublicVideoThumbnail } from '~/server/utils/public-video-thumbnail';
import { NsfwLevel } from '~/server/common/enums';
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

  it('falls back to an extracted frame at the video’s own dimensions', () => {
    expect(getPublicVideoThumbnail({ image: video, browsingLevel: 1 })).toEqual({
      url: expect.stringMatching(
        /(^|\/)video-uuid\/anim=false,transcode=true,optimized=true\/video-uuid\.jpeg$/
      ),
      width: 1280,
      height: 704,
    });
  });

  it('never carries an `original` param, since `original=true` serves the MP4', () => {
    const frame = getPublicVideoThumbnail({ image: video, browsingLevel: 1 })!.url;
    const custom = getPublicVideoThumbnail({
      image: video,
      customThumbnail,
      browsingLevel: 1,
    })!.url;

    for (const url of [frame, custom]) {
      expect(url).not.toContain('original=');
    }
  });

  it('skips into a long video the way the site’s poster does', () => {
    const thumbnail = getPublicVideoThumbnail({
      image: { ...video, metadata: { ...video.metadata, duration: 600, thumbnailFrame: 12 } },
      browsingLevel: 1,
    });

    expect(thumbnail!.url).toMatch(/\/anim=false,transcode=true,optimized=true,skip=12\//);
  });

  it('prefers the uploader’s custom thumbnail, at its own dimensions, when the level allows it', () => {
    expect(getPublicVideoThumbnail({ image: video, customThumbnail, browsingLevel: 1 })).toEqual({
      url: expect.stringMatching(/(^|\/)thumb-uuid\/anim=false,optimized=true\/thumb-uuid\.jpeg$/),
      width: 832,
      height: 1216,
    });
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

  it('never serves a Blocked custom thumbnail, even when the caller asks for the Blocked level', () => {
    const thumbnail = getPublicVideoThumbnail({
      image: video,
      customThumbnail: { ...customThumbnail, nsfwLevel: NsfwLevel.Blocked },
      browsingLevel: 63,
    });

    expect(thumbnail!.url).toMatch(/(^|\/)video-uuid\//);
  });

  it('serves the frame instead of an unrated custom thumbnail', () => {
    const thumbnail = getPublicVideoThumbnail({
      image: video,
      customThumbnail: { ...customThumbnail, nsfwLevel: 0 },
      browsingLevel: 31,
    });

    expect(thumbnail!.url).toMatch(/(^|\/)video-uuid\//);
  });

  it('reports null dimensions for a custom thumbnail cached without them', () => {
    const thumbnail = getPublicVideoThumbnail({
      image: video,
      customThumbnail: { url: 'thumb-uuid', nsfwLevel: 1 },
      browsingLevel: 1,
    });

    expect(thumbnail).toMatchObject({ width: null, height: null });
  });
});

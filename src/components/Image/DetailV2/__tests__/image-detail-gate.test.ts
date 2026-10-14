import { describe, expect, it } from 'vitest';
import { imageDetailGateLevel } from '~/components/Image/DetailV2/image-detail-gate';
import { NsfwLevel } from '~/server/common/enums';

const CONTEST_LEVEL = NsfwLevel.PG | NsfwLevel.PG13;

describe('imageDetailGateLevel', () => {
  it("gates on a contest's forced level when the media was sent", () => {
    expect(imageDetailGateLevel({ url: 'media-key', nsfwLevel: NsfwLevel.R }, CONTEST_LEVEL)).toBe(
      CONTEST_LEVEL
    );
  });

  // `image.get` sends `url: null` when the viewer may not receive the media.
  it('gates on the image rating when the media was withheld', () => {
    expect(imageDetailGateLevel({ url: null, nsfwLevel: NsfwLevel.R }, CONTEST_LEVEL)).toBe(
      NsfwLevel.R
    );
  });

  it('gates on the image rating without a forced level', () => {
    expect(imageDetailGateLevel({ url: 'media-key', nsfwLevel: NsfwLevel.R }, undefined)).toBe(
      NsfwLevel.R
    );
    expect(imageDetailGateLevel({ url: 'media-key', nsfwLevel: NsfwLevel.R }, 0)).toBe(NsfwLevel.R);
  });
});

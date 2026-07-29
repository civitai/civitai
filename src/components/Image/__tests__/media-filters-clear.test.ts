import { describe, expect, it } from 'vitest';
import { getDefaultMediaTypes } from '~/components/Image/image.utils';
import { MetricTimeframe, MediaType } from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';

describe('getDefaultMediaTypes', () => {
  it('scopes the images feed to image-only', () => {
    expect(getDefaultMediaTypes('images')).toEqual([MediaType.image]);
  });

  it('scopes the videos feed to video-only', () => {
    expect(getDefaultMediaTypes('videos')).toEqual([MediaType.video]);
  });

  it('leaves model-image feeds unscoped (all media types)', () => {
    expect(getDefaultMediaTypes('modelImages')).toBeUndefined();
  });
});

describe('clearing feed filters keeps the media-type scope', () => {
  // Regression for the /images "Clear all filters" bug: the clear handler used
  // to reset `types` to `undefined`, which `removeEmpty` strips from the stored
  // filters, so the image.getInfinite payload lost its media-type scope and the
  // feed served videos alongside images. Clearing must restore the feed default.
  it('does not strip types from a cleared images payload', () => {
    const cleared = removeEmpty({
      types: getDefaultMediaTypes('images'),
      period: MetricTimeframe.AllTime,
    });
    expect(cleared.types).toEqual([MediaType.image]);
  });

  it('does not strip types from a cleared videos payload', () => {
    const cleared = removeEmpty({
      types: getDefaultMediaTypes('videos'),
      period: MetricTimeframe.AllTime,
    });
    expect(cleared.types).toEqual([MediaType.video]);
  });
});

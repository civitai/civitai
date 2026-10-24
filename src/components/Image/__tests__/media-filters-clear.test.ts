import { describe, expect, it } from 'vitest';
import { getDefaultMediaTypes } from '~/components/Image/image.utils';
import { MediaType } from '~/shared/utils/prisma/enums';

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

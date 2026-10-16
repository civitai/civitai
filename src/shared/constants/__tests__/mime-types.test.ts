import { describe, expect, it } from 'vitest';
import {
  getExtensionsFromMimeTypes,
  getMimeTypeFromExt,
  getMimeTypesFromMediaTypes,
  IMAGE_MIME_TYPE,
  MEDIA_TYPE,
  ENGINE_INPUT_IMAGE_MIME_TYPE,
} from '~/shared/constants/mime-types';
import { MediaType } from '~/shared/utils/prisma/enums';

describe('AVIF uploads', () => {
  it('are an accepted image type', () => {
    expect(IMAGE_MIME_TYPE).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/avif']);
    expect(getMimeTypesFromMediaTypes([MediaType.image])).toContain('image/avif');
  });

  it('are classed as images, so the preprocessor and size checks handle them', () => {
    expect(MEDIA_TYPE['image/avif']).toBe(MediaType.image);
    expect(getMimeTypeFromExt('avif')).toBe('image/avif');
  });

  it('are named in the dropzone label', () => {
    expect(getExtensionsFromMimeTypes(IMAGE_MIME_TYPE)).toBe('PNG, JPG, WEBP, AVIF');
  });

  it('are kept out of inputs that reach an engine as raw bytes', () => {
    expect(ENGINE_INPUT_IMAGE_MIME_TYPE).toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  imageDetailMainImageUrl,
  imageDetailPreloadUrl,
} from '~/components/Image/DetailV2/image-detail-main-media';
import { env } from '~/env/client';
import { NsfwLevel } from '~/server/common/enums';

/**
 * `imageDetailMainImageUrl` names the `<img>` request only; media the carousel does not render as
 * an `<img>` has none. (That the rendered `<img>` asks for exactly this URL is
 * `ImageDetailCarousel.mainImageUrl.browser.test.tsx`; which viewers get it, the endpoint suite.)
 */

const edge = (...segments: string[]) =>
  [env.NEXT_PUBLIC_IMAGE_LOCATION, ...segments].filter(Boolean).join('/');

const base = { id: 5150, name: 'Field at Dawn.webp', url: 'key-5150' };

describe('imageDetailMainImageUrl', () => {
  it('an image: its original, under its name with the delivered extension', () => {
    expect(imageDetailMainImageUrl({ ...base, type: 'image' })).toBe(
      edge('key-5150', 'original=true', 'Field at Dawn.jpeg')
    );
  });

  it.each([
    ['a video', { ...base, type: 'video' as const }],
    ['audio', { ...base, type: 'audio' as const }],
    ['no URL (media the viewer is not sent)', { ...base, url: null, type: 'image' as const }],
  ])('none for %s', (_, image) => {
    expect(imageDetailMainImageUrl(image)).toBeUndefined();
  });
});

describe('imageDetailPreloadUrl', () => {
  const image = (nsfwLevel: number) => ({
    ...base,
    type: 'image' as const,
    nsfwLevel,
    poi: false,
    user: { id: 1 },
  });
  const viewer = { id: 2 };

  it('a PG image for a signed-in viewer', () => {
    expect(imageDetailPreloadUrl({ image: image(NsfwLevel.PG), viewer, canViewNsfw: false })).toBe(
      imageDetailMainImageUrl(image(NsfwLevel.PG))
    );
  });

  it.each([
    ['no image', { image: null, viewer, canViewNsfw: false }],
    [
      'an unrated image (the guard blurs per viewer)',
      { image: image(0), viewer, canViewNsfw: true },
    ],
    ['an X image on .red', { image: image(NsfwLevel.X), viewer, canViewNsfw: true }],
    [
      'a PG image a contest forces to X, on .com',
      { image: image(NsfwLevel.PG), viewer, canViewNsfw: false, forcedBrowsingLevel: NsfwLevel.X },
    ],
  ])('none for %s', (_, input) => {
    expect(imageDetailPreloadUrl(input)).toBeUndefined();
  });
});

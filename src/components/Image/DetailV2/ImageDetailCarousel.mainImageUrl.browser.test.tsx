import type { ReactElement } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { imageDetailMainImageUrl } from '~/components/Image/DetailV2/image-detail-main-media';
import { env } from '~/env/client';
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * The shell of `/images/[imageId]` preloads its main image by the URL `imageDetailMainImageUrl`
 * computes (the page data's `mainImageUrl`). A preload saves anything only if the `<img>` the
 * carousel then renders asks for the very same URL; a different one is a second download. So this
 * renders the REAL carousel, `EdgeMedia` and `EdgeImage`, and compares the `src` the element got
 * with the helper's answer, and with the URL written out.
 *
 * The guard is stubbed to "show": which viewers see the media is `imageDetailPreloadUrl`'s
 * question, pinned with the endpoint (`image-detail.endpoint.test.ts`). Here it is only the URL.
 */

vi.mock('~/components/ImageGuard/ImageGuard2', async (o) => ({
  ...(await o<object>()),
  ImageGuardContent: ({ children }: { children: (show: boolean) => ReactElement | null }) =>
    children(true),
}));
vi.mock('~/components/Sticker/ImageStickerOverlay', async (o) => ({
  ...(await o<object>()),
  ImageStickerOverlay: () => null,
}));
vi.mock('~/components/Cosmetics/EventDecoration/DrawnMediaHat', async (o) => ({
  ...(await o<object>()),
  DrawnMediaHat: () => null,
}));
vi.mock('~/components/ImageHash/ImageHash', async (o) => ({
  ...(await o<object>()),
  MediaHash: () => null,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (o) => ({
  ...(await o<object>()),
  useFeatureFlags: () => ({}),
}));

import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';

const edge = (...segments: string[]) =>
  [env.NEXT_PUBLIC_IMAGE_LOCATION, ...segments].filter(Boolean).join('/');

const image = (overrides: { id: number; name: string | null; url: string }) => ({
  nsfwLevel: 1,
  height: 600,
  width: 400,
  type: 'image' as const,
  ...overrides,
});

const noop = () => undefined;

async function renderedSrc(img: ReturnType<typeof image>) {
  await page.viewport(1200, 800);
  renderWithProviders(
    <div style={{ width: 400, height: 300, display: 'flex' }}>
      <ImageDetailCarousel
        images={[img]}
        index={0}
        next={noop}
        previous={noop}
        canNavigate={false}
      />
    </div>
  );
  const element = await vi.waitFor(() => {
    const found = document.querySelector('img');
    if (!found) throw new Error('no <img> yet');
    return found;
  });
  // A `srcset` would let the browser pick a candidate the preload's `href` is not.
  expect(element.getAttribute('srcset')).toBeNull();
  return element.getAttribute('src');
}

describe('the carousel’s main <img> requests the URL the shell preloads', () => {
  test.each([
    [
      'a named image',
      image({ id: 4101, name: 'Sunset Over Hills.png', url: 'key-4101' }),
      edge('key-4101', 'original=true', 'Sunset Over Hills.jpeg'),
    ],
    [
      'an unnamed image (named by its id)',
      image({ id: 4102, name: null, url: 'key-4102' }),
      edge('key-4102', 'original=true', '4102.jpeg'),
    ],
  ])('%s', async (_, img, expected) => {
    const src = await renderedSrc(img);
    expect(src).toBe(expected);
    expect(src).toBe(imageDetailMainImageUrl(img));
  });
});

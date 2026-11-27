import type { ReactElement } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * `image.get` serves a blocked image to its owner with `url` null (`ownerBlockedNotice`): the row
 * and its notice, never the media. The slide must stand in `WithheldMedia` for it, not hand the
 * null to `EdgeMedia`, which draws a broken image.
 *
 * The guard is stubbed to "show", as the owner sees their own image.
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
vi.mock('~/providers/FeatureFlagsProvider', async (o) => ({
  ...(await o<object>()),
  useFeatureFlags: () => ({}),
}));

import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';

const noop = () => undefined;

async function renderSlide(image: { url: string | null; type: 'image' | 'video' }) {
  await page.viewport(1200, 800);
  renderWithProviders(
    <div data-slide style={{ width: 400, height: 300, display: 'flex' }}>
      <ImageDetailCarousel
        images={[{ id: 7, name: 'mine.png', nsfwLevel: 1, height: 600, width: 400, ...image }]}
        index={0}
        next={noop}
        previous={noop}
        canNavigate={false}
      />
    </div>
  );
  return vi.waitFor(() => {
    const slide = document.querySelector<HTMLElement>('[data-slide]');
    if (!slide?.querySelector('img, video, svg')) throw new Error('slide not drawn yet');
    return slide;
  });
}

describe('a slide whose media the server withheld', () => {
  test.each(['image', 'video'] as const)(
    'a %s with no url shows WithheldMedia, no media element',
    async (type) => {
      const slide = await renderSlide({ url: null, type });
      expect(slide.textContent).toContain('Media unavailable');
      expect(slide.querySelector('img, video')).toBeNull();
    }
  );

  test('an image with its url still renders its <img> (control)', async () => {
    const slide = await renderSlide({ url: 'a1b2c3d4-0000-4000-8000-000000000000', type: 'image' });
    await vi.waitFor(() => {
      if (!slide.querySelector('img')) throw new Error('no <img> yet');
    });
    expect(slide.textContent).not.toContain('Media unavailable');
  });
});

import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useCarouselNavigation } from '~/hooks/useCarouselNavigation';
import { renderWithProviders } from '../../../../test/component-setup';

vi.mock('~/components/ImageGuard/ImageGuard2', async (o) => ({
  ...(await o<object>()),
  ImageGuardContent: () => null,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (o) => ({
  ...(await o<object>()),
  EdgeMedia: () => null,
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

// The harness loads no Tailwind; embla measures its slides, so give them the layout they have.
const layout = document.createElement('style');
layout.textContent = `
.flex{display:flex}.flex-1{flex:1 1 0%}.min-h-0{min-height:0}.h-full{height:100%}
.items-stretch{align-items:stretch}.justify-stretch{justify-content:stretch}
.overflow-hidden{overflow:hidden}.relative{position:relative}
.flex-\\[0_0_100\\%\\]{flex:0 0 100%;min-width:0}
`;
document.head.appendChild(layout);

const image = (id: number) => ({
  id,
  nsfwLevel: 1,
  url: `img-${id}`,
  height: 10,
  width: 10,
  type: 'image' as const,
  name: null,
});

/** The slide embla has in view, not the index state the parent holds. */
function slideInView() {
  const viewport = document.querySelector('.touch-pan-y');
  const slides = [...(viewport?.firstElementChild?.children ?? [])];
  const mid = viewport ? viewport.getBoundingClientRect().left + viewport.clientWidth / 2 : 0;
  return slides.findIndex((slide) => {
    const rect = slide.getBoundingClientRect();
    return rect.left <= mid && mid < rect.right;
  });
}

// A storyline branch appends the new chapter's images and moves the URL's image to one of them.
function AppendAndJump() {
  const [count, setCount] = useState(3);
  const images = Array.from({ length: count }, (_, i) => image(i + 1));
  const navigation = useCarouselNavigation({ items: images, initialIndex: 2 });
  return (
    <div style={{ width: 400, height: 300, display: 'flex' }}>
      <button
        type="button"
        data-testid="append"
        onClick={() => {
          setCount(4);
          navigation.navigate(3);
        }}
      />
      <output data-testid="state">{navigation.index}</output>
      <ImageDetailCarousel images={images} {...navigation} loop={false} />
    </div>
  );
}

describe('ImageDetailCarousel', () => {
  test('an index into slides appended in the same commit lands on that slide', async () => {
    await page.viewport(1200, 800);
    renderWithProviders(<AppendAndJump />);
    await expect.element(page.getByTestId('state')).toHaveTextContent('2');
    expect(slideInView()).toBe(2);
    await page.getByTestId('append').click();
    await vi.waitFor(() => expect(slideInView()).toBe(3));
    await expect.element(page.getByTestId('state')).toHaveTextContent('3');
  });
});

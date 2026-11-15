import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../../test/component-setup';
import { ReviewImageMedia } from '../ResourceReviewCarousel';
import { getReviewSlideSize } from '../review-image-width';

const SLIDE_HEIGHT = 400;

// A blob: src is forwarded untouched by the edge-url builder and loads, so the img is not in its
// error state (which collapses it to the alt text).
const IMAGE_URL = URL.createObjectURL(
  new Blob([Uint8Array.from(atob(LOADABLE_IMAGE_DATA_URI.split(',')[1]), (c) => c.charCodeAt(0))], {
    type: 'image/png',
  })
);

// The slide box comes from the same helper ReviewImage uses; only the viewport-relative height is
// pinned, so the numbers do not depend on the browser window.
function Slide({ width, height }: { width: number; height: number }) {
  return (
    <div style={{ width: 3000 }}>
      <div
        data-testid="slide"
        className="relative overflow-hidden"
        style={{ ...getReviewSlideSize({ width, height }, false), height: SLIDE_HEIGHT }}
      >
        <ReviewImageMedia
          image={{
            id: 1,
            name: 'a.png',
            url: IMAGE_URL,
            type: 'image',
            width,
            height,
          }}
        />
      </div>
    </div>
  );
}

async function widths() {
  await expect.element(page.getByTestId('slide')).toBeInTheDocument();
  const slide = document.querySelector('[data-testid="slide"]')!.getBoundingClientRect().width;
  const img = document.querySelector('[data-testid="slide"] img')!.getBoundingClientRect().width;
  return { slide, img };
}

describe('ReviewImageMedia', () => {
  test('a 2.34:1 image fills its slide, not the default 800px', async () => {
    renderWithProviders(<Slide width={2712} height={1160} />);
    const { slide, img } = await widths();
    expect(slide).toBeGreaterThan(900);
    expect(img).toBeCloseTo(slide, 0);
  });

  test('a portrait image still fills its slide', async () => {
    renderWithProviders(<Slide width={1160} height={2712} />);
    const { slide, img } = await widths();
    expect(slide).toBeLessThan(800);
    expect(img).toBeCloseTo(slide, 0);
  });

  // The requested URL is the other half of the fix, and a blob: src bypasses it, so these use an
  // edge key. The image never loads; only the src attribute is read.
  test.each([
    { name: 'landscape', width: 2712, height: 1160, requested: 'width=1600' },
    { name: 'portrait', width: 1160, height: 2712, requested: 'width=800' },
  ])('requests $requested for a $name image', async ({ width, height, requested }) => {
    renderWithProviders(
      <ReviewImageMedia
        image={{ id: 1, name: 'a.png', url: 'abc-key', type: 'image', width, height }}
      />
    );
    await expect
      .element(page.getByRole('img'))
      .toHaveAttribute('src', expect.stringContaining(requested));
  });
});

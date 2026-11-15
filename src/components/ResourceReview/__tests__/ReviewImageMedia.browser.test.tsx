import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../../test/component-setup';
import { ReviewImageMedia } from '../ResourceReviewCarousel';

const SLIDE_HEIGHT = 400;

// A blob: src is forwarded untouched by the edge-url builder and loads, so the img is not in its
// error state (which collapses it to the alt text).
const IMAGE_URL = URL.createObjectURL(
  new Blob([Uint8Array.from(atob(LOADABLE_IMAGE_DATA_URI.split(',')[1]), (c) => c.charCodeAt(0))], {
    type: 'image/png',
  })
);

// The slide as ReviewImage sizes it on desktop: fixed height, the image's own ratio, clipped.
function Slide({ width, height }: { width: number; height: number; hiDpi: boolean }) {
  return (
    <div style={{ width: 3000 }}>
      <div
        data-testid="slide"
        className="relative overflow-hidden"
        style={{ aspectRatio: width / height, height: SLIDE_HEIGHT, maxWidth: '100%' }}
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
});

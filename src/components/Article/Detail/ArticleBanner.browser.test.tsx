import type { ReactNode } from 'react';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';

// Tailwind is inert in the component project unless a test imports it, and `size-full` is the layout under test.
import '~/styles/globals.css';

vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  function ImageGuard2({ children }: { children: (safe: boolean) => ReactNode }) {
    return <>{children(true)}</>;
  }
  ImageGuard2.BlurToggle = function BlurToggle() {
    return null;
  };
  return { ImageGuard2 };
});
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', () => ({
  ImageContextMenu: () => null,
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));

import { ArticleBanner } from './ArticleBanner';
import { renderWithProviders, LOADABLE_IMAGE_DATA_URI } from '../../../../test/component-setup';

const image = {
  id: 1,
  url: LOADABLE_IMAGE_DATA_URI,
  name: 'banner.png',
  type: 'image',
  nsfwLevel: 1,
  width: 2400,
  height: 600,
  hash: null,
} as unknown as Parameters<typeof ArticleBanner>[0]['image'];

async function measure(containerWidth: number) {
  const screen = await renderWithProviders(
    <div style={{ width: containerWidth }}>
      <ArticleBanner image={image} articleId={1} title="Banner" />
    </div>
  );
  const wrapperEl = screen.getByTestId('article-banner').element() as HTMLElement;
  // The sharp image is the one with alt text; the blurred backdrop is decorative.
  const img = wrapperEl.querySelector<HTMLImageElement>('img[alt="Banner"]')!;
  await expect.poll(() => img.getBoundingClientRect().width).toBeGreaterThan(0);
  const box = img.getBoundingClientRect();
  const wrapper = wrapperEl.getBoundingClientRect();
  // The src is not decodable here (EdgeMedia suffixes a CDN transform), so the 4:1 shape comes from the row.
  const natural = { width: image.width!, height: image.height! };
  // Where the pixels land inside the element box, given its object-fit.
  const fit = getComputedStyle(img).objectFit === 'cover' ? Math.max : Math.min;
  const scale = fit(box.width / natural.width, box.height / natural.height);
  const paintedWidth = natural.width * scale;
  const paintedHeight = natural.height * scale;
  // object-position decides where the content sits inside the box; the box itself always equals the wrapper.
  const [posX, posY] = getComputedStyle(img)
    .objectPosition.split(' ')
    .map((v) => parseFloat(v) / 100);
  return {
    wrapper,
    wrapperEl,
    painted: {
      width: paintedWidth,
      height: paintedHeight,
      centerX: box.left + (box.width - paintedWidth) * posX + paintedWidth / 2,
      centerY: box.top + (box.height - paintedHeight) * posY + paintedHeight / 2,
    },
  };
}

afterEach(() => cleanup());

describe('ArticleBanner', () => {
  // Past the 28rem cap a 4:1 band is wider than the image: it keeps its shape and sits in the middle.
  test('centres the whole 4:1 image, uncropped, on a wide screen', async () => {
    const { wrapper, painted } = await measure(3200);
    expect(wrapper.width).toBe(3200);
    expect(wrapper.height).toBe(448);
    expect(painted.height).toBeCloseTo(448, 0);
    expect(painted.width).toBeCloseTo(1792, 0);
    expect(Math.abs(painted.centerX - (wrapper.left + wrapper.width / 2))).toBeLessThan(2);
    expect(Math.abs(painted.centerY - (wrapper.top + wrapper.height / 2))).toBeLessThan(2);
  });

  test('keeps the 4:1 ratio on a phone', async () => {
    const { wrapper, painted } = await measure(375);
    expect(painted.width).toBeCloseTo(375, 0);
    expect(wrapper.height).toBeCloseTo(375 / 4, 1);
  });

  test('draws a blurred backdrop behind the image', async () => {
    const { wrapperEl } = await measure(3200);
    const backdrop = wrapperEl.querySelector<HTMLImageElement>('img[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    expect(getComputedStyle(backdrop!).filter).toContain('blur');
  });
});

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
  const wrapper = screen.getByTestId('article-banner').element() as HTMLElement;
  const img = wrapper.querySelector('img')!;
  await expect.poll(() => img.getBoundingClientRect().width).toBeGreaterThan(0);
  return { wrapper: wrapper.getBoundingClientRect(), img: img.getBoundingClientRect() };
}

afterEach(() => cleanup());

describe('ArticleBanner', () => {
  // EdgeImage caps an image at the width it was requested at (2400): past that the banner sat left.
  test('fills a container wider than the requested image width', async () => {
    const { wrapper, img } = await measure(3200);
    expect(wrapper.width).toBe(3200);
    expect(img.width).toBe(wrapper.width);
    expect(wrapper.height).toBe(448);
  });

  test('keeps the 4:1 ratio on a phone', async () => {
    const { wrapper, img } = await measure(375);
    expect(img.width).toBe(375);
    expect(wrapper.height).toBeCloseTo(375 / 4, 1);
  });
});

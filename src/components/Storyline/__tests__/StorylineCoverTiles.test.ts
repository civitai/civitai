// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ImageGuardModule from '~/components/ImageGuard/ImageGuard2';
import type * as EdgeMediaModule from '~/components/EdgeMedia/EdgeMedia';
import type * as ImageHashModule from '~/components/ImageHash/ImageHash';
import type * as ImageUtilsModule from '~/components/Image/image.utils';

const mocks = vi.hoisted(() => ({
  safe: true,
  loading: false,
  images: [] as { id: number; postId: number }[],
}));

// The guard's verdict is mocks.safe; the media and hash stubs expose what the tile passed down
// (className, style, data-crop) so tests can read it.
vi.mock('~/components/ImageGuard/ImageGuard2', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageGuardModule>()),
  ImageGuard2: ({ children }: { children: (safe: boolean) => unknown }) => children(mocks.safe),
}));
vi.mock('~/components/ImageHash/ImageHash', async (importOriginal) => {
  const { createElement: h } = await import('react');
  return {
    ...(await importOriginal<typeof ImageHashModule>()),
    MediaHash: ({ cropFocus }: { cropFocus?: string }) =>
      h('div', { 'data-testid': 'media-hash', 'data-crop': cropFocus }),
  };
});
vi.mock('~/components/EdgeMedia/EdgeMedia', async (importOriginal) => {
  const { createElement: h } = await import('react');
  return {
    ...(await importOriginal<typeof EdgeMediaModule>()),
    EdgeMedia: ({ src, className, style }: { src: string; className?: string; style?: object }) =>
      h('img', { src, className, style, 'data-testid': 'tile-image' }),
  };
});

vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtilsModule>()),
  useQueryImages: () => ({ images: mocks.images, isLoading: mocks.loading, isError: false }),
}));

import {
  ChapterImages,
  StorylineImagePicker,
} from '~/components/Storyline/manage/StorylineCoversRow';
import { coverPickerTile } from '~/components/Storyline/storyline-cover-picker.utils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const image = (id: number) => ({
  id,
  url: `u${id}`,
  type: 'image' as const,
  nsfwLevel: 1,
  width: 320,
  height: 213,
});

function render(slot: 'cover' | 'banner', onSelect = vi.fn(), position = 35) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(
        MantineProvider,
        null,
        createElement(ChapterImages, {
          number: 2,
          images: [image(1), image(2)],
          tile: coverPickerTile(slot, position),
          selectedId: null,
          onSelect,
        })
      )
    );
  });
  return container;
}

const tiles = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[role="radio"]')];
const frame = (button: HTMLElement) => button.firstElementChild as HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.safe = true;
  mocks.loading = false;
  mocks.images = [];
});

function renderPicker(slot: 'cover' | 'banner') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const storyline = {
    userId: 3,
    collaborators: [],
    maxNsfwLevel: 2,
    heroImagePosition: 35,
    heroImageId: null,
    coverImageId: null,
    mainPath: [{ depth: 0, post: { id: 10, userId: 3 } }],
  };
  act(() => {
    createRoot(container).render(
      createElement(
        MantineProvider,
        null,
        createElement(StorylineImagePicker, {
          storyline: storyline as never,
          slot,
          initialId: null,
          confirmLabel: 'Use it',
          onCancel: vi.fn(),
          onPick: vi.fn(),
        })
      )
    );
  });
  return container;
}

describe('the cover and banner picker tiles', () => {
  it('draws banner choices as the wide crop the banner shows, at the banner position', () => {
    const c = render('banner');
    expect(tiles(c)).toHaveLength(2);
    for (const button of tiles(c)) {
      expect(frame(button).className).toContain('aspect-[16/6]');
      const img = button.querySelector<HTMLImageElement>('[data-testid="tile-image"]')!;
      expect(img.className).toContain('object-center');
      expect(img.style.objectPosition).toBe('50% 35%');
    }
    expect(c.querySelector('[role="radiogroup"]')?.className).toContain('grid-cols-2');
  });

  it('keeps card cover choices as the portrait crop the card shows', () => {
    const c = render('cover');
    for (const button of tiles(c)) {
      expect(frame(button).className).toContain('aspect-[3/4]');
      const img = button.querySelector<HTMLImageElement>('[data-testid="tile-image"]')!;
      expect(img.className).toContain('object-[50%_20%]');
      expect(img.style.objectPosition).toBe('');
    }
    expect(c.querySelector('[role="radiogroup"]')?.className).toContain('grid-cols-3');
  });

  it('centres the blurred stand-in of a banner choice, and tops a portrait one', () => {
    mocks.safe = false;
    expect(
      render('banner').querySelector('[data-testid="media-hash"]')?.getAttribute('data-crop')
    ).toBe('center');
    document.body.innerHTML = '';
    expect(
      render('cover').querySelector('[data-testid="media-hash"]')?.getAttribute('data-crop')
    ).toBe('top');
  });

  it('selects the tile that is tapped, in either slot', () => {
    for (const slot of ['banner', 'cover'] as const) {
      document.body.innerHTML = '';
      const onSelect = vi.fn();
      const c = render(slot, onSelect);
      act(() => tiles(c)[1].click());
      expect(onSelect.mock.calls).toEqual([[2]]);
    }
  });
});

describe('the picker for each slot', () => {
  beforeEach(() => {
    mocks.images = [
      { ...image(1), postId: 10 },
      { ...image(2), postId: 10 },
    ] as never;
  });

  it('offers wide tiles at the banner position for the banner, portrait ones for the card cover', () => {
    const banner = renderPicker('banner');
    expect(frame(tiles(banner)[0]).className).toContain('aspect-[16/6]');
    expect(
      tiles(banner)[0].querySelector<HTMLImageElement>('[data-testid="tile-image"]')?.style
        .objectPosition
    ).toBe('50% 35%');
    document.body.innerHTML = '';
    const cover = renderPicker('cover');
    expect(frame(tiles(cover)[0]).className).toContain('aspect-[3/4]');
  });

  it('shapes the loading placeholders like the tiles that will replace them', () => {
    mocks.loading = true;
    const placeholder = (c: HTMLElement) =>
      c.querySelector('.mantine-Skeleton-root')?.className ?? '';
    expect(placeholder(renderPicker('banner'))).toContain('aspect-[16/6]');
    document.body.innerHTML = '';
    expect(placeholder(renderPicker('cover'))).toContain('aspect-[3/4]');
  });
});

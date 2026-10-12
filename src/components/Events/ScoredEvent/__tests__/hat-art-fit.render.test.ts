// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventDecorationFit } from '~/shared/constants/event-decoration.constants';

/**
 * The shop tile hands the hat's fit to HatArt, and HatArt draws the real image by it. The
 * geometry is pinned in hat-preview-box.test.ts; this pins what reaches the <img>.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));
vi.mock('~/components/Currency/useCurrencyConfig', () => ({
  useBuzzCurrencyConfig: () => ({ color: '#fcc419' }),
}));
vi.mock('~/components/Currency/CurrencyIcon', () => ({ CurrencyIcon: () => null }));
vi.mock('~/components/CosmeticShop/CosmeticShopItemPreviewModal', () => ({
  CosmeticShopItemPreviewModal: () => null,
}));

const { HatArt } = await import('~/components/Events/ScoredEvent/HatArt');
const { EventHatTile } = await import('~/components/Events/ScoredEvent/EventHatTile');

const TINY_UFO: EventDecorationFit = { canvas: [128, 160], bounds: [10, 83, 118, 152] };

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(React.createElement(MantineProvider, null, element)));
  const img = host.querySelector('img');
  if (!img) throw new Error('no <img> rendered');
  return { img, square: img.parentElement! };
}

describe('a hat preview drawn by its fit', () => {
  it('is not held to the source width EdgeImage sets inline', () => {
    // Tiny UFO's canvas is 0.92 of the square: on a tile wider than ~209px a 192px cap squashes it.
    const { img } = render(React.createElement(HatArt, { url: 'u', width: 192, fit: TINY_UFO }));
    expect(img.style.maxWidth).toBe('none');
    expect(parseFloat(img.style.width)).toBeGreaterThan(90);
  });

  it('keeps its canvas inside the square, off the tiles around it', () => {
    // Tiny UFO's canvas starts a third of the square above it.
    const { img, square } = render(React.createElement(HatArt, { url: 'u', fit: TINY_UFO }));
    expect(parseFloat(img.style.top)).toBeLessThan(0);
    expect(square.className.split(' ')).toContain('overflow-hidden');
  });

  it('is drawn as before, by its canvas, without a fit', () => {
    const { img, square } = render(React.createElement(HatArt, { url: 'u', width: 192 }));
    expect(img.className.split(' ')).toContain('w-3/5');
    expect(img.style.width).toBe('');
    expect(img.style.maxWidth).toBe('192px');
    expect(square.className.split(' ')).not.toContain('overflow-hidden');
  });

  it('gets its fit from the shop tile', () => {
    const item = {
      id: 1,
      title: 'Tiny UFO',
      unitAmount: 3000,
      availableQuantity: null,
      meta: null,
      cosmetic: { data: { url: 'u', fit: TINY_UFO } },
    };
    const { img } = render(React.createElement(EventHatTile, { item: item as never }));
    expect(img.style.maxWidth).toBe('none');
    expect(img.className.split(' ')).not.toContain('w-3/5');
  });
});

import React, { useRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { nextLayout, renderAtViewport } from '../../../test/geometry-setup';
import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ITEM_BLEED } from '~/components/MasonryColumns/masonry.constants';
import { ScrollAreaContext } from '~/components/ScrollArea/ScrollAreaContext';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import {
  getEventDecorationClearLeft,
  getHatLayout,
  HAT_LOOK,
} from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import type { EventDecorationFit } from '~/shared/constants/event-decoration.constants';
import type * as AdsProvider from '~/components/Ads/AdsProvider';
import type * as AdsUtils from '~/components/Ads/ads.utils';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';

vi.mock('~/components/Ads/AdsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AdsProvider>()),
  useAdsContext: () => ({ adsEnabled: false, useDirectAds: false }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/Ads/ads.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof AdsUtils>()),
  useCreateAdFeed: () => (args: { data: unknown[] }) =>
    args.data.map((item) => ({ type: 'data' as const, data: item })),
}));

const VIEWPORT = { width: 900, height: 900 };
// Prod party-cap art: brim and convex outline measured from its 128x160 file.
const FIT: EventDecorationFit = {
  canvas: [128, 160],
  bounds: [13, 25, 115, 152],
  brim: [16, 112, 134],
  outline: [
    [15, 118.7],
    [59.9, 26],
    [68.1, 26],
    [113, 118.7],
    [115.9, 135.7],
    [111.8, 141],
    [101.6, 146.6],
    [86.9, 151.3],
    [76.2, 152.8],
    [51.8, 152.8],
    [41.1, 151.3],
    [26.4, 146.6],
    [16.2, 141],
    [12.1, 135.7],
  ],
};
const HAT = { type: 'hat', event: 'birthday2026', url: 'hat.png', fit: FIT };

type Item = { id: number };
const items: Item[] = Array.from({ length: 8 }, (_, i) => ({ id: i }));

/** Card 1 (the right column's first card) wears a hat; the rest are plain. */
function Card({ data }: { data: Item }) {
  const card = (
    <div data-testid="card" data-id={data.id} style={{ height: 200, background: '#888' }}>
      <div
        data-testid={data.id === 1 ? 'chip' : undefined}
        style={{ paddingLeft: 'var(--event-decoration-clear-left)' }}
      />
    </div>
  );
  return data.id === 1 ? (
    <TwCosmeticWrapper eventDecoration={HAT} data-testid="hat-wearer">
      {card}
    </TwCosmeticWrapper>
  ) : (
    card
  );
}

function Gallery({ style }: { style?: React.CSSProperties }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <ScrollAreaContext.Provider value={{ ref: scrollRef as React.RefObject<HTMLDivElement> }}>
      <div ref={scrollRef} style={{ height: 800, width: 700, overflowY: 'auto', ...style }}>
        <div style={{ height: 80 }} />
        <MasonryProvider columnWidth={320} maxColumnCount={2} style={{ width: 700 }}>
          <MasonryColumnsVirtual
            data={items}
            render={Card}
            imageDimensions={() => ({ width: 320, height: 200 })}
            itemId={(data) => data.id}
          />
        </MasonryProvider>
      </div>
    </ScrollAreaContext.Provider>
  );
}

const card = (id: number) => document.querySelector(`[data-testid="card"][data-id="${id}"]`)!;
const hat = () => document.querySelector('button[data-event-decoration="hat"]') as HTMLElement;
const itemOf = (el: Element) => el.closest('[data-masonry-item]') as HTMLElement;
const GROW_WAIT = { timeout: 5000 };

describe('MasonryColumnsVirtual with worn hats', () => {
  // ITEM_BLEED is wider than the gap between cards, so the right column's item padding lies over
  // the left card's right edge, and that item comes later in the DOM.
  test('a point on the edge of a card reaches that card, not the item beside it', async () => {
    await renderAtViewport(<Gallery />, VIEWPORT);
    await vi.waitFor(() => expect(card(1)).toBeTruthy());
    const left = card(0).getBoundingClientRect();
    expect(card(1).getBoundingClientRect().left - left.right).toBeLessThan(ITEM_BLEED);

    const hit = document.elementFromPoint(left.right - 2, left.top + 20);
    expect(hit?.closest('[data-testid="card"]')).toBe(card(0));
  });

  test('the hat grows on hover and its item stops cropping it', async () => {
    await renderAtViewport(<Gallery />, VIEWPORT);
    await vi.waitFor(() => expect(hat()).toBeTruthy());
    const [wearer, plain] = [itemOf(card(1)), itemOf(card(0))];
    expect(getComputedStyle(hat()).scale).toBe('none');
    expect(getComputedStyle(wearer).contentVisibility).toBe('auto');
    expect(getComputedStyle(wearer).zIndex).toBe('1');
    expect(getComputedStyle(plain).zIndex).toBe('auto');

    // Released at once on the way in, before the hat has grown past the crop.
    await userEvent.hover(card(1));
    expect(getComputedStyle(wearer).contentVisibility).toBe('visible');
    expect(getComputedStyle(wearer).zIndex).toBe('2');
    await vi.waitFor(
      () => expect(getComputedStyle(hat()).scale).toBe(String(HAT_LOOK.grow)),
      GROW_WAIT
    );
    expect(getComputedStyle(plain).contentVisibility).toBe('auto');

    // Held on the way out until the hat has settled back, then restored.
    await userEvent.unhover(card(1));
    expect(getComputedStyle(wearer).contentVisibility).toBe('visible');
    await vi.waitFor(
      () => expect(getComputedStyle(wearer).contentVisibility).toBe('auto'),
      GROW_WAIT
    );
    expect(getComputedStyle(wearer).zIndex).toBe('1');
  });

  // Only an inner layer is clipped to the art: clipping the button cut its shadow and focus ring.
  test('the hat itself is never clipped, only the layer that takes clicks', async () => {
    await renderAtViewport(<Gallery />, VIEWPORT);
    await vi.waitFor(() => expect(hat()).toBeTruthy());
    expect(getComputedStyle(hat()).clipPath).toBe('none');
    const hitLayers = [...hat().querySelectorAll('*')].filter((el) =>
      getComputedStyle(el).clipPath.startsWith('polygon(')
    );
    expect(hitLayers).toHaveLength(1);
    await userEvent.tab();
    expect(document.activeElement).toBe(hat());
  });

  test.each([undefined, 8, 0])(
    'corner chips step clear of a hat its container moves in (%spx of room)',
    async (allowance) => {
      const style =
        allowance === undefined
          ? undefined
          : ({ '--event-decoration-allowance': `${allowance}px` } as React.CSSProperties);
      await renderAtViewport(<Gallery style={style} />, VIEWPORT);
      await vi.waitFor(() => expect(hat()).toBeTruthy());
      const chip = document.querySelector('[data-testid="chip"]')!;
      const expected = getEventDecorationClearLeft({ type: 'hat', fit: FIT }, 'corner', allowance);
      expect(Math.abs(parseFloat(getComputedStyle(chip).paddingLeft) - expected)).toBeLessThan(1);
    }
  );

  test.each([undefined, 8, 0])(
    'a container giving %spx of room moves the hat in to fit it',
    async (allowance) => {
      const style =
        allowance === undefined
          ? undefined
          : ({ '--event-decoration-allowance': `${allowance}px` } as React.CSSProperties);
      await renderAtViewport(<Gallery style={style} />, VIEWPORT);
      await vi.waitFor(() => expect(hat()).toBeTruthy());
      const expected = getHatLayout('corner', FIT, allowance);
      expect(parseFloat(getComputedStyle(hat()).left)).toBeCloseTo(expected.left, 1);
      expect(parseFloat(getComputedStyle(hat()).top)).toBeCloseTo(expected.top, 1);
    }
  );

  // The canvas is a rectangle that lies over the neighbouring cards; only the art takes clicks.
  test('a click beside the art, inside its canvas, does not hit the hat', async () => {
    await renderAtViewport(<Gallery />, VIEWPORT);
    await vi.waitFor(() => expect(hat()).toBeTruthy());
    const el = hat();
    const cs = getComputedStyle(el);
    const parent = el.parentElement!.getBoundingClientRect();
    const [ox, oy] = cs.transformOrigin.split(' ').map(parseFloat);
    const m = new DOMMatrix(cs.transform);
    const toPage = (x: number, y: number) => {
      const p = m.transformPoint(new DOMPoint(x - ox, y - oy));
      return {
        x: parent.left + parseFloat(cs.left) + ox + p.x,
        y: parent.top + parseFloat(cs.top) + oy + p.y,
      };
    };
    const scale = parseFloat(cs.width) / 128;
    const inside = toPage(64 * scale, 110 * scale);
    const beside = toPage(4 * scale, 150 * scale);
    expect(document.elementFromPoint(inside.x, inside.y)?.closest('button')).toBe(el);
    expect(document.elementFromPoint(beside.x, beside.y)?.closest('button')).not.toBe(el);
    // The same point does hit the canvas once the clip is gone, so it is on the canvas.
    for (const layer of el.querySelectorAll<HTMLElement>('*')) layer.style.clipPath = 'none';
    expect(document.elementFromPoint(beside.x, beside.y)?.closest('button')).toBe(el);
  });

  test('where growth is switched off, the hovered hat stays at rest size', async () => {
    await renderAtViewport(
      <Gallery style={{ '--event-decoration-grow': 1 } as React.CSSProperties} />,
      VIEWPORT
    );
    await vi.waitFor(() => expect(hat()).toBeTruthy());
    await userEvent.hover(card(1));
    await nextLayout();
    await vi.waitFor(() => expect(getComputedStyle(hat()).scale).toBe('1'), GROW_WAIT);
  });
});

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
  HAT_PLAIN_CARD_NUDGE,
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

/**
 * Card 1 (the right column's first card) wears a hat; card 3 a hat and a padded CSS frame; card 5 a
 * hat and lights, a cosmetic with no padding; card 6 a hat and a padded texture frame; card 2 a
 * hat and a 2px border; card 7 a hat with its own hover growth. The rest are plain.
 */
function Card({ data }: { data: Item }) {
  const card = (
    <div data-testid="card" data-id={data.id} style={{ height: 200, background: '#888' }}>
      <div
        data-testid={`chip-${data.id}`}
        style={{ paddingLeft: 'var(--event-decoration-clear-left)' }}
      />
    </div>
  );
  if (data.id === 1)
    return (
      <TwCosmeticWrapper eventDecoration={HAT} data-testid="hat-wearer">
        {card}
      </TwCosmeticWrapper>
    );
  if (data.id === 3)
    return (
      <TwCosmeticWrapper
        cosmetic={{ cssFrame: 'linear-gradient(red, blue)' }}
        eventDecoration={HAT}
      >
        {card}
      </TwCosmeticWrapper>
    );
  if (data.id === 5)
    return (
      <TwCosmeticWrapper cosmetic={{ lights: 3, color: 'yellow' }} eventDecoration={HAT}>
        {card}
      </TwCosmeticWrapper>
    );
  if (data.id === 6)
    return (
      <TwCosmeticWrapper
        cosmetic={{ texture: { url: 'texture.png', size: { width: 64, height: 64 } } }}
        eventDecoration={HAT}
      >
        {card}
      </TwCosmeticWrapper>
    );
  if (data.id === 2)
    return (
      <TwCosmeticWrapper cosmetic={{ border: 'red', borderWidth: 2 }} eventDecoration={HAT}>
        {card}
      </TwCosmeticWrapper>
    );
  if (data.id === 7)
    return (
      <TwCosmeticWrapper eventDecoration={{ ...HAT, fit: { ...FIT, grow: 1.15 } }}>
        {card}
      </TwCosmeticWrapper>
    );
  return card;
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
const hatOf = (id: number) =>
  card(id)?.closest('[data-event-decoration]')?.querySelector('button') as HTMLElement;
/** Card 1's hat: the plain card the hover and room tests are about. */
const hat = () => hatOf(1);
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

    expect(getComputedStyle(wearer).transitionDelay).toBe('0s');

    // Held on the way out until the hat has settled back, then restored. The hold is read as a
    // style fact: the value it holds leaves on a timer, so reading that would race the runner.
    await userEvent.unhover(card(1));
    const leaving = getComputedStyle(wearer);
    expect(leaving.transitionProperty).toBe('content-visibility, z-index');
    // content-visibility is discrete: without allow-discrete it is not held at all.
    expect(new Set(leaving.transitionBehavior.split(',').map((b) => b.trim()))).toEqual(
      new Set(['allow-discrete'])
    );
    const settle = parseFloat(getComputedStyle(hat()).transitionDuration);
    for (const delay of leaving.transitionDelay.split(','))
      expect(parseFloat(delay)).toBeGreaterThan(settle);
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

    expect(getComputedStyle(hat()).outlineStyle).toBe('none');
    for (let i = 0; i < 10 && document.activeElement !== hat(); i++) await userEvent.tab();
    expect(document.activeElement).toBe(hat());
    // The hat's own ring, not the browser's default one.
    expect(getComputedStyle(hat()).outlineStyle).toBe('solid');
    expect(getComputedStyle(hat()).outlineWidth).toBe('2px');
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
      const chip = document.querySelector('[data-testid="chip-1"]')!;
      const expected = getEventDecorationClearLeft(
        { type: 'hat', fit: FIT },
        'corner',
        allowance,
        HAT_PLAIN_CARD_NUDGE
      );
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
      const expected = getHatLayout('corner', FIT, allowance, HAT_PLAIN_CARD_NUDGE);
      expect(parseFloat(getComputedStyle(hat()).left)).toBeCloseTo(expected.left, 1);
      expect(parseFloat(getComputedStyle(hat()).top)).toBeCloseTo(expected.top, 1);
    }
  );

  // A frame's padding already carries the hat out past the picture, so only cards without that
  // padding are nudged. Lights and borders are cosmetics too, but add no padding.
  test.each([
    [1, 'nothing', false],
    [3, 'a CSS frame', true],
    [5, 'lights', false],
    [6, 'a texture frame', true],
  ])(
    'card %i, wearing %s, places its hat and corner chips for its padding',
    async (id, _, padded) => {
      await renderAtViewport(<Gallery />, VIEWPORT);
      await vi.waitFor(() => expect(card(id)).toBeTruthy());
      const wrapper = card(id).closest('[data-event-decoration]')!;
      expect(getComputedStyle(wrapper).paddingLeft).toBe(padded ? '6px' : '0px');
      expect(getComputedStyle(wrapper).paddingTop).toBe(padded ? '6px' : '0px');

      const nudge = padded ? 0 : HAT_PLAIN_CARD_NUDGE;
      const layout = getHatLayout('corner', FIT, undefined, nudge);
      expect(parseFloat(getComputedStyle(hatOf(id)).left)).toBeCloseTo(layout.left, 1);
      expect(parseFloat(getComputedStyle(hatOf(id)).top)).toBeCloseTo(layout.top, 1);
      const chip = document.querySelector(`[data-testid="chip-${id}"]`)!;
      const clear = getEventDecorationClearLeft(
        { type: 'hat', fit: FIT },
        'corner',
        undefined,
        nudge
      );
      expect(Math.abs(parseFloat(getComputedStyle(chip).paddingLeft) - clear)).toBeLessThan(1);
    }
  );

  test('a hat grows on hover by its own amount', async () => {
    await renderAtViewport(<Gallery />, VIEWPORT);
    await vi.waitFor(() => expect(hatOf(7)).toBeTruthy());
    await userEvent.hover(card(7));
    await vi.waitFor(() => expect(getComputedStyle(hatOf(7)).scale).toBe('1.15'), GROW_WAIT);
  });

  // A border is drawn outside the picture and the hat is placed from inside it, so a bordered
  // card's hat sits that much further from the crop, never closer. Nothing needs to count it.
  test("a card's border moves its hat away from the crop, by the border's width", async () => {
    await renderAtViewport(<Gallery />, VIEWPORT);
    await vi.waitFor(() => expect(hatOf(2)).toBeTruthy());
    const fromEdge = (id: number) => {
      const wrapper = card(id).closest('[data-event-decoration]')!.getBoundingClientRect();
      const box = hatOf(id).getBoundingClientRect();
      return [box.left - wrapper.left, box.top - wrapper.top];
    };
    const [plain, bordered] = [fromEdge(1), fromEdge(2)];
    expect(bordered[0] - plain[0]).toBeCloseTo(2, 1);
    expect(bordered[1] - plain[1]).toBeCloseTo(2, 1);
  });

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

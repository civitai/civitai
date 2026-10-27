import type * as EmblaReact from 'embla-carousel-react';
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

// Counts the calls the carousel makes on embla's API, through the one hook that hands it out.
const emblaCalls = vi.hoisted(() => ({
  reInit: [] as unknown[][],
  scrollTo: [] as unknown[][],
  seen: new WeakSet<object>(),
}));
vi.mock('embla-carousel-react', async (o) => {
  const actual = (await o<object>()) as typeof EmblaReact;
  const spied = (...args: Parameters<typeof actual.default>) => {
    const result = actual.default(...args);
    const api = result[1];
    if (api && !emblaCalls.seen.has(api)) {
      emblaCalls.seen.add(api);
      for (const method of ['reInit', 'scrollTo'] as const) {
        const original = api[method].bind(api) as (...a: unknown[]) => unknown;
        (api as unknown as Record<string, unknown>)[method] = (...a: unknown[]) => {
          emblaCalls[method].push(a);
          return original(...a);
        };
      }
    }
    return result;
  };
  return { ...actual, default: Object.assign(spied, actual.default) };
});

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

/** How far slide `i` is from the left edge of the viewport. */
function slideOffset(i: number) {
  const viewport = document.querySelector('.touch-pan-y');
  const slide = viewport?.firstElementChild?.children[i];
  if (!viewport || !slide) return NaN;
  return Math.abs(slide.getBoundingClientRect().left - viewport.getBoundingClientRect().left);
}

// A storyline branch appends the new chapter's images and moves the URL's image to one of them.
function Harness({
  loop,
  initialCount = 3,
  initialIndex = 2,
}: {
  loop: boolean;
  initialCount?: number;
  initialIndex?: number;
}) {
  const [count, setCount] = useState(initialCount);
  const [offsets, setOffsets] = useState<number[]>([]);
  const images = Array.from({ length: count }, (_, i) => image(i + 1));
  const navigation = useCarouselNavigation({ items: images, initialIndex });
  const trackSlide = (i: number) => {
    const log: number[] = [];
    const sample = () => {
      log.push(Math.round(slideOffset(i)));
      if (log.length < 40) requestAnimationFrame(sample);
      else setOffsets(log);
    };
    requestAnimationFrame(sample);
  };
  return (
    <div style={{ width: 400, height: 300, display: 'flex' }}>
      <button
        type="button"
        data-testid="append-and-jump"
        onClick={() => {
          setCount(count + 1);
          navigation.navigate(count);
        }}
      />
      <button type="button" data-testid="append" onClick={() => setCount(count + 1)} />
      <button type="button" data-testid="shrink" onClick={() => setCount(count - 1)} />
      <button
        type="button"
        data-testid="next"
        onClick={() => {
          navigation.next();
          trackSlide(navigation.index + 1);
        }}
      />
      <output data-testid="state">{navigation.index}</output>
      <output data-testid="count">{count}</output>
      <output data-testid="offsets">{offsets.join(',')}</output>
      <ImageDetailCarousel images={images} {...navigation} loop={loop} />
    </div>
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Long enough for embla's observers, the resize observer and the settle fallback to have fired. */
const QUIET_MS = 1000;

/**
 * Calls that move the reader, made while `action` runs and for QUIET_MS after so a late one still
 * counts. A bare `reInit()` is the resize observer re-measuring and keeps the position.
 */
async function movesAfter(action: () => Promise<unknown>) {
  const before = { reInit: emblaCalls.reInit.length, scrollTo: emblaCalls.scrollTo.length };
  await action();
  await wait(QUIET_MS);
  return {
    reInitWithOptions: emblaCalls.reInit.slice(before.reInit).filter((args) => args.length > 0),
    scrollTo: emblaCalls.scrollTo.slice(before.scrollTo),
  };
}

describe.each([false, true])('ImageDetailCarousel, loop %s', (loop) => {
  test('an index into slides appended in the same commit lands on that slide', async () => {
    await page.viewport(1200, 800);
    renderWithProviders(<Harness loop={loop} />);
    await expect.element(page.getByTestId('state')).toHaveTextContent('2');
    await vi.waitFor(() => expect(slideInView()).toBe(2));
    await page.getByTestId('append-and-jump').click();
    await vi.waitFor(() => expect(slideInView()).toBe(3));
    await expect.element(page.getByTestId('state')).toHaveTextContent('3');
  });

  test('an index within the slides scrolls to its slide', async () => {
    await page.viewport(1200, 800);
    renderWithProviders(<Harness loop={loop} initialCount={4} initialIndex={0} />);
    await expect.element(page.getByTestId('state')).toHaveTextContent('0');
    await page.getByTestId('next').click();
    await vi.waitFor(() => expect(slideInView()).toBe(1));
    await expect.element(page.getByTestId('state')).toHaveTextContent('1');
    // It travelled there: the first frame is still far from the edge, which a reinit at the
    // target would not be.
    await vi.waitFor(() =>
      expect(
        Number(page.getByTestId('offsets').element().textContent?.split(',')[0])
      ).toBeGreaterThan(100)
    );
  });

  test('a page appended without moving the index leaves the reader on their slide', async () => {
    await page.viewport(1200, 800);
    renderWithProviders(<Harness loop={loop} initialCount={4} initialIndex={1} />);
    await vi.waitFor(() => expect(slideInView()).toBe(1));
    const moves = await movesAfter(() => page.getByTestId('append').click());
    await expect.element(page.getByTestId('count')).toHaveTextContent('5');
    expect(moves).toEqual({ reInitWithOptions: [], scrollTo: [] });
    expect(slideInView()).toBe(1);
    await expect.element(page.getByTestId('state')).toHaveTextContent('1');
  });

  test('a list that shrinks keeps the reader where they are', async () => {
    await page.viewport(1200, 800);
    renderWithProviders(<Harness loop={loop} initialCount={5} initialIndex={1} />);
    await vi.waitFor(() => expect(slideInView()).toBe(1));
    const moves = await movesAfter(() => page.getByTestId('shrink').click());
    await expect.element(page.getByTestId('count')).toHaveTextContent('4');
    expect(moves).toEqual({ reInitWithOptions: [], scrollTo: [] });
    expect(slideInView()).toBe(1);
    await expect.element(page.getByTestId('state')).toHaveTextContent('1');
  });
});

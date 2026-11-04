import React, { useRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { renderAtViewport } from '../../../test/geometry-setup';
import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import type { ColumnItem } from '~/components/MasonryColumns/masonry.utils';
import { MASONRY_GAP, useMasonryColumns } from '~/components/MasonryColumns/masonry.utils';
import { ScrollAreaContext } from '~/components/ScrollArea/ScrollAreaContext';
import type * as AdsProvider from '~/components/Ads/AdsProvider';
import type * as AdsUtils from '~/components/Ads/ads.utils';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';

// Where the fake ad feed puts an ad (-1: none), so one test can prove an ad is never widened.
const adAt = vi.hoisted(() => ({ index: -1 }));

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
  useCreateAdFeed: () => (args: { data: unknown[] }) => {
    const feed = args.data.map((item) => ({ type: 'data' as const, data: item }));
    if (adAt.index >= 0)
      feed.splice(adAt.index, 0, {
        type: 'ad',
        data: { width: 300, height: 250, AdUnit: () => null },
      } as never);
    return feed;
  },
}));

const COLUMN_WIDTH = 320;
const WIDE = COLUMN_WIDTH * 2 + MASONRY_GAP;
const MAX_HEIGHT = 480;

type Item = { id: number; width: number; height: number };
const LANDSCAPE = { width: 1600, height: 900 }; // 1.78
const PORTRAIT = { width: 900, height: 1200 }; // 0.75
const SQUARE = { width: 1000, height: 1000 };
const mixed = (n: number): Item[] =>
  Array.from({ length: n }, (_, id) => ({
    id,
    ...(id % 4 === 2 ? LANDSCAPE : id % 4 === 3 ? SQUARE : PORTRAIT),
  }));

const dimensions = (d: Item) => ({ width: d.width, height: d.height });

function Card({ data, width, height }: { data: Item; width: number; height: number }) {
  return (
    <div
      data-testid="card"
      data-id={data.id}
      data-width={width}
      style={{ height, width: '100%', background: '#888', position: 'relative' }}
    >
      <button data-testid={`button-${data.id}`} style={{ position: 'absolute', inset: 0 }} />
    </div>
  );
}

function Gallery({
  data,
  span = MAX_HEIGHT,
  width = 1100,
}: {
  data: Item[];
  span?: number;
  width?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <ScrollAreaContext.Provider value={{ ref: scrollRef as React.RefObject<HTMLDivElement> }}>
      <div ref={scrollRef} style={{ height: 4000, width, overflowY: 'auto', position: 'relative' }}>
        <MasonryProvider columnWidth={COLUMN_WIDTH} maxColumnCount={7} style={{ width }}>
          <MasonryColumnsVirtual
            data={data}
            render={Card}
            imageDimensions={dimensions}
            itemId={(d) => d.id}
            spanLandscapeMaxHeight={span || undefined}
            overscan={50}
          />
        </MasonryProvider>
      </div>
    </ScrollAreaContext.Provider>
  );
}

const cards = () => [...document.querySelectorAll<HTMLElement>('[data-testid="card"]')];
const card = (id: number) => cards().find((c) => c.dataset.id === String(id))!;
const rect = (el: Element) => el.getBoundingClientRect();
const ready = (n: number) => vi.waitFor(() => expect(cards().length).toBe(n));

let latest: ColumnItem<unknown>[][] = [];
function Probe({
  data,
  columnCount,
  span,
}: {
  data: Item[];
  columnCount: number;
  span?: { minRatio: number; maxHeight: number };
}) {
  latest = useMasonryColumns(
    data,
    COLUMN_WIDTH,
    columnCount,
    dimensions,
    undefined,
    undefined,
    false,
    span
  ) as ColumnItem<unknown>[][];
  return null;
}
const SPAN = { minRatio: 1.3, maxHeight: MAX_HEIGHT };
const columnsFor = async (data: Item[], columnCount: number, span?: typeof SPAN) => {
  await renderAtViewport(<Probe data={data} columnCount={columnCount} span={span} />, {
    width: 400,
    height: 400,
  });
  return latest;
};

// Today's placement loop, kept here as the reference the off paths must still equal.
function referenceColumns(data: Item[], columnCount: number) {
  const heights: number[] = Array(columnCount).fill(0);
  const columns: { height: number; data: { type: 'data'; data: Item } }[][] = Array.from(
    { length: columnCount },
    () => []
  );
  for (const item of data) {
    const height = Math.floor((item.height / item.width) * COLUMN_WIDTH);
    let shortest = 0;
    for (let j = 1; j < columnCount; ++j) if (heights[j] < heights[shortest]) shortest = j;
    heights[shortest] += height;
    columns[shortest].push({ height, data: { type: 'data', data: item } });
  }
  return columns;
}

describe('MasonryColumnsVirtual landscape span', () => {
  test('a landscape image covers two columns and the others keep one', async () => {
    const data = mixed(10);
    await renderAtViewport(<Gallery data={data} />, { width: 1440, height: 900 });
    await ready(10);

    const wide = rect(card(2));
    expect(wide.width).toBeCloseTo(WIDE, 0);
    expect(card(2).dataset.width).toBe(String(WIDE));
    expect(rect(card(0)).width).toBeCloseTo(COLUMN_WIDTH, 0);
    expect(rect(card(3)).width).toBeCloseTo(COLUMN_WIDTH, 0);
    // Taller than a 1.78 image at that width would be only if the cap failed to hold.
    expect(wide.height).toBeLessThanOrEqual(MAX_HEIGHT);
    expect(wide.height).toBeCloseTo(Math.floor((900 / 1600) * WIDE), 0);
  });

  test('no two cards overlap', async () => {
    await renderAtViewport(<Gallery data={mixed(24)} />, { width: 1440, height: 900 });
    await ready(24);
    const all = cards().map((c) => ({ id: c.dataset.id, r: rect(c) }));
    for (const a of all)
      for (const b of all) {
        if (a.id >= b.id!) continue;
        const apart =
          a.r.right <= b.r.left + 0.5 ||
          b.r.right <= a.r.left + 0.5 ||
          a.r.bottom <= b.r.top + 0.5 ||
          b.r.bottom <= a.r.top + 0.5;
        expect(apart, `cards ${a.id} and ${b.id} overlap`).toBe(true);
      }
  });

  test('the wide card takes pointers on its right half, not the column beside it', async () => {
    await renderAtViewport(<Gallery data={mixed(10)} />, { width: 1440, height: 900 });
    await ready(10);
    const r = rect(card(2));
    const hit = document.elementFromPoint(r.left + r.width * 0.75, r.top + r.height / 2);
    expect(hit?.closest('[data-testid="card"]')).toBe(card(2));
    // Past the card's own edge the gap and the neighbour's blank room must not be the card.
    const right = rect(card(2)).right + 4;
    expect(document.elementFromPoint(right, r.top + r.height / 2)?.closest('[data-id="2"]')).toBe(
      null
    );
  });

  test('the wide card is not cropped by a column', async () => {
    await renderAtViewport(<Gallery data={mixed(10)} />, { width: 1440, height: 900 });
    await ready(10);
    const wide = card(2);
    for (let el = wide.parentElement; el && el !== document.body; el = el.parentElement) {
      const { overflowX, contain } = getComputedStyle(el);
      if (el.getAttribute('style')?.includes('overflow-y')) break;
      expect(overflowX, `${el.tagName} clips`).not.toBe('hidden');
      expect(contain).not.toContain('inline-size');
    }
    const columnLeft = wide.closest('[data-masonry-item]')!.parentElement!;
    expect(rect(wide).right).toBeGreaterThan(rect(columnLeft).right + MASONRY_GAP);
  });

  test('without the prop the layout is the one before it existed', async () => {
    adAt.index = -1;
    const data = mixed(30);
    for (const count of [3, 4]) {
      const off = await columnsFor(data, count, undefined);
      expect(off).toEqual(referenceColumns(data, count));
    }
    // Wide-eligible data, yet two columns: still no span.
    const two = await columnsFor(data, 2, SPAN);
    expect(two).toEqual(referenceColumns(data, 2));
    expect(two.flat().some((i) => i.span || i.spacer)).toBe(false);
  });

  test('appending items never moves the ones already placed', async () => {
    const data = mixed(40);
    const short = await columnsFor(data.slice(0, 25), 4, SPAN);
    const long = await columnsFor(data, 4, SPAN);
    short.forEach((column, c) => expect(long[c].slice(0, column.length)).toEqual(column));
    expect(long.flat().filter((i) => i.span).length).toBeGreaterThan(0);
  });

  test('an ad is never widened and a spanning pair keeps both columns level', async () => {
    adAt.index = 2;
    const data = mixed(12);
    const cols = await columnsFor(data, 4, SPAN);
    adAt.index = -1;
    const ads = cols.flat().filter((i) => (i.data as { type?: string } | undefined)?.type === 'ad');
    expect(ads.length).toBe(1);
    expect(ads[0].span).toBeUndefined();

    // Every spanning item has a spacer ending where it ends, in the column to its right.
    const end = (c: ColumnItem<unknown>[], upTo: number) =>
      c.slice(0, upTo + 1).reduce((y, i, n) => y + i.height + (n ? MASONRY_GAP : 0), 0);
    cols.forEach((column, c) =>
      column.forEach((item, n) => {
        if (!item.span) return;
        const partner = cols[c + 1];
        expect(
          partner.some((p) => p.spacer && end(partner, partner.indexOf(p)) === end(column, n))
        ).toBe(true);
      })
    );
  });

  test('the wide image goes where the pair can begin highest', async () => {
    // Four columns end at 426, 320, 256 and 426 high: the middle pair (320, 256) is the lowest.
    const tall = { width: 900, height: 1200 };
    const square = { width: 1000, height: 1000 };
    const short = { width: 1000, height: 800 };
    const data = [tall, square, short, tall, { ...LANDSCAPE }].map((d, id) => ({ id, ...d }));
    const cols = await columnsFor(data, 4, SPAN);
    expect(cols.map((c) => c.findIndex((i) => i.span))).toEqual([-1, 1, -1, -1]);
  });

  test('on a phone nothing spans', async () => {
    await renderAtViewport(<Gallery data={mixed(10)} width={358} />, { width: 390, height: 844 });
    await ready(10);
    const widths = new Set(cards().map((c) => Math.round(rect(c).width)));
    expect(widths.size).toBe(1);
    expect(cards().some((c) => c.dataset.width === String(WIDE))).toBe(false);
  });
});

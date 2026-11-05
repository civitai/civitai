import React, { useRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { renderAtViewport } from '../../../test/geometry-setup';
import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import type { ColumnItem } from '~/components/MasonryColumns/masonry.utils';
import {
  MASONRY_FILL_LOOKAHEAD,
  MASONRY_GAP,
  MASONRY_MIN_FILL_ROOM,
  MASONRY_SPAN_MIN_RATIO,
  useMasonryColumns,
} from '~/components/MasonryColumns/masonry.utils';
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
        // Landscape-shaped, so only the ad guard keeps it from spanning.
        data: { width: 1600, height: 250, AdUnit: () => null },
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

const hasSpan = (cols: ColumnItem<unknown>[][]) => cols.flat().some((i) => i.span);
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
  span?: { minRatio: number; maxHeight: number; holdTail?: boolean };
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
const SPAN = { minRatio: MASONRY_SPAN_MIN_RATIO, maxHeight: MAX_HEIGHT };
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
    const all = cards().map((c) => ({ id: Number(c.dataset.id), r: rect(c) }));
    for (const a of all)
      for (const b of all) {
        if (a.id >= b.id) continue;
        const apart =
          a.r.right <= b.r.left + 0.5 ||
          b.r.right <= a.r.left + 0.5 ||
          a.r.bottom <= b.r.top + 0.5 ||
          b.r.bottom <= a.r.top + 0.5;
        expect(apart, `cards ${a.id} and ${b.id} overlap`).toBe(true);
      }
  });

  test('the wide card takes pointers across its whole width, not the column beside it', async () => {
    await renderAtViewport(<Gallery data={mixed(10)} />, { width: 1440, height: 900 });
    await ready(10);
    const r = rect(card(2));
    for (const across of [0.25, 0.75, 0.98]) {
      const hit = document.elementFromPoint(r.left + r.width * across, r.top + r.height / 2);
      expect(hit?.closest('[data-testid="card"]'), `at ${across}`).toBe(card(2));
    }
    // The right half sits over the next column, past that column's own width.
    expect(r.right).toBeGreaterThan(
      rect(card(2).closest('[data-masonry-item]')!.parentElement!).right
    );
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
    let cols: ColumnItem<unknown>[][];
    try {
      cols = await columnsFor(mixed(12), 4, SPAN);
    } finally {
      adAt.index = -1;
    }
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

  test('the wide image goes where the pair wastes least', async () => {
    // Four columns end at 426, 320, 256 and 426 high: the middle pair (320, 256) starts highest and leaves the smallest hole.
    const tall = { width: 900, height: 1200 };
    const square = { width: 1000, height: 1000 };
    const short = { width: 1000, height: 800 };
    const data = [tall, square, short, tall, { ...LANDSCAPE }].map((d, id) => ({ id, ...d }));
    const cols = await columnsFor(data, 4, SPAN);
    expect(cols.map((c) => c.findIndex((i) => i.span))).toEqual([-1, 1, -1, -1]);
  });

  test('a lower start with a big hole loses to a slightly higher start with none', async () => {
    // Next starts are 262, 496, 515, 515: the first pair starts lowest but leaves a 234px hole.
    const dims = [
      { width: 1000, height: 770 },
      { width: 1000, height: 1500 },
      { width: 1000, height: 1562 },
      { width: 1000, height: 1562 },
      LANDSCAPE,
    ].map((d, id) => ({ id, ...d }));
    const cols = await columnsFor(dims, 4, SPAN);
    expect(cols.map((c) => c.findIndex((i) => i.span))).toEqual([-1, -1, 1, -1]);
  });

  test('an image with no height is not widened', async () => {
    const cols = await columnsFor(
      [{ id: 0, width: 1600, height: 0 }, ...mixed(6).map((d) => ({ ...d, id: d.id + 1 }))],
      4,
      SPAN
    );
    expect(
      cols.flat().find((i) => (i.data as { data?: Item } | undefined)?.data?.id === 0)?.span
    ).toBeUndefined();
  });

  test('any feed keeps spacers non-negative and spanned columns level, at 3 to 6 columns', async () => {
    // A feed of varied heights, so column ends land within a gap of each other now and then.
    const feed: Item[] = Array.from({ length: 200 }, (_, id) => ({
      id,
      width: 1000,
      height: id % 3 === 0 ? 540 + ((id * 37) % 30) : 700 + ((id * 53) % 900),
    }));
    for (const count of [3, 4, 5, 6]) {
      const cols = await columnsFor(feed, count, SPAN);
      expect(cols.flat().filter((i) => i.span).length, `${count} columns`).toBeGreaterThan(0);
      const end = (c: ColumnItem<unknown>[], upTo: number) =>
        c.slice(0, upTo + 1).reduce((y, i, n) => y + i.height + (n ? MASONRY_GAP : 0), 0);
      cols.forEach((column, c) =>
        column.forEach((item, n) => {
          if (item.spacer) expect(item.height).toBeGreaterThanOrEqual(0);
          if (!item.span) return;
          const partner = cols[c + 1];
          expect(
            partner.some((p) => p.spacer && end(partner, partner.indexOf(p)) === end(column, n))
          ).toBe(true);
        })
      );
    }
  });

  test('a lead column only a few pixels shorter is padded, never by a negative spacer', async () => {
    // Next starts are 336, 344 and 656: the first pair is 8px apart, less than one gap.
    const dims = [
      { width: 1000, height: 1000 },
      { width: 1000, height: 1025 },
      { width: 1000, height: 2000 },
      LANDSCAPE,
    ].map((d, id) => ({ id, ...d }));
    const cols = await columnsFor(dims, 3, SPAN);
    expect(
      cols
        .flat()
        .filter((i) => i.spacer)
        .every((i) => i.height >= 0)
    ).toBe(true);
    expect(cols[0].map((i) => (i.spacer ? 'spacer' : i.span ? 'wide' : 'card'))).toEqual([
      'card',
      'spacer',
      'wide',
    ]);
  });

  test('a wide card is never taller than the cap', async () => {
    // 1920x1080 at two columns is 369px; a 200px cap must hold it to 200.
    const cols = await columnsFor([{ id: 0, width: 1920, height: 1080 }], 3, {
      minRatio: MASONRY_SPAN_MIN_RATIO,
      maxHeight: 200,
    });
    expect(cols.flat().find((i) => i.span)?.height).toBe(200);
  });

  test('only images at least 16:9 wide span', async () => {
    // Real feed sizes: 1920x1080 and SDXL's 1344x768 span; 2544x1904 (1.34) and 1216x832 (1.46) do not.
    const sizes = [
      { width: 1920, height: 1080 },
      { width: 2544, height: 1904 },
      { width: 1216, height: 832 },
      { width: 1344, height: 768 },
    ].map((d, id) => ({ id, ...d }));
    for (const item of sizes) {
      // Alone in the feed, so nothing else decides it.
      const cols = await columnsFor([item], 3, SPAN);
      const spans = cols.flat().some((i) => i.span);
      expect(spans, `${item.width}x${item.height}`).toBe(item.id === 0 || item.id === 3);
    }
  });

  test('on a phone nothing spans', async () => {
    await renderAtViewport(<Gallery data={mixed(10)} width={358} />, { width: 390, height: 844 });
    await ready(10);
    const widths = new Set(cards().map((c) => Math.round(rect(c).width)));
    expect(widths.size).toBe(1);
    expect(cards().some((c) => c.dataset.width === String(WIDE))).toBe(false);
  });

  describe('gap fill', () => {
    const portrait = { width: 900, height: 1200 }; // 426
    const short = { width: 1700, height: 1000 }; // 1.7, 188: too narrow to span
    // Three cards, then a wide one at index 3 with 238px blank beside it, `lead` portraits that
    // cannot fill it, then `shorts` that can.
    const WIDE_INDEX = 3;
    const gapFeed = (shorts = 6, lead = 0): Item[] =>
      [
        portrait,
        short,
        portrait,
        LANDSCAPE,
        ...Array.from({ length: lead }, () => portrait),
        ...Array.from({ length: shorts }, () => short),
      ].map((d, id) => ({ id, ...d }));
    const feedOfLength = (n: number) => gapFeed(n - WIDE_INDEX - 1 - 4, 4);
    // Room left blank beside wide items: all spacer height minus what the wide items cover.
    const blankRoom = (cols: ColumnItem<unknown>[][]) => {
      const flat = cols.flat();
      return (
        flat.filter((i) => i.spacer).reduce((y, i) => y + i.height, 0) -
        flat.filter((i) => i.span).reduce((y, i) => y + i.height, 0)
      );
    };
    const idOf = (i: ColumnItem<unknown>) => (i.data as { data: Item }).data.id;
    const ids = (cols: ColumnItem<unknown>[][]) =>
      cols
        .flat()
        .filter((i) => !i.spacer)
        .map(idOf)
        .sort((a, b) => a - b);
    const describeCols = (cols: ColumnItem<unknown>[][]) =>
      cols.map((column) =>
        column.map((i) =>
          i.spacer ? `spacer:${i.height}` : `${idOf(i)}:${i.height}:${i.span ?? 1}`
        )
      );

    test('short items fill the room beside a wide one', async () => {
      const cols = await columnsFor(gapFeed(), 3, SPAN);
      expect(hasSpan(cols)).toBe(true);
      expect(blankRoom(cols)).toBeLessThanOrEqual(MASONRY_MIN_FILL_ROOM);
    });

    test('fillers come from anywhere in the lookahead window', async () => {
      // The first short sits at lookahead position 5.
      const feed = gapFeed(2, 4);
      const cols = await columnsFor(feed, 3, SPAN);
      expect(hasSpan(cols)).toBe(true);
      expect(blankRoom(cols)).toBeLessThanOrEqual(MASONRY_MIN_FILL_ROOM);
    });

    test('every item is placed exactly once', async () => {
      const feed = gapFeed();
      const cols = await columnsFor(feed, 3, SPAN);
      expect(ids(cols)).toEqual(feed.map((i) => i.id));
    });

    test("nothing that fits keeps the span and today's spacer", async () => {
      const feed = [portrait, short, portrait, LANDSCAPE, portrait, portrait].map((d, id) => ({
        id,
        ...d,
      }));
      const cols = await columnsFor(feed, 3, SPAN);
      expect(hasSpan(cols)).toBe(true);
      expect(blankRoom(cols)).toBeGreaterThan(200);
    });

    test('a wide image waits for its full lookahead while more pages are coming', async () => {
      const held = { ...SPAN, holdTail: true };
      const lastHeld = feedOfLength(WIDE_INDEX + MASONRY_FILL_LOOKAHEAD);
      const firstPlaced = feedOfLength(WIDE_INDEX + MASONRY_FILL_LOOKAHEAD + 1);
      const heldCols = await columnsFor(lastHeld, 3, held);
      expect(hasSpan(heldCols)).toBe(false);
      expect(ids(heldCols)).toEqual([0, 1, 2]);
      expect(hasSpan(await columnsFor(firstPlaced, 3, held))).toBe(true);
      // The last page: nothing is held.
      expect(hasSpan(await columnsFor(lastHeld, 3, SPAN))).toBe(true);
    });

    test('appending a page never moves what is already placed', async () => {
      const held = { ...SPAN, holdTail: true };
      const full = feedOfLength(24);
      const after = describeCols(await columnsFor(full, 3, held));
      let placedWide = 0;
      for (let n = 4; n < full.length; n++) {
        const beforeCols = await columnsFor(full.slice(0, n), 3, held);
        if (hasSpan(beforeCols)) placedWide++;
        describeCols(beforeCols).forEach((column, c) =>
          expect(after[c].slice(0, column.length), `n=${n} column ${c}`).toEqual(column)
        );
      }
      expect(placedWide).toBeGreaterThan(0);
    });
  });
});

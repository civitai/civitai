import React, { useRef } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ScrollAreaContext } from '~/components/ScrollArea/ScrollAreaContext';
import { renderWithProviders } from '../../../test/component-setup';
import type * as AdsProvider from '~/components/Ads/AdsProvider';
import type * as AdsUtils from '~/components/Ads/ads.utils';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';

// Model-page gallery blanking (CU 868kgxjv7).
//
// Repro: scroll to the gallery, scroll back up, expand a long description via "Show More",
// scroll back down. The description pushes the gallery ~5000px further down the scroll
// container; the virtualizer keeps mapping `scrollTop` through the offset it captured when
// the gallery mounted, so it renders a window ~5000px deeper into the list and the rows
// actually on screen are gone.
//
// Asserted as the user-visible symptom — no vertical hole at the top of the gallery once
// it's scrolled to — rather than the offset value, which is `useScrollMargin`'s own test.

// Ads/browsing-level are ambient app context this component reads but the bug
// doesn't involve; stub the hooks and keep each module's other exports intact.
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

const SCROLL_AREA_HEIGHT = 400;
const INITIAL_SPACER = 300;
const ITEM_HEIGHT = 200;

type Item = { id: number };
const items: Item[] = Array.from({ length: 60 }, (_, i) => ({ id: i }));

function Card({ data }: { data: Item }) {
  return <div data-testid="card" data-id={data.id} style={{ height: ITEM_HEIGHT }} />;
}

function Gallery() {
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <ScrollAreaContext.Provider value={{ ref: scrollRef as React.RefObject<HTMLDivElement> }}>
      <div
        ref={scrollRef}
        data-testid="scroll-area"
        style={{
          height: SCROLL_AREA_HEIGHT,
          width: 700,
          overflowY: 'auto',
          position: 'relative',
        }}
      >
        {/* Both sections sit under one page wrapper, as they do on the model page. */}
        <div>
          {/* Stands in for the model description above the gallery. */}
          <div data-testid="description" style={{ height: INITIAL_SPACER }} />
          <MasonryProvider columnWidth={320} maxColumnCount={6} style={{ width: 700 }}>
            <MasonryColumnsVirtual
              data={items}
              render={Card}
              imageDimensions={() => ({ width: 320, height: ITEM_HEIGHT })}
              itemId={(data) => data.id}
            />
          </MasonryProvider>
        </div>
      </div>
    </ScrollAreaContext.Provider>
  );
}

const el = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
const columns = () =>
  Array.from(document.querySelectorAll('div.mx-auto.flex.justify-center.gap-4 > div'));

/** Largest blank strip between the top of a column and its first rendered card. */
function holeAtTopOfGallery() {
  return Math.max(
    ...columns().map((column) => {
      const cards = Array.from(column.querySelectorAll('[data-testid="card"]'));
      if (!cards.length) return Infinity;
      const columnTop = column.getBoundingClientRect().top;
      const viewportTop = el('scroll-area').getBoundingClientRect().top;
      const firstCardTop = Math.min(...cards.map((card) => card.getBoundingClientRect().top));
      return firstCardTop - Math.max(columnTop, viewportTop);
    })
  );
}

const renderedIds = () =>
  Array.from(document.querySelectorAll('[data-testid="card"]')).map((card) =>
    Number(card.getAttribute('data-id'))
  );

function scrollBy(delta: number) {
  el('scroll-area').scrollTop += delta;
}

/** Put the top of the gallery at the top of the viewport. */
function scrollToGallery() {
  const scrollArea = el('scroll-area');
  scrollBy(columns()[0].getBoundingClientRect().top - scrollArea.getBoundingClientRect().top);
}

/** The first row is rendered and sits flush against the top of the viewport. */
async function expectGalleryTopOnScreen() {
  await vi.waitFor(() => {
    expect(renderedIds()).toContain(0);
    expect(holeAtTopOfGallery()).toBeLessThan(20);
  });
}

describe('MasonryColumnsVirtual', () => {
  beforeEach(async () => {
    renderWithProviders(<Gallery />);
    await vi.waitFor(() => expect(columns().length).toBe(2));
    await vi.waitFor(() => expect(renderedIds().length).toBeGreaterThan(0));
  });

  test('fills the viewport when scrolled to the gallery', async () => {
    scrollToGallery();

    await expectGalleryTopOnScreen();
  });

  test('keeps rendering the rows on screen after content above it expands', async () => {
    scrollToGallery();
    await expectGalleryTopOnScreen();

    // Scroll deep enough that the first row is windowed out, so the assertion at the
    // end can only pass if the virtualizer re-renders rather than leaving stale DOM.
    scrollBy(4000);
    await vi.waitFor(() => expect(renderedIds()).not.toContain(0));

    // "Show More": the description grows while the gallery is mounted and untouched.
    el('description').style.height = `${INITIAL_SPACER + 3000}px`;
    scrollToGallery();

    await expectGalleryTopOnScreen();
  });
});

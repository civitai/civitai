import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';
import { useRemixFlyoutLayout } from '~/components/RemixGallery/remix-flyout-layout';

// `createElement` rather than JSX because the unit project's include is
// `src/**/*.test.ts`; a `.tsx` file here collects zero tests and reads as a pass.
const LayoutProbe = () => createElement('span', { 'data-layout': useRemixFlyoutLayout() });

/**
 * Do not delete the provider this pins. A profile shelf is a fixed row count
 * inside `overflow: hidden`, so a flyout leaving a card downward is cut off by
 * the section under it. The home-block shelves declare `side` for that reason;
 * without the provider the context default is `stack`, and the profile silently
 * diverges from home again.
 */
describe('profile shelves declare the side remix flyout layout', () => {
  it('serves side to cards in the grid', () => {
    const markup = renderToStaticMarkup(
      createElement(ShowcaseGrid, { itemCount: 1, rows: 2 }, createElement(LayoutProbe))
    );

    expect(markup).toContain('data-layout="side"');
  });

  // The carousel track is `overflow: visible`, so its clipper is the scroll area
  // rather than the grid and the cell lift would not resolve. Nothing mounts a
  // flyout there today; this pins the declaration only, NOT that the carousel
  // works.
  it('serves side to cards in the carousel variant', () => {
    const markup = renderToStaticMarkup(
      createElement(
        ShowcaseGrid,
        { itemCount: 1, rows: 1, carousel: true },
        createElement(LayoutProbe)
      )
    );

    expect(markup).toContain('data-layout="side"');
  });
});

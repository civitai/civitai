// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ArticleSort } from '~/server/common/enums';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { FiltersProvider, useFiltersContext } from '~/providers/FiltersProvider';

// civitai.red resolves to the blue domain color, so the red default has to come
// from the isRed capability flag, not from the color.
const flags = vi.hoisted(() => ({ current: null as Partial<FeatureAccess> | null }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useOptionalFeatureFlags: () => flags.current,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (callback: () => void) => void }).act;

let seen: string | undefined;
function ArticleSortProbe() {
  seen = useFiltersContext((state) => state.articles.sort);
  return null;
}

let root: Root;
let container: HTMLElement;

function render(siteFlags: Partial<FeatureAccess> | null) {
  flags.current = siteFlags;
  act(() =>
    root.render(React.createElement(FiltersProvider, null, React.createElement(ArticleSortProbe)))
  );
}

describe('FiltersProvider articles default', () => {
  beforeEach(() => {
    localStorage.clear();
    seen = undefined;
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));

  it('serves Newest on civitai.red (isRed flag on a blue-colored domain)', () => {
    render({ isRed: true, isBlue: true });
    expect(seen).toBe(ArticleSort.Newest);
  });

  it('serves Most Bookmarks on civitai.com (green, no isRed flag)', () => {
    render({ isGreen: true });
    expect(seen).toBe(ArticleSort.MostBookmarks);
  });

  it('serves Most Bookmarks outside a FeatureFlagsProvider', () => {
    render(null);
    expect(seen).toBe(ArticleSort.MostBookmarks);
  });
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ArticleSort } from '~/server/common/enums';
import { FiltersProvider, useFiltersContext } from '~/providers/FiltersProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let seen: string | undefined;
function ArticleSortProbe() {
  seen = useFiltersContext((state) => state.articles.sort);
  return null;
}

let root: Root;
let container: HTMLElement;

function render(props: { isRed?: boolean }) {
  act(() =>
    root.render(React.createElement(FiltersProvider, props, React.createElement(ArticleSortProbe)))
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

  it('serves Newest to consumers when isRed', () => {
    render({ isRed: true });
    expect(seen).toBe(ArticleSort.Newest);
  });

  it('serves Most Bookmarks without isRed', () => {
    render({});
    expect(seen).toBe(ArticleSort.MostBookmarks);
  });
});

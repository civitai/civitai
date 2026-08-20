// @vitest-environment happy-dom
import fs from 'fs';
import path from 'path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TagUtils from '~/components/Tags/tag.utils';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  query: {} as Record<string, unknown>,
  categories: [] as { id: number; name: string }[],
}));

vi.mock('next/router', () => ({
  useRouter: () => ({ query: mocks.query, pathname: '/models', replace: mocks.replace }),
}));

vi.mock('~/components/Tags/tag.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof TagUtils>()),
  useCategoryTags: () => ({ data: mocks.categories, isLoading: false }),
}));

import { MantineProvider } from '@mantine/core';

import { CategoryTags } from '~/components/CategoryTags/CategoryTags';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function render(props?: Parameters<typeof CategoryTags>[0]) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(
        MantineProvider,
        { forceColorScheme: 'light' },
        createElement(CategoryTags, props)
      )
    );
  });
  return container;
}

function buttonLabels(container: HTMLElement) {
  return Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim());
}

function variantOf(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label
  );
  if (!button) throw new Error(`no button labelled ${label}; found ${buttonLabels(container)}`);
  return button.dataset.variant;
}

function clickButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label
  );
  if (!button) throw new Error(`no button labelled ${label}; found ${buttonLabels(container)}`);
  act(() => {
    button.click();
  });
}

/**
 * The bar is the only category navigation on /models — without it categories are
 * reachable only from inside a search. If the uncontrolled path stops reading and
 * writing `?tag=`, browsing by category is gone with nothing else offering it.
 */
describe('CategoryTags', () => {
  beforeEach(() => {
    mocks.replace.mockClear();
    mocks.query = {};
    mocks.categories = [
      { id: 1, name: 'character' },
      { id: 2, name: 'style' },
    ];
  });

  it('renders the All chip plus every category by default', () => {
    const container = render();
    expect(buttonLabels(container)).toEqual(['All', 'character', 'style']);
  });

  it('omits the All chip when includeAll is false', () => {
    const container = render({ includeAll: false, setSelected: vi.fn() });
    expect(buttonLabels(container)).toEqual(['character', 'style']);
  });

  it('writes the category to ?tag= when uncontrolled', () => {
    mocks.query = { sort: 'Newest' };
    const container = render();

    clickButton(container, 'character');

    expect(mocks.replace).toHaveBeenCalledTimes(1);
    const [target] = mocks.replace.mock.calls[0];
    expect(target.query).toEqual({ sort: 'Newest', tag: 'character' });
  });

  it('clears ?tag= from All, keeping the rest of the query', () => {
    mocks.query = { tag: 'character', sort: 'Newest' };
    const container = render();

    clickButton(container, 'All');

    const [target] = mocks.replace.mock.calls[0];
    expect(target.query).toEqual({ sort: 'Newest' });
    expect(target.query).not.toHaveProperty('tag');
  });

  it('reads the active category from ?tag= rather than from props', () => {
    mocks.query = { tag: 'style' };
    const container = render();

    clickButton(container, 'style');

    const [target] = mocks.replace.mock.calls[0];
    expect(target.query).not.toHaveProperty('tag');
  });

  // Asserted before any click: the router is mocked, so `mocks.query` never moves in
  // response to `replace` and a post-click read would report the pre-click state.
  it('marks the active chip, and only it, as filled', () => {
    mocks.query = { tag: 'style' };
    const container = render();

    expect(variantOf(container, 'style')).toBe('filled');
    expect(variantOf(container, 'character')).toBe('light');
    expect(variantOf(container, 'All')).toBe('light');
  });

  it('fills the All chip when no category is active', () => {
    const container = render();

    expect(variantOf(container, 'All')).toBe('filled');
    expect(variantOf(container, 'style')).toBe('light');
  });

  it('prefers selected over ?tag= when controlled, and leaves the URL alone', () => {
    const setSelected = vi.fn();
    mocks.query = { tag: 'character' };
    const container = render({ selected: 'style', setSelected });

    // Active per `selected`, so this toggles off.
    clickButton(container, 'style');
    expect(setSelected).toHaveBeenCalledTimes(1);
    expect(setSelected).toHaveBeenCalledWith(undefined);

    // Negative control: `?tag=character` must not select anything in a controlled bar.
    clickButton(container, 'character');
    expect(setSelected).toHaveBeenLastCalledWith('character');

    expect(mocks.replace).not.toHaveBeenCalled();
  });

  // The generation resource-select modal opens over /models with `selected` undefined
  // until the user picks. A `selected ?? tagQuery` fallback would light up the page's
  // category behind the modal and swallow the first click as a toggle-off.
  it('ignores ?tag= entirely when controlled with no selection', () => {
    const setSelected = vi.fn();
    mocks.query = { tag: 'character' };
    const container = render({ selected: undefined, setSelected, includeAll: false });

    expect(variantOf(container, 'character')).toBe('light');

    clickButton(container, 'character');
    expect(setSelected).toHaveBeenCalledWith('character');
  });

  // The chip row resolves client-side. Rendering nothing until it does lets it pop in
  // above the feed and shove it down — 0.65 CLS on /images when this last shipped.
  it('reserves the row height before the categories resolve', () => {
    mocks.categories = [];
    const container = render();

    expect(container.querySelector('button')).toBeNull();
    const reserved = Array.from(container.querySelectorAll('div')).filter((el) =>
      el.className.includes('min-h-[26px]')
    );
    expect(reserved).toHaveLength(1);
  });

  it('applies the filter prop, dropping excluded categories', () => {
    const container = render({
      includeAll: false,
      setSelected: vi.fn(),
      filter: (tag) => tag !== 'style',
    });

    expect(buttonLabels(container)).toEqual(['character']);
  });
});

/**
 * The component tests all render CategoryTags directly, so deleting the JSX from the
 * pages leaves every one of them green — which is how #4141 shipped ActiveTagFilter
 * with a passing suite and no mount point anywhere. This is the only assertion that
 * the bar is on the pages at all.
 */
describe('models surfaces mount the category bar', () => {
  it.each([['src/pages/models/index.tsx'], ['src/pages/user/[username]/models.tsx']])(
    '%s renders <CategoryTags />',
    (relative) => {
      // readFileSync throws on a moved or renamed page rather than silently passing.
      const source = fs.readFileSync(path.join(process.cwd(), ...relative.split('/')), 'utf-8');

      expect(source).toContain("from '~/components/CategoryTags/CategoryTags'");
      expect(source).toContain('<CategoryTags');
    }
  );
});

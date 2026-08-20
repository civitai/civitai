// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TagUtils from '~/components/Tags/tag.utils';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  query: {} as Record<string, unknown>,
}));

vi.mock('next/router', () => ({
  useRouter: () => ({ query: mocks.query, pathname: '/models', replace: mocks.replace }),
}));

vi.mock('~/components/Tags/tag.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof TagUtils>()),
  useCategoryTags: () => ({
    data: [
      { id: 1, name: 'character' },
      { id: 2, name: 'style' },
    ],
    isLoading: false,
  }),
}));

import { MantineProvider } from '@mantine/core';

import { CategoryTags } from '~/components/CategoryTags/CategoryTags';

function render(props?: Parameters<typeof CategoryTags>[0]) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(MantineProvider, null, createElement(CategoryTags, props))
    );
  });
  return container;
}

function buttonLabels(container: HTMLElement) {
  return Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim());
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

  it('defers to setSelected when controlled, leaving the URL alone', () => {
    const setSelected = vi.fn();
    const container = render({ selected: undefined, setSelected });

    clickButton(container, 'style');

    expect(setSelected).toHaveBeenCalledWith('style');
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});

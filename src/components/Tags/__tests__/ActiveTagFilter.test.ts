// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  query: {} as Record<string, unknown>,
}));

vi.mock('next/router', () => ({
  useRouter: () => ({ query: mocks.query, pathname: '/images', replace: mocks.replace }),
}));

import { MantineProvider } from '@mantine/core';

import { ActiveTagFilter } from '~/components/Tags/ActiveTagFilter';

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(MantineProvider, null, createElement(ActiveTagFilter))
    );
  });
  return container;
}

/**
 * This control is the ONLY way to unset `?tags=` now that the category scroller is
 * gone, and the feeds still filter on the param. If clearing stops removing `tags`,
 * or starts removing the rest of the query with it, a deep link becomes a feed the
 * visitor cannot widen.
 */
describe('ActiveTagFilter', () => {
  beforeEach(() => {
    mocks.replace.mockClear();
    mocks.query = {};
  });

  it('renders nothing when no tag filter is active', () => {
    const container = render();
    expect(container.querySelector('button')).toBeNull();
  });

  // Positive control for the assertion above: same matcher, tags present.
  it('renders a clear control when a tag filter is active', () => {
    mocks.query = { tags: '5' };
    const container = render();
    expect(container.querySelector('button')).not.toBeNull();
    expect(container.textContent).toContain('Clear 1 tag filter');
  });

  it('pluralises for several tags', () => {
    mocks.query = { tags: ['5', '9'] };
    const container = render();
    expect(container.textContent).toContain('Clear 2 tag filters');
  });

  it('drops `tags` and keeps every other query param', () => {
    mocks.query = { tags: ['5', '9'], sort: 'Newest', period: 'Week' };
    const container = render();

    act(() => {
      container.querySelector('button')?.click();
    });

    expect(mocks.replace).toHaveBeenCalledTimes(1);
    const [target] = mocks.replace.mock.calls[0];
    expect(target.query).toEqual({ sort: 'Newest', period: 'Week' });
    expect(target.query).not.toHaveProperty('tags');
  });
});

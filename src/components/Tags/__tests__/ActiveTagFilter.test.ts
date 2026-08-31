// @vitest-environment happy-dom
import fs from 'fs';
import path from 'path';
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

/**
 * Every test above renders the component directly, so all of them stay green while it is
 * mounted nowhere — which is exactly how it shipped in #4141 and sat unused until
 * 868kuq3jk. These are the only assertions that anything in the app renders it.
 *
 * /images and /videos are not in this list: there the escape hatch is the `All` chip on
 * ImageFeedTagBar, with this component as its flag-off fallback. Both of those are
 * covered in ImageFeedTagBar's own suite — the mount guard there, and the flag-off
 * fallback test beside it.
 */
describe('the feeds that filter on ?tags= mount the clear control', () => {
  it.each([['src/pages/posts/index.tsx'], ['src/pages/articles/index.tsx']])(
    '%s renders <ActiveTagFilter />',
    (relative) => {
      const repoRoot = path.resolve(__dirname, '../../../..');
      const source = fs.readFileSync(path.join(repoRoot, ...relative.split('/')), 'utf-8');

      // Commenting the mount out leaves the string in place, so strip comments first —
      // block comments because that is what an editor produces over a selection.
      //
      // Known limit, same as the ImageFeedTagBar guard: `{someFlag && <ActiveTagFilter/>}`
      // passes this while rendering for nobody. Scanning source cannot see that.
      const code = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const mounted = code
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes('<ActiveTagFilter') && !line.startsWith('//'));

      expect(source).toContain("from '~/components/Tags/ActiveTagFilter'");
      expect(mounted).toHaveLength(1);
    }
  );
});

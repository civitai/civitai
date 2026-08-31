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

function render(tagIds: number[] = []) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(MantineProvider, null, createElement(ActiveTagFilter, { tagIds }))
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
    const container = render([]);
    expect(container.querySelector('button')).toBeNull();
  });

  // Positive control for the assertion above: same matcher, tags present.
  it('renders a clear control when a tag filter is active', () => {
    const container = render([5]);
    expect(container.querySelector('button')).not.toBeNull();
    expect(container.textContent).toContain('Clear 1 tag filter');
  });

  it('pluralises for several tags', () => {
    const container = render([5, 9]);
    expect(container.textContent).toContain('Clear 2 tag filters');
  });

  // The caller owns the parse, so a `?tags=` the FEED did not accept must not raise a
  // control here. `useZodRouteParams` fails wholesale on one bad param, which is how a
  // url carrying `tags` reaches a feed that is not tag-filtered.
  it('renders nothing when the url carries tags the caller did not accept', () => {
    mocks.query = { tags: ['5'], sort: 'bogus' };
    const container = render([]);
    expect(container.querySelector('button')).toBeNull();
  });

  it('drops `tags` and keeps every other query param', () => {
    mocks.query = { tags: ['5', '9'], sort: 'Newest', period: 'Week' };
    const container = render([5, 9]);

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
 * /images and /videos are not in this list because their escape hatch is normally the
 * `All` chip on ImageFeedTagBar; this component stands in only where that chip is absent,
 * and both of those states are pinned in ImageFeedTagBar's own suite, beside the mount
 * guard for the bar itself.
 */
describe('the feeds that filter on ?tags= mount the clear control', () => {
  it.each([
    ['src/pages/posts/index.tsx'],
    ['src/pages/articles/index.tsx'],
    // Read-only `?tags=` since its category scroller was removed, and it reads the param
    // with `parseNumericStringArray` — the same dead end, on a flag-gated feed.
    ['src/pages/3d-models/index.tsx'],
  ])('%s renders <ActiveTagFilter />', (relative) => {
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
  });
});

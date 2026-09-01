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
 *
 * `/tools/[slug]` was named alongside the two `/user/*` pages as a third gap (868kz0qq6)
 * and is deliberately NOT here: it destructures a fixed field list out of
 * `useImageQueryParams()` that omits `tags`, and passes `disableStoreFilters`, so the
 * merge in `ImagesInfiniteContent` that would otherwise supply `tags` from the url never
 * runs. `?tags=` reaches that page and goes nowhere. Mounting the control there would
 * offer to clear a filter the feed never applied.
 *
 * ⚠️ Named for the pages it pins, not for the property. Still NOT a closed set — a new
 * feed that spreads its parsed query into `filters` inherits the same defect and nothing
 * here will notice. Do not read a green run as "every tag-filtered feed is covered".
 */
describe('the tag-filtered feeds mount the clear control', () => {
  it.each([
    ['src/pages/posts/index.tsx'],
    ['src/pages/articles/index.tsx'],
    // Read-only `?tags=` since its category scroller was removed, and it reads the param
    // with `parseNumericStringArray` — the same dead end, on a flag-gated feed.
    ['src/pages/3d-models/index.tsx'],
    // Both spread the whole parsed query into their feed, and `tags` is in both route
    // schemas, so `?tags=` genuinely filters them. Added by 868kz0qq6.
    ['src/pages/user/[username]/posts.tsx'],
    ['src/pages/user/[username]/articles.tsx'],
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
    // `tagIds` became required in the same change that added these mounts, which makes
    // `tagIds={[]}` a one-token edit that mounts the control and renders it for nobody —
    // a guard stopping at "it is on the page" passes over exactly that.
    expect(mounted[0]).toMatch(/tagIds=\{/);
    expect(mounted[0]).not.toContain('tagIds={[]}');
  });
});

/**
 * A decision, not an accident — do not "fix" this by ungating the mount.
 *
 * `/user/[username]/articles` renders `ArticlesInfinite` (which receives `tags`) only in
 * the published section; the draft section renders `UserDraftArticles`, which takes no
 * filters at all. So in drafts there is no tag filter in force, and an ungated control
 * would offer to clear one that was never applied — the same falsehood that kept
 * `/tools/[slug]` out of the list above.
 *
 * The sibling posts page is deliberately NOT gated: it renders `PostsInfinite` in both
 * sections and spreads `tags` into the filters either way, so the control is honest in
 * drafts there too.
 *
 * The mount guard above cannot see this — it reads source lines, and its own comment
 * records that a flag-gated mount passes it. This is the assertion that does.
 */
describe('the articles clear control is gated on the published section', () => {
  const read = (relative: string) =>
    fs.readFileSync(
      path.join(path.resolve(__dirname, '../../../..'), ...relative.split('/')),
      'utf-8'
    );

  it('gates the mount on viewingPublished', () => {
    const line = read('src/pages/user/[username]/articles.tsx')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.includes('<ActiveTagFilter'));

    expect(line).toBeDefined();
    expect(line).toContain('viewingPublished &&');
  });

  // Positive control for the matcher above: the posts page mounts the same component on
  // the same kind of line and must NOT carry that gate, so a match here would mean the
  // assertion passes on any mount rather than on the gate.
  it('does not gate the posts mount', () => {
    const line = read('src/pages/user/[username]/posts.tsx')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.includes('<ActiveTagFilter'));

    expect(line).toBeDefined();
    expect(line).not.toContain('viewingPublished');
  });
});

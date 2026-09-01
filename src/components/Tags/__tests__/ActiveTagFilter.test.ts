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
 * ⚠️ Named for the pages it pins, not for the property, and NOT a closed set. Two
 * surfaces have the same defect right now and are deliberately absent because they were
 * out of scope for 868kz0qq6, not because they are covered: `/user/[username]/images` and
 * `/user/[username]/videos`, both backed by `UserMediaInfinite`, which spreads `...query`
 * (retaining `tags`) into `ImagesInfinite` and renders no tag control at all, while
 * `getAllImages` applies its tag clause for every viewer. Do not read a green run here as
 * "every tag-filtered feed is covered" — read it as "these five".
 *
 * The note above about /images and /videos means the ROOT feeds, whose escape hatch is the
 * `All` chip on ImageFeedTagBar. That bar is not on the profile tabs.
 */
describe('the tag-filtered feeds mount the clear control', () => {
  it.each([
    ['src/pages/posts/index.tsx'],
    ['src/pages/articles/index.tsx'],
    // Read-only `?tags=` since its category scroller was removed, and it reads the param
    // with `parseNumericStringArray` — the same dead end, on a flag-gated feed.
    ['src/pages/3d-models/index.tsx'],
    // Both spread the whole parsed query into their feed and `tags` is in both route
    // schemas, so `?tags=` reaches the server on each. Added by 868kz0qq6. Whether the
    // server then APPLIES it differs per viewer — see the gating block below.
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
 * ⚠️ These gates pin a DECISION (868kz0qq6) about SERVER behaviour that neither page's
 * source reveals. Do not "tidy" either mount by ungating it.
 *
 * The control must only appear where the feed actually applied the tag filter, otherwise it
 * offers to clear something that was never in force — the same falsehood that kept
 * `/tools/[slug]` out of the list above.
 *
 * `/user/[username]/posts` is gated on `!selfView` because `getPostsInfinite` puts the tag
 * clause behind `if (!isOwnerRequest)` (`post.service.ts`, "these are discovery filters, not
 * publication ones"), and the page always sends `username`. So an owner viewing their own
 * profile gets an UNFILTERED feed in both the published and draft sections, however much
 * `?tags=` the url carries. Moderators are not owners there, so they keep both the filter
 * and the control.
 *
 * `/user/[username]/articles` is gated on `viewingPublished` instead, for an unrelated
 * reason: `getInfiniteArticles` applies its tag clause unconditionally, so every viewer is
 * filtered — but the draft section renders `UserDraftArticles`, which takes no filters at
 * all.
 *
 * Two different gates, two different causes. The mount guard above cannot see either: it
 * reads source lines, and its own comment records that a flag-gated mount passes it.
 */
describe('each user feed gates the clear control on where its filter really applies', () => {
  const read = (relative: string) =>
    fs.readFileSync(
      path.join(path.resolve(__dirname, '../../../..'), ...relative.split('/')),
      'utf-8'
    );

  /**
   * Returns the gate expression guarding the mount — `!selfView`, `viewingPublished` — or
   * undefined if the mount is absent, commented out, or written in some other shape.
   *
   * Whitespace is collapsed before matching so a Prettier re-wrap (both mount lines are
   * within ~25 columns of printWidth, so one added prop wraps them) moves the gate onto
   * its own line without reddening this.
   */
  const mountGate = (source: string) => {
    const stripped = source
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join(' ')
      .replace(/\s+/g, ' ');

    return stripped.match(/\{ ?([^{}]*?) ?&& ?<ActiveTagFilter/)?.[1];
  };

  /**
   * The control for every assertion below, and the reason they are exact-equality rather
   * than `toContain`.
   *
   * `toContain('viewingPublished &&')` is satisfied by `'!viewingPublished &&'` — the
   * substring is a prefix of its own negation — so the ONE mutation this block exists to
   * catch, mounting the control on the section where the filter is not applied, passed
   * silently. Same for an extra conjunct narrowing the gate. Both are pinned here against
   * fixtures rather than against the repo, so the discrimination is demonstrated without
   * mutating a page.
   */
  it.each([
    ['{viewingPublished && <ActiveTagFilter tagIds={x} />}', 'viewingPublished'],
    ['{!viewingPublished && <ActiveTagFilter tagIds={x} />}', '!viewingPublished'],
    ['{!selfView && <ActiveTagFilter tagIds={x} />}', '!selfView'],
    ['{selfView && <ActiveTagFilter tagIds={x} />}', 'selfView'],
    [
      '{canViewDrafts && !selfView && <ActiveTagFilter tagIds={x} />}',
      'canViewDrafts && !selfView',
    ],
    // Prettier re-wrapped across lines: same gate, still found.
    ['{viewingPublished &&\n  <ActiveTagFilter tagIds={x} />}', 'viewingPublished'],
  ])('reads the gate out of %j', (source, expected) => {
    expect(mountGate(source)).toBe(expected);
  });

  it.each([
    ['// {!selfView && <ActiveTagFilter tagIds={x} />}'],
    ['{/* {!selfView && <ActiveTagFilter tagIds={x} />} */}'],
    ['<ActiveTagFilter tagIds={x} />'],
  ])('reports no gate for %j', (source) => {
    expect(mountGate(source)).toBeUndefined();
  });

  it('gates the posts mount on ownership, and on nothing else', () => {
    expect(mountGate(read('src/pages/user/[username]/posts.tsx'))).toBe('!selfView');
  });

  it('gates the articles mount on the published section, and on nothing else', () => {
    expect(mountGate(read('src/pages/user/[username]/articles.tsx'))).toBe('viewingPublished');
  });
});

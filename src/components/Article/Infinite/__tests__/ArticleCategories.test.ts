// @vitest-environment happy-dom
import fs from 'fs';
import path from 'path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as HiddenPreferences from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import type * as TrpcModule from '~/utils/trpc';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  pathname: '/articles',
  query: {} as Record<string, unknown>,
  tags: [] as { id: number; name: string; nsfwLevel: number }[],
  hiddenTagIds: [] as number[],
  loadingPreferences: false,
  maxNsfwLevel: 1,
  tagsLoading: false,
  getAll: vi.fn(),
}));

vi.mock('next/router', () => ({
  useRouter: () => ({ query: mocks.query, pathname: mocks.pathname, replace: mocks.replace }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    tag: {
      getAll: {
        // Records the input so the tests can assert WHICH tags this bar asks for. That is
        // the whole point of the component: `CategoryTags` next door asks the same
        // procedure for `TagTarget.Model`, and a copy-paste that kept the model entity
        // type would still render a plausible-looking row of chips.
        useQuery: (input: unknown) => {
          mocks.getAll(input);
          return { data: { items: mocks.tags }, isLoading: mocks.tagsLoading };
        },
      },
    },
  },
}));

// Stands in for the real hidden-preferences provider, which needs a session + query
// client. `hiddenTagIds` drives it so the bar's use of it is observable rather than
// assumed — a bar that ignored the hook would keep rendering a category the viewer has
// personally hidden.
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', async (importOriginal) => ({
  ...(await importOriginal<typeof HiddenPreferences>()),
  useApplyHiddenPreferences: ({ data }: { data?: { id: number; nsfwLevel?: number }[] }) => ({
    items: (data ?? []).filter(
      (x) => !mocks.hiddenTagIds.includes(x.id) && (x.nsfwLevel ?? 1) <= mocks.maxNsfwLevel
    ),
    loadingPreferences: mocks.loadingPreferences,
  }),
}));

import { MantineProvider } from '@mantine/core';

import { ArticleCategories } from '~/components/Article/Infinite/ArticleCategories';
import { TagTarget } from '~/shared/utils/prisma/enums';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(
        MantineProvider,
        { forceColorScheme: 'light' },
        createElement(ArticleCategories)
      )
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

function activeLabels(container: HTMLElement) {
  // Active chips are `color="blue"`, inactive ones grey. Mantine writes the colour onto
  // the element as a `--button-*` CSS variable rather than a class, so read that.
  return Array.from(container.querySelectorAll('button'))
    .filter((b) => (b.getAttribute('style') ?? '').includes('blue'))
    .map((b) => b.textContent?.trim());
}

function reservedRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('div')).filter((el) =>
    el.className.includes('min-h-[26px]')
  );
}

function lastReplacedQuery() {
  const [target] = mocks.replace.mock.calls[mocks.replace.mock.calls.length - 1];
  return (target as { query: Record<string, unknown> }).query;
}

describe('ArticleCategories', () => {
  beforeEach(() => {
    mocks.replace.mockClear();
    mocks.getAll.mockClear();
    mocks.pathname = '/articles';
    mocks.query = {};
    mocks.hiddenTagIds = [];
    mocks.maxNsfwLevel = 1;
    mocks.loadingPreferences = false;
    mocks.tagsLoading = false;
    // Names and ids as they are in production, in the order the server returns them
    // (`TagSort.MostArticles`).
    mocks.tags = [
      { id: 128643, name: 'announcement', nsfwLevel: 1 },
      { id: 121951, name: 'story', nsfwLevel: 1 },
      { id: 128649, name: 'musing', nsfwLevel: 1 },
    ];
  });

  it('renders the All chip plus every category, in the order the server sent them', () => {
    const container = render();
    expect(buttonLabels(container)).toEqual(['All', 'announcement', 'story', 'musing']);
  });

  // 🔴 This is the assertion that says this bar is the ARTICLE bar. `CategoryTags` is the
  // same row of chips over `TagTarget.Model`, and a future tidy-up that "shares" the two
  // by pointing this one at that component would still draw chips and still filter — with
  // the model taxonomy on the article feed. Do not delete this because it looks like it
  // is testing a hook's arguments; it is testing which taxonomy the page shows.
  it('asks for article categories, not model ones', () => {
    render();
    expect(mocks.getAll).toHaveBeenCalledTimes(1);
    expect(mocks.getAll).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: [TagTarget.Article], categories: true })
    );
  });

  it('writes ?tags=<id> on select and leaves the rest of the query alone', () => {
    mocks.query = { sort: 'Newest', period: 'Month' };
    const container = render();

    clickButton(container, 'story');

    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(lastReplacedQuery()).toEqual({ sort: 'Newest', period: 'Month', tags: [121951] });
  });

  it('lights the chip the feed is actually filtered on', () => {
    mocks.query = { tags: ['121951'] };
    const container = render();
    expect(activeLabels(container)).toEqual(['story']);
  });

  it('clears the filter when the active chip is pressed again', () => {
    mocks.query = { tags: ['121951'] };
    const container = render();

    clickButton(container, 'story');

    expect(lastReplacedQuery()).not.toHaveProperty('tags');
  });

  // The All chip is the escape hatch (868kuq3jk). It has to clear ids this bar cannot
  // draw, which is what a deep link from a tag page or a search result carries.
  it('clears a ?tags= id that is not a chip on this bar', () => {
    mocks.query = { tags: ['999999'], sort: 'Newest' };
    const container = render();

    clickButton(container, 'All');

    expect(lastReplacedQuery()).toEqual({ sort: 'Newest' });
  });

  // 🔴 DELIBERATE, and it differs from `ImageFeedTagBar` on purpose. `TagChipRow` fills
  // the All chip whenever `activeId` is `undefined`, so the obvious
  // `tagIds.length === 1 ? tagIds[0] : undefined` lights ALL — the chip that means
  // "unfiltered" — over a feed that is filtered on tags this bar cannot draw. The
  // component hands those states an id no chip holds instead. If you are here because
  // that sentinel looks redundant, this is what it is for.
  it('lights nothing — not All — when ?tags= is something the bar cannot draw', () => {
    mocks.query = { tags: ['999999'] };
    expect(activeLabels(render())).toEqual([]);

    mocks.query = { tags: ['121951', '128649'] };
    expect(activeLabels(render())).toEqual([]);

    // The control: with no filter at all, All IS lit. Without this the two assertions
    // above pass for a bar that never lights anything.
    mocks.query = {};
    expect(activeLabels(render())).toEqual(['All']);
  });

  // Lighting one chip of several would describe the feed wrongly: `getArticles` filters
  // `?tags=` as a union, so a two-id link is showing BOTH categories, not `story`.
  it('lights no category chip when several tags are filtered', () => {
    mocks.query = { tags: ['121951', '128649'] };
    const container = render();

    expect(activeLabels(container)).toEqual([]);

    clickButton(container, 'All');
    expect(lastReplacedQuery()).not.toHaveProperty('tags');
  });

  it('does not render a category the viewer has hidden', () => {
    mocks.hiddenTagIds = [121951];
    const container = render();
    expect(buttonLabels(container)).toEqual(['All', 'announcement', 'musing']);
  });

  // The CLS reservation, which is why `TagChipRow` exists at all: the row holds 26px
  // while it has nothing to draw, so the feed underneath does not jump when the chips
  // arrive. Both halves matter — no buttons, and the reserved row still present.
  it('holds the row height and draws nothing while the categories load', () => {
    mocks.tagsLoading = true;
    mocks.tags = [];
    const container = render();

    expect(buttonLabels(container)).toEqual([]);
    expect(reservedRows(container)).toHaveLength(1);
  });

  // Settled and empty — a failed category fetch. Permanent, unlike the state above, so
  // the escape hatch has to come back or a `?tags=` deep link is a dead end forever.
  it('falls back to the clear control when the category list comes back empty', () => {
    mocks.tags = [];
    mocks.query = { tags: ['999999'], sort: 'Newest' };
    const container = render();

    expect(buttonLabels(container)).toEqual(['Clear 1 tag filter']);

    clickButton(container, 'Clear 1 tag filter');
    expect(lastReplacedQuery()).toEqual({ sort: 'Newest' });
  });

  // The negative control for the test above: same empty list, no `?tags=`, so there is
  // nothing to escape from and the fallback must not appear. Without this, a component
  // that rendered the clear button unconditionally would pass that one.
  it('renders no control when the category list is empty and no tag filter is active', () => {
    mocks.tags = [];
    const container = render();

    expect(buttonLabels(container)).toEqual([]);
  });
});

/**
 * Rendering the component directly leaves every test above green if the JSX is deleted
 * from the page — which is how #4141 shipped `ActiveTagFilter` with a passing suite and
 * no mount point anywhere. This is the only assertion that the bar is on the feed.
 *
 * It is also why `src/pages/articles/index.tsx` left the list in `ActiveTagFilter`'s own
 * mount guard: that page's escape hatch is now the `All` chip here, and the fallback
 * above covers the state where the chip is absent. Delete this block and nothing in the
 * repo asserts the articles feed has either.
 */
describe('the articles feed mounts the category bar', () => {
  it('src/pages/articles/index.tsx renders <ArticleCategories />', () => {
    const repoRoot = path.resolve(__dirname, '../../../../..');
    const source = fs.readFileSync(
      path.join(repoRoot, 'src', 'pages', 'articles', 'index.tsx'),
      'utf-8'
    );

    // Commenting the mount out is likelier than deleting it, and leaves the string in
    // place. Block comments are stripped first because that is what an editor's comment
    // command produces over a multi-line selection.
    //
    // ⚠️ Known limit, the same one the ImageFeedTagBar guard carries: a gated mount
    // (`{someFlag && <ArticleCategories />}`) passes this while rendering for nobody.
    // Scanning source cannot see it.
    const code = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const mounted = code
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('<ArticleCategories') && !line.startsWith('//'));

    expect(source).toContain("from '~/components/Article/Infinite/ArticleCategories'");
    expect(mounted).toHaveLength(1);
  });
});

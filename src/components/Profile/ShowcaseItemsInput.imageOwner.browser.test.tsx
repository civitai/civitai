import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { ReactNode } from 'react';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

// The showcase editor's Images picker, mounted with the real InstantSearch, Configure and search
// client wiring. Only the transports are faked: Meilisearch answers no images, the semantic search
// fake applies `usernames` the way the server does, and `image.getMyImages` answers the caller's own
// images (the server reads the caller from the session).

const OWNER_IMAGE = 41;
const OTHER_USERS_IMAGE = 99;
const OWNER_ARTICLE = 51;
const OTHER_USERS_ARTICLE = 98;
const RECENT_SAFE = 61;
const RECENT_MATURE = 62;

const state = vi.hoisted(() => ({
  renderedHits: [] as unknown[],
  rowProps: [] as unknown[],
  imageSearch: true,
  semanticQuery: vi.fn(),
  articleQuery: vi.fn(),
  myImages: vi.fn(),
}));

vi.mock('@meilisearch/instant-meilisearch', async () => {
  const { emptyResult } = await import('~/components/Search/semanticImageSearchClient');
  return {
    instantMeiliSearch: () => ({
      // Meili applies the `filters` string, so the owner's filter narrows to the owner's article.
      search: async (requests: Array<{ indexName: string; params: { filters?: string } }>) => ({
        results: requests.map((r) => {
          const result = emptyResult(r.indexName, r.params as never);
          if (!r.indexName.startsWith('articles')) return result;
          const owned = r.params.filters?.includes("user.username = 'fox'");
          return {
            ...result,
            hits: [{ id: owned ? 51 : 98, objectID: owned ? '51' : '98', nsfwLevel: [1] }],
            nbHits: 1,
          };
        }),
      }),
    }),
  };
});
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useFeatureFlags: () =>
    new Proxy({}, { get: (_, key) => (key === 'imageSearch' ? state.imageSearch : true) }),
}));
// Articles answer from the semantic article search when this is on; it ignores `filters`.
vi.mock('~/components/Search/semanticArticleSearchFlag', () => ({
  setSemanticArticleSearchEnabled: () => undefined,
  isSemanticArticleSearchEnabled: () => true,
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  BrowsingSettingsAddonsProvider: (props: { children: ReactNode }) => props.children,
  useBrowsingSettingsAddons: () => ({ settings: {}, browsingLevel: 3 }),
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCurrentUser: () => ({ id: 7, username: 'fox' }),
}));
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data: unknown[] }) => ({ items: data }),
}));
// The option renderer is out of frame; a marker per offered image is all this test reads.
vi.mock('~/components/AutocompleteSearch/renderItems/images', async () => {
  const React = await import('react');
  const ImagesSearchItem = React.forwardRef((props: { value: string; hit?: unknown }, ref) => {
    state.renderedHits.push(props.hit);
    state.rowProps.push(props);
    return React.createElement('div', { ref, 'data-testid': `option-${props.value}` });
  });
  ImagesSearchItem.displayName = 'ImagesSearchItemStub';
  return { ImagesSearchItem };
});
vi.mock('~/components/AutocompleteSearch/renderItems/articles', async () => {
  const React = await import('react');
  const ArticlesSearchItem = React.forwardRef((props: { value: string }, ref) =>
    React.createElement('div', { ref, 'data-testid': `option-${props.value}` })
  );
  ArticlesSearchItem.displayName = 'ArticlesSearchItemStub';
  return { ArticlesSearchItem };
});
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'image.getEntitiesCoverImage': {
      useQuery: () => ({ data: [], isLoading: false, isRefetching: false }),
    },
  }),
  trpcVanilla: {
    semanticImageSearch: { search: { query: state.semanticQuery } },
    semanticArticleSearch: { search: { query: state.articleQuery } },
    image: { getMyImages: { query: state.myImages } },
  },
}));

const { ShowcaseItemsInput } = await import('~/components/Profile/ShowcaseItemsInput');

beforeEach(() => {
  state.renderedHits = [];
  state.rowProps = [];
  state.imageSearch = true;
  state.myImages.mockReset();
  // Browsing level 3 (PG + PG-13) is set above; 2 is PG-13, 16 is X.
  state.myImages.mockResolvedValue({
    items: [
      {
        id: RECENT_SAFE,
        nsfwLevel: 2,
        url: 'a',
        type: 'image',
        metadata: { hash: 'h', width: 3, height: 2 },
      },
      { id: RECENT_MATURE, nsfwLevel: 16, url: 'b', type: 'image' },
    ],
  });
  state.semanticQuery.mockReset();
  // As the server: `usernames` narrows to those users' images; without it, anyone's.
  state.semanticQuery.mockImplementation(async (input: { usernames?: string[] }) => ({
    items: [{ id: input.usernames?.includes('fox') ? OWNER_IMAGE : OTHER_USERS_IMAGE }],
    latencyMs: 1,
  }));
  state.articleQuery.mockReset();
  state.articleQuery.mockResolvedValue({ items: [{ id: OTHER_USERS_ARTICLE }], latencyMs: 1 });
});

const offeredIds = () =>
  [...document.querySelectorAll('[data-testid^="option-"]')].map((el) =>
    Number(el.getAttribute('data-testid')!.slice('option-'.length))
  );

describe('Images search in the showcase picker', () => {
  // Control built into the fake: it answers another user's image whenever the owner scope is
  // missing, so offering exactly the owner's image is the scope holding, not the fake.
  test.each([
    ['with image search', true],
    ['without image search', false],
  ])('typing a search offers the owner’s images and never another user’s, %s', async (_, flag) => {
    state.imageSearch = flag;
    renderWithProviders(
      <ShowcaseItemsInput username="fox" supportedIndexes={['images']} value={[]} />
    );

    await userEvent.type(page.getByPlaceholder('Search Civitai'), 'kuro');

    await vi.waitFor(() => expect(offeredIds()).toEqual([OWNER_IMAGE]), { timeout: 3000 });
    expect(state.semanticQuery).toHaveBeenCalledWith(expect.objectContaining({ query: 'kuro' }));
    for (const [input] of state.semanticQuery.mock.calls) expect(input.usernames).toEqual(['fox']);
  });

  // Owner scope only reaches the semantic image search (as a facet); the semantic article search
  // would ignore it, so Articles stay on Meilisearch, where the `filters` string applies.
  test('the Articles tab offers only the owner’s articles with semantic article search on', async () => {
    renderWithProviders(
      <ShowcaseItemsInput username="fox" supportedIndexes={['articles']} value={[]} />
    );

    await userEvent.type(page.getByPlaceholder('Search Civitai'), 'kuro');

    await vi.waitFor(() => expect(offeredIds()).toEqual([OWNER_ARTICLE]), { timeout: 3000 });
    expect(state.articleQuery).not.toHaveBeenCalled();
  });

  test('on open, it lists the caller’s recent images at their browsing level', async () => {
    state.imageSearch = false;
    renderWithProviders(
      <ShowcaseItemsInput username="fox" supportedIndexes={['images']} value={[]} />
    );

    await userEvent.click(page.getByPlaceholder('Search Civitai'));

    await vi.waitFor(() => expect(offeredIds()).toEqual([RECENT_SAFE]), { timeout: 3000 });
    // A blurred row draws its placeholder from these; without them it is an empty box.
    expect(state.renderedHits.at(-1)).toMatchObject({ hash: 'h', width: 3, height: 2 });
    // The select returns no `user`; the row's avatar needs the caller's.
    expect(state.renderedHits.at(-1)).toMatchObject({ user: { id: 7, username: 'fox' } });
    expect(state.rowProps.at(-1)).toMatchObject({
      pickerRow: true,
      viewerLevel: 3,
      blurLevels: expect.any(Number),
    });
    expect(state.semanticQuery).not.toHaveBeenCalled();
    // Whose images is the session's call: the request names no user.
    expect(state.myImages).toHaveBeenCalledWith(expect.objectContaining({ publishedOnly: true }));
  });

  test('on open, it lists more than one page of the caller’s media, videos included', async () => {
    state.imageSearch = false;
    // As the server: the caller's newest first, narrowed to the media types asked for, up to limit.
    const own = Array.from({ length: 40 }, (_, i) => ({
      id: 1000 + i,
      nsfwLevel: 1,
      url: `m${i}`,
      type: i === 30 ? 'video' : 'image',
    }));
    state.myImages.mockImplementation(async (input: { limit: number; mediaTypes: string[] }) => ({
      items: own.filter((item) => input.mediaTypes.includes(item.type)).slice(0, input.limit),
    }));
    renderWithProviders(
      <ShowcaseItemsInput username="fox" supportedIndexes={['images']} value={[]} />
    );

    await userEvent.click(page.getByPlaceholder('Search Civitai'));

    await vi.waitFor(() => expect(offeredIds()).toHaveLength(40), { timeout: 3000 });
    expect(offeredIds()).toContain(1030);
  });

  // The profile editor renders this input signed in with no owner: a session check in place of the
  // `username` guard would give it a search scoped to no one.
  test('with no owner, there is no picker to search, even signed in', async () => {
    renderWithProviders(<ShowcaseItemsInput supportedIndexes={['images']} value={[]} />);

    await expect
      .element(page.getByText('You have not selected any items'), { timeout: 3000 })
      .toBeInTheDocument();
    expect(page.getByPlaceholder('Search Civitai').elements()).toHaveLength(0);
    expect(state.myImages).not.toHaveBeenCalled();
  });
});

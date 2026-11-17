import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { ReactNode } from 'react';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

// The showcase editor's Images picker, mounted with the real InstantSearch, Configure and search
// client wiring. Only the transports are faked: Meilisearch has no images index any more (images_v6
// was deleted), and the semantic search fake applies `usernames` the way the server does.

const OWNER_IMAGE = 41;
const OTHER_USERS_IMAGE = 99;
const OWNER_ARTICLE = 51;
const OTHER_USERS_ARTICLE = 98;

const state = vi.hoisted(() => ({ semanticQuery: vi.fn(), articleQuery: vi.fn() }));

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
  // The Images tab is offered only with `imageSearch` on.
  useFeatureFlags: () => new Proxy({}, { get: () => true }),
}));
// Articles answer from the semantic article search when this is on; it ignores `filters`.
vi.mock('~/components/Search/semanticArticleSearchFlag', () => ({
  setSemanticArticleSearchEnabled: () => undefined,
  isSemanticArticleSearchEnabled: () => true,
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  BrowsingSettingsAddonsProvider: (props: { children: ReactNode }) => props.children,
  useBrowsingSettingsAddons: () => ({ settings: {}, browsingLevel: 1 }),
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
  const ImagesSearchItem = React.forwardRef((props: { value: string }, ref) =>
    React.createElement('div', { ref, 'data-testid': `option-${props.value}` })
  );
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
  },
}));

const { ShowcaseItemsInput } = await import('~/components/Profile/ShowcaseItemsInput');

beforeEach(() => {
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
  test('typing a search offers the owner’s images and never another user’s', async () => {
    renderWithProviders(
      <ShowcaseItemsInput username="fox" supportedIndexes={['images']} value={[]} />
    );

    await userEvent.type(page.getByPlaceholder('Search Civitai'), 'kuro');

    // The failure that shipped: no images index answered, so nothing was offered.
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
});

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

type Item = Record<string, unknown> & { id: string; status: string };

const KEPT = { url: '00000000-0000-4000-8000-000000000000', width: 2520, height: 630 };

const h = vi.hoisted(() => ({
  items: [] as Item[],
  submit: vi.fn<(input: Record<string, unknown>) => Promise<{ workflowId: string }>>(),
  keep: vi.fn<(input: Record<string, unknown>) => Promise<Record<string, unknown>>>(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 9 }) }));
vi.mock('~/providers/AppProvider', async (orig) => ({
  ...(await orig<object>()),
  useAppContext: () => ({ domain: 'blue' }),
}));
vi.mock('~/providers/BrowserSettingsProvider', async (orig) => ({
  ...(await orig<object>()),
  useBrowsingSettings: () => true,
}));
vi.mock('~/providers/FiltersProvider', async (orig) => ({
  ...(await orig<object>()),
  useFiltersContext: () => ({}),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<typeof FeatureFlagsProvider>()),
  useOptionalFeatureFlags: () => ({ articleTypography: true }),
  useFeatureFlags: () => ({ articleTypography: true }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { useInfiniteQuery, useMutation } = await import('@tanstack/react-query');
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  const original = await importOriginal<typeof Trpc>();
  const realOrchestrator = original.trpc.orchestrator as unknown as Record<string, object>;
  const mutation = (fn: (input: never) => Promise<unknown>) => ({
    useMutation: () =>
      useMutation({ mutationFn: (input: never) => fn(input) }, original.queryClient),
  });
  // The real router, so the queue query and its invalidations use the generator's own keys.
  const orchestrator = new Proxy(realOrchestrator, {
    get(target, key: string) {
      if (key === 'queryGeneratedImages')
        return new Proxy(target[key], {
          get: (proc, name) =>
            name === 'useInfiniteQuery'
              ? (input: unknown, options: Record<string, unknown>) =>
                  useInfiniteQuery(
                    {
                      queryKey: [
                        ['orchestrator', 'queryGeneratedImages'],
                        { input, type: 'infinite' },
                      ],
                      queryFn: async () => ({ items: h.items, nextCursor: undefined }),
                      initialPageParam: undefined,
                      getNextPageParam: () => undefined,
                      ...options,
                    },
                    original.queryClient
                  )
              : (proc as Record<string | symbol, unknown>)[name],
        });
      return target[key];
    },
  });
  return {
    ...original,
    trpc: makeTrpcProxy(
      {
        'article.reframeQuote': {
          useQuery: () => ({
            isLoading: false,
            isError: false,
            data: { cost: 40, ready: true },
          }),
        },
        'article.reframeSubmit': mutation(h.submit),
        'article.reframeKeep': mutation(h.keep),
      },
      { orchestrator }
    ),
  };
});

import { getQueryKey } from '@trpc/react-query';
import { ArticleReframeContent } from '~/components/Article/ArticleReframeModal';
import { queryClient, trpc } from '~/utils/trpc';

function take(status: string, { width = 2520, height = 1080 } = {}): Item {
  return {
    id: 'wf-1',
    status,
    tags: ['gen', 'article-reframe', 'article-reframe:banner'],
    createdAt: new Date(2026, 10, 6).toISOString(),
    steps: [
      {
        $type: 'imageGen',
        name: '0',
        status,
        metadata: {},
        output:
          status === 'succeeded'
            ? [
                {
                  id: 'b1',
                  type: 'image',
                  url: 'https://example.com/take.png',
                  available: true,
                  nsfwLevel: 'pG',
                  width,
                  height,
                },
              ]
            : [],
      },
    ],
  };
}

async function setItems(items: Item[]) {
  h.items = items;
  await queryClient.invalidateQueries({
    queryKey: getQueryKey(trpc.orchestrator.queryGeneratedImages),
  });
}

const onKeep = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  h.items = [];
  h.submit.mockImplementation(async () => {
    h.items = [take('processing')];
    return { workflowId: 'wf-1' };
  });
  h.keep.mockResolvedValue(KEPT);
});

describe('ArticleReframeContent', () => {
  test('a paid take reaches the form only when the author keeps it', async () => {
    await renderWithProviders(
      <ArticleReframeContent
        source={{ id: 11, url: 'c0ffee00-0000-4000-8000-000000000000' }}
        target="banner"
        onKeep={onKeep}
        onClose={onClose}
      />
    );
    await page.getByRole('button', { name: /Generate banner/ }).click();
    await vi.waitFor(() =>
      expect(h.submit).toHaveBeenCalledWith(
        expect.objectContaining({ imageId: 11, target: 'banner', quote: 40 })
      )
    );

    await setItems([take('succeeded')]);
    await expect.element(page.getByRole('img', { name: 'Generated take' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Keep as banner' })).toBeVisible();
    // Generated and shown, still nothing in the form.
    expect(onKeep).not.toHaveBeenCalled();

    await page.getByRole('button', { name: 'Keep as banner' }).click();
    await vi.waitFor(() => expect(onKeep).toHaveBeenCalledTimes(1));
    expect(h.keep).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', target: 'banner' })
    );
    expect(onKeep).toHaveBeenCalledWith(expect.objectContaining({ url: KEPT.url, type: 'image' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Retry discards the take without keeping it', async () => {
    await renderWithProviders(
      <ArticleReframeContent
        source={{ id: 11, url: 'c0ffee00-0000-4000-8000-000000000000' }}
        target="banner"
        onKeep={onKeep}
        onClose={onClose}
      />
    );
    await page.getByRole('button', { name: /Generate banner/ }).click();
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalled());
    await setItems([take('succeeded')]);
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect.element(page.getByRole('button', { name: /Generate banner/ })).toBeVisible();
    await expect.element(page.getByRole('img', { name: 'Generated take' })).not.toBeInTheDocument();
    expect(onKeep).not.toHaveBeenCalled();
    expect(h.keep).not.toHaveBeenCalled();
  });

  test('says when a take is narrower than the suggested width, and not otherwise', async () => {
    await renderWithProviders(
      <ArticleReframeContent
        source={{ id: 11, url: 'c0ffee00-0000-4000-8000-000000000000' }}
        target="banner"
        onKeep={onKeep}
        onClose={onClose}
      />
    );
    const warning = page.getByText(/narrower than the suggested/);
    await page.getByRole('button', { name: /Generate banner/ }).click();
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalled());

    await setItems([take('succeeded')]);
    await expect.element(page.getByRole('img', { name: 'Generated take' })).toBeVisible();
    await expect.element(warning).not.toBeInTheDocument();

    await setItems([take('succeeded', { width: 1200, height: 600 })]);
    await expect.element(warning).toBeVisible();
  });
});

import { generateJSON } from '@tiptap/html';
import { useQuery } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsModule from '~/providers/BrowserSettingsProvider';
import type * as AddonsModule from '~/providers/BrowsingSettingsAddonsProvider';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { tiptapExtensions } from '~/shared/tiptap/extensions';
import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';

// A stand-in for the feed endpoints that applies the one rule under test: a row comes back only
// when its rating intersects the requested browsing level. Everything else about visibility is the
// real client code — the hooks, the providers and the level they send.
const mocks = vi.hoisted(() => {
  const rows = {
    model: [
      { id: 1, name: 'Safe model', nsfwLevel: 1, images: [{ id: 101, url: 'safe-cover.jpg' }] },
      { id: 2, name: 'Spicy model', nsfwLevel: 16, images: [{ id: 102, url: 'mature-cover.jpg' }] },
      { id: 4, name: 'Other model', nsfwLevel: 1, images: [{ id: 104, url: 'other-cover.jpg' }] },
    ],
    image: [{ id: 7, name: 'Safe image', nsfwLevel: 1, url: 'safe-image.jpg' }],
  };
  const state = {
    level: 1,
    showNsfw: true,
    canViewNsfw: true,
    user: { id: 9 } as { id: number } | null,
    inView: true,
  };
  const requests: { type: 'model' | 'image'; ids: number[]; browsingLevel: number }[] = [];
  const setBrowsingSettings = vi.fn();
  return { rows, state, requests, setBrowsingSettings };
});

function fakeFeed(type: 'model' | 'image') {
  return function useInfiniteQuery(
    input: { ids: number[]; browsingLevel: number },
    opts?: { enabled?: boolean }
  ) {
    return useQuery({
      queryKey: [type, input],
      enabled: opts?.enabled ?? true,
      queryFn: async () => {
        mocks.requests.push({ type, ids: input.ids, browsingLevel: input.browsingLevel });
        const items = mocks.rows[type].filter(
          (row) =>
            input.ids.includes(row.id) && Flags.intersects(row.nsfwLevel, input.browsingLevel)
        );
        return { pages: [{ items, nextCursor: undefined }], pageParams: [undefined] };
      },
    });
  };
}

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'model.getAll': { useInfiniteQuery: fakeFeed('model') },
    'image.getInfinite': { useInfiniteQuery: fakeFeed('image') },
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.state.user }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ canViewNsfw: mocks.state.canViewNsfw }),
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsModule>()),
  useBrowsingSettings: (selector: (s: unknown) => unknown) =>
    selector({
      showNsfw: mocks.state.showNsfw,
      browsingLevel: mocks.state.level,
      blurNsfw: true,
      setState: mocks.setBrowsingSettings,
    }),
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AddonsModule>()),
  useBrowsingSettingsAddons: () => ({ settings: {} }),
}));
// Hidden-user/tag filtering is the feeds' own and not under test here.
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data?: unknown[] }) => ({
    items: data ?? [],
    loadingPreferences: false,
    hiddenCount: 0,
  }),
}));
vi.mock('~/hooks/useInView', () => ({
  useInView: () => ({ ref: { current: null }, inView: mocks.state.inView }),
}));
vi.mock('~/components/Image/Providers/ImagesProvider', () => ({
  ImagesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// The feed cards are the feeds' own; what matters here is which data reaches them.
vi.mock('~/components/Cards/ModelCard', () => ({
  ModelCard: ({ data }: { data: (typeof mocks.rows.model)[number] }) => (
    <div data-testid="model-card">
      <img src={data.images[0].url} alt="" />
      {data.name}
    </div>
  ),
}));
vi.mock('~/components/Cards/ImageCard', () => ({
  ImageCard: ({ data }: { data: (typeof mocks.rows.image)[number] }) => (
    <div data-testid="image-card">
      <img src={data.url} alt="" />
    </div>
  ),
}));

const { RenderRichText } = await import('~/components/RichTextEditor/RenderRichText');

const link = (type: 'model' | 'image', id: number) =>
  `<a href="/${type}s/${id}" data-entity="${type}" data-id="${id}">x</a>`;
const article = (...blocks: string[][]) =>
  generateJSON(
    blocks.map((links) => `<div data-type="civitaiEmbed">${links.join('')}</div>`).join(''),
    tiptapExtensions
  );

function renderArticle(content: Record<string, unknown>) {
  return renderWithProviders(
    <BrowsingLevelProvider>
      <div data-testid="host">
        <RenderRichText content={content} />
      </div>
    </BrowsingLevelProvider>
  );
}
const host = () => document.querySelector('[data-testid="host"]') as HTMLElement;
// Waits for every card to leave its skeleton, so a wrong state fails on what it shows rather
// than as a timeout waiting for the right one.
const settled = () =>
  vi.waitFor(() => {
    expect(host().querySelectorAll('[data-testid="civitai-embed-item"]').length).toBeGreaterThan(0);
    expect(host().querySelector('.mantine-Skeleton-root')).toBeNull();
  });

beforeEach(() => {
  Object.assign(mocks.state, {
    level: NsfwLevel.PG,
    showNsfw: true,
    canViewNsfw: true,
    user: { id: 9 },
    inView: true,
  });
  mocks.requests.length = 0;
  mocks.setBrowsingSettings.mockClear();
});

describe('Civitai cards in an article', () => {
  test('N cards across blocks make one request per type, at the viewer level', async () => {
    renderArticle(
      article([link('model', 1), link('model', 4), link('image', 7)], [link('model', 1)])
    );

    await expect.element(page.getByTestId('image-card')).toBeInTheDocument();
    await vi.waitFor(() => expect(page.getByTestId('model-card').elements()).toHaveLength(3));
    expect(mocks.requests).toEqual([
      { type: 'model', ids: [1, 4], browsingLevel: NsfwLevel.PG },
      { type: 'image', ids: [7], browsingLevel: NsfwLevel.PG },
    ]);
  });

  test('nothing is requested until a card is in view', async () => {
    mocks.state.inView = false;
    renderArticle(article([link('model', 1)]));

    await expect.element(page.getByTestId('civitai-embed-item')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mocks.requests).toEqual([]);
  });

  test('a mature model for a SFW viewer is a placeholder with neither cover nor name', async () => {
    renderArticle(article([link('model', 1), link('model', 2)]));

    await settled();
    expect(host().innerHTML).not.toContain('mature-cover.jpg');
    expect(host().textContent).not.toContain('Spicy model');
    expect(host().textContent).toContain('Safe model');
    expect(host().textContent).toContain('Mature content, hidden by your browsing settings');

    await userEvent.click(page.getByRole('button', { name: 'Show' }));
    await vi.waitFor(() => expect(host().innerHTML).toContain('mature-cover.jpg'));
  });

  test('Show turns mature content on site-wide when the viewer has it off', async () => {
    mocks.state.showNsfw = false;
    renderArticle(article([link('model', 2)]));

    await settled();
    expect(host().innerHTML).not.toContain('mature-cover.jpg');
    await userEvent.click(page.getByRole('button', { name: 'Show' }));
    expect(mocks.setBrowsingSettings).toHaveBeenCalledWith({ showNsfw: true });
    expect(host().innerHTML).not.toContain('mature-cover.jpg');
  });

  test('where mature content cannot be enabled, a mature model is simply not available', async () => {
    mocks.state.canViewNsfw = false;
    renderArticle(article([link('model', 2)]));

    await settled();
    expect(host().textContent).toContain('This model is not available');
    expect(mocks.requests.map((r) => r.ids)).toEqual([[2]]);
  });

  test('a deleted id renders the not-available tile with its plain link', async () => {
    renderArticle(article([link('model', 3)]));

    await settled();
    const tile = host().querySelector('[data-testid="civitai-embed-unavailable"]');
    expect(tile?.textContent).toContain('This model is not available');
    expect(tile?.querySelector('a')?.getAttribute('href')).toBe('/models/3');
  });
});

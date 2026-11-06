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

// Stand-in feed endpoint: a row comes back only when its rating intersects the requested level.
// The query hooks and browsing-level providers are real; settings, flags, the user, hidden
// preferences and the cards are stubbed.
const mocks = vi.hoisted(() => {
  const rows = {
    model: [
      { id: 1, name: 'Safe model', nsfwLevel: 1, images: [{ id: 101, url: 'safe-cover.jpg' }] },
      { id: 2, name: 'Spicy model', nsfwLevel: 16, images: [{ id: 102, url: 'mature-cover.jpg' }] },
      { id: 4, name: 'Other model', nsfwLevel: 1, images: [{ id: 104, url: 'other-cover.jpg' }] },
    ],
    image: [
      { id: 7, name: 'Safe image', nsfwLevel: 1, url: 'safe-image.jpg' },
      { id: 8, name: 'Spicy image', nsfwLevel: 16, url: 'mature-image.jpg' },
    ],
  };
  const state = {
    level: 1,
    showNsfw: true,
    canViewNsfw: true,
    user: { id: 9 } as { id: number } | null,
    inView: true,
    server: 'ok' as 'ok' | 'fail',
  };
  const requests: { type: 'model' | 'image'; ids: number[]; browsingLevel: number }[] = [];
  return { rows, state, requests };
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
        if (mocks.state.server === 'fail') throw new Error('feed down');
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
  trpc: makeTrpcProxy(
    {
      'model.getAll': { useInfiniteQuery: fakeFeed('model') },
      'image.getInfinite': { useInfiniteQuery: fakeFeed('image') },
    },
    // useQueryModels writes back to this cache when a request fails.
    { useUtils: () => ({ model: { getAll: { setInfiniteData: () => undefined } } }) }
  ),
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
    }),
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AddonsModule>()),
  useBrowsingSettingsAddons: () => ({ settings: {} }),
}));
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
// Stand-in cards that show media only when the browsing level covers it. The real cards blur via
// ImageGuard2's blurLevels instead, so these prove Show raises the level for one card, not that
// the real cover appears unblurred.
async function levelGate() {
  const { useBrowsingLevelDebounced } = await import(
    '~/components/BrowsingLevel/BrowsingLevelProvider'
  );
  return function useMedia(nsfwLevel: number, url: string) {
    const level = useBrowsingLevelDebounced();
    return Flags.intersects(nsfwLevel, level) ? <img src={url} alt="" /> : null;
  };
}
vi.mock('~/components/Cards/ModelCard', async () => {
  const useMedia = await levelGate();
  return {
    ModelCard: function ModelCard({ data }: { data: (typeof mocks.rows.model)[number] }) {
      return (
        <div data-testid="model-card">
          {useMedia(data.nsfwLevel, data.images[0].url)}
          {data.name}
        </div>
      );
    },
  };
});
vi.mock('~/components/Cards/ImageCard', async () => {
  const useMedia = await levelGate();
  return {
    ImageCard: function ImageCard({ data }: { data: (typeof mocks.rows.image)[number] }) {
      return <div data-testid="image-card">{useMedia(data.nsfwLevel, data.url)}</div>;
    },
  };
});

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
    server: 'ok',
  });
  mocks.requests.length = 0;
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

  test('moving to another article starts its cards fresh', async () => {
    const view = (content: Record<string, unknown>) => (
      <BrowsingLevelProvider>
        <div data-testid="host">
          <RenderRichText content={content} />
        </div>
      </BrowsingLevelProvider>
    );
    const screen = await renderWithProviders(view(article([link('model', 1)])));
    await expect.element(page.getByText('Safe model')).toBeInTheDocument();

    await screen.rerender(view(article([link('model', 4)])));
    await expect.element(page.getByText('Other model')).toBeInTheDocument();
    // Read as "missing" against the last article's results, id 4 would also go to the
    // mature follow-up.
    expect(mocks.requests.map((r) => r.ids)).toEqual([[1], [4]]);
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

  test('a mature image gets the same placeholder, and Show reveals only that card', async () => {
    renderArticle(article([link('image', 8), link('model', 2)]));

    await settled();
    expect(host().innerHTML).not.toContain('mature-image.jpg');
    expect(page.getByRole('button', { name: 'Show' }).elements()).toHaveLength(2);

    await userEvent.click(page.getByRole('button', { name: 'Show' }).first());
    await vi.waitFor(() => expect(host().innerHTML).toContain('mature-image.jpg'));
    expect(host().innerHTML).not.toContain('mature-cover.jpg');
  });

  // Nothing above the viewer's level may even be requested where they could not see it: the
  // response reaches the client whether or not it renders.
  test.each([
    ['the site does not allow mature content', { canViewNsfw: false }],
    ['the viewer is signed out', { user: null }],
    ['the viewer has mature content off', { showNsfw: false }],
  ])('when %s, a mature model is not available and nothing more is fetched', async (_, state) => {
    Object.assign(mocks.state, state);
    renderArticle(article([link('model', 2)]));

    await settled();
    expect(host().textContent).toContain('This model is not available');
    expect(host().textContent).not.toContain('Mature content');
    expect(mocks.requests.map((r) => r.ids)).toEqual([[2]]);
  });

  test('a failed request shows not-available, never the mature follow-up', async () => {
    mocks.state.server = 'fail';
    renderArticle(article([link('model', 1)]));

    await settled();
    expect(host().textContent).toContain('This model is not available');
    expect(mocks.requests).toHaveLength(1);
  });

  test('a deleted id renders the not-available tile with its plain link', async () => {
    renderArticle(article([link('model', 3)]));

    await settled();
    const tile = host().querySelector('[data-testid="civitai-embed-unavailable"]');
    expect(tile?.textContent).toContain('This model is not available');
    expect(tile?.querySelector('a')?.getAttribute('href')).toBe('/models/3');
  });
});

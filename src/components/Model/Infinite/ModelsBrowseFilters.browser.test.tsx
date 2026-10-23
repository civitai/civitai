import { useReducer } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { useRouter } from 'next/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as ModelCardContext from '~/components/Cards/ModelCardContext';
import type * as ModelUtils from '~/components/Model/model.utils';
import type * as UseEngagedModelMembership from '~/hooks/useEngagedModelMembership';
import type * as UseIsMobile from '~/hooks/useIsMobile';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import { ModelFeedFilters } from '~/components/Filters/FeedFilters/ModelFeedFilters';
import ModelsPage from '~/pages/models/index';
import { FiltersProvider } from '~/providers/FiltersProvider';
import { IsClientProvider } from '~/providers/IsClientProvider';

/**
 * The /models toolbar and feed, mounted together the way SubNav and the page mount them: two
 * siblings that share only the router and the persisted filter store. The router is the
 * scaffold's shared singleton, taught to feed `replace` back into `query` so a write reaches the
 * next render. Only the data layer is faked: `useQueryModels` records the filters the feed would
 * request.
 */

const mocks = vi.hoisted(() => ({ requested: [] as Record<string, unknown>[] }));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof UseIsMobile>()),
  useIsMobile: () => false,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => ({ imageGeneration: true, canViewNsfw: true }),
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProvider>()),
  useBrowsingSettings: (select: (state: { showNsfw: boolean }) => unknown) =>
    select({ showNsfw: false }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/Cards/ModelCardContext', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelCardContext>()),
  ModelCardContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useModelSaleBadges: () => ({}),
}));
vi.mock('~/hooks/useEngagedModelMembership', async (importOriginal) => ({
  ...(await importOriginal<typeof UseEngagedModelMembership>()),
  useEngagedModelsPrefetch: vi.fn(),
}));
vi.mock('~/components/AppLayout/Page', () => ({ Page: (component: unknown) => component }));
vi.mock('~/components/AppLayout/FeedLayout', () => ({ FeedLayout: () => null }));
vi.mock('~/components/CategoryTags/CategoryTags', () => ({ CategoryTags: () => null }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/components/Filters/FollowedFilter', () => ({ FollowedFilter: () => null }));
vi.mock('~/components/MasonryColumns/MasonryContainer', () => ({
  MasonryContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('~/components/Model/model.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelUtils>()),
  useQueryModels: (filters: Record<string, unknown>) => {
    mocks.requested.push(filters);
    return { models: [], fetchNextPage: vi.fn(), hasNextPage: false, isFetching: false };
  },
}));

// Not a real hook: the scaffold mocks `next/router` with `useRouter: () => router`, a singleton.
// eslint-disable-next-line react-hooks/rules-of-hooks
const router = useRouter() as unknown as {
  isReady: boolean;
  query: Record<string, unknown>;
  replace: ReturnType<typeof vi.fn>;
  pathname: string;
};

let rerenderToolbar: () => void = vi.fn();

function Toolbar() {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  rerenderToolbar = rerender;
  router.replace.mockImplementation(async (url: { query: Record<string, unknown> }) => {
    // A real navigation lands a tick later; in between the store already holds the new filters.
    await new Promise((resolve) => setTimeout(resolve, 0));
    router.query = url.query;
    rerender();
    return true;
  });
  return (
    <>
      <ModelFeedFilters />
      <ModelsPage />
    </>
  );
}

const mount = async () =>
  renderWithProviders(
    <IsClientProvider>
      <FiltersProvider>
        <Toolbar />
      </FiltersProvider>
    </IsClientProvider>
  );

/** The filters the feed most recently asked the server for. */
const lastRequest = () => mocks.requested.at(-1) ?? {};

beforeEach(() => {
  localStorage.clear();
  mocks.requested.length = 0;
  router.query = {};
  router.isReady = true;
  router.pathname = '/models';
  router.replace.mockReset();
});
afterEach(() => localStorage.clear());

describe('/models filters and the address bar', () => {
  test('a filter picked in the menu is written to the URL and applied to the feed', async () => {
    await mount();

    await userEvent.click(page.getByRole('button', { name: 'Filters' }));
    await userEvent.click(page.getByText('LoRA', { exact: true }));
    await userEvent.click(page.getByRole('button', { name: 'Apply filters' }));

    await expect.poll(() => router.query.types).toEqual(['LORA']);
    expect(lastRequest().types).toEqual(['LORA']);
  });

  test('a URL carrying filters loads filtered, and the URL is left as it was', async () => {
    // The stored filters differ on purpose: a bookmark must not inherit the visitor's own.
    localStorage.setItem(
      'model-filters',
      JSON.stringify({ types: ['Checkpoint'], checkpointType: 'Merge' })
    );
    router.query = { types: 'LORA', baseModels: ['SDXL 1.0'] };

    await mount();

    await expect.poll(() => lastRequest().baseModels).toEqual(['SDXL 1.0']);
    expect(lastRequest().types).toEqual(['LORA']);
    // Not even on the first render, before the store has caught up with the URL.
    expect(mocks.requested.map((request) => request.checkpointType)).toEqual(
      mocks.requested.map(() => undefined)
    );
    expect(router.query).toEqual({ types: 'LORA', baseModels: ['SDXL 1.0'] });
    // Nothing may have stripped the params, and the stored filters must not have leaked in.
    expect(router.replace).not.toHaveBeenCalled();
  });

  test('a bare /models still applies the stored filters', async () => {
    localStorage.setItem('model-filters', JSON.stringify({ types: ['Checkpoint'] }));

    await mount();

    await expect.poll(() => lastRequest().types).toEqual(['Checkpoint']);
  });

  test('stored filters are put in the address bar, so the page can be bookmarked as it stands', async () => {
    localStorage.setItem('model-filters', JSON.stringify({ types: ['Checkpoint'] }));

    await mount();

    await expect.poll(() => router.query.types).toEqual(['Checkpoint']);
  });

  test('the URL is not touched before the router has read it', async () => {
    // A statically served page has an empty `query` until hydration; writing the stored filters
    // over it would destroy the bookmark that is about to arrive.
    localStorage.setItem('model-filters', JSON.stringify({ types: ['Checkpoint'] }));
    router.isReady = false;
    await mount();
    // Effects have flushed once the render has been awaited.
    expect(router.replace).not.toHaveBeenCalled();

    router.isReady = true;
    router.query = { types: 'LORA' };
    rerenderToolbar();

    await expect.poll(() => lastRequest().types).toEqual(['LORA']);
    expect(router.replace).not.toHaveBeenCalled();
  });

  test('a published range picked in the menu is written to the URL and sent with the feed request', async () => {
    await mount();

    await userEvent.click(page.getByRole('button', { name: 'Filters' }));
    await userEvent.fill(page.getByLabelText('Published from'), '2024-12-01');
    await userEvent.fill(page.getByLabelText('Published to'), '2024-12-31');
    await userEvent.click(page.getByRole('button', { name: 'Apply filters' }));

    await expect.poll(() => router.query.publishedFrom).toBe('2024-12-01');
    expect(router.query.publishedTo).toBe('2024-12-31');
    expect(lastRequest().publishedFrom).toBe('2024-12-01');
    expect(lastRequest().publishedTo).toBe('2024-12-31');
  });

  test('a URL carrying a published range loads with it, in the menu and in the request', async () => {
    router.query = { publishedFrom: '2024-12-01', publishedTo: '2024-12-31' };
    await mount();

    await expect.poll(() => lastRequest().publishedFrom).toBe('2024-12-01');
    expect(lastRequest().publishedTo).toBe('2024-12-31');
    expect(router.replace).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole('button', { name: 'Filters' }));
    await expect.element(page.getByLabelText('Published from')).toHaveValue('2024-12-01');
    await expect.element(page.getByLabelText('Published to')).toHaveValue('2024-12-31');
  });

  test('a junk date in the URL is dropped without taking the other filters with it', async () => {
    router.query = { types: 'LORA', publishedFrom: '2024-02-31' };
    await mount();

    await expect.poll(() => lastRequest().types).toEqual(['LORA']);
    expect(lastRequest().publishedFrom).toBeUndefined();
  });

  test('picking one end fills the other with the same day', async () => {
    await mount();

    await userEvent.click(page.getByRole('button', { name: 'Filters' }));
    await userEvent.fill(page.getByLabelText('Published from'), '2024-12-05');

    await expect.element(page.getByLabelText('Published to')).toHaveValue('2024-12-05');
  });

  test('a published range the server would refuse is not sent', async () => {
    router.query = { types: 'LORA', publishedFrom: '2024-01-01', publishedTo: '2024-12-31' };
    await mount();

    await expect.poll(() => lastRequest().types).toEqual(['LORA']);
    expect(mocks.requested.every((request) => request.publishedFrom === undefined)).toBe(true);
  });

  test('Clear all filters drops the published range too', async () => {
    router.query = { publishedFrom: '2024-12-01', publishedTo: '2024-12-31' };
    await mount();
    await expect.poll(() => lastRequest().publishedFrom).toBe('2024-12-01');

    await userEvent.click(page.getByRole('button', { name: 'Filters' }));
    await userEvent.click(page.getByRole('button', { name: 'Clear all filters' }));

    await expect.poll(() => router.query.publishedFrom).toBeUndefined();
    await expect.poll(() => lastRequest().publishedFrom).toBeUndefined();
  });

  test('a sort picked in the toolbar is written to the URL', async () => {
    await mount();

    await userEvent.click(page.getByRole('button', { name: 'Hot' }));
    await userEvent.click(page.getByRole('menuitem', { name: 'Newest' }));

    await expect.poll(() => router.query.sort).toBe('Newest');
    expect(lastRequest().sort).toBe('Newest');
  });

  test('Clear all filters empties the URL and the stored filters alike', async () => {
    router.query = { types: 'LORA' };
    await mount();
    await expect.poll(() => lastRequest().types).toEqual(['LORA']);

    await userEvent.click(page.getByRole('button', { name: 'Filters' }));
    await userEvent.click(page.getByRole('button', { name: 'Clear all filters' }));

    await expect.poll(() => router.query.types).toBeUndefined();
    await expect.poll(() => lastRequest().types).toBeUndefined();
    // Otherwise the next bare visit would bring the cleared filter back.
    expect(JSON.parse(localStorage.getItem('model-filters') ?? '{}').types).toBeUndefined();
  });
});

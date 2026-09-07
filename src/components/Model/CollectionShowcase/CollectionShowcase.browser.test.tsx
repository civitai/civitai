import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import type * as ModelUtils from '~/components/Model/model.utils';
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../../test/component-setup';

const useModelShowcaseCollection = vi.fn();

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/components/Model/model.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelUtils>()),
  useModelShowcaseCollection: (args: { modelId: number }) => useModelShowcaseCollection(args),
}));

const { CollectionShowcase } = await import('./CollectionShowcase');

type Overrides = Partial<ReturnType<typeof useModelShowcaseCollection>>;

function showcaseState(overrides: Overrides = {}) {
  return {
    items: [],
    isLoading: false,
    isError: false,
    hasNextPage: true,
    fetchNextPage: vi.fn(),
    isFetching: false,
    isRefetching: false,
    pageCount: 1,
    refetch: vi.fn(),
    ...overrides,
  };
}

function item(id: number) {
  return {
    id,
    name: `Model ${id}`,
    type: 'Checkpoint',
    images: [
      { id, url: LOADABLE_IMAGE_DATA_URI, name: `image-${id}`, type: 'image', nsfwLevel: 1 },
    ],
    rank: undefined,
    version: { id, name: 'v1', baseModel: 'SDXL 1.0' },
  };
}

// `ShowcaseItem` renders `ElementInView`, which throws without this provider.
function render(modelId = 1) {
  return renderWithProviders(
    <IntersectionObserverProvider id="collection-showcase-test">
      <CollectionShowcase modelId={modelId} />
    </IntersectionObserverProvider>
  );
}

beforeEach(() => {
  useModelShowcaseCollection.mockReset();
});

describe('CollectionShowcase auto-loading', () => {
  test('below the page cap it keeps the in-view loader', async () => {
    useModelShowcaseCollection.mockReturnValue(showcaseState({ items: [item(1)], pageCount: 4 }));
    render();

    await expect.element(page.getByText('Model 1')).toBeInTheDocument();
    expect(page.getByRole('button', { name: 'Load more' }).elements()).toHaveLength(0);
  });

  test('at the page cap it stops auto-loading and offers a manual Load more', async () => {
    const fetchNextPage = vi.fn();
    useModelShowcaseCollection.mockReturnValue(
      showcaseState({ items: [item(1)], pageCount: 5, fetchNextPage })
    );
    render();

    const button = page.getByRole('button', { name: 'Load more' });
    await expect.element(button).toBeInTheDocument();
    await button.click();
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  test('a failed fetch stops auto-loading rather than retrying on a timer', async () => {
    useModelShowcaseCollection.mockReturnValue(
      showcaseState({ items: [item(1)], pageCount: 1, isError: true })
    );
    render();

    await expect.element(page.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });
});

describe('CollectionShowcase error state', () => {
  test('an errored first page reads as a failure, not as an empty collection', async () => {
    const refetch = vi.fn();
    useModelShowcaseCollection.mockReturnValue(
      showcaseState({ items: [], pageCount: 0, isError: true, refetch })
    );
    render();

    await expect.element(page.getByText(/Couldn.t load this collection/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('There are no items for this collection');

    await page.getByRole('button', { name: 'Try again' }).click();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('an empty collection still reads as empty', async () => {
    useModelShowcaseCollection.mockReturnValue(showcaseState({ items: [], hasNextPage: false }));
    render();

    await expect
      .element(page.getByText('There are no items for this collection'))
      .toBeInTheDocument();
  });
});

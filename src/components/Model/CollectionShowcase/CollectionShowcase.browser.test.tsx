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
    collection: { id: 7, itemCount: 2145 },
    isLoading: false,
    isError: false,
    hasNextPage: true,
    isRefetching: false,
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

describe('CollectionShowcase overflow', () => {
  test('a collection with more items hands off to the collection page', async () => {
    useModelShowcaseCollection.mockReturnValue(showcaseState({ items: [item(1)] }));
    render();

    const link = page.getByRole('link', { name: /View all 2,145 models/ });
    await expect.element(link).toBeInTheDocument();
    await expect.element(link).toHaveAttribute('href', '/collections/7');
  });

  test('a collection that fits shows no hand-off', async () => {
    useModelShowcaseCollection.mockReturnValue(
      showcaseState({ items: [item(1)], hasNextPage: false })
    );
    render();

    await expect.element(page.getByText('Model 1')).toBeInTheDocument();
    expect(page.getByRole('link', { name: /View all/ }).elements()).toHaveLength(0);
  });
});

describe('CollectionShowcase error state', () => {
  test('an errored first page reads as a failure, not as an empty collection', async () => {
    const refetch = vi.fn();
    useModelShowcaseCollection.mockReturnValue(
      showcaseState({ items: [], isError: true, refetch })
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

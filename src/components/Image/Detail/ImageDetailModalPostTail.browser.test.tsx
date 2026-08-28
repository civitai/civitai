import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// Type-only namespace imports for the `importOriginal` spreads below. Erased at compile
// time, so they do not participate in mock hoisting. `consistent-type-imports` rejects the
// `typeof import('...')` form, which is why these are named namespaces.
import type * as TrpcUtils from '~/utils/trpc';
import type * as CollectionUtils from '~/components/Collections/collection.utils';
import type * as HiddenPreferences from '~/components/HiddenPreferences/useApplyHiddenPreferences';

// =============================================================================
// The detail modal's half of the gallery lazy per-post load (`galleryLazyPostImages`).
//
// The card carousel lazy-loads a post's tail on APPROACH to the loaded edge. A click
// on the cover is index 0 — six slides short of that — so the modal it seeds gets the
// bare first slice, and before this it kept it forever: `ImageDetailProvider` only
// fetches when the seed is EMPTY. Everything past image 6 was unreachable from a
// gallery click (Freshdesk #69700, ClickUp 868kxypd0).
//
// Pinned here:
//   * a partial seed + `postTail` grows to the post's full set,
//   * the fetched tail is re-run through the REAL hidden-prefs filter using the
//     OWNER-curation lists carried on the descriptor — `getInfinite` re-derives
//     none of them, so dropping them would surface owner-hidden images,
//   * a seed with no `postTail` (every other feed) still never fetches.
// =============================================================================

const mocks = vi.hoisted(() => {
  const image = (id: number) => ({
    id,
    type: 'image',
    url: `img-${id}.jpeg`,
    name: null,
    poi: false,
    minor: false,
    metadata: { width: 1, height: 1 },
    reactions: [],
    stats: {},
    user: { id: 9 },
    userId: 9,
    nsfwLevel: 1,
    tagIds: [] as number[],
    prompt: '',
  });
  // Mirrors react-query gating: no data unless the query was actually enabled, so an
  // assertion on the resulting image count also proves the enable wiring.
  const getInfiniteUseQuery = vi.fn((_input: any, opts: any) => {
    if (!opts?.enabled) return { data: undefined, isError: false };
    return {
      data: { items: Array.from({ length: 14 }, (_, i) => image(i + 7)), nextCursor: undefined },
      isError: false,
    };
  });
  return { image, getInfiniteUseQuery };
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcUtils>()),
  trpc: {
    image: { getInfinite: { useQuery: mocks.getInfiniteUseQuery } },
    useUtils: () => ({}),
  },
}));

// The REAL `images` filter, not a pass-through — this is the branch that makes the
// owner-curation assertion below load-bearing.
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', async (importOriginal) => {
  const actual = await importOriginal<typeof HiddenPreferences>();
  return {
    ...actual,
    useApplyHiddenPreferences: ({
      type,
      data,
      hiddenImages = [],
      hiddenUsers = [],
      hiddenTags = [],
      browsingLevel,
    }: any) => {
      const { items } = actual.filterPreferences({
        type,
        data,
        hiddenPreferences: {
          hiddenUsers: new Map(hiddenUsers.map((id: number) => [id, true])),
          hiddenTags: new Map(hiddenTags.map((id: number) => [id, true])),
          hiddenModels: new Map(),
          hiddenModel3Ds: new Map(),
          hiddenImages: new Map(hiddenImages.map((id: number) => [id, true])),
          hiddenLoading: false,
          moderatedTags: [],
          systemHiddenTags: new Map(),
        } as any,
        browsingLevel,
        currentUser: null as any,
        canViewNsfw: true,
      });
      return { items };
    },
  };
});

vi.mock('~/components/BrowserRouter/BrowserRouterProvider', () => ({
  useBrowserRouter: () => ({ query: { imageId: 1 } }),
}));
vi.mock('~/components/Dialog/DialogProvider', () => ({ useDialogContext: () => ({}) }));
vi.mock('~/components/Dialog/Templates/PageModal', () => ({
  PageModal: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('~/components/Collections/collection.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionUtils>()),
  useCollection: () => ({ collection: undefined, isLoading: false }),
}));
vi.mock('~/components/Image/DetailV2/ImageDetail2', () => ({ ImageDetail2: () => null }));

// The seam under test: whatever reaches the provider is what the user can navigate.
vi.mock('~/components/Image/Detail/ImageDetailProvider', () => ({
  ImageDetailProvider: ({ images }: any) => (
    <div data-testid="provider-images" data-ids={(images ?? []).map((x: any) => x.id).join(',')} />
  ),
}));

// Import AFTER the mocks are registered.
import { renderWithProviders } from '../../../../test/component-setup';
import ImageDetailModal from '~/components/Image/Detail/ImageDetailModal';

const seed = (n: number) => Array.from({ length: n }, (_, i) => mocks.image(i + 1)) as any;
const providedIds = async () =>
  ((await page.getByTestId('provider-images').element()).getAttribute('data-ids') ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number);

const postTail = (overrides: Record<string, unknown> = {}) => ({
  postId: 100,
  imageCount: 20,
  filters: { modelId: 1, modelVersionId: 2 },
  browsingLevel: 1,
  hiddenImageIds: [] as number[],
  hiddenTags: [] as number[],
  hiddenUsers: [] as number[],
  ...overrides,
});

beforeEach(() => {
  mocks.getInfiniteUseQuery.mockClear();
});

describe('ImageDetailModal seeded from a lazy gallery card', () => {
  test('grows a partial seed to the whole post', async () => {
    renderWithProviders(<ImageDetailModal imageId={1} images={seed(6)} postTail={postTail()} />);

    // The seed alone is 6. Without the tail load this stays 6 forever — that is the bug.
    await vi.waitFor(async () => expect(await providedIds()).toHaveLength(20));
    expect(await providedIds()).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    const call = mocks.getInfiniteUseQuery.mock.calls.find(([, opts]) => opts?.enabled)!;
    expect(call[0]).toMatchObject({ postId: 100, browsingLevel: 1, modelVersionId: 2 });
  });

  test('applies the gallery-owner hidden lists to the tail (safety regression guard)', async () => {
    // id 7 is hidden by the MODEL OWNER's gallery settings. `image.getInfinite` does not
    // know about that list, and `useQueryImages` applies the VIEWER's prefs only — so it
    // is filtered here or not at all.
    renderWithProviders(
      <ImageDetailModal imageId={1} images={seed(6)} postTail={postTail({ hiddenImageIds: [7] })} />
    );

    await vi.waitFor(async () => expect(await providedIds()).toHaveLength(19));
    expect(await providedIds()).not.toContain(7);
  });

  test('a seed that already covers the post does not refetch', async () => {
    renderWithProviders(
      <ImageDetailModal imageId={1} images={seed(20)} postTail={postTail({ imageCount: 20 })} />
    );

    await vi.waitFor(async () => expect(await providedIds()).toHaveLength(20));
    expect(mocks.getInfiniteUseQuery.mock.calls.every(([, opts]) => opts?.enabled === false)).toBe(
      true
    );
  });

  test('a seed with no descriptor is passed through untouched (every other feed)', async () => {
    renderWithProviders(<ImageDetailModal imageId={1} images={seed(6)} />);

    await vi.waitFor(async () => expect(await providedIds()).toHaveLength(6));
    expect(mocks.getInfiniteUseQuery.mock.calls.every(([, opts]) => opts?.enabled === false)).toBe(
      true
    );
  });
});

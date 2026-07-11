import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// =============================================================================
// Gallery lazy per-post carousel (`galleryLazyPostImages`).
//
// Pins the WIRING the node tests can't reach:
//   * LAZY (server sent a 6-image slice + true `imageCount` 20): the carousel
//     advertises the true total, and when the active slide approaches the loaded
//     edge it fires `trpc.image.getInfinite({ postId })` (enabled flips true) and
//     appends the fetched tail — image 7 becomes navigable.
//   * STATIC (flag off / post within the slice): renders all images inline and
//     NEVER calls `getInfinite`.
//
// The pure decision/merge logic + the server slice/imageCount transform are
// covered by node unit tests (lazyPostImages.test.ts, images-as-posts-wire.test.ts).
// Here we boundary-stub the slide's heavy leaves and drive the REAL SimpleImageCarousel.
// =============================================================================

const mocks = vi.hoisted(() => {
  // A full-shaped image the slide can render (ids 7..20 = the lazily-fetched tail).
  const tailImage = (id: number) => ({
    id,
    type: 'image',
    url: `img-${id}.jpeg`,
    name: null,
    hasMeta: false,
    hasPositivePrompt: false,
    onSite: false,
    remixOfId: null,
    poi: false,
    metadata: { width: 1, height: 1 },
    thumbnailUrl: undefined,
    reactions: [],
    stats: {},
    user: { id: 9 },
  });
  return {
    // getInfinite returns the tail ONLY when enabled (mirrors react-query gating), so
    // asserting on the returned data also proves the enable-on-approach wiring.
    getInfiniteUseQuery: vi.fn((_input: any, opts: any) => ({
      data: opts?.enabled
        ? { items: Array.from({ length: 14 }, (_, i) => tailImage(i + 7)), nextCursor: undefined }
        : undefined,
    })),
  };
});

// --- tail fetch ---------------------------------------------------------------
vi.mock('~/utils/trpc', () => ({
  trpc: {
    image: { getInfinite: { useQuery: mocks.getInfiniteUseQuery } },
    useUtils: () => ({}),
  },
}));

// --- gallery context (filters + browsing level + hidden-pref inputs) ----------
vi.mock('~/components/Image/AsPosts/ImagesAsPostsInfiniteProvider', () => ({
  useImagesAsPostsInfiniteContext: () => ({
    filters: { modelId: 1, modelVersionId: 2 },
    browsingLevel: 1,
    hiddenImageIds: [],
    hiddenTags: [],
    hiddenUsers: [],
    source: { kind: 'model', model: { id: 1, user: { id: 9 } } },
    modelVersions: [],
  }),
  ImagesAsPostsInfiniteProvider: ({ children }: any) => <>{children}</>,
}));

// --- hidden-prefs = identity pass-through (its own filtering is unit-tested) ---
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: any) => ({ items: data ?? [] }),
}));

// --- slide leaves: render a marker carrying the image id ----------------------
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia2: ({ imageId }: any) => <div data-testid="slide" data-image-id={String(imageId)} />,
  EdgeMedia: () => null,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia.util', () => ({ getSkipValue: () => undefined }));
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  const ImageGuard2 = ({ children }: any) => <>{children(true)}</>;
  ImageGuard2.BlurToggle = () => null;
  return { ImageGuard2 };
});
vi.mock('~/components/ImageHash/ImageHash', () => ({ MediaHash: () => null }));
vi.mock('~/components/Reaction/Reactions', () => ({ Reactions: () => null }));
vi.mock('~/components/Image/Indicators/OnsiteIndicator', () => ({ OnsiteIndicator: () => null }));
vi.mock('~/components/Image/ContextMenu/ImagesAsPostsContextMenu', () => ({
  ImagesAsPostsContextMenu: () => null,
}));
vi.mock('~/components/Image/Meta/ImageMetaPopover', () => ({ ImageMetaPopover2: () => null }));
vi.mock('~/components/Cards/components/HoverActionButton', () => ({ default: () => null }));
vi.mock('~/components/Dialog/RoutedDialogLink', () => ({
  RoutedDialogLink: ({ children }: any) => <a>{children}</a>,
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ imageGeneration: false }),
}));
vi.mock('~/components/TrackView/track.utils', () => ({
  useTrackEvent: () => ({ trackAction: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('~/store/generation-graph.store', () => ({ generationGraphPanel: { open: vi.fn() } }));

// Import AFTER the mocks are registered.
import { renderWithProviders } from '../../../../test/component-setup';
import {
  LazyPostImagesCarousel,
  StaticPostImagesCarousel,
} from '~/components/Image/AsPosts/ImagesAsPostsCard';

const slice = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => ({
    id: from + i,
    type: 'image',
    url: `img-${from + i}.jpeg`,
    name: null,
    hasMeta: false,
    hasPositivePrompt: false,
    onSite: false,
    remixOfId: null,
    poi: false,
    metadata: { width: 1, height: 1 },
    thumbnailUrl: undefined,
    reactions: [],
    stats: {},
    user: { id: 9 },
  })) as any;

const activeSlideId = () => page.getByTestId('slide');
const clickNext = () => userEvent.click(page.getByRole('button').nth(1)); // [prev, next]

describe('LazyPostImagesCarousel', () => {
  test('advertises the true count, and lazy-loads + appends the tail on approach', async () => {
    mocks.getInfiniteUseQuery.mockClear();
    const data = { postId: 100, imageCount: 20, images: slice(6) } as any;
    renderWithProviders(<LazyPostImagesCarousel data={data} postId={100} />);

    // Cover (index 0) is the first slice image.
    await expect.element(activeSlideId()).toHaveAttribute('data-image-id', '1');

    // On mount the tail fetch is NOT enabled (index 0 is far from the loaded edge).
    expect(mocks.getInfiniteUseQuery).toHaveBeenCalled();
    expect(mocks.getInfiniteUseQuery.mock.calls.every(([, opts]) => opts?.enabled === false)).toBe(
      true
    );

    // Walk toward the end of the loaded slice (6). At index 4 (within threshold 2)
    // the fetch enables; keep going to index 6 — the FIRST appended tail image.
    for (let i = 0; i < 6; i++) await clickNext();

    // The tail fetch was enabled, scoped to this post + the gallery's browsing level.
    await vi.waitFor(() => {
      expect(mocks.getInfiniteUseQuery.mock.calls.some(([, opts]) => opts?.enabled === true)).toBe(
        true
      );
    });
    const enabledCall = mocks.getInfiniteUseQuery.mock.calls.find(([, opts]) => opts?.enabled)!;
    expect(enabledCall[0]).toMatchObject({ postId: 100, browsingLevel: 1, modelVersionId: 2 });

    // Image 7 (the first lazily-fetched image) is now navigable — NOT truncated.
    await expect.element(activeSlideId()).toHaveAttribute('data-image-id', '7');
  });
});

describe('StaticPostImagesCarousel', () => {
  test('renders all images inline and never calls getInfinite (flag OFF path)', async () => {
    mocks.getInfiniteUseQuery.mockClear();
    renderWithProviders(<StaticPostImagesCarousel images={slice(3)} postId={100} />);

    await expect.element(activeSlideId()).toHaveAttribute('data-image-id', '1');
    await clickNext();
    await expect.element(activeSlideId()).toHaveAttribute('data-image-id', '2');

    // No lazy tail fetch on the static path.
    expect(mocks.getInfiniteUseQuery).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// =============================================================================
// Gallery lazy per-post carousel (`galleryLazyPostImages`).
//
// Pins the WIRING the node tests can't reach:
//   * LAZY (server sent a 6-image slice + true `imageCount` 20): the carousel
//     advertises the true total, and when the active slide approaches the loaded
//     edge it fires `trpc.image.getInfinite({ postId })` (enabled flips true) and
//     appends the fetched tail — image 7 becomes navigable.
//   * CONTENT SAFETY: the fetched tail is re-run through the REAL
//     `useApplyHiddenPreferences({ type: 'images' })` filter (not an identity
//     stub), so a hidden image fed into the tail is genuinely dropped and never
//     renders — and the regression test fails if the component stops filtering.
//   * DEGRADATION: a persistent tail-fetch error collapses the count to what is
//     loaded (no phantom `<Loader/>` slots on an unreachable "1 of N").
//   * `postId == null` never broadens the tail query.
//   * STATIC (flag off / post within the slice): renders all images inline and
//     NEVER calls `getInfinite`.
//
// The pure decision/merge logic + the server slice/imageCount transform + the
// exhaustive per-dimension `images`-filter drop cases are covered by node unit
// tests (lazyPostImages.test.ts, images-as-posts-wire.test.ts,
// useApplyHiddenPreferences.test.ts). Here we boundary-stub the slide's heavy
// leaves and drive the REAL SimpleImageCarousel + REAL hidden-prefs filter.
// =============================================================================

const mocks = vi.hoisted(() => {
  // A full-shaped image the slide can render AND that the real `images` hidden-prefs
  // filter can evaluate (needs id/userId/nsfwLevel/tagIds/poi/minor/prompt). ids
  // 7..20 = the lazily-fetched tail.
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
    minor: false,
    metadata: { width: 1, height: 1 },
    thumbnailUrl: undefined,
    reactions: [],
    stats: {},
    user: { id: 9 },
    userId: 9,
    nsfwLevel: 1,
    tagIds: [] as number[],
    prompt: '',
  });
  // Per-test knobs (reset in beforeEach).
  const state = { error: false };
  const ctx = {
    browsingLevel: 1,
    hiddenImageIds: [] as number[],
    hiddenTags: [] as number[],
    hiddenUsers: [] as number[],
  };
  // getInfinite returns the tail ONLY when enabled (mirrors react-query gating), so
  // asserting on the returned data also proves the enable-on-approach wiring; on
  // `state.error` it returns the react-query error shape (isError true, no data).
  const getInfiniteUseQuery = vi.fn((_input: any, opts: any) => {
    if (!opts?.enabled) return { data: undefined, isError: false };
    if (state.error) return { data: undefined, isError: true };
    return {
      data: { items: Array.from({ length: 14 }, (_, i) => tailImage(i + 7)), nextCursor: undefined },
      isError: false,
    };
  });
  return { tailImage, state, ctx, getInfiniteUseQuery };
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
    browsingLevel: mocks.ctx.browsingLevel,
    hiddenImageIds: mocks.ctx.hiddenImageIds,
    hiddenTags: mocks.ctx.hiddenTags,
    hiddenUsers: mocks.ctx.hiddenUsers,
    source: { kind: 'model', model: { id: 1, user: { id: 9 } } },
    modelVersions: [],
  }),
  ImagesAsPostsInfiniteProvider: ({ children }: any) => <>{children}</>,
}));

// --- hidden-prefs = the REAL `images` filter (NOT identity) --------------------
// Route the tail through the actual pure `filterPreferences('images')` — the same
// content-safety branch prod uses — instead of a pass-through. This makes the
// regression guard below load-bearing: if the component stopped calling this hook
// (or passed the wrong type), a hidden image would render.
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('~/components/HiddenPreferences/useApplyHiddenPreferences')
  >();
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
// Indicators are the only aria-hidden buttons (controls are focusable); their count
// == the carousel's `effectiveTotal`.
const indicatorCount = () => document.querySelectorAll('button[aria-hidden]').length;
// Walk toward the end of the 6-image seed. At index 4 (threshold 2) the tail fetch
// latches; six clicks lands on carousel index 6 = the first appended tail image.
const walkToTail = async () => {
  for (let i = 0; i < 6; i++) await clickNext();
};

beforeEach(() => {
  mocks.getInfiniteUseQuery.mockClear();
  mocks.state.error = false;
  mocks.ctx.browsingLevel = 1;
  mocks.ctx.hiddenImageIds = [];
  mocks.ctx.hiddenTags = [];
  mocks.ctx.hiddenUsers = [];
});

describe('LazyPostImagesCarousel', () => {
  test('advertises the true count, and lazy-loads + appends the tail on approach', async () => {
    const data = { postId: 100, imageCount: 20, images: slice(6) } as any;
    renderWithProviders(<LazyPostImagesCarousel data={data} postId={100} />);

    // Cover (index 0) is the first slice image.
    await expect.element(activeSlideId()).toHaveAttribute('data-image-id', '1');

    // On mount the tail fetch is NOT enabled (index 0 is far from the loaded edge).
    expect(mocks.getInfiniteUseQuery).toHaveBeenCalled();
    expect(mocks.getInfiniteUseQuery.mock.calls.every(([, opts]) => opts?.enabled === false)).toBe(
      true
    );

    await walkToTail();

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

  test('re-applies hidden preferences to the tail — a hidden image never renders (safety regression guard)', async () => {
    // The first tail image (id 7) is user-hidden. The feed forwarded it via context.
    mocks.ctx.hiddenImageIds = [7];
    const data = { postId: 100, imageCount: 20, images: slice(6) } as any;
    renderWithProviders(<LazyPostImagesCarousel data={data} postId={100} />);

    await expect.element(activeSlideId()).toHaveAttribute('data-image-id', '1');
    await walkToTail();

    // With id 7 filtered out, the count self-corrects 20 → 19 and the image at
    // carousel index 6 is id 8 (id 7 is gone). If the component stopped filtering,
    // index 6 would be id 7 and the count would stay 20 — so this fails loudly.
    await expect.element(activeSlideId()).toHaveAttribute('data-image-id', '8');
    await vi.waitFor(() => expect(indicatorCount()).toBe(19));
  });

  test('count self-corrects on a hidden drop — the last tail image stays reachable (no dead-end)', async () => {
    mocks.ctx.hiddenImageIds = [7];
    const data = { postId: 100, imageCount: 20, images: slice(6) } as any;
    renderWithProviders(<LazyPostImagesCarousel data={data} postId={100} />);

    await expect.element(activeSlideId()).toHaveAttribute('data-image-id', '1');
    await walkToTail();
    await vi.waitFor(() => expect(indicatorCount()).toBe(19));

    // Jump to the last slide (index 18 of 19) — it renders a real image (id 20),
    // not a stranded <Loader/>.
    await userEvent.click(page.getByRole('button').nth(1)); // step once more onto index 7
    for (let i = 0; i < 11; i++) await clickNext(); // …to the final index (18)
    await expect.element(activeSlideId()).toHaveAttribute('data-image-id', '20');
  });

  test('degrades gracefully on a tail-fetch error — count collapses to loaded, no phantom loaders', async () => {
    mocks.state.error = true;
    const data = { postId: 100, imageCount: 20, images: slice(6) } as any;
    renderWithProviders(<LazyPostImagesCarousel data={data} postId={100} />);

    await expect.element(activeSlideId()).toHaveAttribute('data-image-id', '1');
    // Approach the edge to latch the fetch (index 4, threshold 2) but STAY inside the
    // seed's 6 images so the active slide is still valid after the count collapses.
    for (let i = 0; i < 5; i++) await clickNext(); // → index 5 (last seed image)

    // The tail query WAS enabled (so the error is real, not a disabled query)…
    await vi.waitFor(() =>
      expect(mocks.getInfiniteUseQuery.mock.calls.some(([, opts]) => opts?.enabled === true)).toBe(
        true
      )
    );
    // …and on error the total collapses from 20 to the 6 loaded seed images — no 14
    // phantom slots stuck on an unreachable <Loader/>. Without the fix this is 20.
    await vi.waitFor(() => expect(indicatorCount()).toBe(6));
    // Every reachable slide is a real image (never a loader) — walk the whole set.
    for (let i = 0; i < 6; i++) {
      await expect.element(activeSlideId()).toBeInTheDocument();
      await clickNext();
    }
  });

  test('never enables the tail query when postId is null (no broadening to the general feed)', async () => {
    const data = { postId: null, imageCount: 20, images: slice(6) } as any;
    renderWithProviders(<LazyPostImagesCarousel data={data} postId={null as any} />);

    await expect.element(activeSlideId()).toHaveAttribute('data-image-id', '1');
    await walkToTail(); // would normally latch fetchTail true

    // fetchTail may be latched, but `postId != null` keeps every call disabled.
    expect(mocks.getInfiniteUseQuery).toHaveBeenCalled();
    expect(mocks.getInfiniteUseQuery.mock.calls.every(([, opts]) => opts?.enabled === false)).toBe(
      true
    );
  });
});

describe('StaticPostImagesCarousel', () => {
  test('renders all images inline and never calls getInfinite (flag OFF path)', async () => {
    renderWithProviders(<StaticPostImagesCarousel images={slice(3)} postId={100} />);

    await expect.element(activeSlideId()).toHaveAttribute('data-image-id', '1');
    await clickNext();
    await expect.element(activeSlideId()).toHaveAttribute('data-image-id', '2');

    // No lazy tail fetch on the static path.
    expect(mocks.getInfiniteUseQuery).not.toHaveBeenCalled();
  });
});

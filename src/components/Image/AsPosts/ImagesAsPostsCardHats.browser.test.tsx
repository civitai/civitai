import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcUtils from '~/utils/trpc';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

// =============================================================================
// Event hats on a gallery post card (a multi-image post in the model gallery).
//
// A hat belongs to one image, so the card wears it only while that image is the slide
// showing: never in the corner while another slide is up, and still there when the hatted
// image is past the first slice and only arrives with the lazily-fetched tail.
// Drives the REAL card, carousel and hat overlay; stubs only the slide's heavy leaves.
// =============================================================================

const HAT_URL =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M5 0L10 10H0z" fill="#e64980"/></svg>'
  );

const mocks = vi.hoisted(() => {
  const image = (id: number, hatted = false) => ({
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
    eventDecoration: hatted
      ? {
          id: 1,
          name: 'Party hat',
          type: 'ProfileDecoration',
          source: 'Event',
          data: { type: 'hat', event: 'birthday2026', url: 'HAT_URL' },
        }
      : null,
  });
  const state = { tail: [] as ReturnType<typeof image>[], swipeGalleryCards: false };
  const getInfiniteUseQuery = vi.fn((_input: any, opts: any) =>
    opts?.enabled
      ? { data: { items: state.tail, nextCursor: undefined }, isError: false }
      : { data: undefined, isError: false }
  );
  return { image, state, getInfiniteUseQuery };
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcUtils>()),
  trpc: makeTrpcProxy({ 'image.getInfinite': { useQuery: mocks.getInfiniteUseQuery } }),
}));
vi.mock('~/components/Image/AsPosts/ImagesAsPostsInfiniteProvider', () => ({
  useImagesAsPostsInfiniteContext: () => ({
    filters: { modelId: 1, modelVersionId: 2 },
    browsingLevel: 1,
    hiddenImageIds: [],
    hiddenTags: [],
    hiddenUsers: [],
    swipeGalleryCards: mocks.state.swipeGalleryCards,
    source: { kind: 'model', model: { id: 1, user: { id: 9 } } },
    modelVersions: [],
  }),
  ImagesAsPostsInfiniteProvider: ({ children }: any) => <>{children}</>,
}));
vi.mock('~/components/Image/AsPosts/gallery.utils', () => ({
  useGallerySettings: () => ({ gallerySettings: undefined }),
}));
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: any) => ({ items: data }),
}));
// The hat's popover needs the event's live data; name the image it is worn on instead.
vi.mock('~/components/Cosmetics/EventDecoration/WornHatPopover', () => ({
  WornHatPopover: ({ wornOn, children }: any) => (
    <span data-worn-on={String(wornOn.entityId)}>{children}</span>
  ),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia2: ({ imageId }: any) => (
    <div
      data-testid="slide"
      data-image-id={String(imageId)}
      className="flex size-full items-center justify-center bg-slate-600 text-4xl text-white"
    >
      {imageId}
    </div>
  ),
  // The hat's own art.
  EdgeMedia: ({ src, className }: any) => (
    <img src={src === 'HAT_URL' ? HAT_URL : src} className={className} alt="" />
  ),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia.util', () => ({ getSkipValue: () => undefined }));
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  const ImageGuard2 = ({ children }: any) => <>{children(true)}</>;
  ImageGuard2.BlurToggle = function BlurToggle() {
    return null;
  };
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
vi.mock('~/components/RemixGallery/RemixedCardFlyout', () => ({ RemixedCardFlyout: () => null }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => <div>poster</div> }));
vi.mock('~/components/TrackView/ImpressionSentinel', () => ({ ImpressionSentinel: () => null }));
vi.mock('~/components/TrackView/useTrackImpression', () => ({
  useTrackImpression: () => () => undefined,
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({ children }: any) => <a>{children}</a>,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ imageGeneration: false, galleryLazyPostImages: true }),
}));
vi.mock('~/components/TrackView/track.utils', () => ({
  useTrackEvent: () => ({ trackAction: vi.fn().mockResolvedValue(undefined) }),
}));

// The app's stylesheet: the swipe carousel only clips its neighbours with its utility classes.
import '~/styles/globals.css';
import { renderWithProviders } from '../../../../test/component-setup';
import { ImagesAsPostsCard } from '~/components/Image/AsPosts/ImagesAsPostsCard';
import { HAT_SETTLE_FALLBACK_MS } from '~/components/EmblaCarousel/EmblaCarousel';

const images = (n: number, hattedId?: number, from = 1) =>
  Array.from({ length: n }, (_, i) => mocks.image(from + i, from + i === hattedId)) as any[];

const post = (seed: any[], imageCount?: number) =>
  ({
    postId: 100,
    publishedAt: new Date(),
    user: { id: 9, username: 'poster' },
    images: seed,
    imageCount,
  } as any);

const shownId = () =>
  document.querySelector('[data-testid="slide"]')?.getAttribute('data-image-id');
// The image the hat is worn by, prefixed 'outside:' when it is not in the card's hat layer.
const hatOn = () => {
  const hats = document.querySelectorAll('button[data-event-decoration="hat"]');
  if (hats.length > 1) return `${hats.length} hats`;
  const hat = hats[0];
  if (!hat) return null;
  const id = hat.closest('[data-worn-on]')?.getAttribute('data-worn-on') ?? '?';
  return hat.closest('[data-testid="hat-layer"]') ? id : `outside:${id}`;
};
const hatsDrawn = () =>
  Array.from(document.querySelectorAll('button[data-event-decoration="hat"]')).map((hat) =>
    hat.closest('[data-worn-on]')?.getAttribute('data-worn-on')
  );
const clickNext = () => userEvent.click(document.querySelector<HTMLElement>('button.right-3')!);

function renderCard(data: any) {
  return renderWithProviders(
    <div style={{ width: 320, padding: 40 }} data-testid="page">
      <ImagesAsPostsCard data={data} width={320} height={440} />
    </div>
  );
}

beforeEach(() => {
  mocks.getInfiniteUseQuery.mockClear();
  mocks.state.tail = [];
  mocks.state.swipeGalleryCards = false;
});

describe('a gallery post card wears a hat only on the slide that wears it', () => {
  test("single-image post: the hat hangs past the media's corner, not clipped inside it", async () => {
    renderCard(post(images(1, 1)));
    await vi.waitFor(() => expect(shownId()).toBe('1'));
    await vi.waitFor(() => expect(hatOn()).toBe('1'));
    const media = document.querySelector('.flex-1.overflow-hidden')!.getBoundingClientRect();
    const hat = document
      .querySelector('button[data-event-decoration="hat"]')!
      .getBoundingClientRect();
    expect(media.top - hat.top).toBeGreaterThanOrEqual(24);
    expect(media.left - hat.left).toBeGreaterThanOrEqual(12);
  });

  test('no hat anywhere when no image wears one', async () => {
    renderCard(post(images(3)));
    await vi.waitFor(() => expect(shownId()).toBe('1'));
    for (let i = 0; i < 3; i++) {
      expect(hatOn()).toBeNull();
      await clickNext();
    }
  });

  test('hat on the cover: shown on the cover, gone when another slide shows', async () => {
    renderCard(post(images(3, 1)));
    await vi.waitFor(() => expect(shownId()).toBe('1'));
    expect(hatOn()).toBe('1');

    await clickNext();
    await vi.waitFor(() => expect(shownId()).toBe('2'));
    expect(hatOn()).toBeNull();
  });

  test('hat on a later slide inside the slice: only while that slide shows', async () => {
    renderCard(post(images(3, 2)));
    await vi.waitFor(() => expect(shownId()).toBe('1'));
    expect(hatOn()).toBeNull();

    await clickNext();
    await vi.waitFor(() => expect(shownId()).toBe('2'));
    expect(hatOn()).toBe('2');
  });

  test('hat on an image past the first slice (lazy tail): shown when that slide shows', async () => {
    // 13 images, the server sends 6, the hatted one is the 7th (id 7).
    mocks.state.tail = images(13, 7);
    renderCard(post(images(6), 13));
    await vi.waitFor(() => expect(shownId()).toBe('1'));

    for (let i = 0; i < 6; i++) await clickNext();
    await vi.waitFor(() => expect(shownId()).toBe('7'));
    expect(hatOn()).toBe('7');
  });

  test("swipe carousel: only the shown slide's hat is drawn", async () => {
    mocks.state.swipeGalleryCards = true;
    renderCard(post(images(3, 2)));
    await vi.waitFor(() => expect(document.querySelectorAll('.transform-3d').length).toBe(3));
    await vi.waitFor(() => expect(hatsDrawn()).toEqual([]));

    await clickNext();
    await vi.waitFor(() => expect(hatsDrawn()).toEqual(['2']), {
      timeout: HAT_SETTLE_FALLBACK_MS + 1000,
    });

    await clickNext();
    // Settled on the third slide: `[]` mid-scroll would also hold.
    await vi.waitFor(
      () => {
        const slides = [...document.querySelectorAll('.transform-3d')];
        const media = document.querySelector('.flex-1.overflow-hidden')!.getBoundingClientRect();
        expect(Math.abs(slides[2].getBoundingClientRect().left - media.left)).toBeLessThan(2);
      },
      { timeout: HAT_SETTLE_FALLBACK_MS + 1000 }
    );
    expect(hatsDrawn()).toEqual([]);
  });
});

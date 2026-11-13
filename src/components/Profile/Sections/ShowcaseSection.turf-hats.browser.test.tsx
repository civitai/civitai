import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as IntersectionObserverModule from '~/components/IntersectionObserver/IntersectionObserverProvider';
import type * as TurfSummaryModule from '~/components/HatTurf/TurfSummaryProvider';
import type * as EdgeMediaModule from '~/components/EdgeMedia/EdgeMedia';

// Feedback: hats placed on an image did not show on it in a profile's Showcase.

const PICTURE =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#456"/></svg>'
  );

const h = vi.hoisted(() => ({ requested: [] as number[][] }));

// One showcased image and one showcased model, whose cover is another image.
const covers = [
  { id: 101, entityType: 'Image', entityId: 101 },
  { id: 202, entityType: 'Model', entityId: 9 },
].map((cover) => ({
  ...cover,
  url: PICTURE,
  type: 'image',
  name: `cover-${cover.id}`,
  metadata: null,
  nsfwLevel: 1,
  width: 400,
  height: 500,
  tags: [],
  postId: 1,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'image.getEntitiesCoverImage': {
        useQuery: () => ({ data: covers, isLoading: false, isRefetching: false }),
      },
    }),
  };
});
vi.mock(
  '~/components/IntersectionObserver/IntersectionObserverProvider',
  async (importOriginal) => ({
    ...(await importOriginal<typeof IntersectionObserverModule>()),
    useInViewDynamic: () => [() => undefined, true],
  })
);
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data: unknown[] }) => ({ items: data }),
}));
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  function ImageGuard2({ children }: { children: (safe: boolean) => React.ReactNode }) {
    return <>{children(true)}</>;
  }
  ImageGuard2.BlurToggle = function BlurToggle() {
    return null;
  };
  return { ImageGuard2 };
});
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', () => ({
  ImageContextMenu: () => null,
}));
vi.mock('~/components/TrackView/useTrackImpression', () => ({
  useTrackImpression: () => undefined,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof EdgeMediaModule>()),
  EdgeMedia2: ({ className }: { className?: string }) => (
    <img src={PICTURE} className={className} style={{ width: '100%', height: '100%' }} alt="" />
  ),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalTopic: () => undefined,
  useSignalConnection: () => undefined,
}));
// The summaries a joined viewer's feed would hold: a hat on each cover, so a card that should not
// draw one has one to draw. Records which images the section asks about.
vi.mock('~/components/HatTurf/TurfSummaryProvider', async (importOriginal) => {
  const real = await importOriginal<typeof TurfSummaryModule>();
  const hat = (imageId: number) => ({
    id: imageId,
    userId: 2,
    team: 'blue',
    cosmeticId: 11,
    data: { x: 0.5, y: 0.5, scale: 0.2, rotation: 0, flip: false },
  });
  return {
    ...real,
    TurfSummaryProvider: ({
      imageIds,
      children,
    }: {
      imageIds: number[];
      children: React.ReactNode;
    }) => {
      h.requested.push(imageIds);
      return (
        <real.TurfSummaryContext.Provider
          value={{
            event: 'birthday2026',
            arm: 'control',
            team: 'blue',
            images: {},
            open: {},
            stickers: { 101: [hat(101)], 202: [hat(202)] },
            joined: true,
            watch: () => () => undefined,
          }}
        >
          {children}
        </real.TurfSummaryContext.Provider>
      );
    },
  };
});

import { cleanup } from 'vitest-browser-react';
import { renderWithProviders } from '../../../../test/component-setup';
import { ShowcaseSection } from '~/components/Profile/Sections/ShowcaseSection';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';

afterEach(() => {
  cleanup();
  h.requested = [];
});

describe('Hat Turf hats in a profile Showcase', () => {
  test('a showcased image draws its hats; a model card, whose cover is an image, does not', async () => {
    useHatTurfStore.setState({ showHats: true });
    const user = {
      id: 5,
      profile: {
        showcaseItems: [
          { entityType: 'Image', entityId: 101 },
          { entityType: 'Model', entityId: 9 },
        ],
      },
    } as unknown as Parameters<typeof ShowcaseSection>[0]['user'];
    await renderWithProviders(
      <div style={{ width: 900 }}>
        <ShowcaseSection user={user} />
      </div>
    );
    const hats = () => [...document.body.querySelectorAll('[data-testid="hat-turf-hat"]')];
    await vi.waitFor(() => expect(hats()).toHaveLength(1));
    expect(h.requested.at(-1)).toEqual([101]);
    // The one hat is on the image's card: its link opens that image.
    const card = hats()[0].closest('a');
    expect(card?.getAttribute('href') ?? '').toContain('101');
  });
});

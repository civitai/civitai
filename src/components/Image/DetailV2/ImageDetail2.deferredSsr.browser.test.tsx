import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { Root } from 'react-dom/client';
import { hydrateRoot } from 'react-dom/client';
import { DEFAULT_THEME, MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import type * as ImageDetailProviderModule from '~/components/Image/Detail/ImageDetailProvider';
import type * as HatTurfDetailControlsModule from '~/components/HatTurf/detail/HatTurfDetailControls';
import type * as HatTurfDetailProviderModule from '~/components/HatTurf/detail/HatTurfDetailProvider';

// Loads the `next/router` stub (and the rest of the component-test environment).
import '../../../../test/component-setup';

/**
 * `/images/[imageId]` under `ssrSignedInSkipPrefetchImages`'s `skip` arm (`deferredSsr`), across a
 * real `renderToString` → `hydrateRoot` of the real `ImageDetail2`, with the mock set of
 * `ImageDetail2.clientOnlySections.browser.test.tsx` (its children are probes; `Gated` records what
 * the page gates on and hands its `<head>`).
 *
 * - The server HTML is a loader in place of the content, inside the same `<Gated>` (rating and
 *   `<head>`) as the full page; the hydrating render reproduces it, and the content renders once
 *   the client has mounted.
 * - An image the viewer gets none of, or a hidden POI image, is NotFound on the server, never the
 *   shell. (Deleted, hidden and blocked-creator images are decided above, in `ImageDetailProvider`,
 *   from the `image.get` and hidden preferences the `skip` arm still prefetches:
 *   `src/tests/pages/images/image-page-skip-prefetch.test.ts`.)
 */

type TestImage = {
  id: number;
  url: string;
  nsfwLevel: number;
  poi: boolean;
  user: { id: number; username: string };
  [key: string]: unknown;
};

const m = vi.hoisted(() => ({
  items: [] as { type: 'image'; key: string; image: TestImage }[],
  contestItems: [] as { collection: { metadata: { forcedBrowsingLevel?: number } } }[],
  gated: [] as Record<string, unknown>[],
}));

const image: TestImage = {
  id: 1,
  url: 'img-1',
  nsfwLevel: 1,
  width: 700,
  height: 900,
  type: 'image',
  name: null,
  postId: 5,
  poi: false,
  minor: false,
  hasMeta: false,
  tagIds: [],
  publishedAt: new Date('2026-11-01'),
  user: { id: 2, username: 'someone' },
  stats: {},
};
const itemOf = (img: TestImage) => ({ type: 'image' as const, key: `img:${img.id}`, image: img });

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy(),
}));
vi.mock('~/components/Image/Detail/ImageDetailProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageDetailProviderModule>()),
  useImageDetailContext: () => ({
    images: m.items.map((item) => item.image),
    items: m.items,
    index: 0,
    active: false,
    close: () => undefined,
    toggleInfo: () => undefined,
    shareUrl: '/images/1',
    navigate: () => undefined,
    loadMore: () => undefined,
    hasMore: false,
    collection: undefined,
    hideReactions: false,
  }),
}));
vi.mock('~/components/HatTurf/detail/HatTurfDetailProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof HatTurfDetailProviderModule>()),
  takesHats: () => false,
  HatTurfDetailProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  HatTurfDetailReset: () => null,
}));
vi.mock('~/components/HatTurf/detail/HatTurfDetailControls', async (importOriginal) => ({
  ...(await importOriginal<typeof HatTurfDetailControlsModule>()),
  HatTurfDetailControls: () => null,
  HatTurfDetailBadge: () => null,
}));
vi.mock('~/hooks/useCurrentUser', async (o) => ({
  ...(await o<object>()),
  useCurrentUser: () => null,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (o) => ({
  ...(await o<object>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/providers/BrowserSettingsProvider', async (o) => ({
  ...(await o<object>()),
  useBrowsingSettings: <T,>(select: (state: Record<string, unknown>) => T) =>
    select({ browsingLevel: 1, blurNsfw: true, showNsfw: false, autoplayGifs: false }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (o) => ({
  ...(await o<object>()),
  BrowsingLevelProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', async (o) => ({
  ...(await o<object>()),
  BrowsingSettingsAddonsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
const stub = vi.hoisted(() => () => null);
vi.mock('~/components/Storyline/StorylineDetail', async (o) => ({
  ...(await o<object>()),
  StorylineStageOverlay: stub,
  StorylineToolbarChip: stub,
  StorylineChapterDescription: stub,
}));
vi.mock('~/components/Storyline/StorylineChapterRail', async (o) => ({
  ...(await o<object>()),
  StorylineChapterRail: stub,
}));
vi.mock('~/components/Ads/AdhesiveAd', async (o) => ({ ...(await o<object>()), AdhesiveAd: stub }));
vi.mock('~/components/Ads/AdUnit', async (o) => ({
  ...(await o<object>()),
  AdUnitSide_2: () => <div data-testid="ad-side" />,
  AdUnitSide_3: stub,
}));
vi.mock('~/components/Ads/AdUnitOutstream', async (o) => ({
  ...(await o<object>()),
  AdUnitOutstream: stub,
}));
vi.mock('~/components/Buzz/InteractiveTipBuzzButton', async (o) => ({
  ...(await o<object>()),
  InteractiveTipBuzzButton: stub,
}));
vi.mock('~/components/Carousel/CarouselIndicators', async (o) => ({
  ...(await o<object>()),
  CarouselIndicators: stub,
}));
vi.mock('~/components/Image/DetailV2/OwnerBlockedImageNotice', async (o) => ({
  ...(await o<object>()),
  OwnerBlockedImageNotice: stub,
}));
vi.mock('~/components/EntityCollaborator/EntityCollaboratorList', async (o) => ({
  ...(await o<object>()),
  EntityCollaboratorList: stub,
}));
vi.mock('~/components/Model3D/Posting/PostingToModel3DCard', async (o) => ({
  ...(await o<object>()),
  PostingToModel3DCard: stub,
}));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', async (o) => ({
  ...(await o<object>()),
  ImageContextMenu: stub,
}));
vi.mock('~/components/Image/DetailV2/ImagePublishedWithApp', async (o) => ({
  ...(await o<object>()),
  ImagePublishedWithApp: stub,
}));
vi.mock('~/components/Image/DownloadImage', async (o) => ({
  ...(await o<object>()),
  DownloadImage: stub,
}));
vi.mock('~/components/Metrics', async (o) => ({ ...(await o<object>()), Metrics: stub }));
vi.mock('~/components/Reaction/ImageReactorsPreview', async (o) => ({
  ...(await o<object>()),
  ImageReactorsPreview: stub,
}));
vi.mock('~/components/ShareButton/ShareButton', async (o) => ({
  ...(await o<object>()),
  ShareButton: stub,
}));
vi.mock('~/components/Image/Remix/RemixMenu', async (o) => ({
  ...(await o<object>()),
  RemixMenu: stub,
}));
vi.mock('~/components/LoginRedirect/LoginRedirect', async (o) => ({
  ...(await o<object>()),
  LoginRedirect: stub,
}));
// What the page gates on and hands its `<head>` is what the head and gating cases read.
vi.mock('~/components/Gated/Gated', () => ({
  Gated: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => {
    m.gated.push(props);
    return <>{children}</>;
  },
}));
vi.mock('~/components/PageLoader/PageLoader', () => ({
  PageLoader: () => <div data-testid="page-loader" />,
}));
vi.mock('~/components/AppLayout/NotFound', () => ({
  NotFound: () => <div data-testid="not-found" />,
}));
vi.mock('~/components/ImageGuard/ImageGuard2', async (o) => {
  function ImageGuard2({ children }: { children: (safe: boolean) => ReactNode }) {
    return <>{children(true)}</>;
  }
  ImageGuard2.BlurToggle = function BlurToggle() {
    return null;
  };
  return { ...(await o<object>()), ImageGuard2 };
});
vi.mock('~/components/Image/DetailV2/ImageDetailCarousel', () => ({
  ImageDetailCarousel: () => <div data-testid="carousel" />,
}));
vi.mock('~/components/Reaction/Reactions', async (o) => ({
  ...(await o<object>()),
  Reactions: stub,
}));
vi.mock('~/components/TrackView/TrackView', () => ({ TrackView: () => null }));
vi.mock('~/components/Sticker/StickerPlacementBar', () => ({ StickerPlacementBar: () => null }));
vi.mock('~/components/CreatorCard/CreatorCard', async (o) => ({
  ...(await o<object>()),
  SmartCreatorCard: () => <div data-testid="creator-card" />,
}));
// The tail, as probes.
vi.mock('~/components/Image/DetailV2/ImageDetailPostCard', async (o) => ({
  ...(await o<object>()),
  ImageDetailPostCard: () => <div data-testid="post-card" />,
}));
vi.mock('~/components/VotableTags/VotableTags', async (o) => ({
  ...(await o<object>()),
  VotableTags: () => <div data-testid="votable-tags" />,
}));
vi.mock('~/components/Image/DetailV2/ImageProcess', async (o) => ({
  ...(await o<object>()),
  ImageProcess: () => <div data-testid="image-process" />,
}));
vi.mock('~/components/Image/DetailV2/ImageRemixOfDetails', async (o) => ({
  ...(await o<object>()),
  ImageRemixOfDetails: () => <div data-testid="image-remix-of" />,
}));
vi.mock('~/components/RemixGallery/RemixGalleryCard', async (o) => ({
  ...(await o<object>()),
  RemixGalleryCard: () => <div data-testid="remix-gallery" />,
}));
vi.mock('~/components/Image/DetailV2/ImageGenerationData', async (o) => ({
  ...(await o<object>()),
  ImageGenerationData: () => <div data-testid="generation-data" />,
}));
vi.mock('~/components/Image/Detail/ImageDetailComments', () => ({
  ImageDetailComments: () => <div data-testid="image-comments" />,
}));
vi.mock('~/components/Image/DetailV2/ImageContestCollectionDetails', async (o) => ({
  ...(await o<object>()),
  useImageContestCollectionDetails: () => ({ collectionItems: [], post: undefined }),
  ImageContestCollectionDetails: () => <div data-testid="contest-details" />,
}));
vi.mock('~/components/Image/DetailV2/ImageExternalMeta', async (o) => ({
  ...(await o<object>()),
  ImageExternalMeta: () => <div data-testid="external-meta" />,
}));
// The Discussion card's body is the comments probe; the card itself must be open to render it.
vi.mock('~/components/Image/DetailV2/CollapsibleCard', async (o) => ({
  ...(await o<object>()),
  CollapsibleCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// The contest details `ImageDetail2` gates on: it reads them from here, not from the module above.
vi.mock('~/components/Image/image.utils', async (o) => ({
  ...(await o<object>()),
  useImageContestCollectionDetails: () => ({ collectionItems: m.contestItems, post: undefined }),
}));

const { ImageDetail2 } = await import('~/components/Image/DetailV2/ImageDetail2');
const { ContainerProvider } = await import('~/components/ContainerProvider/ContainerProvider');

const HYDRATION_RE =
  /(Hydration failed|An error occurred during hydration|The server HTML was replaced|Expected server HTML|did not match|Text content does not match)/i;

let consoleErrors: string[] = [];
let recoverable: string[] = [];
let restoreConsole: (() => void) | null = null;
const roots: Root[] = [];
const containers: HTMLElement[] = [];

beforeEach(() => {
  m.items = [itemOf(image)];
  m.contestItems = [];
  m.gated = [];
  consoleErrors = [];
  recoverable = [];
  const original = console.error;
  console.error = ((...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    original.apply(console, args as []);
  }) as typeof console.error;
  restoreConsole = () => {
    console.error = original;
  };
});

afterEach(() => {
  restoreConsole?.();
  for (const r of roots.splice(0)) r.unmount();
  for (const c of containers.splice(0)) c.remove();
});

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const hydrationErrors = () => [
  ...recoverable,
  ...consoleErrors.filter((e) => HYDRATION_RE.test(e)),
];

function Tree({ client, deferredSsr }: { client: QueryClient; deferredSsr: boolean }) {
  return (
    <QueryClientProvider client={client}>
      <MantineProvider theme={{ colors: { accent: DEFAULT_THEME.colors.orange } }}>
        <div style={{ width: 1280, height: 900 }}>
          <ContainerProvider containerName="main">
            <ImageDetail2 deferredSsr={deferredSsr} />
          </ContainerProvider>
        </div>
      </MantineProvider>
    </QueryClientProvider>
  );
}

/** The server render alone: its HTML and the last `<Gated>` props it rendered. */
function serverRender(deferredSsr: boolean) {
  m.gated = [];
  const html = renderToString(<Tree client={new QueryClient()} deferredSsr={deferredSsr} />);
  return { html, gated: m.gated.at(-1) };
}

async function serverThenHydrate(server: boolean, client = server) {
  const { html } = serverRender(server);
  // The "server" render runs in the browser, so React warns about `useLayoutEffect` in
  // `renderToString`; only the hydration is measured.
  consoleErrors = [];
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  containers.push(container);
  roots.push(
    hydrateRoot(container, <Tree client={new QueryClient()} deferredSsr={client} />, {
      onRecoverableError: (err) =>
        recoverable.push(err instanceof Error ? err.message : String(err)),
    })
  );
  await flush();
  return { html, container };
}

const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);
const count = (html: string, id: string) => html.split(`data-testid="${id}"`).length - 1;

describe('image detail — deferredSsr (ssrSignedInSkipPrefetchImages skip arm)', () => {
  test('INSTRUMENT CHECK: hydrating the shell with the full page IS reported as a mismatch', async () => {
    await serverThenHydrate(true, false);
    expect(hydrationErrors().length).toBeGreaterThan(0);
  });

  test('deferredSsr false (flag off, anonymous, bots): the content in the server HTML, as before', async () => {
    const { html, container } = await serverThenHydrate(false);
    // Positive control: the probes do reach the server HTML.
    expect(has(html, 'carousel')).toBe(true);
    expect(has(html, 'creator-card')).toBe(true);
    expect(has(html, 'page-loader')).toBe(false);
    expect(hydrationErrors()).toEqual([]);
    expect(container.querySelector('[data-testid="carousel"]')).not.toBeNull();
  });

  test('server HTML is one loader and no content; it hydrates with no mismatch, then the content renders', async () => {
    const { html, container } = await serverThenHydrate(true);

    expect(count(html, 'page-loader')).toBe(1);
    expect(has(html, 'carousel')).toBe(false);
    expect(has(html, 'creator-card')).toBe(false);
    expect(hydrationErrors()).toEqual([]);
    // Mounted: the content, the loader gone.
    expect(container.querySelector('[data-testid="carousel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="page-loader"]')).toBeNull();
  });

  test('the shell gates and fills <head> exactly as the full page does', () => {
    const full = serverRender(false).gated;
    const shell = serverRender(true).gated;

    expect(shell).toMatchObject({
      contentNsfwLevel: 1,
      meta: {
        title: 'Image posted by someone',
        canonical: '/images/1',
        ogEndpoint: '/api/og?type=image&id=1',
        deIndex: true,
      },
    });
    expect(shell).toEqual(full);
  });

  test("the shell gates on a contest's forced rating, from the contest details it kept", () => {
    m.contestItems = [{ collection: { metadata: { forcedBrowsingLevel: 8 } } }];
    const { gated } = serverRender(true);

    expect(gated?.contentNsfwLevel).toBe(8);
  });

  test.each([
    [
      'an image the viewer gets none of',
      () => {
        m.items = [];
      },
    ],
    [
      'a POI image, to a viewer who is not its owner',
      () => {
        m.items = [itemOf({ ...image, poi: true })];
      },
    ],
  ])('%s: NotFound on the server, not the shell', (_, arrange) => {
    arrange();
    const { html } = serverRender(true);

    expect(has(html, 'not-found')).toBe(true);
    expect(has(html, 'page-loader')).toBe(false);
  });
});

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
 * `/images/[imageId]`'s sidebar under `ssr-client-only-sections`, across a real `renderToString`
 * → `hydrateRoot` of the real `ImageDetail2`. Its children are probes (the mock set of
 * `ImageDetail2.phoneSheet.browser.test.tsx`), so what is read is which of them the server HTML
 * holds: switch off, all of them, as before; switch on, the creator card and everything above it,
 * and in place of the sidebar's tail one placeholder, which hydrates cleanly and gives way to the
 * tail on the next render.
 */

const image = {
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

/** The sidebar's tail: what the switch moves to the client, in screen order. */
const TAIL = [
  'votable-tags',
  'post-card',
  'image-process',
  'image-remix-of',
  'remix-gallery',
  'generation-data',
  'image-comments',
  'contest-details',
  'external-meta',
] as const;

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy(),
}));
vi.mock('~/components/Image/Detail/ImageDetailProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageDetailProviderModule>()),
  useImageDetailContext: () => ({
    images: [image],
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
vi.mock('~/components/Gated/Gated', () => ({
  Gated: ({ children }: { children: ReactNode }) => <>{children}</>,
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

const { ImageDetail2 } = await import('~/components/Image/DetailV2/ImageDetail2');
const { ClientOnlySectionsProvider } = await import(
  '~/components/ClientOnlySection/ClientOnlySection'
);
const { ContainerProvider } = await import('~/components/ContainerProvider/ContainerProvider');

const HYDRATION_RE =
  /(Hydration failed|An error occurred during hydration|The server HTML was replaced|Expected server HTML|did not match|Text content does not match)/i;

let consoleErrors: string[] = [];
let recoverable: string[] = [];
let restoreConsole: (() => void) | null = null;
const roots: Root[] = [];
const containers: HTMLElement[] = [];

beforeEach(() => {
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

function Tree({ client, enabled }: { client: QueryClient; enabled: boolean }) {
  return (
    <QueryClientProvider client={client}>
      <MantineProvider theme={{ colors: { accent: DEFAULT_THEME.colors.orange } }}>
        <div style={{ width: 1280, height: 900 }}>
          <ContainerProvider containerName="main">
            <ClientOnlySectionsProvider enabled={enabled}>
              <ImageDetail2 />
            </ClientOnlySectionsProvider>
          </ContainerProvider>
        </div>
      </MantineProvider>
    </QueryClientProvider>
  );
}

async function serverThenHydrate(enabled: boolean) {
  const html = renderToString(<Tree client={new QueryClient()} enabled={enabled} />);
  // The "server" render runs in the browser, so React warns about `useLayoutEffect` in
  // `renderToString`; only the hydration is measured.
  consoleErrors = [];
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  containers.push(container);
  roots.push(
    hydrateRoot(container, <Tree client={new QueryClient()} enabled={enabled} />, {
      onRecoverableError: (err) =>
        recoverable.push(err instanceof Error ? err.message : String(err)),
    })
  );
  await flush();
  return { html, container };
}

const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);

describe('image detail sidebar — ssr-client-only-sections', () => {
  test('switch off: the server renders the whole sidebar, as before', async () => {
    const { html, container } = await serverThenHydrate(false);
    // Positive control: the probes do reach the server HTML.
    expect(has(html, 'creator-card')).toBe(true);
    expect(TAIL.filter((id) => !has(html, id))).toEqual([]);
    expect(html).not.toContain('data-client-only-section');
    expect(hydrationErrors()).toEqual([]);
    expect(container.querySelector('[data-testid="external-meta"]')).not.toBeNull();
  });

  test('switch on: the server renders everything down to the ad, then one placeholder', async () => {
    const { html } = await serverThenHydrate(true);
    expect(has(html, 'carousel')).toBe(true);
    expect(has(html, 'creator-card')).toBe(true);
    expect(has(html, 'ad-side')).toBe(true);
    expect(TAIL.filter((id) => has(html, id))).toEqual([]);
    expect(html).toContain('data-client-only-section="image-detail-sidebar"');
    // The placeholder sits where the tail goes: after the ad, inside the sidebar.
    expect(html.indexOf('data-client-only-section')).toBeGreaterThan(
      html.indexOf('data-testid="ad-side"')
    );
  });

  test('switch on: hydration matches, and the tail then replaces the placeholder in order', async () => {
    const { container } = await serverThenHydrate(true);
    expect(hydrationErrors()).toEqual([]);
    expect(container.querySelector('[data-client-only-section]')).toBeNull();
    const order = [...container.querySelectorAll('[data-testid]')]
      .map((el) => el.getAttribute('data-testid'))
      .filter((id): id is (typeof TAIL)[number] => (TAIL as readonly string[]).includes(id ?? ''));
    expect(order).toEqual([...TAIL]);
  });
});

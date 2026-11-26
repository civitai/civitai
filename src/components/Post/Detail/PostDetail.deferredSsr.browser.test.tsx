import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { Root } from 'react-dom/client';
import { hydrateRoot } from 'react-dom/client';
import { DEFAULT_THEME, MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

// Loads the `next/router` stub (and the rest of the component-test environment).
import '../../../../test/component-setup';

/**
 * `/posts/[postId]` under `ssrSignedInSkipPrefetchPosts`'s `skip` arm (`deferredSsr`), across a
 * real `renderToString` → `hydrateRoot` of the real `PostDetail`, with the mock set of
 * `PostDetail.clientOnlySections.browser.test.tsx` (its data hooks fixed, its leaves probes;
 * `Gated` records what the page gates on and hands its `<head>`).
 *
 * - The server HTML is a loader in place of the content, inside the same `<Gated>` (rating, ads and
 *   `<head>`) as the full page; the hydrating render reproduces it, and the content renders once
 *   the client has mounted.
 * - A post the viewer gets none of, or one by a creator the viewer blocked, is NotFound on the
 *   server, never the shell: the `skip` arm keeps `post.get` and the hidden preferences for exactly
 *   that (`src/tests/pages/posts/post-page-skip-prefetch.test.ts`).
 */

const post = {
  id: 5,
  title: 'A post',
  detail: null,
  nsfw: false,
  nsfwLevel: 1,
  availability: 'Public',
  collectionId: null,
  modelVersion: null,
  modelVersionId: null,
  publishedAt: null,
  wasPublished: false,
  publishedWithApp: null,
  tags: [],
  texts: [],
  user: { id: 2, username: 'someone' },
};

const m = vi.hoisted(() => ({
  post: null as unknown,
  blocked: false,
  collection: undefined as undefined | { metadata: { forcedBrowsingLevel?: number } },
  gated: [] as Record<string, unknown>[],
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy({
    'post.get': { useQuery: () => ({ data: m.post, isLoading: false }) },
  }),
}));
vi.mock('next/navigation', async (o) => ({
  ...(await o<object>()),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('~/components/BrowserRouter/BrowserRouterProvider', async (o) => ({
  ...(await o<object>()),
  useBrowserRouter: () => ({ query: {} }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (o) => ({
  ...(await o<object>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (o) => ({
  ...(await o<object>()),
  BrowsingLevelProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useBrowsingLevelContext: () => ({
    setForcedBrowsingLevel: () => undefined,
    userBrowsingLevel: 1,
  }),
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', async (o) => ({
  ...(await o<object>()),
  BrowsingSettingsAddonsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useBrowsingSettingsAddons: () => ({ settings: { disableMinor: false, disablePoi: false } }),
}));
vi.mock('~/hooks/hidden-preferences', async (o) => ({
  ...(await o<object>()),
  useHiddenPreferencesData: () => ({
    blockedUsers: m.blocked ? [{ id: post.user.id, username: post.user.username }] : [],
  }),
}));
vi.mock('~/components/Post/post.utils', async (o) => ({
  ...(await o<object>()),
  usePostContestCollectionDetails: () => ({
    collectionItems: [],
    permissions: undefined,
    collection: m.collection,
    isLoading: false,
  }),
}));
vi.mock('~/components/Image/image.utils', async (o) => ({
  ...(await o<object>()),
  useQueryImages: () => ({ flatData: [{ id: 1 }], images: [{ id: 1 }], isLoading: false }),
}));
vi.mock('~/components/Image/ExplainHiddenImages/ExplainHiddenImages', async (o) => ({
  ...(await o<object>()),
  useExplainHiddenImages: () => ({ hasHidden: false, hiddenByBrowsingSettings: [] }),
  ExplainHiddenImages: () => null,
}));
vi.mock('~/components/EntityCollaborator/entityCollaborator.util', async (o) => ({
  ...(await o<object>()),
  useGetEntityCollaborators: () => ({ collaborators: [] }),
  useEntityCollaboratorsMutate: () => ({
    removeEntityCollaborator: () => undefined,
    removingEntityCollaborator: false,
    actionEntityCollaborator: () => undefined,
    actioningEntityCollaborator: false,
  }),
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
vi.mock('~/components/MantineOverlays', async (o) => ({
  ...(await o<object>()),
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
const stub = vi.hoisted(() => () => null);
vi.mock('~/components/TrackView/TrackView', () => ({ TrackView: () => null }));
vi.mock('~/components/Ads/AdUnit', async (o) => ({
  ...(await o<object>()),
  AdUnitSide_1: stub,
  AdUnitSide_2: stub,
}));
vi.mock('~/components/Ads/AdUnitOutstream', async (o) => ({
  ...(await o<object>()),
  RenderAdUnitOutstream: stub,
}));
vi.mock('~/components/RatingReview/OwnerRatingControls', async (o) => ({
  ...(await o<object>()),
  OwnerRatingControls: stub,
}));
vi.mock('~/components/Storyline/StorylinePostChapter', async (o) => ({
  ...(await o<object>()),
  StorylinePostNext: stub,
  StorylinePostPill: stub,
}));
vi.mock('~/components/ShareButton/ShareButton', async (o) => ({
  ...(await o<object>()),
  ShareButton: stub,
}));
vi.mock('~/components/Post/Detail/PostControls', async (o) => ({
  ...(await o<object>()),
  PostControls: stub,
}));
vi.mock('~/components/UserAvatar/UserAvatar', async (o) => ({
  ...(await o<object>()),
  UserAvatar: stub,
}));
vi.mock('~/components/Buzz/TipBuzzButton', async (o) => ({
  ...(await o<object>()),
  TipBuzzButton: stub,
}));
vi.mock('~/components/Chat/ChatUserButton', async (o) => ({
  ...(await o<object>()),
  ChatUserButton: stub,
}));
vi.mock('~/components/FollowUserButton/FollowUserButton', async (o) => ({
  ...(await o<object>()),
  FollowUserButton: stub,
}));
vi.mock('~/components/Post/Detail/PostPublishedWithApp', async (o) => ({
  ...(await o<object>()),
  PostPublishedWithApp: stub,
}));
// Probes: the images (above the comments, always server-rendered) and the comment section.
vi.mock('~/components/Post/Detail/PostImages', async (o) => ({
  ...(await o<object>()),
  PostImages: () => <div data-testid="post-images" />,
}));
vi.mock('~/components/Post/Detail/PostComments', async (o) => ({
  ...(await o<object>()),
  PostComments: () => <div data-testid="post-comments" />,
}));

const { PostDetail } = await import('~/components/Post/Detail/PostDetail');
const { ContainerProvider } = await import('~/components/ContainerProvider/ContainerProvider');

const HYDRATION_RE =
  /(Hydration failed|An error occurred during hydration|The server HTML was replaced|Expected server HTML|did not match|Text content does not match)/i;

let consoleErrors: string[] = [];
let recoverable: string[] = [];
let restoreConsole: (() => void) | null = null;
const roots: Root[] = [];
const containers: HTMLElement[] = [];

beforeEach(() => {
  m.post = post;
  m.blocked = false;
  m.collection = undefined;
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
            <PostDetail postId={post.id} deferredSsr={deferredSsr} />
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

describe('post detail — deferredSsr (ssrSignedInSkipPrefetchPosts skip arm)', () => {
  test('INSTRUMENT CHECK: hydrating the shell with the full page IS reported as a mismatch', async () => {
    await serverThenHydrate(true, false);
    expect(hydrationErrors().length).toBeGreaterThan(0);
  });

  test('deferredSsr false (flag off, anonymous, bots): the content in the server HTML, as before', async () => {
    const { html, container } = await serverThenHydrate(false);
    // Positive control: the probes do reach the server HTML.
    expect(has(html, 'post-images')).toBe(true);
    expect(has(html, 'page-loader')).toBe(false);
    expect(hydrationErrors()).toEqual([]);
    expect(container.querySelector('[data-testid="post-images"]')).not.toBeNull();
  });

  test('server HTML is one loader and no content; it hydrates with no mismatch, then the content renders', async () => {
    const { html, container } = await serverThenHydrate(true);

    expect(count(html, 'page-loader')).toBe(1);
    expect(has(html, 'post-images')).toBe(false);
    expect(has(html, 'post-comments')).toBe(false);
    expect(hydrationErrors()).toEqual([]);
    // Mounted: the content, the loader gone.
    expect(container.querySelector('[data-testid="post-images"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="page-loader"]')).toBeNull();
  });

  test('the shell gates, sets ads and fills <head> exactly as the full page does', () => {
    const full = serverRender(false).gated;
    const shell = serverRender(true).gated;

    expect(shell).toMatchObject({
      contentNsfwLevel: 1,
      suppressAds: true,
      meta: {
        title: 'A post | Civitai',
        canonical: '/posts/5',
        ogEndpoint: '/api/og?type=post&id=5',
        deIndex: false,
      },
    });
    expect(shell).toEqual(full);
  });

  test("the shell gates on a contest's forced rating, from the contest details it kept", () => {
    m.post = { ...post, collectionId: 11 };
    m.collection = { metadata: { forcedBrowsingLevel: 8 } };
    const { gated } = serverRender(true);

    expect(gated?.contentNsfwLevel).toBe(8);
  });

  test.each([
    [
      'a post the viewer gets none of',
      () => {
        m.post = null;
      },
    ],
    [
      'a post by a creator the viewer blocked',
      () => {
        m.blocked = true;
      },
    ],
  ])('%s: NotFound on the server, not the shell', (_, arrange) => {
    arrange();
    const { html } = serverRender(true);

    expect(has(html, 'not-found')).toBe(true);
    expect(has(html, 'page-loader')).toBe(false);
  });
});

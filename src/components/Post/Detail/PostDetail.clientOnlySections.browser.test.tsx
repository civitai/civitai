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
 * `/posts/[postId]`'s comment section under `ssr-client-only-sections`, across a real
 * `renderToString` → `hydrateRoot` of the real `PostDetail`. Its data hooks and leaf components are
 * mocked to fixed values and probes, so what is read is which probes the server HTML holds and
 * where: switch off, the comment section under `#comments`, as before; switch on, the `#comments`
 * anchor with one placeholder inside it and no comment section, which hydrates cleanly and gives
 * way to the comments on the next render.
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

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy({
    'post.get': { useQuery: () => ({ data: post, isLoading: false }) },
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
vi.mock('~/hooks/useCurrentUser', async (o) => ({
  ...(await o<object>()),
  useCurrentUser: () => null,
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
  useHiddenPreferencesData: () => ({ blockedUsers: [] }),
}));
vi.mock('~/components/Post/post.utils', async (o) => ({
  ...(await o<object>()),
  usePostContestCollectionDetails: () => ({
    collectionItems: [],
    permissions: undefined,
    collection: undefined,
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
vi.mock('~/components/Gated/Gated', () => ({
  Gated: ({ children }: { children: ReactNode }) => <>{children}</>,
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
              <PostDetail postId={post.id} />
            </ClientOnlySectionsProvider>
          </ContainerProvider>
        </div>
      </MantineProvider>
    </QueryClientProvider>
  );
}

/** The server HTML, parsed without hydrating, so its structure can be queried. */
function parse(html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
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

describe('post detail comments — ssr-client-only-sections', () => {
  test('switch off: the server renders the comment section under #comments, as before', async () => {
    const { html, container } = await serverThenHydrate(false);
    const server = parse(html);
    // Positive control: the probes do reach the server HTML.
    expect(server.querySelector('[data-testid="post-images"]')).not.toBeNull();
    expect(server.querySelector('#comments [data-testid="post-comments"]')).not.toBeNull();
    expect(html).not.toContain('data-client-only-section');
    expect(hydrationErrors()).toEqual([]);
    expect(container.querySelector('#comments [data-testid="post-comments"]')).not.toBeNull();
  });

  test('switch on: the server renders #comments with one placeholder and no comment section', async () => {
    const { html } = await serverThenHydrate(true);
    const server = parse(html);
    expect(server.querySelector('[data-testid="post-images"]')).not.toBeNull();
    expect(server.querySelector('[data-testid="post-comments"]')).toBeNull();
    const placeholders = server.querySelectorAll('[data-client-only-section]');
    expect(placeholders.length).toBe(1);
    expect(placeholders[0].getAttribute('data-client-only-section')).toBe('post-comments');
    // The anchor stays server-rendered, and the placeholder is inside it.
    expect(placeholders[0].closest('#comments')).not.toBeNull();
  });

  test('switch on: hydration matches, and the comments then replace the placeholder', async () => {
    const { container } = await serverThenHydrate(true);
    expect(hydrationErrors()).toEqual([]);
    expect(container.querySelector('[data-client-only-section]')).toBeNull();
    expect(container.querySelector('#comments [data-testid="post-comments"]')).not.toBeNull();
  });
});

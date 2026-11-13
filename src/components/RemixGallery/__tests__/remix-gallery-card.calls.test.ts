// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { RemixGalleryCard } from '~/components/RemixGallery/RemixGalleryCard';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import { queryClient, trpc } from '~/utils/trpc';

/**
 * 🔴 AN IMAGE WITH NO GALLERY ENTRIES ASKS FOR NO GALLERY PAGE.
 *
 * `getRemixGalleryVisibility` already answers `hasEntries` with the gallery's own visibility
 * predicate at the viewer's level, so a page fetched where it is false can only come back empty.
 * The card used to fetch it wherever the card RENDERS — which, with every gallery open by default,
 * is nearly every image view.
 *
 * Counted on the wire: the real tRPC client runs, only `fetch` is stubbed.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => ({ remixGallery: true }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useViewerBrowsingLevelDebounced: () => 1,
}));
// Wraps the signed-out submit button and reads the router; the button is not what is measured.
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: unknown }) => children,
}));
// An entry is drawn by the shared image card, which needs the whole feed-image shape; what is
// asserted here is WHICH entries reach it.
vi.mock('~/components/CardTemplates/AspectRatioImageCard', () => ({
  AspectRatioImageCard: ({ image }: { image: { id: number } }) =>
    createElement('div', { 'data-entry': image.id }),
}));

const HOST = 74;
const ENTRY_IMAGE = 9311;

const visibility = (hasEntries: boolean) => ({
  open: true,
  hasEntries,
  render: true,
  price: 100,
  ownerId: 41,
  ownerUsername: 'owner',
  ownerShare: 0.7,
  freeSlots: 0,
  freeSlotsRemaining: null,
  declineFee: 30,
  pendingCount: 0,
  viewerPending: [],
  maxSubmissionLevel: null,
  acceptedMaxLevel: null,
});

const galleryPage = {
  items: [
    {
      placementId: 501,
      placerId: 52,
      pinned: false,
      resolvedAt: '2026-10-01T00:00:00.000Z',
      image: { id: ENTRY_IMAGE, user: { id: 52, username: 'placer' } },
    },
  ],
  nextCursor: null,
};

const requests: string[] = [];
let hasEntries = false;

function stubFetch() {
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://test');
      const path = url.pathname.replace('/api/trpc/', '');
      requests.push(path);
      const data =
        path === 'placement.getRemixGalleryVisibility'
          ? visibility(hasEntries)
          : path === 'placement.getRemixGallery'
          ? // As the server answers: the page and `hasEntries` share one predicate.
            hasEntries
            ? galleryPage
            : { items: [], nextCursor: null }
          : null;
      return new Response(JSON.stringify({ result: { data: { json: data } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
}

let root: Root | undefined;
let container: HTMLElement;

async function renderCard() {
  queryClient.clear();
  const Inner = () =>
    createElement(MantineProvider, null, createElement(RemixGalleryCard, { imageId: HOST }));
  const Wrapped = trpc.withTRPC(Inner as never) as unknown as ComponentType<{ pageProps: object }>;
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Wrapped, { pageProps: {} }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

const entries = () =>
  [...container.querySelectorAll('[data-entry]')].map((el) => el.getAttribute('data-entry'));

/**
 * What a remix mutation's `utils.placement.invalidate()` does: every query under the placement
 * router, and nothing else. Its tRPC keys start with the path `['placement', <procedure>]`.
 */
async function invalidatePlacements() {
  await act(async () => {
    await queryClient.invalidateQueries({
      predicate: ({ queryKey }) => Array.isArray(queryKey[0]) && queryKey[0][0] === 'placement',
    });
  });
}

/** Only the visibility query, leaving the gallery page's cached data untouched. */
async function invalidateVisibilityOnly() {
  await act(async () => {
    await queryClient.invalidateQueries({
      predicate: ({ queryKey }) =>
        Array.isArray(queryKey[0]) &&
        queryKey[0][0] === 'placement' &&
        queryKey[0][1] === 'getRemixGalleryVisibility',
    });
  });
}

const count = (path: string) => requests.filter((request) => request === path).length;

/** Polls a condition the render must reach, bounded so a regression fails rather than hangs. */
async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 40 && !condition(); attempt++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
}

beforeEach(stubFetch);
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the remix gallery card on an image view', () => {
  it('asks for no gallery page where the gallery has no entries, and still shows its pitch', async () => {
    hasEntries = false;
    await renderCard();

    // POSITIVE CONTROL: the instrument saw the card's own query.
    expect(count('placement.getRemixGalleryVisibility')).toBe(1);
    expect(count('placement.getRemixGallery')).toBe(0);
    expect(container.textContent).toContain('Get your remix seen here');
    expect(container.querySelectorAll('[data-entry]')).toHaveLength(0);
  });

  it('still asks for, and draws, the entries where there are some', async () => {
    hasEntries = true;
    await renderCard();
    await until(() => container.querySelectorAll('[data-entry]').length > 0);

    expect(count('placement.getRemixGallery')).toBe(1);
    expect(
      [...container.querySelectorAll('[data-entry]')].map((el) => el.getAttribute('data-entry'))
    ).toEqual([String(ENTRY_IMAGE)]);
    expect(container.textContent).not.toContain('Get your remix seen here');
  });

  // 🔴 Once `hasEntries` is false the gallery query is disabled, and a disabled query keeps its
  // cached page and is skipped by invalidation. Only the VISIBILITY is invalidated here — the
  // narrowest refresh a caller could make — so the page is never refetched and still holds the
  // entry; the card must stop drawing it on `hasEntries` alone.
  it('drops the last entry from the grid as soon as it is removed', async () => {
    hasEntries = true;
    await renderCard();
    await until(() => entries().length > 0);
    expect(entries()).toEqual([String(ENTRY_IMAGE)]);
    const pagesBefore = count('placement.getRemixGallery');

    hasEntries = false;
    await invalidateVisibilityOnly();
    await until(() => container.textContent?.includes('Get your remix seen here') ?? false);

    expect(entries()).toEqual([]);
    expect(container.textContent).toContain('Get your remix seen here');
    // The control: the page really was not refetched, so the cache still held the entry.
    expect(count('placement.getRemixGallery')).toBe(pagesBefore);
  });

  // The other direction, and the positive control for the first test's window: the same harness
  // sees the gallery request once there is something to list.
  it('asks for the page once a first entry arrives', async () => {
    hasEntries = false;
    await renderCard();
    expect(count('placement.getRemixGallery')).toBe(0);

    hasEntries = true;
    await invalidatePlacements();
    await until(() => entries().length > 0);

    expect(count('placement.getRemixGallery')).toBe(1);
    expect(entries()).toEqual([String(ENTRY_IMAGE)]);
  });
});

// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * A hat belongs to one image of a post, so a gallery post card draws it on that image's media and
 * only while that image is the slide showing: never on the card for another slide, and still there
 * when the image is past the first slice and only arrives with the lazily-fetched tail. Drives the
 * real card, carousel and hat overlay. The browser-mode twin (ImagesAsPostsCardHats.browser.test)
 * runs the same cases with a real layout; this one is the copy CI runs.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const image = (id: number, hatted = false) => ({
    id,
    type: 'image',
    url: `img-${id}.jpeg`,
    name: null,
    hasMeta: false,
    onSite: false,
    remixOfId: null,
    poi: false,
    minor: false,
    metadata: { width: 1, height: 1 },
    reactions: [],
    stats: {},
    user: { id: 9 },
    userId: 9,
    nsfwLevel: 1,
    tagIds: [] as number[],
    eventDecoration: hatted
      ? { id: 1, data: { type: 'hat', event: 'birthday2026', url: 'hat.png' } }
      : null,
  });
  const tail = { items: [] as ReturnType<typeof image>[] };
  const getInfinite = (_input: unknown, opts?: { enabled?: boolean }) =>
    opts?.enabled
      ? { data: { items: tail.items, nextCursor: undefined }, isError: false }
      : { data: undefined, isError: false };
  return { image, tail, getInfinite };
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({ 'image.getInfinite': { useQuery: h.getInfinite } }),
}));
vi.mock('~/components/Image/AsPosts/ImagesAsPostsInfiniteProvider', () => ({
  useImagesAsPostsInfiniteContext: () => ({
    filters: { modelId: 1, modelVersionId: 2 },
    browsingLevel: 1,
    hiddenImageIds: [],
    hiddenTags: [],
    hiddenUsers: [],
    swipeGalleryCards: false,
    source: { kind: 'model', model: { id: 1, user: { id: 9 } } },
    modelVersions: [],
  }),
}));
vi.mock('~/components/Image/AsPosts/gallery.utils', () => ({
  useGallerySettings: () => ({ gallerySettings: undefined }),
}));
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data: unknown }) => ({ items: data }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => ({ galleryLazyPostImages: true }),
}));
// The hat's popover needs the event's live data; name the image it is worn on instead.
vi.mock('~/components/Cosmetics/EventDecoration/WornHatPopover', () => ({
  WornHatPopover: ({
    wornOn,
    children,
  }: {
    wornOn: { entityId: number };
    children: React.ReactNode;
  }) => React.createElement('span', { 'data-worn-on': String(wornOn.entityId) }, children),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: () => null,
  EdgeMedia2: ({ imageId }: { imageId: number }) =>
    React.createElement('div', { 'data-testid': 'slide', 'data-image-id': String(imageId) }),
}));
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  const ImageGuard2 = ({ children }: { children: (safe: boolean) => React.ReactNode }) =>
    children(true);
  // The browsing-level badge in the media's top-left corner, which steps clear of a hat.
  ImageGuard2.BlurToggle = function BlurToggle({ style }: { style?: React.CSSProperties }) {
    return React.createElement('span', { 'data-testid': 'blur-toggle', style });
  };
  return { ImageGuard2 };
});
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({ children }: { children: React.ReactNode }) =>
    React.createElement('a', null, children),
}));
vi.mock('~/components/ImageHash/ImageHash', () => ({ MediaHash: () => null }));
vi.mock('~/components/Reaction/Reactions', () => ({ Reactions: () => null }));
vi.mock('~/components/Image/ContextMenu/ImagesAsPostsContextMenu', () => ({
  ImagesAsPostsContextMenu: () => null,
}));
vi.mock('~/components/RemixGallery/RemixedCardFlyout', () => ({ RemixedCardFlyout: () => null }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('~/components/TrackView/ImpressionSentinel', () => ({ ImpressionSentinel: () => null }));
vi.mock('~/components/TrackView/useTrackImpression', () => ({
  useTrackImpression: () => () => undefined,
}));

const { ImagesAsPostsCard } = await import('~/components/Image/AsPosts/ImagesAsPostsCard');

type Image = ReturnType<typeof h.image>;
const images = (n: number, hattedId?: number) =>
  Array.from({ length: n }, (_, i) => h.image(i + 1, i + 1 === hattedId));

let container: HTMLDivElement;
let root: Root;

async function renderCard(seed: Image[], imageCount?: number) {
  const data = { postId: 100, publishedAt: new Date(), user: { id: 9 }, images: seed, imageCount };
  await act(async () => {
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(ImagesAsPostsCard, { data: data as never, width: 320, height: 440 })
      )
    );
  });
}

const shownId = () =>
  container.querySelector('[data-testid="slide"]')?.getAttribute('data-image-id') ?? null;
// The image wearing the drawn hat, prefixed 'outside:' when it is not in the card's hat layer.
const hatOn = () => {
  const hats = container.querySelectorAll('button[data-event-decoration="hat"]');
  if (hats.length > 1) return `${hats.length} hats`;
  const hat = hats[0];
  if (!hat) return null;
  const id = hat.closest('[data-worn-on]')?.getAttribute('data-worn-on') ?? '?';
  return hat.closest('[data-testid="hat-layer"]') ? id : `outside:${id}`;
};
const badgeClearance = () =>
  (
    container.querySelector('[data-testid="blur-toggle"]') as HTMLElement | null
  )?.style.getPropertyValue('--event-decoration-clear-left');
// The cheap carousel's controls are [previous, next]; the hat is the only other button.
const clickNext = () =>
  act(async () => {
    const [, next] = Array.from(container.querySelectorAll('button')).filter(
      (b) => !b.hasAttribute('aria-hidden') && !b.hasAttribute('data-event-decoration')
    );
    next.click();
  });

// happy-dom has no layout; the hat layer draws a card's hat only where the card's corner is in view.
const rectOf = { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 };

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    ...rectOf,
    toJSON: () => rectOf,
  });
  h.tail.items = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('a gallery post card wears a hat only on the image that wears it', () => {
  it('single-image post: on the media, not the card', async () => {
    await renderCard(images(1, 1));
    expect(shownId()).toBe('1');
    expect(hatOn()).toBe('1');
    expect(badgeClearance()).toMatch(/^calc\(/);
  });

  it('hat on the cover: shown on the cover, gone when another slide shows', async () => {
    await renderCard(images(3, 1));
    expect(shownId()).toBe('1');
    expect(hatOn()).toBe('1');
    expect(badgeClearance()).toMatch(/^calc\(/);

    await clickNext();
    expect(shownId()).toBe('2');
    expect(hatOn()).toBeNull();
    expect(badgeClearance()).toBe('');
  });

  it('hat on a later slide: only while that slide shows', async () => {
    await renderCard(images(3, 2));
    expect(hatOn()).toBeNull();

    await clickNext();
    expect(shownId()).toBe('2');
    expect(hatOn()).toBe('2');
  });

  it('hat on an image past the first slice: shown when the tail brings it in', async () => {
    // 13 images, the server sends 6, the hatted one is the 7th.
    h.tail.items = images(13, 7);
    await renderCard(images(6), 13);
    expect(hatOn()).toBeNull();

    for (let i = 0; i < 6; i++) await clickNext();
    expect(shownId()).toBe('7');
    expect(hatOn()).toBe('7');
  });

  it('no hat when no image wears one', async () => {
    await renderCard(images(3));
    for (let i = 0; i < 3; i++) {
      expect(hatOn()).toBeNull();
      await clickNext();
    }
  });
});

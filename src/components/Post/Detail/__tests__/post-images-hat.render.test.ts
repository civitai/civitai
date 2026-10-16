// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';

/**
 * The post page draws each image's hat on that image's corner, with the same overlay the feed and
 * gallery cards use. To whoever changes this: the hat data already arrives on every post image
 * (image.getInfinite names the viewer, and the server drops hats a viewer may not see yet), so the
 * page must render exactly what it is given: a hat when `eventDecoration` is set, none when it is
 * null. Null is what a viewer outside the preview receives; drawing anything then is a leak.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const image = (id: number, hatted = false) => ({
    id,
    type: 'image',
    url: `img-${id}.jpeg`,
    name: null,
    width: 512,
    height: 512,
    hasMeta: false,
    metadata: {},
    reactions: [],
    stats: {},
    user: { id: 9 },
    eventDecoration: hatted
      ? { id: 1, data: { type: 'hat', event: 'birthday2026', url: 'hat.png' } }
      : null,
  });
  return { image, linkClicks: { count: 0 } };
});

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => ({}),
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
  EdgeMedia: ({ imageId }: { imageId?: number }) =>
    React.createElement('div', { 'data-testid': 'media', 'data-image-id': String(imageId) }),
}));
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  const ImageGuard2 = ({ children }: { children: (safe: boolean) => React.ReactNode }) =>
    children(true);
  ImageGuard2.BlurToggle = function BlurToggle() {
    return React.createElement('span', { 'data-testid': 'blur-toggle' });
  };
  return { ImageGuard2 };
});
// Opening the image detail is the link's click; count it to see whether a hat click reaches it.
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({ children }: { children: React.ReactNode }) =>
    React.createElement(
      'a',
      { 'data-testid': 'image-link', onClick: () => void h.linkClicks.count++ },
      children
    ),
}));
vi.mock('~/components/Sticker/StickerPlacementBatchProvider', () => ({
  StickerPlacementBatchProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('~/components/Ads/AdUnit', () => ({ AdUnitTop: () => null }));
vi.mock('~/components/ImageHash/ImageHash', () => ({ MediaHash: () => null }));
vi.mock('~/components/Reaction/Reactions', () => ({ Reactions: () => null }));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', () => ({
  ImageContextMenu: () => null,
}));
vi.mock('~/components/Image/Meta/ImageMetaPopover', () => ({ ImageMetaPopover2: () => null }));
vi.mock('~/components/Post/Detail/PostContestCollectionInfoAlert', () => ({
  PostContestCollectionInfoAlert: () => null,
}));

const { PostImages } = await import('~/components/Post/Detail/PostImages');
const { getEventDecorationClearLeftCss, getHatLayout } = await import(
  '~/components/Cosmetics/EventDecoration/event-decoration-placement'
);

let container: HTMLDivElement;
let root: Root;

async function renderPost(images: ReturnType<typeof h.image>[]) {
  await act(async () => {
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(PostImages, { postId: 100, images: images as never })
      )
    );
  });
}

const hats = () => Array.from(container.querySelectorAll('button[data-event-decoration="hat"]'));
// Each image's frame: the box around its media that its badges and hat sit in.
const frameOf = (imageId: number) =>
  container
    .querySelector(`[data-testid="media"][data-image-id="${imageId}"]`)
    ?.closest('div.relative') ?? null;
// The top-left badge group (blur toggle, sticker badge, collection tag) of one image.
const badgeGroup = (imageId: number) =>
  frameOf(imageId)?.querySelector('[data-testid="blur-toggle"]')?.parentElement as
    | HTMLElement
    | undefined;
const badgeClearance = (imageId: number) =>
  badgeGroup(imageId)?.style.getPropertyValue('--event-decoration-clear-left');

beforeEach(() => {
  h.linkClicks.count = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('the post page wears each image hat on that image, as the cards do', () => {
  it('draws the hat on the image that wears it, and steps its badges clear', async () => {
    await renderPost([h.image(1), h.image(2, true), h.image(3)]);

    expect(hats()).toHaveLength(1);
    const hat = hats()[0];
    expect(hat.closest('[data-worn-on]')?.getAttribute('data-worn-on')).toBe('2');
    expect(frameOf(2)?.contains(hat)).toBe(true);
    // Inside the corner, not hanging off it: the image's frame clips at its edge.
    const hatData = h.image(2, true).eventDecoration!.data;
    const hatLeft = (hat as HTMLElement).style.left;
    expect(hatLeft).toMatch(/^[0-9.]+px$/);
    expect(parseFloat(hatLeft)).toBeCloseTo(getHatLayout('inside', undefined).left, 3);
    expect(badgeClearance(2)).toBe(getEventDecorationClearLeftCss(hatData, 'inside'));
    expect(badgeClearance(2)).toMatch(/^[1-9][0-9]*px$/);
    // The clearance only moves the badges if their position reads it.
    expect(badgeGroup(2)?.className).toContain('var(--event-decoration-clear-left');
    expect(badgeClearance(1)).toBe('');
  });

  it('a hat click does not open the image detail', async () => {
    await renderPost([h.image(1, true)]);
    const hat = hats()[0];
    expect(container.querySelector('[data-testid="image-link"]')?.contains(hat)).toBe(false);

    await act(async () => hat.click());
    expect(h.linkClicks.count).toBe(0);
  });

  it('gate: no hat when no image carries one (what a viewer outside the preview receives)', async () => {
    await renderPost([h.image(1), h.image(2)]);
    expect(hats()).toHaveLength(0);
    expect(badgeClearance(1)).toBe('');
  });
});

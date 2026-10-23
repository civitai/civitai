import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type * as TrpcUtils from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as ImageGuardModule from '~/components/ImageGuard/ImageGuard2';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

/**
 * The image detail letterboxes its picture inside a full-height slot, so an image's hat goes on the
 * box the picture is drawn in (useDrawnMediaBox), not on the slot's corner. To whoever changes this:
 * - the hat sits in the PICTURE's top-left corner and follows it when the slot resizes (the info
 *   sidebar opening or closing moves the picture without a window resize);
 * - it is the feed-card hat, never larger, and smaller on a narrower picture;
 * - Escape with the hat's popover open closes only the popover; with it closed, Escape still closes
 *   the viewer (the modal it opens in, ImageDetailModal's PageModal);
 * - no hat when the image carries none, which is what a viewer outside the preview receives.
 * Browser mode only: placement needs a real layout. CI runs these as `Component tests`.
 */

const svg = (w: number, h: number, fill: string) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`
  );
const HAT = svg(10, 10, '#e64980');

const mocks = vi.hoisted(() => ({
  state: { cover: false },
  image: (hatted: boolean, width = 2000, height = 1000) => ({
    id: 1,
    nsfwLevel: 1,
    url: 'picture',
    width,
    height,
    type: 'image' as const,
    name: null,
    metadata: null,
    eventDecoration: hatted ? { data: { type: 'hat', event: 'birthday2026', url: 'hat' } } : null,
  }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcUtils>()),
  trpc: makeTrpcProxy({}),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/components/ImageGuard/ImageGuard2', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageGuardModule>()),
  ImageGuardContent: ({ children }: any) => <>{children(true)}</>,
}));
// The picture is a fixed-ratio SVG drawn with the detail's own classes, so it letterboxes for real.
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ imageId, className, wrapperProps }: any) =>
    imageId == null ? (
      <img src={HAT} className={className} alt="" />
    ) : (
      <div {...wrapperProps}>
        <img src={svg(2000, 1000, '#228be6')} className={className} data-testid="picture" alt="" />
      </div>
    ),
}));
vi.mock('~/components/ImageHash/ImageHash', () => ({ MediaHash: () => null }));
// The sticker overlay's host, after the hat as in the app; with `cover` it holds a sticker spread
// over the whole picture, which has to paint and take the pointer above the hat.
vi.mock('~/components/Sticker/ImageStickerOverlay', () => ({
  ImageStickerOverlay: () => (
    <div
      data-media-overlay=""
      data-testid="sticker-host"
      className="pointer-events-none absolute inset-0"
    >
      {mocks.state.cover && (
        <div data-testid="sticker" className="pointer-events-auto absolute inset-0 isolate" />
      )}
    </div>
  ),
}));

import '~/styles/globals.css';
import { renderWithProviders } from '../../../../test/component-setup';
import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';
import { PageModal } from '~/components/Dialog/Templates/PageModal';
import { getHatLayout } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';

const onClose = vi.fn();
let setSlot: (size: { width: number; height: number }) => void = () => undefined;

function Viewer({ image, bare }: { image: ReturnType<typeof mocks.image>; bare?: boolean }) {
  const [slot, set] = useState({ width: 800, height: 600 });
  setSlot = set;
  const stage = (
    <div style={{ ...slot, display: 'flex', flexDirection: 'column' }}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ImageDetailCarousel
          images={[image]}
          index={0}
          canNavigate={false}
          next={() => undefined}
          previous={() => undefined}
        />
      </div>
    </div>
  );
  // Bare for hit-testing: the modal in this harness does not hit-test (elementFromPoint gives BODY).
  if (bare) return stage;
  // The modal the image detail opens in (ImageDetailModal), whose Escape is what closes the viewer.
  return (
    <PageModal
      opened
      onClose={onClose}
      withCloseButton={false}
      withinPortal={false}
      withOverlay={false}
      lockScroll={false}
      padding={0}
      fullScreen
    >
      {stage}
    </PageModal>
  );
}

const hat = () => document.querySelector<HTMLElement>('button[data-event-decoration="hat"]');
const rect = (el: Element | null) => el!.getBoundingClientRect();
const popover = () => document.querySelector('[data-testid="worn-hat-popover"]');

// The hat sits inside the picture's top-left corner: within its box and near its corner.
async function expectOnPictureCorner() {
  await vi.waitFor(() => {
    const picture = rect(document.querySelector('[data-testid="picture"]'));
    const h = rect(hat());
    expect(h.left).toBeGreaterThanOrEqual(picture.left - 1);
    expect(h.top).toBeGreaterThanOrEqual(picture.top - 1);
    expect(h.left - picture.left).toBeLessThan(40);
    expect(h.top - picture.top).toBeLessThan(40);
  });
}

beforeEach(() => {
  onClose.mockClear();
  mocks.state.cover = false;
});

describe('the image detail wears the image hat on the picture', () => {
  test('on the letterboxed picture, not the slot, and it follows a resize', async () => {
    renderWithProviders(<Viewer image={mocks.image(true)} />);
    await vi.waitFor(() => expect(hat()).not.toBeNull());
    // A 2:1 picture in an 800x600 slot is letterboxed: the slot's corner is empty space.
    const picture = rect(document.querySelector('[data-testid="picture"]'));
    const slot = rect(document.querySelector('[data-testid="picture"]')!.closest('.relative'));
    expect(picture.top - slot.top).toBeGreaterThan(50);
    await expectOnPictureCorner();

    // The sidebar opening narrows the slot without any window resize.
    setSlot({ width: 500, height: 600 });
    await vi.waitFor(() =>
      expect(rect(document.querySelector('[data-testid="picture"]')).width).toBeLessThan(510)
    );
    await expectOnPictureCorner();
  });

  test('the feed-card hat, smaller on a narrower picture', async () => {
    renderWithProviders(<Viewer image={mocks.image(true)} />);
    await vi.waitFor(() => expect(hat()).not.toBeNull());
    // offsetWidth: the hat's own size, before its tilt widens its bounding box.
    const full = getHatLayout('inside', undefined).width;
    await vi.waitFor(() => expect(hat()!.offsetWidth).toBe(Math.round(full)));

    setSlot({ width: 160, height: 600 });
    await vi.waitFor(() => expect(hat()!.offsetWidth).toBeLessThan(full * 0.75));
  });

  test('Escape closes the open hat popover only, then the viewer', async () => {
    renderWithProviders(<Viewer image={mocks.image(true)} />);
    await vi.waitFor(() => expect(hat()).not.toBeNull());

    // Opened from the keyboard: the modal in this harness does not hit-test, so a pointer click
    // never lands (the live check covers the pointer). Focus stays on the hat, as after a click.
    hat()!.focus();
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(popover()).not.toBeNull());

    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(popover()).toBeNull());
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Escape with focus inside the open popover closes only the popover', async () => {
    renderWithProviders(<Viewer image={mocks.image(true)} />);
    await vi.waitFor(() => expect(hat()).not.toBeNull());
    hat()!.focus();
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(popover()).not.toBeNull());

    // A click inside the dropdown focuses it (it is tabIndex -1).
    (popover() as HTMLElement).focus();
    expect(document.activeElement).toBe(popover());
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(popover()).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  test('a click focuses the hat, which Safari and Firefox do not do for a button', async () => {
    renderWithProviders(<Viewer image={mocks.image(true)} />);
    await vi.waitFor(() => expect(hat()).not.toBeNull());
    // A dispatched click, like those browsers' mouse click, moves no focus by itself.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).not.toBe(hat());
    hat()!.click();
    await vi.waitFor(() => expect(popover()).not.toBeNull());
    expect(document.activeElement).toBe(hat());
  });

  test('stickers paint and take the pointer above the hat', async () => {
    mocks.state.cover = true;
    renderWithProviders(<Viewer image={mocks.image(true)} bare />);
    await vi.waitFor(() => expect(hat()).not.toBeNull());
    await expectOnPictureCorner();
    // Every point of the hat is under the sticker, so the sticker is what the pointer reaches.
    const h = rect(hat());
    const hits = new Set<string | null>();
    for (let x = h.left + 2; x < h.right - 2; x += 4)
      for (let y = h.top + 2; y < h.bottom - 2; y += 4)
        hits.add(document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? null);
    expect([...hits]).toEqual(['sticker']);
  });

  test('gate: no hat when the image carries none', async () => {
    renderWithProviders(<Viewer image={mocks.image(false)} />);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="picture"]')).not.toBeNull()
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="sticker-host"]')).not.toBeNull()
    );
    expect(hat()).toBeNull();
    expect(document.querySelector('[data-testid="drawn-media-hat"]')).toBeNull();
  });
});

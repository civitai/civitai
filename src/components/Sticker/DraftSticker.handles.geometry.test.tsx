import { describe, expect, test, vi } from 'vitest';
import type * as CosmeticShopUtil from '~/components/CosmeticShop/cosmetic-shop.util';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { PHONE_VIEWPORT, renderAtViewport } from '../../../test/geometry-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import { resolveTreatment } from '~/components/Sticker/treatments/sticker-treatments';
import type { StickerDraft } from '~/store/sticker-placement-draft.store';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';

// Everything the draft reaches for that is not its own geometry.
vi.mock('~/components/Sticker/placement.util', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementUtil>()),
  useCreateStickerPlacement: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock('~/components/CosmeticShop/cosmetic-shop.util', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticShopUtil>()),
  useMutateCosmeticShop: () => ({ purchaseShopItem: vi.fn(), purchasingShopItem: false }),
}));
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useBuyStickerUses: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(
    {},
    { useUtils: () => ({ cosmetic: { getStickerBalances: { invalidate: vi.fn() } } }) }
  ),
}));
// A square artwork box, so the geometry does not depend on an image loading.
vi.mock('~/components/EdgeMedia/EdgeImage', () => ({
  EdgeImage: ({ style }: { style?: React.CSSProperties }) => (
    <div style={{ ...style, aspectRatio: '1' }} />
  ),
}));

const PRICE = 700;
const draft: StickerDraft = {
  id: 'draft-1',
  imageId: 74,
  cosmeticId: 85,
  x: 0.5,
  y: 0.4,
  scale: 0.4,
  rotation: 0,
  flip: false,
  opacity: 1,
};
const art = { id: 85, name: 'Star', slug: 'star', url: 'star.png' };
const { DraftSticker } = await import('~/components/Sticker/DraftSticker');
const { useDraftGestures } = await import('~/components/Sticker/useDraftGestures');

/**
 * The handle dots are 12px (corners) and 16px (rotate knob) so they do not cover
 * the artwork; what a finger has to hit is the invisible ring around each. A
 * press this far off a dot's centre has to land on the handle, not the sticker.
 */
const CORNER_REACH = 18;
const KNOB_REACH = 20;

const renderDraft = (scale: number) =>
  renderAtViewport(
    <div style={{ position: 'relative', width: 380, height: 600 }}>
      <DraftSticker
        draft={{ ...draft, rotation: 0, scale, y: 0.4 }}
        art={art}
        selected
        dressed={resolveTreatment({ treatment: 'none', surface: 'detail', isPending: false })}
        price={PRICE}
        creatorMaxScale={0.4}
        freeOffer={null}
        ownerShare={undefined}
        ownerUsername="creator"
        onGesture={() => true}
      />
    </div>,
    PHONE_VIEWPORT
  );

const handles = () => [...document.querySelectorAll<HTMLElement>('span.rounded-full.bg-blue-5')];
const centre = (box: DOMRect) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });

describe('draft sticker handles on a phone', () => {
  test('a finger near a handle, on its outer side, lands on it', async () => {
    await renderDraft(0.4);
    await expect.poll(() => handles().length).toBe(5);
    const body = centre(
      (document.querySelector('[data-sticker-editor]') as HTMLElement).getBoundingClientRect()
    );
    expect(handles()).toHaveLength(5);

    for (const handle of handles()) {
      const box = handle.getBoundingClientRect();
      const dot = centre(box);
      const reach = box.width > 14 ? KNOB_REACH : CORNER_REACH;
      // Away from the sticker's middle: where a finger reaching for it lands.
      const dx = dot.x - body.x;
      const dy = dot.y - body.y;
      const length = Math.hypot(dx, dy) || 1;
      const x = dot.x + (dx / length) * reach;
      const y = dot.y + (dy / length) * reach;
      expect(document.elementFromPoint(x, y), `${box.width}px handle`).toBe(handle);
    }
  });

  test('the rings leave a small sticker draggable by its middle', async () => {
    await renderDraft(0.1);
    await expect.poll(() => handles().length).toBe(5);
    const artwork = handles()[0].parentElement?.parentElement as HTMLElement;
    const { x, y } = centre(artwork.getBoundingClientRect());

    expect(handles()).not.toContain(document.elementFromPoint(x, y));

    // And each corner's ring leaves the side facing the body to the body.
    for (const handle of handles().filter((h) => h.getBoundingClientRect().width < 14)) {
      const dot = centre(handle.getBoundingClientRect());
      const inward = { x: dot.x + Math.sign(x - dot.x) * 12, y: dot.y + Math.sign(y - dot.y) * 12 };
      expect(document.elementFromPoint(inward.x, inward.y), 'inward of a corner').not.toBe(handle);
    }
  });
});

/**
 * Feedback: a hat moved to the top edge of an image (or to whichever edge its knob faces after a
 * turn) could not be rotated, because the knob hung past the clipping edge. A host that opts in
 * (`knobFlips`, a Hat Turf hat) hangs the knob below there instead; a sticker keeps it above.
 */
describe('the rotate knob at the clipping edge', () => {
  type Gesture = Parameters<Parameters<typeof DraftSticker>[0]['onGesture']>[0];
  const knob = () =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="draft-rotate-knob"]')].at(-1)!;
  const renderAtEdge = async ({
    knobFlips,
    y,
    rotation = 0,
  }: {
    knobFlips?: boolean;
    y: number;
    rotation?: number;
  }) => {
    const gestures: Gesture[] = [];
    await renderAtViewport(
      <div
        data-knob-host
        style={{ position: 'relative', width: 380, height: 600, overflow: 'hidden' }}
      >
        <DraftSticker
          draft={{ ...draft, y, rotation, scale: 0.4 }}
          art={art}
          selected
          dressed={resolveTreatment({ treatment: 'none', surface: 'detail', isPending: false })}
          price={PRICE}
          creatorMaxScale={0.4}
          freeOffer={null}
          ownerShare={undefined}
          ownerUsername="creator"
          onGesture={(gesture) => {
            gestures.push(gesture);
            return true;
          }}
          knobFlips={knobFlips}
        />
      </div>,
      PHONE_VIEWPORT
    );
    const host = [...document.querySelectorAll<HTMLElement>('[data-knob-host]')].at(-1)!;
    await expect.poll(() => knob().getBoundingClientRect().height).toBe(16);
    return { host, gestures };
  };
  const inside = (inner: DOMRect, outer: DOMRect) =>
    inner.top >= outer.top &&
    inner.bottom <= outer.bottom &&
    inner.left >= outer.left &&
    inner.right <= outer.right;

  test('at the top edge, a hat hangs its knob below, inside the clip', async () => {
    const { host } = await renderAtEdge({ knobFlips: true, y: 0.08 });
    await expect.poll(() => knob().dataset.knobBelow).toBe('true');
    expect(inside(knob().getBoundingClientRect(), host.getBoundingClientRect())).toBe(true);
  });

  test('turned upside down at the bottom edge, the knob points down, so it flips too', async () => {
    const { host } = await renderAtEdge({ knobFlips: true, y: 0.92, rotation: 180 });
    await expect.poll(() => knob().dataset.knobBelow).toBe('true');
    expect(inside(knob().getBoundingClientRect(), host.getBoundingClientRect())).toBe(true);
  });

  test('a hat mid-image keeps the knob above', async () => {
    const { host } = await renderAtEdge({ knobFlips: true, y: 0.5 });
    expect(knob().dataset.knobBelow).toBeUndefined();
    expect(inside(knob().getBoundingClientRect(), host.getBoundingClientRect())).toBe(true);
  });

  test('a sticker (no knobFlips) keeps the knob above, even past the edge', async () => {
    const { host } = await renderAtEdge({ y: 0.08 });
    expect(knob().dataset.knobBelow).toBeUndefined();
    expect(inside(knob().getBoundingClientRect(), host.getBoundingClientRect())).toBe(false);
  });

  test('grabbing a knob hung below starts a turn that reads it as below', async () => {
    const { host, gestures } = await renderAtEdge({ knobFlips: true, y: 0.08 });
    await expect.poll(() => knob().dataset.knobBelow).toBe('true');
    // A press is a fraction of the registered surface; with none the handler returns at once.
    const store = useStickerPlacementDraftStore.getState();
    store.open(draft.imageId);
    store.setSurface(host);
    const r = knob().getBoundingClientRect();
    knob().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      })
    );
    expect(gestures.at(-1)).toMatchObject({ mode: 'rotate', knobBelow: true });
  });
});

/**
 * The same knob driven through the store and the real gesture hook, as the hat editor runs it:
 * the turn reads the side the knob started on, and the side waits for the turn to end.
 */
describe('turning a hat by a knob hung below', () => {
  const knob = () =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="draft-rotate-knob"]')].at(-1)!;
  const store = () => useStickerPlacementDraftStore.getState();
  const current = () => store().drafts[0];

  function StoreHost() {
    const live = useStickerPlacementDraftStore((state) => state.drafts[0]);
    const onGesture = useDraftGestures(0.4);
    return (
      <div
        data-knob-host
        style={{ position: 'relative', width: 380, height: 600, overflow: 'hidden' }}
      >
        {live && (
          <DraftSticker
            draft={live}
            art={art}
            selected
            dressed={resolveTreatment({ treatment: 'none', surface: 'detail', isPending: false })}
            price={PRICE}
            creatorMaxScale={0.4}
            freeOffer={null}
            ownerShare={undefined}
            ownerUsername="creator"
            onGesture={onGesture}
            knobFlips
          />
        )}
      </div>
    );
  }

  const renderHat = async (y: number) => {
    store().close();
    store().open(draft.imageId);
    await renderAtViewport(<StoreHost />, PHONE_VIEWPORT);
    store().setSurface([...document.querySelectorAll<HTMLElement>('[data-knob-host]')].at(-1)!);
    store().begin(draft.cosmeticId, { x: 0.5, y }, 0.4);
    store().move(current().id, { scale: 0.4, rotation: 0, x: 0.5, y });
    await expect.poll(() => knob()?.getBoundingClientRect().height).toBe(16);
  };
  const pointer = (type: string, x: number, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX: x,
      clientY: y,
    });

  test('grabbing the knob below does not spin the hat, and the hat follows the pointer', async () => {
    await renderHat(0.08);
    await expect.poll(() => knob().dataset.knobBelow).toBe('true');
    const r = knob().getBoundingClientRect();
    const at = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    knob().dispatchEvent(pointer('pointerdown', at.x, at.y));
    window.dispatchEvent(pointer('pointermove', at.x, at.y));
    expect(Math.abs(current().rotation)).toBeLessThan(1);
    // The pointer straight right of the centre puts the knob below on the right: a quarter turn back.
    const host = [...document.querySelectorAll<HTMLElement>('[data-knob-host]')].at(-1)!;
    const box = host.getBoundingClientRect();
    const centreY = box.top + current().y * box.height;
    window.dispatchEvent(pointer('pointermove', box.left + box.width - 10, centreY));
    expect(current().rotation).toBeCloseTo(-90, 0);
    window.dispatchEvent(pointer('pointerup', box.left + box.width - 10, centreY));
  });

  test('the knob keeps its side through a turn, and changes it when the turn ends', async () => {
    await renderHat(0.5);
    expect(knob().dataset.knobBelow).toBeUndefined();
    store().setInteraction('rotate');
    store().move(current().id, { y: 0.08 });
    await expect.poll(() => current().y).toBe(0.08);
    // Two frames for a measure that should not flip it.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(knob().dataset.knobBelow, 'the knob changed side mid-turn').toBeUndefined();
    store().setInteraction(null);
    await expect.poll(() => knob().dataset.knobBelow).toBe('true');
  });
});

import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * 🔴 THE WIRING, WHICH IS WHERE THE REPORTED BUG ACTUALLY LIVED.
 *
 * `mediaContentRect` is covered as arithmetic, and it would catch a regression
 * inside itself. It cannot catch the overlay going back to measuring
 * `offsetWidth`/`offsetHeight` — and that one line IS the defect ECAJ reported.
 * Before this file, reverting it left the entire suite green on the exact
 * surface the bug came from.
 *
 * So this renders the real `CardStickerOverlay` over a real `object-fit: cover`
 * image and asserts where the overlay box lands: the artwork's rectangle, which
 * on a cropped card is taller than the card and starts above its top edge.
 */

const IMAGE_ID = 74;

/** A 1x2 PNG — portrait, the shape that gets cropped in a wide card. */
const PORTRAIT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAIAAAAW4yFwAAAADklEQVR4nGNgaPjPAMQACgIC/2I9KX4AAAAASUVORK5CYII=';

const placement = {
  id: 1,
  imageId: IMAGE_ID,
  isPending: false,
  data: { cosmeticId: 9, x: 0.5, y: 0.5, scale: 0.25, rotation: 0, flip: false, opacity: 1 },
};

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));

// The store's default is `revealed: false`, which renders no placements at all —
// so without this the overlay never measures and every assertion below would be
// asserting an empty card.
type RevealState = { revealed: boolean; forced: boolean };

vi.mock('~/store/sticker-reveal.store', () => ({
  // Both exports, because the overlay reads the store THROUGH the selector now.
  // A mock supplying only the hook hands it `undefined` to call.
  stickersRevealed: (state: RevealState) => state.revealed || state.forced,
  useStickerRevealStore: (select: (state: RevealState) => unknown) =>
    select({ revealed: true, forced: false }),
}));

vi.mock('~/components/Sticker/StickerPlacementBatchProvider', () => ({
  useStickerPlacementBatch: () => ({
    count: 1,
    placements: [placement],
    pending: [],
    sticker: new Map(),
    treatment: 'none',
  }),
}));

// Reduced to a marker: what is asserted is the BOX the overlay is given, which
// is the thing the fix changes. The real overlay wants artwork, reveal timing
// and a treatment, none of which decide where the box lands.
vi.mock('~/components/Sticker/StickerPlacementOverlay', () => ({
  StickerPlacementOverlay: () => <div data-testid="placements" />,
}));

const { CardStickerOverlay } = await import('~/components/Sticker/CardStickerOverlay');

/**
 * A card wider than it is tall, holding a portrait image under `cover`.
 *
 * 400x200 with a 1:2 picture: covering 400 wide scales the artwork to 800 tall,
 * so 600px of it is cropped. `object-position: top` keeps the top edge, which is
 * what both real card stylesheets do.
 */
const CARD = { width: 400, height: 200 };

const renderCard = async () => {
  renderWithProviders(
    <div style={{ position: 'relative', ...CARD }}>
      {/* Absolutely positioned, as the real cards have it — the media sits inside
          a positioned link and the overlay is its sibling. It also keeps the
          media out of normal flow, which matters here: this harness mounts
          components without the app's stylesheet, so the overlay's own
          `absolute inset-0` does nothing and an in-flow image would push the
          overlay's root below it, measuring an offset no real card has. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- a fixture, not app
          markup: the point is a plain element with a known natural size and a
          real object-fit, which next/image would wrap and re-style. */}
      <img
        src={PORTRAIT_PNG}
        alt=""
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: 'top',
        }}
      />
      <CardStickerOverlay imageId={IMAGE_ID} />
    </div>
  );

  // `.element()` does not retry, and the overlay paints its positioned box only
  // after the effect has measured a laid-out image — a later frame than the
  // first render. Poll for it, then take the node.
  const locator = page.getByTestId('placements');
  await expect.element(locator, { timeout: 5000 }).toBeInTheDocument();
  const marker = await locator.element();
  // The box is the overlay's positioned wrapper — the element the fix moves.
  return marker.parentElement as HTMLElement;
};

/**
 * The box's own inline style, which is where the measurement lands.
 *
 * Not `offsetTop`/`offsetWidth`: the overlay positions itself with Tailwind's
 * `absolute inset-0`, and this harness mounts components without the app's
 * stylesheet — so those classes do nothing here and the layout numbers describe
 * normal flow rather than anything the component decided. The inline style is
 * the component's own output and is unaffected by that.
 */
const measured = (box: HTMLElement) => ({
  width: parseFloat(box.style.width),
  height: parseFloat(box.style.height),
  left: parseFloat(box.style.left),
  top: parseFloat(box.style.top),
});

describe('the overlay is sized to the artwork, not to the card', () => {
  test('a cropped card gets the artwork rect, which overflows it', async () => {
    const box = measured(await renderCard());

    // 1:2 artwork covering 400 wide is 800 tall. The card is 200.
    expect(box.width).toBe(400);
    expect(box.height).toBe(800);

    // `object-position: top` pins the top edge, so the overflow hangs below.
    expect(box.top).toBe(0);
    expect(box.left).toBe(0);
  });

  /**
   * The assertion that speaks in the reporter's terms rather than the DOM's:
   * a sticker at y = 0.5 belongs halfway down the PICTURE. The old code made
   * that halfway down the CARD, which is a different place on any cropped image
   * — 400px down here against 100.
   */
  test('half way down the artwork is not half way down the card', async () => {
    const box = measured(await renderCard());

    const middleOfArtwork = box.top + box.height * 0.5;

    expect(middleOfArtwork).toBe(400);
    expect(middleOfArtwork).not.toBe(CARD.height * 0.5);
  });
});

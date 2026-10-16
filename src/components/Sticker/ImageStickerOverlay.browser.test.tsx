import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as RevealStore from '~/store/sticker-reveal.store';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * 🔴 THE BOX MUST FOLLOW THE MEDIA WHEN NOTHING FIRES A WINDOW RESIZE.
 *
 * The overlay used to be handed a pixel box worked out at mount and on window
 * `resize`. A sidebar closing, or a footer growing once its data arrived, moves
 * the picture without either — and a sticker placed against the stale box is
 * stored as a fraction of the wrong rectangle, so other viewers see it somewhere
 * else. Every check here changes the stage WITHOUT dispatching a resize.
 */

const IMAGE_ID = 74;

/** A 1x2 PNG: a real element with a natural size, whose pixels do not matter. */
const PORTRAIT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAIAAAAW4yFwAAAADklEQVR4nGNgaPjPAMQACgIC/2I9KX4AAAAASUVORK5CYII=';

const placement = {
  id: 1,
  imageId: IMAGE_ID,
  isPending: false,
  data: { cosmeticId: 9, x: 0.5, y: 0.5, scale: 0.25, rotation: 0, flip: false, opacity: 1 },
};

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));

type RevealState = { revealed: boolean; forced: boolean };

// Spreads the real module so the REAL `stickersRevealed` runs against the fake
// state: `revealed` defaults to false, which renders no placements at all.
vi.mock('~/store/sticker-reveal.store', async (importOriginal) => ({
  ...(await importOriginal<typeof RevealStore>()),
  useStickerRevealStore: (select: (state: RevealState) => unknown) =>
    select({ revealed: true, forced: false }),
}));

vi.mock('~/components/Sticker/placement.util', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementUtil>()),
  useStickerPlacements: () => ({ byImage: new Map([[IMAGE_ID, [placement]]]) }),
}));

vi.mock('~/components/Sticker/treatments/useStickerTreatment', () => ({
  useStickerTreatment: () => 'none',
}));

// Reduced to markers: what is asserted is the BOX these are given.
vi.mock('~/components/Sticker/StickerPlacementOverlay', () => ({
  StickerPlacementOverlay: () => <div data-testid="placements" />,
}));
vi.mock('~/components/Sticker/DraftStickerLayer', () => ({
  DraftStickerLayer: () => <div data-testid="draft" />,
}));

const { ImageStickerOverlay } = await import('~/components/Sticker/ImageStickerOverlay');

/**
 * The media is absolutely positioned and sized in percentages of the stage: the
 * harness mounts components without the app's stylesheet, so the overlay's own
 * `absolute inset-0` does nothing, and an in-flow image would push the overlay's
 * root below it and measure an offset no real page has. Percentages, so that
 * resizing the stage resizes the media with no help from the test.
 */
const renderStage = (src: string | null = PORTRAIT_PNG) => {
  renderWithProviders(
    <div data-testid="stage" style={{ position: 'relative', width: 400, height: 400 }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a fixture, not app markup. */}
      <img
        data-testid="media"
        src={src ?? undefined}
        alt=""
        style={{ position: 'absolute', left: '10%', top: '10%', width: '60%', height: '60%' }}
      />
      <ImageStickerOverlay imageId={IMAGE_ID} />
    </div>
  );
};

/** The overlay's positioned box, once it has been measured. */
const overlayBox = async () => {
  const marker = page.getByTestId('placements');
  await expect.element(marker, { timeout: 5000 }).toBeInTheDocument();
  return (await marker.element()).parentElement as HTMLElement;
};

/**
 * Inline style, not `offsetWidth`: the box positions itself with Tailwind's
 * `absolute`, which this harness does not load, so layout numbers would describe
 * normal flow rather than anything the component decided.
 */
const styleBox = (box: HTMLElement) => ({
  left: parseFloat(box.style.left),
  top: parseFloat(box.style.top),
  width: parseFloat(box.style.width),
  height: parseFloat(box.style.height),
});

const mediaRect = async () => {
  const media = (await page.getByTestId('media').element()) as HTMLElement;
  return {
    left: media.offsetLeft,
    top: media.offsetTop,
    width: media.offsetWidth,
    height: media.offsetHeight,
  };
};

describe('the overlay is the rendered media box', () => {
  test('it matches the media on first paint', async () => {
    renderStage();

    const box = await overlayBox();

    expect(styleBox(box)).toEqual({ left: 40, top: 40, width: 240, height: 240 });
    expect(styleBox(box)).toEqual(await mediaRect());
  });

  // The harness loads no stylesheet, so the class is all that can be pinned here.
  // It is what keeps the layer z-indexes in `placement-layers.ts` off the page's
  // own ladder: the box used to be a stacking context only by way of its
  // centring transform, which it no longer has.
  test('the box is its own stacking context', async () => {
    renderStage();

    expect((await overlayBox()).classList.contains('isolate')).toBe(true);
  });

  test('it follows the media when the stage resizes with no window resize', async () => {
    renderStage();
    const box = await overlayBox();

    // Not `window.dispatchEvent(new Event('resize'))`, and not a viewport change:
    // the sidebar toggling and a late footer fire neither.
    const stage = (await page.getByTestId('stage').element()) as HTMLElement;
    stage.style.width = '800px';
    stage.style.height = '600px';

    await expect
      .poll(() => styleBox(box), { timeout: 5000 })
      .toEqual({ left: 80, top: 60, width: 480, height: 360 });
    expect(styleBox(box)).toEqual(await mediaRect());
  });
});

describe('media that is not a plain image', () => {
  /**
   * A padding-ratio embed, the shape `YoutubeEmbed` renders: no height of its own,
   * so the visible box is all padding and its content box is zero tall.
   */
  test('an embed is measured by its border box, not its empty content box', async () => {
    renderWithProviders(
      <div data-testid="stage" style={{ position: 'relative', width: 400, height: 400 }}>
        <div
          data-testid="embed"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 300,
            height: 0,
            paddingBottom: '56.25%',
          }}
        >
          <iframe
            title="embed"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          />
        </div>
        <ImageStickerOverlay imageId={IMAGE_ID} />
      </div>
    );

    const box = styleBox(await overlayBox());
    const embed = (await page.getByTestId('embed').element()) as HTMLElement;

    // The wide-screen box a viewer actually sees, not the zero-tall content box.
    expect(box.width).toBe(300);
    expect(box.height).toBe(embed.offsetHeight);
    expect(box.height).toBeGreaterThan(0);
  });

  /**
   * A placement is a fraction of the picture, and a picture that did not load is
   * not one: the broken-image icon and its alt text would become the coordinate
   * system, and anything placed there is stored against a rectangle nobody else
   * sees.
   */
  /**
   * The other half of the guard: refusing an image with no picture must not mean
   * refusing it forever. The surface appears when the picture does, which only the
   * `load` listener can notice, since the box is already final by then.
   */
  test('the surface appears when the picture arrives', async () => {
    renderStage(null);

    await expect.element(page.getByTestId('media'), { timeout: 5000 }).toBeInTheDocument();
    const media = (await page.getByTestId('media').element()) as HTMLImageElement;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.querySelector('[data-testid="placements"]')).toBeNull();

    media.src = PORTRAIT_PNG;

    expect(styleBox(await overlayBox())).toEqual({ left: 40, top: 40, width: 240, height: 240 });
  });

  test('an image that failed to load is not a surface', async () => {
    renderStage('data:image/png;base64,AAAA');

    await expect.element(page.getByTestId('media'), { timeout: 5000 }).toBeInTheDocument();
    const media = (await page.getByTestId('media').element()) as HTMLImageElement;
    await expect.poll(() => media.complete, { timeout: 5000 }).toBe(true);
    expect(media.naturalWidth).toBe(0);
    // Laid out and non-zero, so a size check alone would let it through.
    expect(media.offsetWidth).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(document.querySelector('[data-testid="placements"]')).toBeNull();
  });
});

describe('placing', () => {
  test('the drag surface is the measured box, which mounts after the media is measured', async () => {
    useStickerPlacementDraftStore.setState({ targetImageId: IMAGE_ID, surface: null });
    renderStage();

    const box = await overlayBox();

    await expect.poll(() => useStickerPlacementDraftStore.getState().surface).toBe(box);

    useStickerPlacementDraftStore.setState({ targetImageId: null, surface: null });
  });
});

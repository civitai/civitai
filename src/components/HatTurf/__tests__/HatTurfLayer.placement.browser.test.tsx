import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as CardStickerOverlayModule from '~/components/Sticker/CardStickerOverlay';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsModule from '~/providers/BrowserSettingsProvider';

// The component project loads no global stylesheet, so Tailwind — including
// preflight's `box-sizing: border-box` — is inert unless a test imports it.
// Without this the card's footer measures 16px WIDER than the card and every
// utility class in the footer row is dead, which is a different layout from the
// one that ships. The wrap assertion below is only meaningful with it.
import '~/styles/globals.css';

const features = {
  stickerPlacement: false,
  imageCardInfoButton: false,
  imageGeneration: false,
  hatTurfFeedCard: true,
};
// The real badge renders null for an image with no stickers; the tip-row tests flip this.
const stickerBadge = { renders: true };

// Both provider mocks spread the real module. The card's import graph reaches other exports of
// each (`useOptionalFeatureFlags` via the impression hook, `useAutoplayGifs` via the nameplate),
// and a hand-listed mock that omits one fails the whole file at import, collecting 0 tests.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => features,
}));
const STICKER_HATS = [
  { cosmeticId: 11, usageCount: 3, lastUsedAt: null },
  { cosmeticId: 12, usageCount: 0, lastUsedAt: null },
];
const h = vi.hoisted(() => ({
  hats: [] as {
    cosmeticId: number;
    usageCount: number;
    lastUsedAt: null;
    art?: { url: string; canvas?: number[]; bounds?: number[] } | null;
  }[],
  stock: { available: 3, optedIn: true },
  mutate: vi.fn(),
  optIn: vi.fn(),
  invalidate: vi.fn(async () => undefined),
  user: { id: 1 } as { id: number } | null,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy(
      {
        'hatTurf.getStock': { useQuery: () => ({ data: h.stock, isLoading: false }) },
        'hatTurf.getMyStickerHats': { useQuery: () => ({ data: h.hats }) },
        'event.getMyHats': {
          useQuery: () => ({
            data: [
              { cosmeticId: 11, name: 'Party Cap' },
              { cosmeticId: 12, name: 'Top Hat' },
            ],
          }),
        },
        'hatTurf.place': { useMutation: () => ({ isPending: false, mutate: h.mutate }) },
        'hatTurf.setOptIn': { useMutation: () => ({ isPending: false, mutate: h.optIn }) },
      },
      {
        useUtils: () => ({
          hatTurf: {
            getStock: { invalidate: h.invalidate },
            getSummaries: { invalidate: h.invalidate },
            getStickersForImages: { invalidate: h.invalidate },
          },
        }),
      }
    ),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () =>
    h.user ? { ...h.user, isModerator: false, muted: false, filePreferences: {} } : null,
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsModule>()),
  useBrowsingSettings: <T,>(selector: (state: { autoplayGifs: boolean }) => T) =>
    selector({ autoplayGifs: false }),
}));
vi.mock('~/components/Image/Providers/ImagesProvider', () => ({
  useImagesContext: () => ({ getImages: () => [] }),
}));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', () => ({
  ImageContextMenu: () => null,
}));
vi.mock('~/components/Image/Remix/CardRemixButton', () => ({ CardRemixButton: () => null }));
vi.mock('~/components/UserAvatar/UserAvatarSimple', () => ({
  UserAvatarSimple: () => <span>user</span>,
}));
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  function ImageGuard2({ children }: { children: (safe: boolean) => ReactNode }) {
    return <>{children(true)}</>;
  }
  ImageGuard2.BlurToggle = function BlurToggle() {
    return null;
  };
  return { ImageGuard2 };
});
vi.mock('~/components/LoginPopover/LoginPopover', () => ({
  LoginPopover: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('~/components/Sticker/StickerPlacementCardBadge', () => ({
  StickerPlacementCardBadge: () =>
    stickerBadge.renders ? (
      <button data-testid="sticker-badge" style={{ height: 26 }}>
        stickers
      </button>
    ) : null,
}));
vi.mock('~/components/Sticker/CardStickerOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof CardStickerOverlayModule>()),
  CardStickerOverlay: () => null,
}));
vi.mock('~/components/Buzz/InteractiveTipBuzzButton', () => ({
  InteractiveTipBuzzButton: ({ children }: { children: ReactNode }) => <>{children}</>,
  useBuzzTippingStore: () => 0,
}));

vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalTopic: () => undefined,
  useSignalConnection: () => undefined,
}));

import { act, useEffect } from 'react';
import { HatTurfCardProvider, useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import { HatTurfLayer } from '~/components/HatTurf/HatTurfLayer';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import { renderWithProviders } from '../../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';
import { HAT_MAX_SCALE } from '~/server/schema/turf.schema';

const svg = (w: number, h: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#3b5bdb"/></svg>`
  )}`;

function OpenDraft() {
  const card = useHatTurfCard();
  useEffect(() => card?.setDraft({ x: 0.5, y: 0.5 }), []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

const CARD = { width: 171, height: 228 };

type Fit = 'contain' | 'cover';

function renderPictures(pictures: [Fit, [number, number]][], card = CARD) {
  return renderWithProviders(
    <TurfSummaryContext.Provider
      value={{
        event: 'birthday2026',
        arm: 'control',
        team: 'blue',
        images: {},
        open: {},
        stickers: {},
        joined: h.stock.optedIn,
        watch: () => () => undefined,
      }}
    >
      {pictures.map(([fit, natural], i) => (
        <HatTurfCardProvider key={i}>
          <div data-testid="frame" style={{ position: 'relative', overflow: 'hidden', ...card }}>
            <img
              src={svg(...natural)}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: fit, display: 'block' }}
            />
            <HatTurfLayer imageId={5 + i} />
            <OpenDraft />
          </div>
        </HatTurfCardProvider>
      ))}
    </TurfSummaryContext.Provider>
  );
}

const renderPicture = (fit: Fit, natural: [number, number]) => renderPictures([[fit, natural]]);

const q = (id: string) =>
  document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

/** Where the picture really is inside the frame, worked out here rather than read from the code under test. */
function drawnRect(fit: 'contain' | 'cover', [nw, nh]: [number, number], card = CARD) {
  const scale = (fit === 'contain' ? Math.min : Math.max)(card.width / nw, card.height / nh);
  const width = nw * scale;
  const height = nh * scale;
  return { left: (card.width - width) / 2, top: (card.height - height) / 2, width, height };
}

const BODY = '[aria-label="Sticker position: arrow keys to move"]';
const CORNER = 'span.cursor-nwse-resize.-bottom-1\\.5.-right-1\\.5';
const KNOB = 'span.cursor-grab';

/** The editor's element, once the layer has measured the picture and the draft is drawn. */
const editorPart = (selector: string) =>
  vi.waitFor(() => {
    const el = document.body.querySelector<HTMLElement>(selector);
    if (!el || !el.getBoundingClientRect().width) throw new Error(`no ${selector} yet`);
    return el;
  });

const centre = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

function pointer(
  type: string,
  at: { x: number; y: number },
  target: EventTarget,
  pointerType: 'mouse' | 'touch' = 'mouse'
) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType,
      buttons: 1,
      clientX: at.x,
      clientY: at.y,
    })
  );
}

/** A press on `part`, a move to `to`, and a release: the sticker editor's own gesture. */
async function drag(
  selector: string,
  to: { x: number; y: number },
  pointerType?: 'mouse' | 'touch'
) {
  const part = await editorPart(selector);
  pointer('pointerdown', centre(part), part, pointerType);
  pointer('pointermove', to, window, pointerType);
  pointer('pointerup', to, window, pointerType);
}

/** Presses "Place hat" and returns what was sent. */
const saved = async () => {
  const button = await vi.waitFor(() => {
    const el = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'Place hat'
    );
    if (!el) throw new Error('no Place hat button');
    return el;
  });
  button.click();
  expect(h.mutate).toHaveBeenCalledTimes(1);
  return h.mutate.mock.calls[0][0].data as {
    x: number;
    y: number;
    scale: number;
    rotation: number;
    flip: boolean;
    opacity: number;
  };
};

/** Until the picture has loaded the layer measures it as the card; a drag before then lands wrong. */
const measured = (fit: Fit, natural: [number, number], card = CARD) =>
  vi.waitFor(() => {
    const box = q('hat-turf-draft')?.parentElement;
    const rect = drawnRect(fit, natural, card);
    expect(parseFloat(box?.style.width ?? '0')).toBeCloseTo(rect.width, 0);
    expect(parseFloat(box?.style.height ?? '0')).toBeCloseTo(rect.height, 0);
  });

const frameAt = (fx: number, fy: number, fit: Fit, natural: [number, number]) => {
  const frame = q('frame')!.getBoundingClientRect();
  const rect = drawnRect(fit, natural);
  return {
    x: frame.left + rect.left + rect.width * fx,
    y: frame.top + rect.top + rect.height * fy,
  };
};

beforeEach(() => {
  h.hats = STICKER_HATS;
  h.stock = { available: 3, optedIn: true };
  h.user = { id: 1 };
  h.mutate.mockReset();
});
afterEach(() => cleanup());

describe('a hat is placed with the sticker editor', () => {
  test('a drag saves the spot as fractions of the drawn picture, not the letterboxed card', async () => {
    renderPicture('contain', [400, 100]);
    await editorPart(BODY);
    await measured('contain', [400, 100]);
    // Re-sent until it lands: a press before the layer has settled on the loaded picture's box
    // measures against the old one.
    await vi.waitFor(async () => {
      await drag(BODY, frameAt(0.25, 0.2, 'contain', [400, 100]));
      const root = (await editorPart(BODY)).parentElement!;
      expect(parseFloat(root.style.left)).toBeCloseTo(25, 0);
    });

    const pose = await saved();
    expect(pose.x).toBeCloseTo(0.25, 2);
    expect(pose.y).toBeCloseTo(0.2, 2);
  });

  test("a corner drag saves a bigger hat, stopping at a sticker's default ceiling", async () => {
    renderPicture('contain', [400, 300]);
    await drag(CORNER, { x: 5000, y: 5000 });

    expect((await saved()).scale).toBeCloseTo(HAT_MAX_SCALE, 10);
  });

  test('the rotate knob saves a rotation', async () => {
    renderPicture('contain', [400, 300]);
    const body = await editorPart(BODY);
    const c = centre(body);
    // Straight right of the hat's centre is a quarter turn.
    await drag(KNOB, { x: c.x + 80, y: c.y });

    expect((await saved()).rotation).toBeCloseTo(90, 0);
  });

  test('flip and the default opacity are saved with the pose', async () => {
    renderPicture('contain', [400, 300]);
    (await editorPart('[aria-label="Flip this sticker"]')).click();
    await vi.waitFor(() =>
      expect(document.body.querySelector('[aria-label="Unflip this sticker"]')).not.toBeNull()
    );

    const pose = await saved();
    expect(pose.flip).toBe(true);
    expect(pose.opacity).toBe(1);
  });

  test('on a cropped card the hat stays on the part the card shows', async () => {
    renderPicture('cover', [100, 400]);
    await editorPart(BODY);
    await measured('cover', [100, 400]);
    const frame = q('frame')!.getBoundingClientRect();
    await drag(BODY, { x: frame.left + CARD.width / 2, y: frame.top - 200 });

    const rect = drawnRect('cover', [100, 400]);
    const onCardY = rect.top + (await saved()).y * rect.height;
    expect(onCardY).toBeGreaterThanOrEqual(0);
    expect(onCardY).toBeLessThanOrEqual(CARD.height);
  });

  test('remove ends the placement and sends nothing', async () => {
    renderPicture('contain', [400, 300]);
    (await editorPart('[aria-label="Remove this sticker"]')).click();

    await vi.waitFor(() => expect(q('hat-turf-draft')).toBeNull());
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test('on a 390px card, touch moves and resizes the hat', async () => {
    const card = { width: 390, height: 520 };
    renderPictures([['contain', [390, 520]]], card);
    const frame = () => q('frame')!.getBoundingClientRect();
    await editorPart(BODY);
    await drag(BODY, { x: frame().left + 390 * 0.3, y: frame().top + 520 * 0.7 }, 'touch');
    await drag(CORNER, { x: 5000, y: 5000 }, 'touch');

    const pose = await saved();
    expect(pose.x).not.toBeCloseTo(0.5, 2);
    expect(pose.y).not.toBeCloseTo(0.5, 2);
    expect(pose.scale).toBeCloseTo(HAT_MAX_SCALE, 10);
  });

  test('the placed hat draws at its saved pose: width a fraction of the picture, rotation on the art', async () => {
    // Image-detail size: 25% of 700px is a 175px hat, past the old 96px cap.
    renderPictures([['contain', [700, 500]]], { width: 700, height: 500 });
    await measured('contain', [700, 500], { width: 700, height: 500 });
    await drag(CORNER, { x: 5000, y: 5000 });
    const body = await editorPart(BODY);
    const c = centre(body);
    await drag(KNOB, { x: c.x + 80, y: c.y });
    const pose = await saved();
    expect(pose.rotation).toBeCloseTo(90, 0);
    await act(async () => h.mutate.mock.calls[0][1].onSuccess());

    const placed = await editorPart('[data-testid="hat-turf-placed"]');
    const picture = drawnRect('contain', [700, 500], { width: 700, height: 500 });
    // The unrotated container is as wide as the art it holds.
    expect(placed.offsetWidth).toBeCloseTo(HAT_MAX_SCALE * picture.width, 0);
    const drawn = (placed.firstElementChild as HTMLElement).style.transform;
    expect(parseFloat(drawn.match(/rotate\(([-\d.]+)deg\)/)![1])).toBeCloseTo(pose.rotation, 2);
  });

  test("the draft and the placed hat draw the chosen hat's art", async () => {
    h.hats = [
      {
        ...STICKER_HATS[0],
        art: { url: 'party-cap-art', canvas: [128, 160], bounds: [24, 40, 104, 150] },
      },
      { ...STICKER_HATS[1], art: { url: 'top-hat-art' } },
    ];
    renderPicture('contain', [400, 300]);
    const artOf = (id: string) => q(id)?.querySelector('[data-testid="hat-turf-art"] img');
    await vi.waitFor(() => expect(artOf('hat-turf-draft')).toBeTruthy());
    expect(artOf('hat-turf-draft')!.getAttribute('src')).toContain('party-cap-art');
    expect(q('hat-turf-draft')!.querySelector('[data-testid="hat-turf-cone"]')).toBeNull();

    await saved();
    await act(async () => h.mutate.mock.calls[0][1].onSuccess());
    await vi.waitFor(() => expect(artOf('hat-turf-placed')).toBeTruthy());
    expect(artOf('hat-turf-placed')!.getAttribute('src')).toContain('party-cap-art');
    expect(q('hat-turf-placed')!.querySelector('[data-testid="hat-turf-cone"]')).toBeNull();
  });

  // The sticker layer draws every draft in the shared store with a buy button, so a hat
  // there would be offered for sale as a sticker.
  test("a hat being placed never joins the sticker tray's drafts", async () => {
    renderPicture('contain', [400, 300]);
    await editorPart(BODY);
    expect(useStickerPlacementDraftStore.getState().drafts).toEqual([]);
    expect(useStickerPlacementDraftStore.getState().targetImageId).toBeNull();
  });

  test('a chosen hat with no known art draws the team cone', async () => {
    renderPicture('contain', [400, 300]);
    await vi.waitFor(() =>
      expect(q('hat-turf-draft')?.querySelector('[data-testid="hat-turf-cone"]')).toBeTruthy()
    );
    expect(q('hat-turf-draft')!.querySelector('img')).toBeNull();
  });
});

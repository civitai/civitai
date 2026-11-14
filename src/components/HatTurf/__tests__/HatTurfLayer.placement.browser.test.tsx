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
  stock: { available: 3, optedIn: true } as {
    available: number;
    optedIn: boolean;
    expiry?: { ttlHours: number; rolloutAt: string | null } | null;
  },
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
            getImageStickers: { invalidate: h.invalidate },
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

/** Where the draft opens; reset before each test. */
const openAt = { x: 0.5, y: 0.5 };
function OpenDraft() {
  const card = useHatTurfCard();
  useEffect(() => card?.setDraft({ ...openAt }), []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

const CARD = { width: 171, height: 228 };

type Fit = 'contain' | 'cover';

function renderPictures(pictures: [Fit, [number, number]][], card = CARD, after?: ReactNode) {
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
            {after}
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
  Object.assign(openAt, { x: 0.5, y: 0.5 });
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
    const root = (await editorPart(CORNER)).parentElement!;
    await measured('contain', [400, 300]);
    const before = root.getBoundingClientRect().width;
    // Re-sent until it lands, as above: a press before the layer settles leaves the hat unscaled.
    await vi.waitFor(async () => {
      await drag(CORNER, { x: 5000, y: 5000 });
      expect(root.getBoundingClientRect().width).toBeGreaterThan(before);
    });

    expect((await saved()).scale).toBeCloseTo(HAT_MAX_SCALE, 10);
  });

  // The DraftSticker geometry tests cover what `knobFlips` does; this one fails if the hat
  // editor stops passing it, which is the fix a user at the top edge depends on.
  test('at the top of the picture the rotate knob hangs below the hat, inside the card', async () => {
    // On a 171px card the hat is small enough that its knob fits above even at the top edge;
    // on a 390px card it does not.
    const card = { width: 390, height: 520 };
    openAt.y = 0.02;
    renderPictures([['cover', [card.width, card.height]]], card);
    await editorPart(BODY);
    await vi.waitFor(() => {
      const knob = document.body.querySelector<HTMLElement>('[data-testid="draft-rotate-knob"]')!;
      const k = knob.getBoundingClientRect();
      const body = document.body.querySelector<HTMLElement>(BODY)!.getBoundingClientRect();
      const frame = q('frame')!.getBoundingClientRect();
      expect(body.height, 'hat drawn').toBeGreaterThan(0);
      expect(body.top - frame.top, 'hat at the top edge').toBeLessThan(k.height);
      expect(k.top - frame.top, "knob top, from the card's top").toBeGreaterThanOrEqual(0);
      expect(frame.bottom - k.bottom, "knob bottom, from the card's bottom").toBeGreaterThanOrEqual(
        0
      );
      expect(knob.dataset.knobBelow, 'knob hung below').toBe('true');
    });
  });

  test('the rotate knob saves a rotation', async () => {
    renderPicture('contain', [400, 300]);
    const body = await editorPart(BODY);
    const c = centre(body);
    // Straight right of the hat's centre is a quarter turn.
    await drag(KNOB, { x: c.x + 80, y: c.y });

    expect((await saved()).rotation).toBeCloseTo(90, 0);
  });

  // Decided: hats stay opaque, so the hat toolbar has no opacity control.
  test('flip is saved with the pose, and the hat is opaque with no opacity control', async () => {
    renderPicture('contain', [400, 300]);
    await editorPart(BODY);
    expect(document.body.querySelector('[aria-label="Set this sticker\'s opacity"]')).toBeNull();
    (await editorPart('[aria-label="Flip this sticker"]')).click();
    await vi.waitFor(() =>
      expect(document.body.querySelector('[aria-label="Unflip this sticker"]')).not.toBeNull()
    );

    const pose = await saved();
    expect(pose.flip).toBe(true);
    expect(pose.opacity).toBe(1);
  });

  test('the preview is mirrored when flipped, and upright again when unflipped', async () => {
    renderPicture('contain', [400, 300]);
    const body = await editorPart(BODY);
    const art = body.querySelector('[data-testid="hat-turf-art"], svg')!;
    const mirrored = () => {
      for (let el: Element | null = art; el && el !== body.parentElement; el = el.parentElement) {
        if (getComputedStyle(el).transform === 'matrix(-1, 0, 0, 1, 0, 0)') return true;
      }
      return false;
    };
    expect(mirrored()).toBe(false);
    (await editorPart('[aria-label="Flip this sticker"]')).click();
    await vi.waitFor(() => expect(mirrored()).toBe(true));
    (await editorPart('[aria-label="Unflip this sticker"]')).click();
    await vi.waitFor(() => expect(mirrored()).toBe(false));
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

  // There is no move: keep this warning until a placed hat can be moved.
  test("Place hat warns that a placed hat can't be moved afterwards", async () => {
    renderPicture('contain', [400, 100]);
    const button = await vi.waitFor(() => {
      const el = [...document.body.querySelectorAll('button')].find(
        (b) => b.textContent === 'Place hat'
      );
      if (!el) throw new Error('no Place hat button');
      return el;
    });
    expect(button.getAttribute('aria-label')).toMatch(/can't be moved afterwards/);
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

// AspectRatioImageCard paints its header and footer chips over the picture as later, unstacked
// siblings of the hat layer. A z-index on the resting layer put hats over the reaction counts and
// the hat button (tester report, 2026-11-06); only the hat being placed may sit on top of them.
describe('hats and the card chips painted over the picture', () => {
  // Hats take no pointer events, so hit-testing can't see them until they do. The card's hover
  // zoom is on too: its transform makes the layer a stacking context, which caps a draft's own
  // z-index under the chips unless the layer itself is raised.
  const hoveredAndHitTestable = () => {
    const style = document.createElement('style');
    style.textContent = [
      '[data-testid="hat-turf-layer"], [data-testid="hat-turf-layer"] * { pointer-events: auto !important; }',
      '[data-sticker-overlay] { transform: scale(1.05) rotate(0.02deg); }',
    ].join('\n');
    document.head.appendChild(style);
    return () => style.remove();
  };
  const chip = <div data-testid="chip" style={{ position: 'absolute', inset: 0 }} />;
  const topAt = (el: HTMLElement) => {
    const { x, y } = centre(el);
    return document.elementFromPoint(x, y);
  };

  test('a placed hat sits under the chips; the hat being placed sits over them', async () => {
    const restore = hoveredAndHitTestable();
    try {
      renderPictures([['contain', [700, 500]]], { width: 700, height: 500 }, chip);
      await measured('contain', [700, 500], { width: 700, height: 500 });
      const draft = await editorPart(BODY);
      expect(
        q('hat-turf-layer')!.contains(topAt(draft)),
        'the hat being placed is under the chips'
      ).toBe(true);

      await saved();
      await act(async () => h.mutate.mock.calls[0][1].onSuccess());
      const placed = await editorPart('[data-testid="hat-turf-placed"]');
      expect(topAt(placed), 'a placed hat paints over the chips').toBe(q('chip'));
    } finally {
      restore();
    }
  });
});

describe("the viewer's own hat says how long it keeps counting", () => {
  const POSE = { x: 0.5, y: 0.4, scale: 0.25, rotation: 0, flip: false };
  // Placed 2h 1m ago: 45h 59m of a 48h lifetime left.
  const hat = (userId: number) => ({
    id: userId,
    userId,
    team: 'blue',
    cosmeticId: 11,
    data: POSE,
    createdAt: new Date(Date.now() - 121 * 60_000),
  });
  const renderHats = (stickers: ReturnType<typeof hat>[]) =>
    renderWithProviders(
      <TurfSummaryContext.Provider
        value={{
          event: 'birthday2026',
          arm: 'control',
          team: 'blue',
          images: {},
          open: {},
          stickers: {},
          joined: true,
          watch: () => () => undefined,
        }}
      >
        <HatTurfCardProvider>
          <div style={{ position: 'relative', overflow: 'hidden', ...CARD }}>
            <img
              src={svg(300, 400)}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            <HatTurfLayer imageId={5} stickers={stickers} />
          </div>
        </HatTurfCardProvider>
      </TurfSummaryContext.Provider>
    );
  const timeLeft = () =>
    document.body.querySelectorAll<HTMLElement>('[data-testid="hat-turf-time-left"]');

  test("on the viewer's own hat only, in whole hours", async () => {
    h.stock = { ...h.stock, expiry: { ttlHours: 48, rolloutAt: null } };
    renderHats([hat(2), hat(1)]);
    await vi.waitFor(() => expect(timeLeft()).toHaveLength(1));
    expect(timeLeft()[0].textContent).toBe('45h left');
  });

  test('an own hat past its lifetime shows nothing and rereads the hats', async () => {
    h.stock = { ...h.stock, expiry: { ttlHours: 2, rolloutAt: null } };
    h.invalidate.mockClear();
    renderHats([hat(1)]);
    await vi.waitFor(() => expect(h.invalidate).toHaveBeenCalled());
    expect(timeLeft()).toHaveLength(0);
  });

  test('nothing while hats do not expire', async () => {
    renderHats([hat(1)]);
    await vi.waitFor(() => expect(q('hat-turf-hat')).not.toBeNull());
    expect(timeLeft()).toHaveLength(0);
  });
});

describe('the hats follow the picture when it moves without resizing', () => {
  // The detail view's sticker timeline pads the media's container: a width-limited video re-centres
  // without changing size, and neither the layer nor the picture resizes. The padded box is the
  // layer's own parent, or a container between it and the picture.
  test.each([
    ['a container between the picture and the layer', 'stage'],
    ["the layer's own parent", 'frame'],
  ])('padding on %s moves the hats with the picture', async (_, padded) => {
    const centred = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxSizing: 'border-box',
    } as const;
    const picture = (
      <img src={svg(120, 80)} alt="" style={{ width: 120, height: 80, display: 'block' }} />
    );
    renderWithProviders(
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
        <HatTurfCardProvider>
          <div
            data-testid="frame"
            style={{ position: 'relative', overflow: 'hidden', ...CARD, ...centred }}
          >
            {padded === 'stage' ? (
              <div data-testid="stage" style={{ position: 'absolute', inset: 0, ...centred }}>
                {picture}
              </div>
            ) : (
              picture
            )}
            <HatTurfLayer imageId={5} />
            <OpenDraft />
          </div>
        </HatTurfCardProvider>
      </TurfSummaryContext.Provider>
    );
    const top = () => parseFloat(q('hat-turf-draft')?.parentElement?.style.top ?? 'NaN');
    await vi.waitFor(() => expect(top()).toBeCloseTo((CARD.height - 80) / 2, 0));
    q(padded)!.style.paddingBottom = '132px';
    await vi.waitFor(() => expect(top()).toBeCloseTo((CARD.height - 132 - 80) / 2, 0));
  });
});

describe('how many hats a card draws, and the overflow chip', () => {
  const POSE = { x: 0.5, y: 0.4, scale: 0.12, rotation: 0, flip: false };
  const crowd = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: 100 + i,
      userId: 100 + i,
      team: 'blue',
      cosmeticId: 11,
      data: { ...POSE, x: 0.1 + (i % 8) * 0.1 },
      createdAt: new Date(Date.now() - i * 60_000),
    }));
  // 14 hats counted on the image, more than any card draws.
  const render = (
    card: { width: number; height: number },
    layer: Partial<React.ComponentProps<typeof HatTurfLayer>>,
    drawn = 12
  ) =>
    renderWithProviders(
      <TurfSummaryContext.Provider
        value={{
          event: 'birthday2026',
          arm: 'control',
          team: 'blue',
          images: {
            5: {
              shown: { blue: 14 },
              counted: { blue: 14 },
              leader: 'blue',
              leaderCosmeticId: 11,
              hatted: false,
              hattedTeam: null,
            },
          },
          open: {},
          stickers: {},
          joined: true,
          watch: () => () => undefined,
        }}
      >
        <HatTurfCardProvider>
          <div style={{ position: 'relative', overflow: 'hidden', ...card }}>
            <img
              src={svg(card.width, card.height)}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            <HatTurfLayer imageId={5} stickers={crowd(drawn)} {...layer} />
          </div>
        </HatTurfCardProvider>
      </TurfSummaryContext.Provider>
    );
  const hats = () => document.body.querySelectorAll('[data-testid="hat-turf-hat"]').length;

  test('a feed card draws 10 hats and no "+N" chip', async () => {
    render({ width: 300, height: 400 }, {});
    await vi.waitFor(() => expect(hats()).toBe(10));
    expect(q('hat-turf-more')).toBeNull();
  });

  test('a narrow feed card draws 3 hats and no chip', async () => {
    render(CARD, {});
    await vi.waitFor(() => expect(hats()).toBe(3));
    expect(q('hat-turf-more')).toBeNull();
  });

  test('the image detail keeps its "+N more" button', async () => {
    const onMore = vi.fn();
    render({ width: 300, height: 400 }, { source: 'image-detail', drawLimit: 10, onMore });
    await vi.waitFor(() => expect(q('hat-turf-more')?.textContent).toContain('+4 more'));
    expect(hats()).toBe(10);
    q('hat-turf-more')!.click();
    expect(onMore).toHaveBeenCalledOnce();
  });
});

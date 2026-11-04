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
const h = vi.hoisted(() => ({
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
        'hatTurf.getMyStickerHats': {
          useQuery: () => ({
            data: [
              { cosmeticId: 11, usageCount: 3, lastUsedAt: null },
              { cosmeticId: 12, usageCount: 0, lastUsedAt: null },
            ],
          }),
        },
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

import { useEffect } from 'react';
import { HatTurfCardProvider, useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import { HatTurfLayer } from '~/components/HatTurf/HatTurfLayer';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import { renderWithProviders } from '../../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';

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
function drawnRect(fit: 'contain' | 'cover', [nw, nh]: [number, number]) {
  const scale = (fit === 'contain' ? Math.min : Math.max)(CARD.width / nw, CARD.height / nh);
  const width = nw * scale;
  const height = nh * scale;
  return { left: (CARD.width - width) / 2, top: (CARD.height - height) / 2, width, height };
}

// Re-sends the move until the layer has re-measured and the draft has landed: a single dispatch
// can arrive before the layer has measured the picture and be dropped.
async function dragTo(px: number, py: number, landed: () => boolean) {
  await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
  await vi.waitFor(() => {
    const frame = q('frame')!.getBoundingClientRect();
    q('hat-turf-draft')!.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        buttons: 1,
        pointerType: 'mouse',
        clientX: frame.left + px,
        clientY: frame.top + py,
      })
    );
    expect(landed()).toBe(true);
  });
}

const savedSpot = () => {
  (document.body.querySelector('[aria-label^="Place hat"]') as HTMLElement).click();
  return h.mutate.mock.calls.at(-1)![0].data as { x: number; y: number };
};

beforeEach(() => {
  h.stock = { available: 3, optedIn: true };
  h.user = { id: 1 };
  h.mutate.mockReset();
});
afterEach(() => cleanup());

describe('hat placement against the drawn picture', () => {
  test('a wide picture letterboxed in a tall card: spots are fractions of the picture, not the card', async () => {
    renderPicture('contain', [400, 100]);
    const rect = drawnRect('contain', [400, 100]);
    // A quarter of the way across the picture and a fifth of the way down it.
    await dragTo(
      rect.left + rect.width * 0.25,
      rect.top + rect.height * 0.2,
      () => q('hat-turf-draft')!.style.left === '25%'
    );
    const spot = savedSpot();
    expect(spot.x).toBeCloseTo(0.25, 2);
    expect(spot.y).toBeCloseTo(0.2, 2);
    // The draft sits where the pointer is, on screen.
    const frame = q('frame')!.getBoundingClientRect();
    const hat = q('hat-turf-draft')!.getBoundingClientRect();
    expect(hat.left + hat.width / 2 - frame.left).toBeCloseTo(rect.left + rect.width * 0.25, 0);
    expect(hat.top + hat.height / 2 - frame.top).toBeCloseTo(rect.top + rect.height * 0.2, 0);
  });

  test('a tall picture cropped by the card: the hat cannot be dragged into the cropped part', async () => {
    renderPicture('cover', [100, 400]);
    const rect = drawnRect('cover', [100, 400]);
    // The picture is far taller than the card; the pointer is dragged out past the card's top edge.
    // The drag was applied (the draft left its starting spot) before anything is asserted about it.
    await dragTo(CARD.width / 2, -30, () => q('hat-turf-draft')!.style.top !== '50%');
    const frame = q('frame')!.getBoundingClientRect();
    await vi.waitFor(() => {
      const hat = q('hat-turf-draft')!.getBoundingClientRect();
      expect(hat.top + hat.height / 2).toBeGreaterThanOrEqual(frame.top);
    });
    const spot = savedSpot();
    const onCardY = rect.top + spot.y * rect.height;
    expect(onCardY).toBeGreaterThanOrEqual(0);
    expect(onCardY).toBeLessThanOrEqual(CARD.height);
  });

  test('a wide picture cropped by a tall card draws the same size hat as a tall one', async () => {
    renderPictures([
      ['cover', [900, 1600]],
      ['cover', [1600, 900]],
    ]);
    let widths: number[] = [];
    await vi.waitFor(() => {
      const drafts = [
        ...document.body.querySelectorAll<HTMLElement>('[data-testid="hat-turf-draft"]'),
      ];
      expect(drafts).toHaveLength(2);
      // Until the wide picture has loaded it measures as the card, which would pass vacuously.
      expect(parseFloat(drafts[1].parentElement!.style.width)).toBeGreaterThan(CARD.width * 2);
      widths = drafts.map((draft) => draft.querySelector('svg')!.getBoundingClientRect().width);
    });
    const [tall, wide] = widths;
    expect(tall).toBeGreaterThan(0);
    expect(wide).toBeCloseTo(tall, 0);
  });

  test('a big image-detail picture caps the hat at 96px', async () => {
    // 700px wide at the default scale would be a 154px hat.
    renderPictures([['contain', [700, 500]]], { width: 700, height: 500 });
    await vi.waitFor(() => {
      const draft = q('hat-turf-draft');
      expect(draft).not.toBeNull();
      // Until the picture has measured, the hat is drawn at the 22px floor.
      expect(draft!.querySelector('svg')!.getBoundingClientRect().width).toBeGreaterThan(22);
    });
    expect(q('hat-turf-draft')!.querySelector('svg')!.getBoundingClientRect().width).toBe(96);
  });
});

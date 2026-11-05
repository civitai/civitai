import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as CardStickerOverlayModule from '~/components/Sticker/CardStickerOverlay';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsModule from '~/providers/BrowserSettingsProvider';
import type * as TrackUtilsModule from '~/components/TrackView/track.utils';
import type * as UseExperimentModule from '~/components/Experiments/useExperiment';

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
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof Trpc>()), trpc: makeTrpcProxy() };
});
const trackAction = vi.hoisted(() =>
  vi.fn<(data: unknown) => Promise<void>>(async () => undefined)
);
vi.mock('~/components/TrackView/track.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackUtilsModule>()),
  useTrackEvent: () => ({ trackAction }),
}));
vi.mock('~/components/Experiments/useExperiment', async (importOriginal) => ({
  ...(await importOriginal<typeof UseExperimentModule>()),
  useExperiment: (_key: string, opts?: { enabled?: boolean }) =>
    opts?.enabled === false
      ? { ready: false, variant: undefined, assignment: undefined }
      : { ready: true, variant: 'control', assignment: 'rule' },
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false, muted: false, filePreferences: {} }),
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

import { ImageCard } from '~/components/Cards/ImageCard';
import { resetExperimentExposuresForTests } from '~/components/Experiments/useExperimentExposure';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import { HatTurfBadge } from '~/components/HatTurf/HatTurfBadge';
import detailClasses from '~/components/HatTurf/detail/HatTurfDetailControls.module.css';
import type { TurfSummaries } from '~/components/HatTurf/TurfSummaryProvider';
import { renderWithProviders, LOADABLE_IMAGE_DATA_URI } from '../../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { MediaType } from '~/shared/utils/prisma/enums';

const PHONE_CARD = 171; // a 2-up grid on a 390px phone

const image = {
  id: 1,
  url: LOADABLE_IMAGE_DATA_URI,
  type: MediaType.image,
  name: 'card.png',
  metadata: null,
  nsfwLevel: 1,
  width: 700,
  height: 900,
  hasMeta: false,
  poi: false,
  reactions: [],
  user: { id: 2, username: 'someone' },
  stats: { likeCountAllTime: 1082, heartCountAllTime: 12400, tippedAmountCountAllTime: 25000 },
} as any;

const counted = { blue: 6, pink: 4, green: 2, yellow: 1 };
const standing = (over: Partial<TurfSummaries['images'][number]> = {}) => ({
  shown: counted,
  counted,
  leader: 'blue',
  leaderCosmeticId: 11,
  hatted: false,
  hattedTeam: null,
  ...over,
});

function renderCard(opts: {
  width?: number;
  feed?: TurfSummaries | null;
  scheme?: 'light' | 'dark';
}) {
  const { width = PHONE_CARD, feed, scheme = 'dark' } = opts;
  document.documentElement.setAttribute('data-mantine-color-scheme', scheme);
  renderWithProviders(
    <TurfSummaryContext.Provider value={feed === undefined ? null : feed}>
      <IntersectionObserverProvider>
        <div data-testid="card-root" style={{ width }} onClick={onCardClick}>
          <ImageCard data={image} />
        </div>
      </IntersectionObserverProvider>
    </TurfSummaryContext.Provider>
  );
}
const onCardClick = vi.fn();
const tracked = (type: string) =>
  trackAction.mock.calls.map(([data]) => data as { type: string }).filter((d) => d.type === type);

const badge = () =>
  document.body.querySelector('[data-testid="hat-turf-badge"]') as HTMLElement | null;
const feedWith = (
  images: TurfSummaries['images'],
  team: string | null = 'blue',
  arm: TurfSummaries['arm'] = 'control',
  open: TurfSummaries['open'] = {}
): TurfSummaries => ({
  event: 'birthday2026',
  arm,
  team,
  images,
  open,
  stickers: {},
  joined: true,
  watch: () => () => undefined,
});

afterEach(() => {
  cleanup();
  trackAction.mockClear();
  onCardClick.mockClear();
  resetExperimentExposuresForTests();
  localStorage.removeItem('experiment-exposures');
  document.documentElement.removeAttribute('data-mantine-color-scheme');
});

describe('Hat Turf badge on a feed ImageCard', () => {
  test('draws the ring, the leader colour and the count', async () => {
    renderCard({ feed: feedWith({ 1: standing() }) });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    const el = badge()!;
    expect(el.dataset.leader).toBe('blue');
    // One arc per team, in the ring's SVG.
    expect(el.querySelectorAll('circle[data-team]').length).toBe(4);
    expect(el.querySelector('[data-testid="hat-turf-count"]')!.textContent).toBe('6');
    // The disc is filled with the leader's colour, not white.
    const fill = getComputedStyle(el.querySelector('[data-testid="hat-turf-disc-fill"]')!).fill;
    expect(fill).not.toBe('rgb(255, 255, 255)');
    expect(fill).not.toBe('none');
    expect(el.getAttribute('aria-label')).toContain('blue leads with 6');
    // The badge sits inside the card, top left, and stays inside it.
    const card = document.querySelector('[data-testid="card-root"]')!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    expect(box.left - card.left).toBeLessThan(16);
    expect(box.top - card.top).toBeLessThan(16);
    expect(box.right).toBeLessThanOrEqual(card.right);
  });

  const parts = () => {
    const el = badge()!;
    const count = el.querySelector('[data-testid="hat-turf-count"]') as HTMLElement | null;
    const disc = el.querySelector('[data-testid="hat-turf-disc"]') as HTMLElement;
    const arc = (team: string) =>
      getComputedStyle(el.querySelector(`circle[data-team="${team}"]`) as SVGElement).stroke;
    const discFill = () =>
      getComputedStyle(el.querySelector('[data-testid="hat-turf-disc-fill"]') as SVGElement).fill;
    return { el, count, disc, arc, discFill };
  };
  const centre = (r: DOMRect) => [r.left + r.width / 2, r.top + r.height / 2];

  test('one digit sits centred in the disc, with no hat behind it', async () => {
    renderCard({ feed: feedWith({ 1: standing() }, 'pink') });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    const { count, disc } = parts();
    expect(disc.contains(count)).toBe(true);
    const [cx, cy] = centre(count!.getBoundingClientRect());
    const [dx, dy] = centre(disc.getBoundingClientRect());
    expect(Math.abs(cx - dx)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(cy - dy)).toBeLessThanOrEqual(2);
    expect(disc.querySelector('svg')).toBeNull();
  });

  test('no dot on the ring, even where the viewer’s own team has an arc', async () => {
    renderCard({ feed: feedWith({ 1: standing() }, 'pink') });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    expect(badge()!.querySelector('circle[data-team="pink"]')).not.toBeNull();
    expect(badge()!.querySelector('[data-testid="hat-turf-mine"]')).toBeNull();
    expect(badge()!.textContent).toBe('6');
  });

  test('a protected image fills the disc with the holding team; the ring still shows the leader', async () => {
    renderCard({
      feed: feedWith({ 1: standing({ hatted: true, hattedTeam: 'pink' }) }, 'blue'),
    });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    const { el, disc, arc, count, discFill } = parts();
    expect(el.dataset.leader).toBe('blue');
    expect(count!.textContent).toBe('6');
    expect(discFill()).toBe(arc('pink'));
    expect(el.getAttribute('aria-label')).toContain('A pink hat protects this image');
    // The lock sits beside the dial, in the badge's chip.
    const lock = el.querySelector('[data-testid="hat-turf-badge-lock"]')!.getBoundingClientRect();
    expect(disc.contains(el.querySelector('[data-testid="hat-turf-badge-lock"]'))).toBe(false);
    expect(lock.left).toBeGreaterThanOrEqual(disc.getBoundingClientRect().right);
    expect(getComputedStyle(el).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('an unprotected image fills the disc with the leader', async () => {
    renderCard({ feed: feedWith({ 1: standing() }, 'pink') });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    const { arc, discFill } = parts();
    expect(discFill()).toBe(arc('blue'));
  });

  test('control arm: tapping the badge opens the card, not the standings', async () => {
    renderCard({ feed: feedWith({ 1: standing() }, 'pink') });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    expect(badge()!.tagName).toBe('DIV');
    expect(getComputedStyle(badge()!).pointerEvents).toBe('none');
    const { left, top, width, height } = badge()!.getBoundingClientRect();
    const hit = document.elementFromPoint(left + width / 2, top + height / 2) as HTMLElement;
    expect(badge()!.contains(hit)).toBe(false);
    hit.click();
    expect(onCardClick).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="hat-turf-standings"]')).toBeNull();
    expect(tracked('HatTurf_Action')).toEqual([]);
  });

  test('badge-popover arm: tapping the badge opens every team’s count without opening the card', async () => {
    renderCard({ feed: feedWith({ 1: standing() }, 'pink', 'badge-popover') });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    const tap = new MouseEvent('click', { bubbles: true, cancelable: true });
    badge()!.dispatchEvent(tap);
    // The card is a link: without this the tap would also navigate to the image.
    expect(tap.defaultPrevented).toBe(true);
    const standings = () =>
      document.body.querySelector('[data-testid="hat-turf-standings"]') as HTMLElement | null;
    await vi.waitFor(() => expect(standings()).not.toBeNull());
    const rows = [...standings()!.querySelectorAll('[data-team]')].map(
      (el) => (el as HTMLElement).dataset.team
    );
    expect(rows).toEqual(['blue', 'pink', 'green', 'yellow']);
    expect(standings()!.textContent).toContain('pink · you');
    expect(
      document.body.querySelector('[data-testid="hat-turf-standings-note"]')!.textContent
    ).toBe('blue holds this image. pink needs 3 more to take it.');
    standings()!.click();
    expect(onCardClick).not.toHaveBeenCalled();
    expect(tracked('HatTurf_Action')).toHaveLength(1);
    expect(trackAction).toHaveBeenCalledWith({
      type: 'HatTurf_Action',
      details: { action: 'hat_count_open', event: 'birthday2026', surface: 'feed-card' },
    });
    badge()!.click();
    await vi.waitFor(() => expect(badge()!.getAttribute('aria-expanded')).toBe('false'));
    expect(tracked('HatTurf_Action')).toHaveLength(1);
  });

  test.each(['control', 'badge-popover'] as const)(
    '%s arm: logs one exposure from the badge, even on a card with no hat button',
    async (arm) => {
      renderCard({ feed: feedWith({ 1: standing() }, 'pink', arm, { 1: false }) });
      await vi.waitFor(() => expect(badge()).not.toBeNull());
      expect(document.body.querySelector('[data-testid="hat-turf-button"]')).toBeNull();
      await vi.waitFor(() =>
        expect(tracked('Experiment_Exposure')).toEqual([
          {
            type: 'Experiment_Exposure',
            details: {
              exp: 'hatTurfFeedCard',
              variant: 'control',
              assignment: 'rule',
              surface: 'feed-card',
            },
          },
        ])
      );
    }
  );

  test('logs no feed exposure on a surface outside the experiment', async () => {
    renderCard({ feed: feedWith({ 1: standing() }, 'pink', null) });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(tracked('Experiment_Exposure')).toEqual([]);
  });

  test('a hat-protected image keeps its badge, with a lock, and says why in the popover', async () => {
    renderCard({ feed: feedWith({ 1: standing({ hatted: true }) }, 'pink', 'badge-popover') });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    expect(badge()!.querySelector('[data-testid="hat-turf-badge-lock"]')).not.toBeNull();
    expect(badge()!.getAttribute('aria-label')).toContain('A hat protects this image');
    badge()!.click();
    await vi.waitFor(() =>
      expect(
        document.body.querySelector('[data-testid="hat-turf-standings-note"]')?.textContent
      ).toMatch(/A hat protects this image/)
    );
  });

  test('no lock on an unprotected image', async () => {
    renderCard({ feed: feedWith({ 1: standing() }) });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    expect(badge()!.querySelector('[data-testid="hat-turf-badge-lock"]')).toBeNull();
  });

  // The card itself must be on screen first, or "no badge" would also pass for a card that never rendered.
  const cardRendered = () =>
    vi.waitFor(() =>
      expect(document.body.querySelector('[aria-label$="reaction"]')).not.toBeNull()
    );

  test('is absent for an image with no turf', async () => {
    renderCard({ feed: feedWith({}) });
    await cardRendered();
    expect(badge()).toBeNull();
  });

  test('is absent when Hat Turf is off for the viewer', async () => {
    renderCard({ feed: null });
    await cardRendered();
    expect(badge()).toBeNull();
  });

  test('an image with stickers but no counted hats gets the neutral badge', async () => {
    renderCard({
      feed: feedWith({
        1: standing({ counted: { blue: 0, pink: 0 }, shown: { blue: 2 }, leader: null }),
      }),
    });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    expect(badge()!.dataset.leader).toBe('');
    expect(badge()!.querySelector('[data-testid="hat-turf-count"]')).toBeNull();
  });

  test('9, the largest count that stays inside the disc', async () => {
    renderCard({
      feed: feedWith({ 1: standing({ counted: { blue: 9, pink: 4 }, leader: 'blue' }) }),
    });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    const { count, disc } = parts();
    expect(count!.textContent).toBe('9');
    expect(disc.contains(count)).toBe(true);
  });

  test.each([
    [10, '10'],
    [42, '42'],
    [1240, '1.2k'],
  ])('%s: the count moves beside the dial and the hat takes the disc', async (lead, shown) => {
    renderCard({
      feed: feedWith({ 1: standing({ counted: { blue: lead, pink: 9 }, leader: 'blue' }) }),
    });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    const { el, count, disc } = parts();
    expect(count!.textContent).toBe(shown);
    expect(disc.contains(count)).toBe(false);
    expect(count!.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      disc.getBoundingClientRect().right
    );
    expect(disc.querySelector('svg')).not.toBeNull();
    expect(getComputedStyle(el).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    // Still inside a phone card.
    const card = document.querySelector('[data-testid="card-root"]')!.getBoundingClientRect();
    expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(card.right);
  });

  test('the detail action row draws the dial at its 36px', async () => {
    document.documentElement.setAttribute('data-mantine-color-scheme', 'dark');
    renderWithProviders(
      <TurfSummaryContext.Provider value={feedWith({ 1: standing() })}>
        <HatTurfBadge imageId={1} className={detailClasses.rowBadge} />
      </TurfSummaryContext.Provider>
    );
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    const ring = badge()!.querySelector('svg')!.getBoundingClientRect();
    expect(ring.width).toBe(36);
    expect(badge()!.getBoundingClientRect().height).toBe(36);
  });

  // Rows place the badge at fractional x (centred content, odd gaps), and the disc was painted a
  // pixel left of its ring there. Measured on pixels: layout boxes were centred all along.
  test.each(
    [0, 0.25, 0.5, 0.75].flatMap((offset) => [
      { surface: 'feed', className: undefined, offset },
      { surface: 'detail row', className: detailClasses.rowBadge, offset },
    ])
  )(
    'the $surface disc is painted at the centre of its ring at x+$offset px',
    async ({ className, offset }) => {
      document.documentElement.setAttribute('data-mantine-color-scheme', 'dark');
      renderWithProviders(
        <TurfSummaryContext.Provider
          value={feedWith({
            1: standing({
              counted: { blue: 6 },
              shown: { blue: 6 },
              hatted: true,
              hattedTeam: 'pink',
            }),
          })}
        >
          <div style={{ paddingLeft: 10 + offset, paddingTop: 10, width: 80, background: '#000' }}>
            <HatTurfBadge imageId={1} className={className} />
          </div>
        </TurfSummaryContext.Provider>
      );
      await vi.waitFor(() => expect(badge()).not.toBeNull());
      const dial = badge()!.firstElementChild as HTMLElement;
      const base64 = await page.screenshot({ element: dial, base64: true, save: false });
      const bitmap = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${base64}`)).blob()
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      // Horizontal centroid of each colour, weighted by how strongly a pixel is that colour.
      let blueW = 0,
        blueX = 0,
        pinkW = 0,
        pinkX = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
          const blue = Math.max(0, b - r);
          const pink = Math.max(0, r - g - 40);
          blueW += blue;
          blueX += blue * x;
          pinkW += pink;
          pinkX += pink * x;
        }
      expect(Math.abs(blueX / blueW - pinkX / pinkW)).toBeLessThanOrEqual(0.25);
    }
  );

  test('the count pops when it changes after being seen, not when it first arrives', async () => {
    const tree = (counted: Record<string, number>) => (
      <TurfSummaryContext.Provider
        value={feedWith({ 1: standing({ counted, shown: counted, leader: 'blue' }) })}
      >
        <IntersectionObserverProvider>
          <div data-testid="card-root" style={{ width: PHONE_CARD }}>
            <ImageCard data={image} />
          </div>
        </IntersectionObserverProvider>
      </TurfSummaryContext.Provider>
    );
    const view = await renderWithProviders(
      <TurfSummaryContext.Provider value={feedWith({})}>
        <IntersectionObserverProvider>
          <div data-testid="card-root" style={{ width: PHONE_CARD }}>
            <ImageCard data={image} />
          </div>
        </IntersectionObserverProvider>
      </TurfSummaryContext.Provider>
    );
    await vi.waitFor(() =>
      expect(document.body.querySelector('[aria-label$="reaction"]')).not.toBeNull()
    );
    await view.rerender(tree({ blue: 6 }));
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    const count = () => badge()!.querySelector('[data-testid="hat-turf-count"]')!;
    expect(count().className).not.toContain('bump');
    await view.rerender(tree({ blue: 7 }));
    await vi.waitFor(() => expect(count().textContent).toBe('7'));
    expect(count().className).toContain('bump');
  });
});

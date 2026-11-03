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
import type { TurfSummaries } from '~/components/HatTurf/TurfSummaryProvider';
import { renderWithProviders, LOADABLE_IMAGE_DATA_URI } from '../../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';
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
  test('draws the ring, the leader colour, a white hat and the count under it', async () => {
    renderCard({ feed: feedWith({ 1: standing() }) });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    const el = badge()!;
    expect(el.dataset.leader).toBe('blue');
    // One arc per team, in the ring's SVG.
    expect(el.querySelectorAll('circle[data-team]').length).toBe(4);
    expect(el.querySelector('[data-testid="hat-turf-count"]')!.textContent).toBe('6');
    // The disc is filled with the leader's colour, not white.
    const disc = el.querySelector('[data-testid="hat-turf-count"]')!.parentElement as HTMLElement;
    const bg = getComputedStyle(disc).backgroundColor;
    expect(bg).not.toBe('rgb(255, 255, 255)');
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(el.getAttribute('aria-label')).toContain('blue leads with 6');
    // The badge sits inside the card, top left, and stays inside it.
    const card = document.querySelector('[data-testid="card-root"]')!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    expect(box.left - card.left).toBeLessThan(16);
    expect(box.top - card.top).toBeLessThan(16);
    expect(box.right).toBeLessThanOrEqual(card.right);
  });

  const mineDot = () =>
    badge()!.querySelector('[data-testid="hat-turf-mine"]') as HTMLElement | null;

  test('marks the viewer’s own arc with a dot in their colour, with no text', async () => {
    renderCard({ feed: feedWith({ 1: standing() }, 'pink') });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    expect(mineDot()).not.toBeNull();
    const pinkArc = badge()!.querySelector('circle[data-team="pink"]') as SVGElement;
    expect(getComputedStyle(mineDot()!).backgroundColor).toBe(getComputedStyle(pinkArc).stroke);
    expect(badge()!.textContent).toBe('6');
  });

  test('no dot when the viewer’s team has no hats here', async () => {
    renderCard({ feed: feedWith({ 1: standing({ counted: { blue: 6 } }) }, 'pink') });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    expect(mineDot()).toBeNull();
  });

  test('no dot when the viewer is on no team', async () => {
    renderCard({ feed: feedWith({ 1: standing() }, null) });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    expect(mineDot()).toBeNull();
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

  test('large counts still fit the disc', async () => {
    renderCard({
      feed: feedWith({ 1: standing({ counted: { blue: 1240, pink: 980 }, leader: 'blue' }) }),
    });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    const count = badge()!.querySelector('[data-testid="hat-turf-count"]') as HTMLElement;
    const disc = count.parentElement!;
    expect(count.getBoundingClientRect().width).toBeLessThanOrEqual(
      disc.getBoundingClientRect().width
    );
  });

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

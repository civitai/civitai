import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as TrackBufferMod from '~/components/TrackView/trackEventBuffer';
import { renderWithProviders } from '../../../test/component-setup';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * The store card's IMPRESSION, end to end: the card's root is observed through the shared feed
 * impression hook, half-visible for a continuous second queues ONE `AppStore_Action` impression,
 * and a second intersection on the same page view queues none.
 *
 * Its own file so the impression hook's module-level observer registry starts empty: the
 * `IntersectionObserver` stub below is what the registry is built with.
 */

const funnel = vi.hoisted(() => ({ on: true, enqueue: vi.fn() }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ feedImpressions: funnel.on }),
  useOptionalFeatureFlags: () => ({ feedImpressions: funnel.on }),
}));
vi.mock('~/components/TrackView/trackEventBuffer', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackBufferMod>()),
  enqueueTrackEvent: funnel.enqueue,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
// Not under test here, and its modals reach tRPC.
vi.mock('~/components/Apps/AppListingActionsMenu', () => ({ AppListingActionsMenu: () => null }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));

const { AppListingCard } = await import('./AppListingCard');
const { __appStoreImpressionTestHooks } = await import('./appStoreTelemetry');

/** A controllable IntersectionObserver: records what it observes and lets a test fire entries. */
class StubObserver {
  static instances: StubObserver[] = [];
  observed = new Set<Element>();
  constructor(public callback: IntersectionObserverCallback) {
    StubObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  takeRecords() {
    return [];
  }
}

const isCardRoot = (el: Element) => el.classList.contains('mantine-Card-root');

/** Fire an intersection for every observed card root (other observers are left alone). */
function intersectAll(ratio: number) {
  for (const obs of StubObserver.instances) {
    const entries = [...obs.observed].filter(isCardRoot).map(
      (target) =>
        ({
          target,
          isIntersecting: ratio > 0,
          intersectionRatio: ratio,
        } as IntersectionObserverEntry)
    );
    if (entries.length) obs.callback(entries, obs as unknown as IntersectionObserver);
  }
}

/**
 * How many CARD ROOTS are being observed. Other components on the card may create their own
 * observers through the same (stubbed) global, so counting every observed element measures them
 * too — only the Mantine Card root is the impression target.
 */
const observedCount = () =>
  StubObserver.instances.reduce((n, o) => n + [...o.observed].filter(isCardRoot).length, 0);

const impressions = () =>
  funnel.enqueue.mock.calls
    .map(([e]) => e)
    .filter(
      (e: any) => e?.data?.type === 'AppStore_Action' && e.data.details.action === 'impression'
    )
    .map((e: any) => e.data.details);

const CARD: ListingCard = {
  id: 'apl_imp',
  slug: 'imp-app',
  kind: 'offsite',
  name: 'Impression App',
  tagline: null,
  category: 'games',
  contentRating: null,
  isBeta: false,
  iconUrl: null,
  coverUrl: null,
  creator: null,
  recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
  reviewCount: 0,
  openCount: null,
  restrictedAudience: null,
  kindData: { kind: 'offsite', externalUrl: 'https://ext.app' },
} as unknown as ListingCard;

const TELEMETRY = { surface: 'store_card' as const, position: 0, sort: 'newest' as const };

describe('AppListingCard — impression', () => {
  beforeEach(() => {
    // The dwell only arms on a visible tab; pin it rather than trust the runner's.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    StubObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', StubObserver);
    funnel.enqueue.mockReset();
    funnel.on = true;
    __appStoreImpressionTestHooks.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // Back to the prototype getter.
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  });

  test('≥50% visible for 1 s queues ONE impression; a second intersection on the same page view, none', async () => {
    renderWithProviders(<AppListingCard card={CARD} telemetry={TELEMETRY} />);
    await expect.element(page.getByText('Impression App')).toBeInTheDocument();
    // The card root is what is observed — without `ref={impressionRef}` nothing would be.
    await vi.waitUntil(() => observedCount() > 0, { timeout: 5000, interval: 25 });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    intersectAll(0.6);
    vi.advanceTimersByTime(999);
    expect(impressions()).toEqual([]); // not before the full second
    vi.advanceTimersByTime(1);
    expect(impressions()).toEqual([
      {
        action: 'impression',
        listingId: 'apl_imp',
        surface: 'store_card',
        position: 0,
        sort: 'newest',
      },
    ]);
    vi.useRealTimers();

    // Same page view: a fresh mount of the same card is observed again, but does not count again.
    // Wait for the observed count to INCREASE, so the intersection below reaches the NEW mount.
    const before = observedCount();
    renderWithProviders(<AppListingCard card={CARD} telemetry={TELEMETRY} />);
    await vi.waitUntil(() => observedCount() > before, { timeout: 5000, interval: 25 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    intersectAll(0.6);
    vi.advanceTimersByTime(2000);
    expect(impressions()).toHaveLength(1);
  });

  test('scrolled away before the second is up, it does not count', async () => {
    renderWithProviders(<AppListingCard card={CARD} telemetry={TELEMETRY} />);
    await vi.waitUntil(() => observedCount() > 0, { timeout: 5000, interval: 25 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    intersectAll(0.6);
    vi.advanceTimersByTime(500);
    intersectAll(0); // left the viewport
    vi.advanceTimersByTime(3000);
    expect(impressions()).toEqual([]);
  });

  test('with the funnel gate OFF the card is not even observed', async () => {
    funnel.on = false;
    renderWithProviders(<AppListingCard card={CARD} telemetry={TELEMETRY} />);
    await expect.element(page.getByText('Impression App')).toBeInTheDocument();
    expect(observedCount()).toBe(0);
  });
});

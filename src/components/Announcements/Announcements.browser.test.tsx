import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * Announcements CLS reserve — component tests for the flag-gated space
 * reservation that stops the above-feed announcement banner from displacing the
 * tall masonry feed on load (the shift production RUM mis-attributes to
 * `MasonryContainer .queries`, the displaced victim).
 *
 * Load-bearing behaviours:
 *   1. Flag OFF ⇒ current behaviour exactly (null when nothing to show; no
 *      reserved space, ever).
 *   2. Flag ON + a seeded announcement + PRE-hydration (isClient=false) ⇒ render
 *      a reserve placeholder holding `minHeight` so the feed doesn't reflow when
 *      the isClient-gated carousel mounts.
 *   3. Flag ON + POST-hydration with everything dismissed (data empty, isClient
 *      true) ⇒ release the reserve (no permanent dead space for a dismisser).
 *   4. When a real announcement is visible, the carousel receives the same
 *      `minHeight` floor (flag ON) / none (flag OFF).
 */

// Per-test-controllable hook outputs (vi.mock is hoisted above imports).
const mocks = vi.hoisted(() => ({
  feedReserveCls: false,
  hook: {
    data: [] as Array<{ id: number; dismissed: boolean }>,
    seededCount: 0,
    isClient: false,
  },
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ feedReserveCls: mocks.feedReserveCls }),
}));

vi.mock('~/components/Announcements/announcements.utils', () => ({
  useGetAnnouncements: () => mocks.hook,
}));

// Stub the dynamically-imported carousel so tests stay network/Embla-free and
// can assert the `minHeight` floor it receives.
vi.mock('~/components/Announcements/AnnouncementsCarousel', () => ({
  default: (props: { minHeight?: number }) => (
    <div data-testid="carousel" data-minheight={props.minHeight ?? 'none'} />
  ),
}));

// Imported AFTER the mocks are registered.
import { Announcements } from '~/components/Announcements/Announcements';

beforeEach(() => {
  mocks.feedReserveCls = false;
  mocks.hook = { data: [], seededCount: 0, isClient: false };
});

describe('Announcements CLS reserve', () => {
  test('flag OFF, pre-hydration, seeded announcement → renders nothing (no reserve)', async () => {
    mocks.feedReserveCls = false;
    mocks.hook = { data: [], seededCount: 1, isClient: false };
    renderWithProviders(<Announcements className="mb-3" />);
    // Give React a tick; then assert neither the reserve nor the carousel exist.
    await expect.poll(() => document.querySelector('[data-testid="announcements-cls-reserve"]')).toBe(
      null
    );
    expect(document.querySelector('[data-testid="carousel"]')).toBe(null);
  });

  test('flag ON, pre-hydration, seeded announcement → renders reserve holding minHeight', async () => {
    mocks.feedReserveCls = true;
    mocks.hook = { data: [], seededCount: 1, isClient: false };
    renderWithProviders(<Announcements className="mb-3" />);
    const reserve = page.getByTestId('announcements-cls-reserve');
    await expect.element(reserve).toBeInTheDocument();
    const el = reserve.element() as HTMLElement;
    // Space is actually reserved (a non-trivial min-height), and it's hidden from a11y.
    expect(parseInt(el.style.minHeight, 10)).toBeGreaterThan(100);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    // The pass-through className is preserved so spacing (mb-3) matches the banner.
    expect(el.className).toContain('mb-3');
  });

  test('flag ON, post-hydration, all dismissed → releases reserve (no dead space)', async () => {
    mocks.feedReserveCls = true;
    mocks.hook = { data: [], seededCount: 1, isClient: true };
    renderWithProviders(<Announcements className="mb-3" />);
    await expect.poll(() => document.querySelector('[data-testid="announcements-cls-reserve"]')).toBe(
      null
    );
    expect(document.querySelector('[data-testid="carousel"]')).toBe(null);
  });

  test('flag ON, visible announcement → carousel gets the minHeight floor', async () => {
    mocks.feedReserveCls = true;
    mocks.hook = { data: [{ id: 1, dismissed: false }], seededCount: 1, isClient: true };
    renderWithProviders(<Announcements className="mb-3" />);
    const carousel = page.getByTestId('carousel');
    await expect.element(carousel).toBeInTheDocument();
    expect(Number((carousel.element() as HTMLElement).dataset.minheight)).toBeGreaterThan(100);
  });

  test('flag OFF, visible announcement → carousel renders WITHOUT a floor (unchanged)', async () => {
    mocks.feedReserveCls = false;
    mocks.hook = { data: [{ id: 1, dismissed: false }], seededCount: 1, isClient: true };
    renderWithProviders(<Announcements className="mb-3" />);
    const carousel = page.getByTestId('carousel');
    await expect.element(carousel).toBeInTheDocument();
    expect((carousel.element() as HTMLElement).dataset.minheight).toBe('none');
  });
});

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
 *   1. Flag OFF ⇒ current behaviour exactly (null when nothing to show; the
 *      carousel with no wrapper when there is — no reserved space, ever).
 *   2. Flag ON + a seeded `site` announcement + PRE-hydration (isClient=false) ⇒
 *      a PERSISTENT parent holding a responsive min-height (mobile 203 / desktop
 *      162), spacer inside.
 *   3. The SAME persistent parent (holding the min-height) is present once the
 *      carousel mounts — so the space is held continuously across the
 *      spacer→carousel swap (no collapse gap / double-shift while the dynamic
 *      chunk resolves).
 *   4. Flag ON + POST-hydration with everything dismissed ⇒ release the reserve
 *      (no permanent dead space for a dismisser).
 *   5. Reserve is scoped to `type === 'site'` — generator/training placements
 *      (above a form/wizard, not the feed) never reserve.
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

// Stub the dynamically-imported carousel so tests stay network/Embla-free.
vi.mock('~/components/Announcements/AnnouncementsCarousel', () => ({
  default: () => <div data-testid="carousel" />,
}));

// Imported AFTER the mocks are registered.
import { Announcements } from '~/components/Announcements/Announcements';

const RESERVE_CLASSES = ['min-h-[203px]', 'md:min-h-[162px]'];

beforeEach(() => {
  mocks.feedReserveCls = false;
  mocks.hook = { data: [], seededCount: 0, isClient: false };
});

describe('Announcements CLS reserve', () => {
  test('flag OFF, pre-hydration, seeded announcement → renders nothing (no reserve, no wrapper)', async () => {
    mocks.feedReserveCls = false;
    mocks.hook = { data: [], seededCount: 1, isClient: false };
    renderWithProviders(<Announcements className="mb-3" />);
    await expect
      .poll(() => document.querySelector('[data-testid="announcements-cls-reserve"]'))
      .toBe(null);
    expect(document.querySelector('[data-testid="carousel"]')).toBe(null);
  });

  test('flag ON, pre-hydration, seeded site announcement → persistent parent holds responsive min-height (spacer inside)', async () => {
    mocks.feedReserveCls = true;
    mocks.hook = { data: [], seededCount: 1, isClient: false };
    renderWithProviders(<Announcements className="mb-3" />);
    const reserve = page.getByTestId('announcements-cls-reserve');
    await expect.element(reserve).toBeInTheDocument();
    const el = reserve.element() as HTMLElement;
    // Reserves the LARGER (mobile) height, with a desktop override — never under-reserves.
    for (const cls of RESERVE_CLASSES) expect(el.className).toContain(cls);
    // Spacer state: hidden from a11y, no carousel inside yet, pass-through spacing preserved.
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('[data-testid="carousel"]')).toBe(null);
    expect(el.className).toContain('mb-3');
  });

  test('flag ON, visible announcement → SAME persistent parent still holds min-height, now wrapping the carousel', async () => {
    mocks.feedReserveCls = true;
    mocks.hook = { data: [{ id: 1, dismissed: false }], seededCount: 1, isClient: true };
    renderWithProviders(<Announcements className="mb-3" />);
    const reserve = page.getByTestId('announcements-cls-reserve');
    await expect.element(reserve).toBeInTheDocument();
    const el = reserve.element() as HTMLElement;
    // The min-height is held by the SAME parent across the swap → no collapse gap.
    for (const cls of RESERVE_CLASSES) expect(el.className).toContain(cls);
    // Carousel is now nested INSIDE the persistent parent, and content is not aria-hidden.
    expect(el.querySelector('[data-testid="carousel"]')).not.toBe(null);
    expect(el.getAttribute('aria-hidden')).toBe(null);
  });

  test('flag ON, post-hydration, all dismissed → releases reserve (no dead space)', async () => {
    mocks.feedReserveCls = true;
    mocks.hook = { data: [], seededCount: 1, isClient: true };
    renderWithProviders(<Announcements className="mb-3" />);
    await expect
      .poll(() => document.querySelector('[data-testid="announcements-cls-reserve"]'))
      .toBe(null);
    expect(document.querySelector('[data-testid="carousel"]')).toBe(null);
  });

  test('flag ON but type !== "site" (generator) → no reserve (scoped to the feed placement)', async () => {
    mocks.feedReserveCls = true;
    mocks.hook = { data: [], seededCount: 1, isClient: false };
    renderWithProviders(<Announcements type="generator" />);
    await expect
      .poll(() => document.querySelector('[data-testid="announcements-cls-reserve"]'))
      .toBe(null);
  });

  test('flag OFF, visible announcement → carousel renders directly, WITHOUT the reserve wrapper (unchanged)', async () => {
    mocks.feedReserveCls = false;
    mocks.hook = { data: [{ id: 1, dismissed: false }], seededCount: 1, isClient: true };
    renderWithProviders(<Announcements className="mb-3" />);
    const carousel = page.getByTestId('carousel');
    await expect.element(carousel).toBeInTheDocument();
    // No persistent reserve parent in the flag-off path.
    expect(document.querySelector('[data-testid="announcements-cls-reserve"]')).toBe(null);
  });
});

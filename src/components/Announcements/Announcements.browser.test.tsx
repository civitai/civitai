import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * `Announcements` component contract AFTER the durable feed-CLS fix.
 *
 * The min-height reserve is GONE — the feed-CLS treatment now lives in
 * `useGetAnnouncements` (SSR-exact render, gated on `feedReserveCls`, verified by
 * the pure `announcements-exposure` + `announcements-dismissed-cookie` unit
 * suites). This component is now a thin renderer: it shows the carousel iff the
 * hook exposes a non-dismissed announcement, else nothing — and NEVER a reserve
 * placeholder. These tests pin that contract at the component boundary.
 *
 * `useGetAnnouncements` is mocked so its (already unit-tested) internal
 * flag/hydration logic is decoupled from the component's job.
 */

// Per-test-controllable hook output (vi.mock is hoisted above imports).
const mocks = vi.hoisted(() => ({
  hook: {
    data: [] as Array<{ id: number; dismissed: boolean }>,
    seededCount: 0,
    isClient: false,
  },
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

beforeEach(() => {
  mocks.hook = { data: [], seededCount: 0, isClient: false };
});

describe('Announcements (reserve-free renderer)', () => {
  test('no exposed announcements → renders nothing (and never a reserve placeholder)', async () => {
    mocks.hook = { data: [], seededCount: 1, isClient: false };
    renderWithProviders(<Announcements className="mb-3" />);
    // Give any async mount a beat, then assert nothing rendered.
    await expect
      .poll(() => document.querySelector('[data-testid="announcements-cls-reserve"]'))
      .toBe(null);
    expect(document.querySelector('[data-testid="carousel"]')).toBe(null);
  });

  test('all exposed announcements dismissed → renders nothing (no dead space)', async () => {
    mocks.hook = { data: [{ id: 1, dismissed: true }], seededCount: 1, isClient: true };
    renderWithProviders(<Announcements className="mb-3" />);
    await expect
      .poll(() => document.querySelector('[data-testid="announcements-cls-reserve"]'))
      .toBe(null);
    expect(document.querySelector('[data-testid="carousel"]')).toBe(null);
  });

  test('a non-dismissed announcement → renders the carousel directly (no reserve wrapper)', async () => {
    mocks.hook = { data: [{ id: 1, dismissed: false }], seededCount: 1, isClient: true };
    renderWithProviders(<Announcements className="mb-3" />);
    const carousel = page.getByTestId('carousel');
    await expect.element(carousel).toBeInTheDocument();
    // No reserve placeholder wrapper in any path.
    expect(document.querySelector('[data-testid="announcements-cls-reserve"]')).toBe(null);
  });

  test('SSR-exact case: a non-dismissed announcement exposed pre-hydration (isClient=false) → carousel already present (renders from server HTML, no post-hydration insert)', async () => {
    // This is the flag-ON server/first-paint shape the hook now produces for a
    // non-dismisser: data exposed even though isClient=false.
    mocks.hook = { data: [{ id: 1, dismissed: false }], seededCount: 1, isClient: false };
    renderWithProviders(<Announcements className="mb-3" />);
    const carousel = page.getByTestId('carousel');
    await expect.element(carousel).toBeInTheDocument();
    expect(document.querySelector('[data-testid="announcements-cls-reserve"]')).toBe(null);
  });
});

import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * `Announcements` component contract for the combined feed-CLS fix: #3018's
 * SSR-exact dismiss (carousel — or nothing — from server HTML, driven by the
 * cookie via `useGetAnnouncements`) PLUS #3000's anti-collapse mechanism (a
 * PERSISTENT `min-h` parent that stays mounted across the SSR→hydration handoff).
 *
 * The hydration/flag logic of `useGetAnnouncements` is unit-tested by the pure
 * `announcements-exposure` + `announcements-dismissed-cookie` suites, so it is
 * mocked here — these tests pin the COMPONENT's job: when does the persistent
 * reserve wrapper appear, and does the min-height floor hold when the inner
 * carousel is momentarily null.
 */

const RESERVE = '[data-testid="announcements-cls-reserve"]';
const RESERVE_MIN_H = 'min-h-[203px]';

// Per-test-controllable hook output (vi.mock is hoisted above imports).
type HookShape = {
  data: Array<{ id: number; dismissed: boolean }>;
  seededCount: number;
  serverExposedCount: number;
  exposeSSR: boolean;
  isClient: boolean;
};
const mocks = vi.hoisted(() => ({
  hook: {
    data: [] as Array<{ id: number; dismissed: boolean }>,
    seededCount: 0,
    serverExposedCount: 0,
    exposeSSR: false,
    isClient: false,
  } as HookShape,
}));

vi.mock('~/components/Announcements/announcements.utils', () => ({
  useGetAnnouncements: () => mocks.hook,
}));

// Stub the (now statically-imported) carousel so tests stay network/Embla-free.
vi.mock('~/components/Announcements/AnnouncementsCarousel', () => ({
  default: () => <div data-testid="carousel" />,
}));

// Imported AFTER the mocks are registered.
import { Announcements } from '~/components/Announcements/Announcements';

beforeEach(() => {
  mocks.hook = {
    data: [],
    seededCount: 0,
    serverExposedCount: 0,
    exposeSSR: false,
    isClient: false,
  };
});

describe('Announcements — flag OFF / non-exposed (byte-identical to pre-fix)', () => {
  test('flag OFF, no exposed data → renders nothing, NO reserve wrapper', async () => {
    mocks.hook = {
      data: [],
      seededCount: 1,
      serverExposedCount: 0,
      exposeSSR: false,
      isClient: false,
    };
    renderWithProviders(<Announcements className="mb-3" />);
    // Give any async mount a beat, then assert nothing rendered.
    await expect.poll(() => document.querySelector(RESERVE)).toBe(null);
    expect(document.querySelector('[data-testid="carousel"]')).toBe(null);
  });

  test('flag OFF, a non-dismissed announcement (post-hydration) → carousel directly, NO reserve wrapper', async () => {
    mocks.hook = {
      data: [{ id: 1, dismissed: false }],
      seededCount: 1,
      serverExposedCount: 0,
      exposeSSR: false,
      isClient: true,
    };
    renderWithProviders(<Announcements className="mb-3" />);
    const carousel = page.getByTestId('carousel');
    await expect.element(carousel).toBeInTheDocument();
    expect(document.querySelector(RESERVE)).toBe(null);
  });
});

describe('Announcements — flag ON, persistent CLS reserve', () => {
  test('server saw a non-dismissed announcement → persistent min-height wrapper WITH the carousel inside', async () => {
    // The flag-ON server/first-paint shape for a non-dismisser: exposed data even
    // though isClient=false, serverExposedCount>0.
    mocks.hook = {
      data: [{ id: 1, dismissed: false }],
      seededCount: 1,
      serverExposedCount: 1,
      exposeSSR: true,
      isClient: false,
    };
    renderWithProviders(<Announcements className="mb-3" />);
    const carousel = page.getByTestId('carousel');
    await expect.element(carousel).toBeInTheDocument();
    const wrapper = document.querySelector(RESERVE);
    expect(wrapper).not.toBe(null);
    // The min-height floor + the caller className both live on the persistent parent.
    expect(wrapper?.className).toContain(RESERVE_MIN_H);
    expect(wrapper?.className).toContain('md:min-h-[162px]');
    expect(wrapper?.className).toContain('mb-3');
    // The carousel is a child of the persistent wrapper (not a sibling).
    expect(wrapper?.querySelector('[data-testid="carousel"]')).not.toBe(null);
  });

  test('inner carousel momentarily null (all data dismissed post-hydration) → the wrapper STILL holds the min-height (no collapse)', async () => {
    // Models the migration-first-load transient: server exposed the carousel
    // (serverExposedCount>0) so the wrapper is committed, but the just-migrated
    // store now marks every announcement dismissed → the INNER goes null. The
    // persistent parent must remain with its min-height so the feed never shifts.
    mocks.hook = {
      data: [{ id: 1, dismissed: true }],
      seededCount: 1,
      serverExposedCount: 1,
      exposeSSR: true,
      isClient: true,
    };
    renderWithProviders(<Announcements className="mb-3" />);
    await expect.poll(() => document.querySelector(RESERVE)).not.toBe(null);
    const wrapper = document.querySelector(RESERVE);
    // Height floor held...
    expect(wrapper?.className).toContain(RESERVE_MIN_H);
    // ...but the inner carousel is gone (no dead visible banner), and the empty
    // reserved box is hidden from assistive tech.
    expect(wrapper?.querySelector('[data-testid="carousel"]')).toBe(null);
    expect(wrapper?.getAttribute('aria-hidden')).toBe('true');
  });

  test('server saw the announcement as DISMISSED (serverExposedCount 0) → NO wrapper, NO dead space', async () => {
    // A cookie-dismisser: the server-read cookie already filters the only active
    // announcement, so serverExposedCount is 0 → the reserve must NOT render (no
    // reserved dead space for people who dismissed).
    mocks.hook = {
      data: [{ id: 1, dismissed: true }],
      seededCount: 1,
      serverExposedCount: 0,
      exposeSSR: true,
      isClient: false,
    };
    renderWithProviders(<Announcements className="mb-3" />);
    await expect.poll(() => document.querySelector(RESERVE)).toBe(null);
    expect(document.querySelector('[data-testid="carousel"]')).toBe(null);
  });
});

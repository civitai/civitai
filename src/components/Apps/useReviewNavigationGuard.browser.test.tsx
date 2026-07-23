import { useRouter } from 'next/router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { useReviewNavigationGuard } from './useReviewNavigationGuard';

/**
 * `useReviewNavigationGuard` — blocks navigation while an approve/reject mutation
 * is in flight on the review PAGE. Reworked (per audit) to sit on the repo's
 * existing `useCatchNavigation` instead of a hand-rolled guard. These tests lock
 * the two real bugs the rework fixes:
 *  1. the guard must NOT block its OWN success-redirect — the returned `bypass()`
 *     escape hatch lets the intended `router.push` through the still-armed guard;
 *  2. the guard must NOT touch `router.beforePopState` (a single global slot owned
 *     by the app's RoutedDialogProvider — the old guard clobbered it).
 * Plus the retained contract: a genuine user navigation mid-mutation is blocked.
 */

// The scaffold mocks `next/router` as a shared singleton; `useRouter()`, the
// default `Router` import (what `useCatchNavigation` uses), and `Router` all back
// the SAME object, so its on/off/beforePopState spies observe the guard.
const router = useRouter();
const onSpy = router.events.on as ReturnType<typeof vi.fn>;
const offSpy = router.events.off as ReturnType<typeof vi.fn>;
const beforePopSpy = router.beforePopState as ReturnType<typeof vi.fn>;

const routeChangeStartRegs = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.filter((c: unknown[]) => c[0] === 'routeChangeStart');

// The `routeChangeStart` handler `useCatchNavigation` last registered (it throws
// to cancel a client navigation — the documented pages-router idiom).
const lastRouteChangeStartHandler = () =>
  routeChangeStartRegs(onSpy).at(-1)![1] as (url: string) => void;

// Captured from the harness so a test can trip the success-redirect bypass.
let bypass: () => void;

function Harness({ active }: { active: boolean }) {
  bypass = useReviewNavigationGuard(active);
  // A visible node so the test can await the mount before reading mock.calls
  // (effects run after the async commit in browser mode).
  return <div data-testid="guard-harness" />;
}

beforeEach(() => {
  onSpy.mockClear();
  offSpy.mockClear();
  beforePopSpy.mockClear();
  (router.events.emit as ReturnType<typeof vi.fn>).mockClear();
});

describe('useReviewNavigationGuard', () => {
  test('registers a routeChangeStart guard only while active — and NEVER touches beforePopState', async () => {
    const { rerender } = await renderWithProviders(<Harness active={false} />);
    await expect.element(page.getByTestId('guard-harness')).toBeInTheDocument();
    // Inactive: nothing armed.
    expect(routeChangeStartRegs(onSpy)).toHaveLength(0);

    // Activate → a routeChangeStart handler installs (via useCatchNavigation).
    await rerender(<Harness active={true} />);
    await vi.waitFor(() => expect(routeChangeStartRegs(onSpy)).toHaveLength(1));
    const registeredHandler = routeChangeStartRegs(onSpy)[0][1];

    // Deactivate → the SAME handler is removed.
    await rerender(<Harness active={false} />);
    await vi.waitFor(() =>
      expect(routeChangeStartRegs(offSpy).some((c) => c[1] === registeredHandler)).toBe(true)
    );

    // Fix #2: the guard must not clobber the app-global beforePopState slot — it
    // is never called across the whole arm→disarm cycle.
    expect(beforePopSpy).not.toHaveBeenCalled();
  });

  test('blocks a genuine user-initiated navigation while active (prompts, then aborts on cancel)', async () => {
    await renderWithProviders(<Harness active={true} />);
    await expect.element(page.getByTestId('guard-harness')).toBeInTheDocument();
    await vi.waitFor(() => expect(routeChangeStartRegs(onSpy).length).toBeGreaterThanOrEqual(1));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    // Avoid a real URL mutation from the guard's history-resync.
    const pushStateSpy = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});

    const handler = lastRouteChangeStartHandler();
    // A user navigating AWAY (distinct target) mid-mutation is prompted; declining
    // throws to cancel the navigation.
    expect(() => handler('/some/other/path')).toThrow();
    expect(confirmSpy).toHaveBeenCalled();

    confirmSpy.mockRestore();
    pushStateSpy.mockRestore();
  });

  test('bypass() lets the intended programmatic redirect through the armed guard WITHOUT prompting', async () => {
    await renderWithProviders(<Harness active={true} />);
    await expect.element(page.getByTestId('guard-harness')).toBeInTheDocument();
    await vi.waitFor(() => expect(routeChangeStartRegs(onSpy).length).toBeGreaterThanOrEqual(1));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const handler = lastRouteChangeStartHandler();

    // Trip the success-redirect bypass SYNCHRONOUSLY (what ReviewDetailView does
    // right before router.push). The still-armed guard must now let this
    // navigation through: no confirm prompt, no throw-to-cancel.
    bypass();
    expect(() => handler('/apps/review')).not.toThrow();
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { useReviewNavigationGuard } from './useReviewNavigationGuard';

/**
 * `useReviewNavigationGuard` — blocks navigation while an approve/reject mutation
 * is in flight on the review PAGE (the page's replacement for the modal's busyRef
 * close-refusal). Asserts the guard REGISTERS its pages-router hooks only while
 * active and REMOVES them when it releases — the deterministic contract, driven by
 * toggling `active`, rather than trying to fire a real route change through the
 * scaffold's mocked router.
 */

// The scaffold mocks `next/router` as a shared singleton; the same object backs
// every `useRouter()` call, so we can inspect its on/off/beforePopState spies.
const router = useRouter();
const onSpy = router.events.on as ReturnType<typeof vi.fn>;
const offSpy = router.events.off as ReturnType<typeof vi.fn>;
const beforePopSpy = router.beforePopState as ReturnType<typeof vi.fn>;

const routeChangeStartCalls = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.filter((c: unknown[]) => c[0] === 'routeChangeStart');

function Harness({ active }: { active: boolean }) {
  useReviewNavigationGuard(active);
  // A visible node so the test can await the mount before reading mock.calls
  // (effects run after the async commit in browser mode).
  return <div data-testid="guard-harness" />;
}

beforeEach(() => {
  onSpy.mockClear();
  offSpy.mockClear();
  beforePopSpy.mockClear();
});

describe('useReviewNavigationGuard', () => {
  test('registers NOTHING while inactive', async () => {
    await renderWithProviders(<Harness active={false} />);
    await expect.element(page.getByTestId('guard-harness')).toBeInTheDocument();
    expect(routeChangeStartCalls(onSpy)).toHaveLength(0);
    expect(beforePopSpy.mock.calls).toHaveLength(0);
  });

  test('registers the routeChangeStart + beforePopState guard while active, and removes it when it releases', async () => {
    const { rerender } = await renderWithProviders(<Harness active={false} />);
    await expect.element(page.getByTestId('guard-harness')).toBeInTheDocument();

    // Activate → guard installs a routeChangeStart handler and a popstate veto.
    await rerender(<Harness active={true} />);
    await vi.waitFor(() => expect(routeChangeStartCalls(onSpy)).toHaveLength(1));

    // beforePopState set to a veto (returns false while active).
    expect(beforePopSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const vetoCb = beforePopSpy.mock.calls.at(-1)![0] as () => boolean;
    expect(vetoCb()).toBe(false);
    const registeredHandler = routeChangeStartCalls(onSpy)[0][1];

    // Deactivate → the SAME handler is removed and popstate is reset to allow nav.
    await rerender(<Harness active={false} />);
    await vi.waitFor(() => expect(routeChangeStartCalls(offSpy)).toHaveLength(1));
    expect(routeChangeStartCalls(offSpy)[0][1]).toBe(registeredHandler);
    const resetCb = beforePopSpy.mock.calls.at(-1)![0] as () => boolean;
    expect(resetCb()).toBe(true);
  });

  test('the registered routeChangeStart handler throws to abort the navigation', async () => {
    await renderWithProviders(<Harness active={true} />);
    await expect.element(page.getByTestId('guard-harness')).toBeInTheDocument();
    await vi.waitFor(() => expect(routeChangeStartCalls(onSpy).length).toBeGreaterThanOrEqual(1));
    const handler = routeChangeStartCalls(onSpy).at(-1)![1] as () => void;
    // Throwing is the documented pages-router way to cancel a client navigation.
    expect(() => handler()).toThrow();
  });
});

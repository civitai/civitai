import Router from 'next/router';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { useCatchNavigation } from '../useCatchNavigation';

/**
 * Locks the shape of `bypassRef`. A bare `true` waives EVERY navigation for as long as it is
 * set, which is wrong for a caller that trips it around one awaited `router.push`: the pages
 * router cancels an in-flight `change()` with a flag rather than by settling its promise, and
 * emits the new `routeChangeStart` before the old push rejects — so a navigation the user
 * starts during that window also skips the prompt. A url string waives only that destination.
 */

// The scaffold mocks `next/router` as a shared singleton, so the default export is the same
// object `useCatchNavigation` reaches for and its spies observe the guard. Imported as the
// default rather than via `useRouter()` so this isn't a hook call outside a component.
const onSpy = Router.events.on as unknown as ReturnType<typeof vi.fn>;

const DESTINATION = '/user/alice/posts?section=draft';
const MESSAGE = 'unsaved changes, continue?';

// The `routeChangeStart` handler `useCatchNavigation` last registered. It throws to cancel a
// client navigation — the documented pages-router idiom.
const lastRouteChangeStartHandler = () =>
  onSpy.mock.calls.filter((c: unknown[]) => c[0] === 'routeChangeStart').at(-1)![1] as (
    url: string
  ) => void;

function Harness({ bypass }: { bypass: boolean | string | null }) {
  const bypassRef = useRef<boolean | string | null>(bypass);
  bypassRef.current = bypass;
  useCatchNavigation({ unsavedChanges: true, message: MESSAGE, bypassRef });
  return <div data-testid="guard-harness" />;
}

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  onSpy.mockClear();
  (Router.events.emit as unknown as ReturnType<typeof vi.fn>).mockClear();
  // Answering `false` keeps the "user declined" branch, which is the one that throws.
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
});

afterEach(() => {
  confirmSpy.mockRestore();
});

describe('useCatchNavigation bypassRef', () => {
  test('with no bypass, an unsaved-changes navigation prompts and is cancelled', async () => {
    await renderWithProviders(<Harness bypass={null} />);
    await expect.element(page.getByTestId('guard-harness')).toBeInTheDocument();

    expect(() => lastRouteChangeStartHandler()(DESTINATION)).toThrow();
    expect(confirmSpy).toHaveBeenCalledWith(MESSAGE);
  });

  test('a url bypass waives THAT destination and no other', async () => {
    await renderWithProviders(<Harness bypass={DESTINATION} />);
    await expect.element(page.getByTestId('guard-harness')).toBeInTheDocument();
    const handler = lastRouteChangeStartHandler();

    // The navigation the caller tripped the ref for: through, silently.
    expect(() => handler(DESTINATION)).not.toThrow();
    expect(confirmSpy).not.toHaveBeenCalled();

    // Negative control — without this, `bypass={true}` would also pass this test.
    expect(() => handler('/models')).toThrow();
    expect(confirmSpy).toHaveBeenCalledWith(MESSAGE);
  });

  test('a boolean bypass still waives everything (useReviewNavigationGuard relies on it)', async () => {
    await renderWithProviders(<Harness bypass={true} />);
    await expect.element(page.getByTestId('guard-harness')).toBeInTheDocument();
    const handler = lastRouteChangeStartHandler();

    expect(() => handler(DESTINATION)).not.toThrow();
    expect(() => handler('/models')).not.toThrow();
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

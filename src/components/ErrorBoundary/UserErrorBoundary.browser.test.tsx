import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

const reported = vi.fn();
vi.mock('~/components/ErrorBoundary/reportBoundaryError', () => ({
  reportBoundaryError: (...args: unknown[]) => reported(...args),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({}) }));

const { default: UserErrorBoundary } = await import('~/components/ErrorBoundary/UserErrorBoundary');

const features = {} as FeatureAccess;
const FALLBACK = 'Something went wrong :(';

/** Throws while `broken.now` is set, so a test can mend the page between routes. */
const broken = { now: true };
let renders = 0;
function Page() {
  renders++;
  if (broken.now) throw new Error('page broke');
  return <p>page content</p>;
}

const at = (resetKey: string) => (
  <UserErrorBoundary features={features} resetKey={resetKey}>
    <Page />
  </UserErrorBoundary>
);

beforeEach(() => {
  reported.mockClear();
  broken.now = true;
  renders = 0;
  // React logs every caught error; the throws here are the point of the test.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('UserErrorBoundary reset', () => {
  // The boundary's own first render is where a stored key and the prop could
  // disagree; a reset there would retry the page that just threw, forever.
  test('a page that throws on first mount settles on the fallback, then recovers', async () => {
    const screen = await renderWithProviders(at('/images/1'));
    await expect.element(page.getByText(FALLBACK)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // React retries a throwing render, and dev mode doubles renders; a loop
    // would be far past this or hit the update-depth limit.
    expect(renders).toBeLessThanOrEqual(8);
    expect(reported).toHaveBeenCalledTimes(1);

    broken.now = false;
    await screen.rerender(at('/images'));
    await expect.element(page.getByText('page content')).toBeInTheDocument();
  });

  test('navigating away clears the fallback', async () => {
    const screen = await renderWithProviders(at('/images/1'));
    await expect.element(page.getByText(FALLBACK)).toBeInTheDocument();

    broken.now = false;
    await screen.rerender(at('/images'));

    await expect.element(page.getByText('page content')).toBeInTheDocument();
    expect(page.getByText(FALLBACK).elements()).toHaveLength(0);
  });

  test('stays on the fallback while the route does not change', async () => {
    const screen = await renderWithProviders(at('/images/1'));
    await expect.element(page.getByText(FALLBACK)).toBeInTheDocument();

    broken.now = false;
    await screen.rerender(at('/images/1'));

    await expect.element(page.getByText(FALLBACK)).toBeInTheDocument();
    expect(page.getByText('page content').elements()).toHaveLength(0);
  });

  // A reset that re-ran on every update would throw again here: a loop, or a
  // second report per visit.
  test('a route that throws again shows the fallback once and reports once', async () => {
    const screen = await renderWithProviders(at('/images/1'));
    await expect.element(page.getByText(FALLBACK)).toBeInTheDocument();
    expect(reported).toHaveBeenCalledTimes(1);

    await screen.rerender(at('/images/2'));
    await expect.element(page.getByText(FALLBACK)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(reported).toHaveBeenCalledTimes(2);
  });
});

const { ErrorBoundary } = await import('~/components/ErrorBoundary/ErrorBoundary');
const { default: Router } = await import('next/router');

describe('ErrorBoundary reset key', () => {
  // A routed dialog moves the URL without moving Next's asPath; Back out of it
  // is a popstate, and a browser-router push or replace is a 'locationchange'.
  // The router that would relay either is unmounted under the fallback.
  test.each([
    ['popstate', () => new PopStateEvent('popstate')],
    ['locationchange', () => new CustomEvent('locationchange', { detail: [null] })],
  ])('a %s to another URL clears the fallback', async (_, event) => {
    const start = window.location.href;
    try {
      window.history.pushState({}, '', '/images/1');
      await renderWithProviders(
        <ErrorBoundary>
          <Page />
        </ErrorBoundary>
      );
      await expect.element(page.getByText(FALLBACK)).toBeInTheDocument();

      broken.now = false;
      window.history.replaceState({}, '', '/images');
      window.dispatchEvent(event());

      await expect.element(page.getByText('page content')).toBeInTheDocument();
    } finally {
      window.history.replaceState({}, '', start);
    }
  });

  const backTo = async (as: string) => {
    window.history.pushState({}, '', '/images/1');
    await renderWithProviders(
      <ErrorBoundary>
        <Page />
      </ErrorBoundary>
    );
    await expect.element(page.getByText(FALLBACK)).toBeInTheDocument();

    broken.now = false;
    const state = { __N: true, as };
    window.history.replaceState(state, '', '/images');
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
  };

  test('a Back onto another Next page waits for Next to swap the page', async () => {
    const start = window.location.href;
    try {
      await backTo('/somewhere-else');
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Next has not moved asPath yet; resetting now would re-render the page
      // that broke, which here would show its content under the wrong route.
      expect(page.getByText('page content').elements()).toHaveLength(0);
    } finally {
      window.history.replaceState({}, '', start);
    }
  });

  test('a Back onto the page under a routed dialog clears the fallback', async () => {
    const start = window.location.href;
    try {
      // The dialog never moved asPath, so the entry under it carries the same one.
      await backTo(Router.asPath);

      await expect.element(page.getByText('page content')).toBeInTheDocument();
    } finally {
      window.history.replaceState({}, '', start);
    }
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The `/apps/*` rail's COLLAPSE STATE — one global value, SSR-seeded from a cookie,
 * persisted to `localStorage` and mirrored back to that cookie.
 *
 * 🔴 THE TWO CLAIMS THIS FILE OWNS, AND WHY EACH IS A REAL DEFECT IF IT BREAKS.
 *
 * (1) ONE GLOBAL VALUE, NOT ONE PER ROUTE. Next's pages router swaps the page component
 *     on every navigation, so state held in `AppsPageLayout`'s own `useState` is destroyed
 *     and re-seeded on each route change — collapsing the rail on `/apps` and clicking to
 *     `/apps/build` would re-open it. `AppsPageLayout.chromeAlignment.browser.test.tsx`
 *     asserts the rail's left edge and width are identical on all 12 routes, and a
 *     per-route value breaks that invariant by design. The state therefore lives in
 *     `AppsRailProvider`, which `_app` mounts ABOVE the router outlet — and this file is
 *     what makes "above the outlet" an observation rather than a claim about a file.
 *
 * (2) THE SSR SEED IS THE COOKIE, NOT `localStorage`. Every `/apps/*` page is
 *     server-rendered and `localStorage` does not exist on a server, so a rail seeded from
 *     storage alone always renders OPEN on the server: a viewer who collapsed it gets a
 *     260 → 56 jump on hydration, and the store grid underneath is a CONTAINER QUERY, so
 *     204px of returned width re-ladders every card on the page rather than shifting one
 *     bar. A collapsed cookie must produce a collapsed FIRST render, with no effect
 *     required to get there.
 *
 * 🔴 THE RAIL IS ONLY VISIBLE AT ≥ `APPS_RAIL_MIN_VIEWPORT`, so every render below sets a
 * desktop viewport first — below it the rail is `display: none` and absent from the
 * accessibility tree, and every query would resolve nothing while the rail was rendering
 * perfectly for the width it was given.
 */

const mocks = vi.hoisted(() => ({
  pathname: '/apps',
}));

// Two sections, so the `< 2` collapse does not remove the rail for a reason that has
// nothing to do with the state under test.
vi.mock('~/components/Apps/useAppsNavSections', async () => {
  const registry = await import('~/components/Apps/apps-sections');
  return { useAppsNavSections: () => registry.appsSections.slice(0, 2) };
});

vi.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ pathname: mocks.pathname }),
}));

const { AppsPageLayout } = await import('~/components/Apps/AppsPageLayout');
const {
  AppsRailProvider,
  APPS_RAIL_COOKIE,
  APPS_RAIL_STORAGE_KEY,
  APPS_RAIL_WIDTH,
  APPS_RAIL_COLLAPSED_WIDTH,
  readAppsRailStorage,
} = await import('~/components/Apps/appsRailState');

/** The rail's rendered width, or null when it did not render. */
function railWidth(): number | null {
  const rail = document.querySelector('[data-apps-chrome="rail"]') as HTMLElement | null;
  return rail ? Math.round(rail.getBoundingClientRect().width) : null;
}

const toggle = () => page.getByRole('button', { name: /(Collapse|Expand) navigation/ });

function readCookie(name: string): string | undefined {
  for (const part of document.cookie.split(';')) {
    const [k, ...rest] = part.split('=');
    if (k.trim() === name) return decodeURIComponent(rest.join('=').trim());
  }
  return undefined;
}

beforeEach(() => {
  mocks.pathname = '/apps';
  try {
    window.localStorage.removeItem(APPS_RAIL_STORAGE_KEY);
  } catch {
    // storage disabled — the cookie assertions still hold
  }
  document.cookie = `${APPS_RAIL_COOKIE}=; path=/; max-age=0`;
});

/**
 * One page render, inside ONE provider. The provider is deliberately hoisted OUT of the
 * render helper in the multi-route test below — that separation is the whole point of
 * claim (1).
 */
function Page({ testid }: { testid: string }) {
  return (
    <AppsPageLayout>
      <div data-testid={testid} />
    </AppsPageLayout>
  );
}

describe('🔴 the SSR cookie seed decides the FIRST render', () => {
  test('a COLLAPSED seed renders a collapsed rail immediately — no effect, no reflow', async () => {
    await page.viewport(1440, 900);
    renderWithProviders(
      <AppsRailProvider value="collapsed">
        <Page testid="body" />
      </AppsRailProvider>
    );
    await expect.element(page.getByTestId('body')).toBeInTheDocument();
    expect(railWidth()).toBe(APPS_RAIL_COLLAPSED_WIDTH);
  });

  test('🔴 DISCRIMINATING CONTROL: an OPEN seed on the same tree renders the full rail', async () => {
    // Without this arm, "collapsed renders 56" would also be satisfied by a rail that is
    // always 56 — i.e. by the seed being ignored in the other direction.
    await page.viewport(1440, 900);
    renderWithProviders(
      <AppsRailProvider value="open">
        <Page testid="body" />
      </AppsRailProvider>
    );
    await expect.element(page.getByTestId('body')).toBeInTheDocument();
    expect(railWidth()).toBe(APPS_RAIL_WIDTH);
  });

  /**
   * 🔴 THE ADOPTION PATH, REACHED THE WAY `_app` REACHES IT — and the test whose absence
   * let a dead feature ship.
   *
   * `useAppsRail` only consults `localStorage` when NO seed arrived, and the only test
   * that exercised that branch did it by omitting the Provider entirely — a shape `_app`
   * never produces. Meanwhile the cookie schema was `.catch('open').default('open')`, so
   * the real Provider ALWAYS received a seed and the branch was unreachable in
   * production. The suite was green, three docstrings described a working fallback, and
   * the fallback did not exist.
   *
   * This renders the Provider the way `_app` does — `value={cookies.appsRail}` — with the
   * value the schema now yields for a request carrying no rail cookie: `undefined`.
   */
  test('🔴 a cookie-less request ADOPTS localStorage after mount (the real _app shape)', async () => {
    window.localStorage.setItem(APPS_RAIL_STORAGE_KEY, 'collapsed');
    await page.viewport(1440, 900);
    renderWithProviders(
      <AppsRailProvider value={undefined}>
        <Page testid="body" />
      </AppsRailProvider>
    );
    await expect.element(page.getByTestId('body')).toBeInTheDocument();

    // The FIRST paint is still the default — it has to be, or the server HTML and the
    // first client render would differ and that is the hydration mismatch the cookie
    // exists to prevent. The adoption happens in an EFFECT, after hydration has matched.
    await vi.waitFor(() => {
      expect(railWidth()).toBe(APPS_RAIL_COLLAPSED_WIDTH);
    });
  });

  test('🔴 DISCRIMINATING CONTROL: the same cookie-less render with EMPTY storage stays open', async () => {
    // Without this arm, "it collapsed" would also be satisfied by a rail that collapses
    // whenever the seed is undefined — i.e. by the storage read being ignored in the
    // other direction.
    await page.viewport(1440, 900);
    renderWithProviders(
      <AppsRailProvider value={undefined}>
        <Page testid="body" />
      </AppsRailProvider>
    );
    await expect.element(page.getByTestId('body')).toBeInTheDocument();
    await new Promise((res) => setTimeout(res, 50));
    expect(railWidth()).toBe(APPS_RAIL_WIDTH);
  });

  test('with NO provider at all the rail is OPEN — the default fails visible', async () => {
    // The provider-less fallback (a surface rendered outside `_app`). An unknown or
    // missing seed must never HIDE the navigation.
    await page.viewport(1440, 900);
    renderWithProviders(<Page testid="body" />);
    await expect.element(page.getByTestId('body')).toBeInTheDocument();
    expect(railWidth()).toBe(APPS_RAIL_WIDTH);
  });

  test('🔴 a collapsed seed BEATS an open `localStorage` value on the first render', async () => {
    // The ordering claim on `useAppsRail`: the cookie is read during render, storage only
    // in an effect and only when NO seed arrived. If storage were read during render the
    // two could disagree on the first client paint, which is the hydration mismatch the
    // cookie exists to prevent — and it would show up as the rail expanding a frame after
    // load for exactly the viewers who had collapsed it.
    window.localStorage.setItem(APPS_RAIL_STORAGE_KEY, 'open');
    await page.viewport(1440, 900);
    renderWithProviders(
      <AppsRailProvider value="collapsed">
        <Page testid="body" />
      </AppsRailProvider>
    );
    await expect.element(page.getByTestId('body')).toBeInTheDocument();
    expect(railWidth()).toBe(APPS_RAIL_COLLAPSED_WIDTH);
    // …and it STAYS collapsed after the effects have run, so nothing adopts storage late.
    await new Promise((res) => setTimeout(res, 50));
    expect(railWidth()).toBe(APPS_RAIL_COLLAPSED_WIDTH);
  });
});

describe('🔴 the collapse state is ONE GLOBAL VALUE, not one per route', () => {
  test('collapsing on /apps survives a route change to /apps/build', async () => {
    await page.viewport(1440, 900);
    // ONE provider, wrapping a page that is then REPLACED — which is exactly what `_app`
    // does on a client-side navigation: the provider persists, the page component does
    // not. Driving it with `rerender` rather than two separate `render`s is what makes
    // this a test of the provider's scope rather than of two independent mounts.
    // `render` is ASYNC in vitest-browser-react v4 — the sibling suites never notice
    // because they discard the result and await `expect.element` instead. Destructuring
    // it without awaiting yields `undefined` for `rerender` and fails as
    // "rerender is not a function", which reads like a missing API rather than a missing
    // await.
    const { rerender } = await renderWithProviders(
      <AppsRailProvider value="open">
        <Page testid="page-apps" />
      </AppsRailProvider>
    );
    await expect.element(page.getByTestId('page-apps')).toBeInTheDocument();
    expect(railWidth()).toBe(APPS_RAIL_WIDTH);

    await userEvent.click(toggle());
    expect(railWidth()).toBe(APPS_RAIL_COLLAPSED_WIDTH);

    // Navigate: a DIFFERENT page component mounts under the same provider.
    mocks.pathname = '/apps/build';
    rerender(
      <AppsRailProvider value="open">
        <Page testid="page-build" />
      </AppsRailProvider>
    );
    await expect.element(page.getByTestId('page-build')).toBeInTheDocument();

    expect(
      railWidth(),
      'the rail re-opened on a route change — the collapse state is being held BELOW the ' +
        'router outlet (in AppsPageLayout) rather than in AppsRailProvider, so every ' +
        'navigation re-seeds it. That also breaks the 12-route alignment ledger in ' +
        'AppsPageLayout.chromeAlignment.browser.test.tsx by design.'
    ).toBe(APPS_RAIL_COLLAPSED_WIDTH);
  });

  test('🔴 NEGATIVE CONTROL: state held per-page really does reset (the defect, demonstrated)', async () => {
    // The control for the test above. Two SEPARATE mounts — i.e. what a per-route value
    // looks like — must lose the toggle, or "it survived a rerender" would be satisfied by
    // a rail that simply cannot be collapsed at all.
    await page.viewport(1440, 900);
    renderWithProviders(
      <AppsRailProvider value="open">
        <Page testid="first" />
      </AppsRailProvider>
    );
    await expect.element(page.getByTestId('first')).toBeInTheDocument();
    await userEvent.click(toggle());
    expect(railWidth()).toBe(APPS_RAIL_COLLAPSED_WIDTH);

    await cleanup();
    // A brand-new provider with an `open` seed — the shape of a per-route default.
    renderWithProviders(
      <AppsRailProvider value="open">
        <Page testid="second" />
      </AppsRailProvider>
    );
    await expect.element(page.getByTestId('second')).toBeInTheDocument();
    expect(railWidth()).toBe(APPS_RAIL_WIDTH);
  });
});

describe('the toggle writes BOTH stores', () => {
  test('collapsing persists to localStorage AND to the cookie', async () => {
    await page.viewport(1440, 900);
    renderWithProviders(
      <AppsRailProvider value="open">
        <Page testid="body" />
      </AppsRailProvider>
    );
    await expect.element(page.getByTestId('body')).toBeInTheDocument();
    expect(readAppsRailStorage()).toBeNull();
    expect(readCookie(APPS_RAIL_COOKIE)).toBeUndefined();

    await userEvent.click(toggle());

    // Both, because they have different jobs: storage is the client-side store, the
    // cookie is what lets the SERVER render the right first paint next time.
    expect(readAppsRailStorage()).toBe('collapsed');
    expect(readCookie(APPS_RAIL_COOKIE)).toBe('collapsed');

    // …and expanding writes both back, so a viewer cannot get stuck collapsed on the
    // server while the client shows open.
    await userEvent.click(toggle());
    expect(railWidth()).toBe(APPS_RAIL_WIDTH);
    expect(readAppsRailStorage()).toBe('open');
    expect(readCookie(APPS_RAIL_COOKIE)).toBe('open');
  });

  test('the toggle names its action, and the name tracks the state', async () => {
    // The accessible name is the only thing telling a screen-reader user what the button
    // will do; a static label ("Toggle navigation") is the shape that reads correctly and
    // says nothing.
    await page.viewport(1440, 900);
    renderWithProviders(
      <AppsRailProvider value="open">
        <Page testid="body" />
      </AppsRailProvider>
    );
    await expect.element(page.getByTestId('body')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Collapse navigation' })).toBeVisible();

    await userEvent.click(toggle());
    await expect.element(page.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
  });
});

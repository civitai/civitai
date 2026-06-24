import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import {
  activeAppsTab,
  AppsSubNavView,
  isActiveAppsRoute,
  type AppsNavSummary,
} from '~/components/Apps/AppsSubNav';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// AppsSubNav's conditional-visibility logic lives in the pure presentational
// `AppsSubNavView` (props-only) so it renders in isolation without the tRPC
// query / router that the `AppsSubNav` container wires. We drive the booleans
// directly and assert which tabs render.
//
// The sub-nav is now Mantine navigation **Tabs**: each tab is a real Next
// `Link` (`component={Link}`) so the element is an `<a href>` with
// `role="tab"` + `aria-selected`. We therefore target `role: 'tab'` (not
// `'link'`) and assert the active tab via `aria-selected="true"`. Navigation is
// the anchor's `href` contract — clicking a Next `<Link>` anchor in browser mode
// would trigger a real page navigation, so we assert the `href` target each tab
// points at (the click-destination) rather than firing the click.
//
// NOTE: this env does not load `@mantine/core/styles.css`, so we assert
// presence / ARIA attributes / href — never computed styles.

const NONE: AppsNavSummary = {
  hasInstalls: false,
  hasSubmissions: false,
  hasApprovedApps: false,
  isReviewer: false,
};

function tab(name: string) {
  return page.getByRole('tab', { name });
}

describe('AppsSubNavView (conditional sub-nav tabs)', () => {
  test('Marketplace + Submit are ALWAYS present (even with an all-false summary)', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} currentPath="/apps" />);
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    await expect.element(tab('Submit')).toBeInTheDocument();
  });

  test('with an all-false summary the conditional tabs are hidden', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} currentPath="/apps" />);
    // None of the conditional tabs should render.
    expect(tab('Installed').elements()).toHaveLength(0);
    expect(tab('My submissions').elements()).toHaveLength(0);
    expect(tab('Revenue').elements()).toHaveLength(0);
    expect(tab('Review').elements()).toHaveLength(0);
  });

  test('Installed shows ONLY when hasInstalls', async () => {
    renderWithProviders(
      <AppsSubNavView summary={{ ...NONE, hasInstalls: true }} currentPath="/apps" />
    );
    await expect.element(tab('Installed')).toBeInTheDocument();
    // The other conditionals stay hidden.
    expect(tab('My submissions').elements()).toHaveLength(0);
    expect(tab('Revenue').elements()).toHaveLength(0);
    expect(tab('Review').elements()).toHaveLength(0);
  });

  test('My submissions shows ONLY when hasSubmissions', async () => {
    renderWithProviders(
      <AppsSubNavView summary={{ ...NONE, hasSubmissions: true }} currentPath="/apps" />
    );
    await expect.element(tab('My submissions')).toBeInTheDocument();
    expect(tab('Installed').elements()).toHaveLength(0);
    expect(tab('Revenue').elements()).toHaveLength(0);
    expect(tab('Review').elements()).toHaveLength(0);
  });

  test('Revenue shows ONLY when hasApprovedApps', async () => {
    renderWithProviders(
      <AppsSubNavView summary={{ ...NONE, hasApprovedApps: true }} currentPath="/apps" />
    );
    await expect.element(tab('Revenue')).toBeInTheDocument();
    expect(tab('Installed').elements()).toHaveLength(0);
    expect(tab('My submissions').elements()).toHaveLength(0);
    expect(tab('Review').elements()).toHaveLength(0);
  });

  test('Review shows ONLY when isReviewer', async () => {
    renderWithProviders(
      <AppsSubNavView summary={{ ...NONE, isReviewer: true }} currentPath="/apps" />
    );
    await expect.element(tab('Review')).toBeInTheDocument();
    expect(tab('Installed').elements()).toHaveLength(0);
    expect(tab('My submissions').elements()).toHaveLength(0);
    expect(tab('Revenue').elements()).toHaveLength(0);
  });

  test('an all-true summary shows every tab', async () => {
    const ALL: AppsNavSummary = {
      hasInstalls: true,
      hasSubmissions: true,
      hasApprovedApps: true,
      isReviewer: true,
    };
    renderWithProviders(<AppsSubNavView summary={ALL} currentPath="/apps" />);
    for (const name of ['Marketplace', 'Submit', 'Installed', 'My submissions', 'Revenue', 'Review']) {
      await expect.element(tab(name)).toBeInTheDocument();
    }
  });
});

describe('AppsSubNavView (active tab reflects the current route)', () => {
  test('the current route is the selected tab (aria-selected=true)', async () => {
    renderWithProviders(
      <AppsSubNavView summary={{ ...NONE, hasInstalls: true }} currentPath="/apps/installed" />
    );
    await expect.element(tab('Installed')).toBeInTheDocument();
    const installed = tab('Installed').element();
    expect(installed.getAttribute('aria-selected')).toBe('true');
  });

  test('/apps (Marketplace) is NOT selected on a child route — exact-match guard', async () => {
    // On a child route the child tab is selected and Marketplace (/apps) is NOT
    // (the exact-match guard), proving the active-route highlight + the /apps
    // prefix guard at once.
    renderWithProviders(
      <AppsSubNavView summary={{ ...NONE, hasInstalls: true }} currentPath="/apps/installed" />
    );
    await expect.element(tab('Installed')).toBeInTheDocument();
    const marketplace = tab('Marketplace').element();
    expect(marketplace.getAttribute('aria-selected')).toBe('false');
  });

  test('Marketplace IS selected on the exact /apps route', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} currentPath="/apps" />);
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    const marketplace = tab('Marketplace').element();
    expect(marketplace.getAttribute('aria-selected')).toBe('true');
    const submit = tab('Submit').element();
    expect(submit.getAttribute('aria-selected')).toBe('false');
  });

  test('Submit tab is selected on /apps/submit (and Marketplace is not)', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} currentPath="/apps/submit" />);
    await expect.element(tab('Submit')).toBeInTheDocument();
    expect(tab('Submit').element().getAttribute('aria-selected')).toBe('true');
    expect(tab('Marketplace').element().getAttribute('aria-selected')).toBe('false');
  });
});

describe('AppsSubNavView (each tab navigates to its route)', () => {
  // Each tab is a Next `<Link>` anchor — the `href` IS the navigation target a
  // click follows. Asserting the href is the deterministic equivalent of "a
  // click navigates to the right route" for a link-based tab.
  test('every visible tab points its href at the matching /apps route', async () => {
    const ALL: AppsNavSummary = {
      hasInstalls: true,
      hasSubmissions: true,
      hasApprovedApps: true,
      isReviewer: true,
    };
    renderWithProviders(<AppsSubNavView summary={ALL} currentPath="/apps" />);
    const cases: Array<[string, string]> = [
      ['Marketplace', '/apps'],
      ['Submit', '/apps/submit'],
      ['Installed', '/apps/installed'],
      ['My submissions', '/apps/my-submissions'],
      ['Revenue', '/apps/revenue'],
      ['Review', '/apps/review'],
    ];
    for (const [name, href] of cases) {
      await expect.element(tab(name)).toBeInTheDocument();
      expect(tab(name).element().getAttribute('href')).toBe(href);
    }
  });
});

describe('isActiveAppsRoute / activeAppsTab (route-matching helpers)', () => {
  test('/apps matches ONLY the exact marketplace route', () => {
    expect(isActiveAppsRoute('/apps', '/apps')).toBe(true);
    expect(isActiveAppsRoute('/apps', '/apps/installed')).toBe(false);
    expect(isActiveAppsRoute('/apps', '/apps/run/foo')).toBe(false);
  });

  test('sub-routes match exact + deeper child paths (prefix)', () => {
    expect(isActiveAppsRoute('/apps/installed', '/apps/installed')).toBe(true);
    expect(isActiveAppsRoute('/apps/installed', '/apps/installed/123')).toBe(true);
    expect(isActiveAppsRoute('/apps/installed', '/apps/installedX')).toBe(false);
    expect(isActiveAppsRoute('/apps/submit', '/apps/installed')).toBe(false);
  });

  test('activeAppsTab resolves the active tab href, or null when none matches', () => {
    expect(activeAppsTab('/apps')).toBe('/apps');
    expect(activeAppsTab('/apps/submit')).toBe('/apps/submit');
    expect(activeAppsTab('/apps/revenue')).toBe('/apps/revenue');
    // A deep /apps/* route with no corresponding tab → no active tab.
    expect(activeAppsTab('/apps/run/some-slug')).toBeNull();
  });
});

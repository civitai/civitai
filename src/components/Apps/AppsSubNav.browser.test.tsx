import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { AppsSubNavView, type AppsNavSummary } from '~/components/Apps/AppsSubNav';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// AppsSubNav's conditional-visibility logic lives in the pure presentational
// `AppsSubNavView` (props-only) so it renders in isolation without the tRPC
// query / router that the `AppsSubNav` container wires. We drive the booleans
// directly and assert which tabs render.
//
// NOTE: this env does not load `@mantine/core/styles.css`, so we assert
// presence / `aria-current` — never computed styles.

const NONE: AppsNavSummary = {
  hasInstalls: false,
  hasSubmissions: false,
  hasApprovedApps: false,
  isReviewer: false,
};

function link(name: string) {
  return page.getByRole('link', { name });
}

describe('AppsSubNavView (conditional sub-nav)', () => {
  test('Marketplace + Submit are ALWAYS present (even with an all-false summary)', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} currentPath="/apps" />);
    await expect.element(link('Marketplace')).toBeInTheDocument();
    await expect.element(link('Submit')).toBeInTheDocument();
  });

  test('with an all-false summary the conditional tabs are hidden', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} currentPath="/apps" />);
    // None of the conditional tabs should render.
    expect(link('Installed').elements()).toHaveLength(0);
    expect(link('My submissions').elements()).toHaveLength(0);
    expect(link('Revenue').elements()).toHaveLength(0);
    expect(link('Review').elements()).toHaveLength(0);
  });

  test('Installed shows ONLY when hasInstalls', async () => {
    renderWithProviders(
      <AppsSubNavView summary={{ ...NONE, hasInstalls: true }} currentPath="/apps" />
    );
    await expect.element(link('Installed')).toBeInTheDocument();
    // The other conditionals stay hidden.
    expect(link('My submissions').elements()).toHaveLength(0);
    expect(link('Revenue').elements()).toHaveLength(0);
    expect(link('Review').elements()).toHaveLength(0);
  });

  test('My submissions shows ONLY when hasSubmissions', async () => {
    renderWithProviders(
      <AppsSubNavView summary={{ ...NONE, hasSubmissions: true }} currentPath="/apps" />
    );
    await expect.element(link('My submissions')).toBeInTheDocument();
    expect(link('Installed').elements()).toHaveLength(0);
    expect(link('Revenue').elements()).toHaveLength(0);
    expect(link('Review').elements()).toHaveLength(0);
  });

  test('Revenue shows ONLY when hasApprovedApps', async () => {
    renderWithProviders(
      <AppsSubNavView summary={{ ...NONE, hasApprovedApps: true }} currentPath="/apps" />
    );
    await expect.element(link('Revenue')).toBeInTheDocument();
    expect(link('Installed').elements()).toHaveLength(0);
    expect(link('My submissions').elements()).toHaveLength(0);
    expect(link('Review').elements()).toHaveLength(0);
  });

  test('Review shows ONLY when isReviewer', async () => {
    renderWithProviders(
      <AppsSubNavView summary={{ ...NONE, isReviewer: true }} currentPath="/apps" />
    );
    await expect.element(link('Review')).toBeInTheDocument();
    expect(link('Installed').elements()).toHaveLength(0);
    expect(link('My submissions').elements()).toHaveLength(0);
    expect(link('Revenue').elements()).toHaveLength(0);
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
      await expect.element(link(name)).toBeInTheDocument();
    }
  });

  test('the active route is marked aria-current=page (and /apps does not light up on a child route)', async () => {
    // On a child route, the child tab is current and Marketplace (/apps) is NOT
    // (exact-match guard) — proves the active-route highlight + the /apps prefix
    // guard at once.
    renderWithProviders(
      <AppsSubNavView summary={{ ...NONE, hasInstalls: true }} currentPath="/apps/installed" />
    );
    // Await the render to settle before reading attributes synchronously.
    await expect.element(link('Installed')).toBeInTheDocument();
    const installed = link('Installed').element();
    expect(installed.getAttribute('aria-current')).toBe('page');
    const marketplace = link('Marketplace').element();
    expect(marketplace.getAttribute('aria-current')).toBeNull();
  });
});

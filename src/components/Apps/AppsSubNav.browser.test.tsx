import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import {
  activeAppsTab,
  AppsSubNavView,
  isActiveAppsRoute,
  type AppsNavContext,
  type AppsNavSummary,
} from '~/components/Apps/AppsSubNav';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// AppsSubNav's conditional-visibility logic lives in the pure presentational
// `AppsSubNavView` (props-only) so it renders in isolation without the tRPC
// query / router that the `AppsSubNav` container wires. We drive the booleans
// directly and assert which tabs render.
//
// TWO input objects, on purpose (they have different provenance and different
// hydration behaviour — see the type docs):
//   - `summary`  — the `blocks.getNavSummary` booleans (client-only, revealed
//                  post-mount).
//   - `context`  — viewer CAPABILITIES resolved from SSR-seeded values
//                  (`isAuthor`), safe on the first paint.
//
// The sub-nav uses the Mantine **Tabs** LOOK but is wrapped in a real
// `<nav aria-label="App sections">` so it's exposed as a navigation LANDMARK
// (cross-page nav, not a single-page tab panel). Each tab is a real Next
// `Link` (`renderRoot`) so the element is an `<a href>` with `role="tab"` +
// `aria-selected`. We therefore target `role: 'tab'` (not `'link'`) and assert
// the active tab via `aria-selected="true"`, and assert the wrapping
// `role="navigation"` landmark carries the `App sections` accessible name.
// Navigation is the anchor's `href` contract — clicking a Next `<Link>` anchor
// in browser mode would trigger a real page navigation, so we assert the `href`
// target each tab points at (the click-destination) rather than firing the
// click. Arrow keys are configured NOT to auto-activate
// (`activateTabWithKeyboard={false}`) so a keyboard user can scan the nav
// without being yanked to another page.
//
// NOTE: this env does not load `@mantine/core/styles.css`, so we assert
// presence / ARIA attributes / href — never computed styles.

const NONE: AppsNavSummary = {
  hasInstalls: false,
  hasSubmissions: false,
  hasApprovedApps: false,
  isReviewer: false,
  hasEditableApps: false,
  hasPendingInvites: false,
};

const ALL: AppsNavSummary = {
  hasInstalls: true,
  hasSubmissions: true,
  hasApprovedApps: true,
  isReviewer: true,
  hasEditableApps: true,
  hasPendingInvites: true,
};

/** May author apps (mod, or a non-mod holding `appBlocksAuthor`). */
const AUTHOR: AppsNavContext = { isAuthor: true };
/** The widened store-visibility tester cohort: sees the store, cannot author. */
const NOT_AUTHOR: AppsNavContext = { isAuthor: false };

function tab(name: string) {
  return page.getByRole('tab', { name });
}

/**
 * 🔴 RENDER BARRIER — required for every "this renders NOTHING" assertion here.
 *
 * `render()` mounts through a React 18 concurrent root, so the DOM is committed on a
 * LATER task, not synchronously. A bare `expect(locator.elements()).toHaveLength(0)`
 * straight after `renderWithProviders` therefore observes an EMPTY container and passes
 * no matter what the component does — structurally unfailable. Caught here by mutation:
 * deleting the `links.length < 2` hide left the collapse tests GREEN until the barrier
 * was added. Render this sentinel alongside the unit under test and AWAIT it; the
 * commit has then happened and "absent" is a real observation.
 */
const RENDER_BARRIER = 'render-barrier';
const RenderBarrier = () => <div data-testid={RENDER_BARRIER} />;
async function awaitCommit() {
  await expect.element(page.getByTestId(RENDER_BARRIER)).toBeInTheDocument();
}

describe('AppsSubNavView (conditional sub-nav tabs)', () => {
  test('Marketplace is present for an author with an all-false summary', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    await expect.element(tab('Create')).toBeInTheDocument();
  });

  // The "Submit" tab was relabeled to "Create" (icon → IconSquarePlus) while
  // keeping the SAME `/apps/submit` route + active-state logic. These assert the
  // visible label flipped, the OLD label is gone (mutation-sanity: reverting the
  // label to "Submit" fails the "no Submit tab" expectation), the route is
  // unchanged, and the new create-affordance icon renders inside the tab.
  test('the author tab reads "Create", NOT "Submit"', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Create')).toBeInTheDocument();
    // The old label must be gone entirely (no tab named "Submit").
    expect(tab('Submit').elements()).toHaveLength(0);
  });

  test('the Create tab still points at /apps/submit (route unchanged)', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Create')).toBeInTheDocument();
    expect(tab('Create').element().getAttribute('href')).toBe('/apps/submit');
  });

  test('the Create tab renders its leftSection icon (create affordance)', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Create')).toBeInTheDocument();
    // The tab's leftSection mounts a tabler SVG; assert an <svg> is present
    // inside the Create tab so the icon affordance isn't silently dropped.
    const icon = tab('Create').element().querySelector('svg');
    expect(icon).not.toBeNull();
  });

  test('with an all-false summary the conditional tabs are hidden', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    // None of the summary-driven tabs should render.
    expect(tab('Installed').elements()).toHaveLength(0);
    expect(tab('My submissions').elements()).toHaveLength(0);
    expect(tab('Revenue').elements()).toHaveLength(0);
    expect(tab('Review').elements()).toHaveLength(0);
  });

  test('Installed shows ONLY when hasInstalls', async () => {
    renderWithProviders(
      <AppsSubNavView summary={{ ...NONE, hasInstalls: true }} context={AUTHOR} currentPath="/apps" />
    );
    await expect.element(tab('Installed')).toBeInTheDocument();
    // The other conditionals stay hidden.
    expect(tab('My submissions').elements()).toHaveLength(0);
    expect(tab('Revenue').elements()).toHaveLength(0);
    expect(tab('Review').elements()).toHaveLength(0);
  });

  test('My submissions shows ONLY when hasSubmissions', async () => {
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasSubmissions: true }}
        context={AUTHOR}
        currentPath="/apps"
      />
    );
    await expect.element(tab('My submissions')).toBeInTheDocument();
    expect(tab('Installed').elements()).toHaveLength(0);
    expect(tab('Revenue').elements()).toHaveLength(0);
    expect(tab('Review').elements()).toHaveLength(0);
  });

  test('Revenue shows ONLY when hasApprovedApps', async () => {
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasApprovedApps: true }}
        context={AUTHOR}
        currentPath="/apps"
      />
    );
    await expect.element(tab('Revenue')).toBeInTheDocument();
    expect(tab('Installed').elements()).toHaveLength(0);
    expect(tab('My submissions').elements()).toHaveLength(0);
    expect(tab('Review').elements()).toHaveLength(0);
  });

  test('Review shows ONLY when isReviewer', async () => {
    renderWithProviders(
      <AppsSubNavView summary={{ ...NONE, isReviewer: true }} context={AUTHOR} currentPath="/apps" />
    );
    await expect.element(tab('Review')).toBeInTheDocument();
    expect(tab('Installed').elements()).toHaveLength(0);
    expect(tab('My submissions').elements()).toHaveLength(0);
    expect(tab('Revenue').elements()).toHaveLength(0);
  });

  test('an all-true summary + author shows every tab', async () => {
    renderWithProviders(<AppsSubNavView summary={ALL} context={AUTHOR} currentPath="/apps" />);
    for (const name of [
      'Marketplace',
      'Create',
      'My apps',
      'Invites',
      'Installed',
      'My submissions',
      'Revenue',
      'Review',
    ]) {
      await expect.element(tab(name)).toBeInTheDocument();
    }
  });

  // 🔴 THE FOUR SUMMARY PREDICATES ARE UNCHANGED BY THE AUTHOR GATE. THREE tabs
  // read `context` — `Create`, `My apps` and `Invites` — and the four asserted
  // below still read the summary alone. Asserted against a NON-author so a
  // predicate that accidentally picked up `isAuthor` (e.g.
  // `(s, c) => c.isAuthor && s.hasInstalls`) fails here even though the
  // author-context tests above would stay green.
  //
  // 🔴 Do NOT "simplify" `My apps` / `Invites` back to a summary-only predicate.
  // They were exactly that until a merge with main silently reverted them: main
  // widened `visible` to `(summary, context)`, this branch had added both against
  // the OLD one-argument signature, and git merged the two edits with no conflict.
  // It compiled and the whole suite passed while both tabs were un-gated. Their
  // dedicated non-author tests above are what pin them now.
  test('the four summary-driven tabs are independent of isAuthor (non-author, all-true summary)', async () => {
    renderWithProviders(<AppsSubNavView summary={ALL} context={NOT_AUTHOR} currentPath="/apps" />);
    for (const name of ['Marketplace', 'Installed', 'My submissions', 'Revenue', 'Review']) {
      await expect.element(tab(name)).toBeInTheDocument();
    }
    // …while the author gate removes Create (asserted here) along with `My apps`
    // and `Invites`, which have their own dedicated non-author tests above.
    // (The awaited loop above is this assertion's positive control — without a
    // present element first, `.elements()` is synchronous and would pass vacuously.)
    expect(tab('Create').elements()).toHaveLength(0);
  });
});

/**
 * 🔴 THE AUTHOR GATE ON `Create` (this change).
 *
 * `/apps/submit`'s `getServerSideProps` returns `notFound` unless
 * `features.appBlocksAuthor` AND `isAppDeveloper(user, …)` hold. The tab used to
 * be hardcoded `visible: () => true`, so the widened store-visibility cohort
 * (`app-listings=true`, `app-blocks-author=false` — verified live on a real
 * tester account) saw a "Create" tab that navigated straight into a 404. The tab
 * now keys off the SAME predicate as the page.
 *
 * MODERATORS ARE A HARD FLOOR: `isAppDeveloper` is `isModerator || appBlocksAuthor`,
 * so a mod keeps the tab even with the capability off. That floor lives in the
 * shared predicate (`~/shared/utils/app-blocks-access`) and is resolved by the
 * CONTAINER; at this level it surfaces as `isAuthor: true`, and the container
 * derivation is covered in `AppsSubNav.hydration.browser.test.tsx`.
 */
describe('AppsSubNavView (Create is gated on the author capability)', () => {
  test('Create is HIDDEN for a non-author (appBlocksAuthor=false, not a mod)', async () => {
    // Give the viewer an install so the bar still has two tabs and renders —
    // otherwise the <2 hide would remove the whole nav and this assertion would
    // pass for the WRONG reason (see the dedicated collapse tests below).
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasInstalls: true }}
        context={NOT_AUTHOR}
        currentPath="/apps"
      />
    );
    // Positive control: the bar IS rendered…
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    await expect.element(tab('Installed')).toBeInTheDocument();
    // …and Create is absent from it.
    expect(tab('Create').elements()).toHaveLength(0);
  });

  test('Create is VISIBLE when the author capability is held', async () => {
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasInstalls: true }}
        context={AUTHOR}
        currentPath="/apps"
      />
    );
    await expect.element(tab('Create')).toBeInTheDocument();
    expect(tab('Create').element().getAttribute('href')).toBe('/apps/submit');
  });

  test('a non-author does NOT get a Create tab even with every summary flag true', async () => {
    renderWithProviders(<AppsSubNavView summary={ALL} context={NOT_AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Review')).toBeInTheDocument();
    expect(tab('Create').elements()).toHaveLength(0);
  });
});

/**
 * The <2-tab collapse. With `Create` conditional, a store-visible non-author
 * with no installs / submissions / approved apps and no reviewer bit qualifies
 * for Marketplace ALONE — a one-entry "navigation" that can only link to the
 * page you are on, while still costing the tab row + its bottom rule. The whole
 * bar (nav landmark included) is dropped below two tabs.
 */
describe('AppsSubNavView (hides entirely below two tabs)', () => {
  test('renders NOTHING when only Marketplace qualifies', async () => {
    renderWithProviders(
      <>
        <RenderBarrier />
        <AppsSubNavView summary={NONE} context={NOT_AUTHOR} currentPath="/apps" />
      </>
    );
    await awaitCommit(); // without this the assertions below cannot fail — see RENDER_BARRIER
    // No tabs, no tablist, and no navigation landmark — the component returned null.
    expect(tab('Marketplace').elements()).toHaveLength(0);
    expect(page.getByRole('tablist').elements()).toHaveLength(0);
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
  });

  test('renders as soon as a SECOND tab qualifies (one install)', async () => {
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasInstalls: true }}
        context={NOT_AUTHOR}
        currentPath="/apps"
      />
    );
    await expect.element(page.getByRole('navigation', { name: 'App sections' })).toBeInTheDocument();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    await expect.element(tab('Installed')).toBeInTheDocument();
    expect(page.getByRole('tab').elements()).toHaveLength(2);
  });

  test('the second tab can be Create (author, otherwise-empty summary)', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    await expect.element(page.getByRole('navigation', { name: 'App sections' })).toBeInTheDocument();
    expect(page.getByRole('tab').elements()).toHaveLength(2);
  });

  // The hide applies to EVERY viewer — there is no moderator carve-out. A mod
  // always resolves to `isAuthor: true` in the container, so the only way a mod
  // reaches one tab is `isAuthor: false`, which is what this drives directly.
  test('the collapse has no moderator carve-out (isAuthor=false ⇒ hidden, whoever the viewer is)', async () => {
    renderWithProviders(
      <>
        <RenderBarrier />
        <AppsSubNavView summary={NONE} context={NOT_AUTHOR} currentPath="/apps/installed" />
      </>
    );
    await awaitCommit();
    expect(page.getByRole('tablist').elements()).toHaveLength(0);
  });
});

describe('AppsSubNavView (navigation landmark)', () => {
  // HIGH-severity a11y regression the audit flagged: converting to Tabs dropped
  // the `role="navigation"` landmark, leaving a bare `role="tablist"` (an ARIA
  // anti-pattern for cross-page navigation). The tabs are wrapped in a
  // `<nav aria-label="App sections">` so the landmark is restored while the Tabs
  // LOOK (active underline) is preserved. Reverting the nav-wrap fails this.
  test('the sub-nav is exposed as a `navigation` landmark named "App sections"', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    const nav = page.getByRole('navigation', { name: 'App sections' });
    await expect.element(nav).toBeInTheDocument();
    // The accessible name is on the <nav> landmark, NOT on the tablist.
    expect(nav.element().tagName.toLowerCase()).toBe('nav');
  });

  test('the tablist itself does NOT carry the `App sections` name (it moved to the nav)', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    await expect.element(page.getByRole('tablist')).toBeInTheDocument();
    const tablist = page.getByRole('tablist').element();
    expect(tablist.getAttribute('aria-label')).not.toBe('App sections');
  });
});

describe('AppsSubNavView (active tab reflects the current route)', () => {
  test('the current route is the selected tab (aria-selected=true)', async () => {
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasInstalls: true }}
        context={AUTHOR}
        currentPath="/apps/installed"
      />
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
      <AppsSubNavView
        summary={{ ...NONE, hasInstalls: true }}
        context={AUTHOR}
        currentPath="/apps/installed"
      />
    );
    await expect.element(tab('Installed')).toBeInTheDocument();
    const marketplace = tab('Marketplace').element();
    expect(marketplace.getAttribute('aria-selected')).toBe('false');
  });

  test('Marketplace IS selected on the exact /apps route', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    const marketplace = tab('Marketplace').element();
    expect(marketplace.getAttribute('aria-selected')).toBe('true');
    const submit = tab('Create').element();
    expect(submit.getAttribute('aria-selected')).toBe('false');
  });

  test('Create tab is selected on /apps/submit (and Marketplace is not)', async () => {
    renderWithProviders(
      <AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps/submit" />
    );
    await expect.element(tab('Create')).toBeInTheDocument();
    expect(tab('Create').element().getAttribute('aria-selected')).toBe('true');
    expect(tab('Marketplace').element().getAttribute('aria-selected')).toBe('false');
  });

  // 🔴 Highlighting with `Create` ABSENT. `activeAppsTab` resolves against the
  // full link table, so a hidden tab must not steal or suppress the highlight on
  // the tabs that DID render.
  test('with Create hidden, the active route still lights the right tab', async () => {
    renderWithProviders(
      <AppsSubNavView summary={ALL} context={NOT_AUTHOR} currentPath="/apps/my-submissions" />
    );
    await expect.element(tab('My submissions')).toBeInTheDocument();
    expect(tab('Create').elements()).toHaveLength(0);
    expect(tab('My submissions').element().getAttribute('aria-selected')).toBe('true');
    // Every other rendered tab is unselected — exactly one highlight.
    for (const name of ['Marketplace', 'Installed', 'Revenue', 'Review']) {
      expect(tab(name).element().getAttribute('aria-selected')).toBe('false');
    }
  });

  test('with Create hidden, /apps still lights Marketplace', async () => {
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasInstalls: true }}
        context={NOT_AUTHOR}
        currentPath="/apps"
      />
    );
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(tab('Create').elements()).toHaveLength(0);
    expect(tab('Marketplace').element().getAttribute('aria-selected')).toBe('true');
    expect(tab('Installed').element().getAttribute('aria-selected')).toBe('false');
  });
});

describe('AppsSubNavView (each tab navigates to its route)', () => {
  // Each tab is a Next `<Link>` anchor — the `href` IS the navigation target a
  // click follows. Asserting the href is the deterministic equivalent of "a
  // click navigates to the right route" for a link-based tab.
  test('every visible tab points its href at the matching /apps route', async () => {
    renderWithProviders(<AppsSubNavView summary={ALL} context={AUTHOR} currentPath="/apps" />);
    const cases: Array<[string, string]> = [
      ['Marketplace', '/apps'],
      ['Create', '/apps/submit'],
      // Collaborator surfaces: "My apps" is the ownership-OR-seat list
      // (`appListings.listMine`) and "Invites" is the invitee inbox
      // (`appCollaborators.listMyPendingInvites`). Both are owner-INDEPENDENT — a
      // collaborator who owns nothing reaches every other tab's page empty.
      ['My apps', '/apps/mine'],
      ['Invites', '/apps/invites'],
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

describe('AppsSubNavView (keyboard: arrow keys scan, do not auto-navigate)', () => {
  // MEDIUM a11y regression: Mantine's default `activateTabWithKeyboard` makes
  // ArrowLeft/Right ACTIVATE the focused tab — on these real `<Link>` anchors
  // that synthesizes a click → full page navigation, so a keyboard user can't
  // arrow across the nav to read it. We set `activateTabWithKeyboard={false}` so
  // arrow keys move focus only and the SELECTED tab (the active route) doesn't
  // change as you scan.
  //
  // Observable: the active tab is marked `aria-selected="true"` and is bound to
  // `Tabs.value` (= the current route, NOT keyboard focus). With auto-activation
  // ON, arrowing would move `aria-selected` onto the newly-focused tab; with it
  // OFF, selection stays anchored on the route's tab. We assert focus moves
  // (keyboard reachability) while selection stays put. The mutation
  // `activateTabWithKeyboard={true}` flips selection onto the focused tab and
  // fails this test.
  test('ArrowRight moves focus but does NOT change the selected tab (no auto-activate)', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    // Wait for the async render before reaching into the DOM synchronously.
    await expect.element(tab('Marketplace')).toBeInTheDocument();

    const marketplace = tab('Marketplace').element() as HTMLElement;
    const submit = tab('Create').element() as HTMLElement;

    // Marketplace (= current route) is the selected tab; Submit is not.
    expect(marketplace.getAttribute('aria-selected')).toBe('true');
    expect(submit.getAttribute('aria-selected')).toBe('false');

    // Focus the first tab, then arrow to the next.
    marketplace.focus();
    expect(document.activeElement).toBe(marketplace);
    await userEvent.keyboard('{ArrowRight}');

    // Focus moved to Submit (keyboard-reachable scan)…
    expect(document.activeElement).toBe(submit);
    // …but selection (aria-selected, driven by the route) did NOT follow focus.
    // If activateTabWithKeyboard were on, Submit would now be aria-selected=true.
    expect(submit.getAttribute('aria-selected')).toBe('false');
    expect(marketplace.getAttribute('aria-selected')).toBe('true');
  });

  test('Enter/Space still activate: the focused tab is a real anchor with the right href', async () => {
    // We don't fire Enter (it would trigger a real navigation in browser mode);
    // instead we assert the keyboard-activation contract structurally — the
    // focusable element IS the `<a href>` the route points at, so native
    // anchor activation (Enter) navigates correctly even with arrow-activation off.
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Create')).toBeInTheDocument();
    const submit = tab('Create').element() as HTMLElement;
    submit.focus();
    expect(document.activeElement).toBe(submit);
    expect(submit.tagName.toLowerCase()).toBe('a');
    expect(submit.getAttribute('href')).toBe('/apps/submit');
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

/**
 * 🔴 THE COLLABORATOR TABS ARE AUTHOR-GATED TOO — the semantic defect that a CLEAN git
 * merge produced and that no test would have caught.
 *
 * `origin/main` (#3899) widened `SubNavLink.visible` to `(summary, context)` and gated
 * "Create" on `context.isAuthor`, because `/apps/submit` `notFound`s a non-author. This
 * branch added "My apps" and "Invites" against the OLD one-argument signature. Git
 * auto-merged the table with no conflict, the result compiled, and every test passed —
 * leaving two tabs whose pages gate on `features.appBlocksAuthor` + `isAppDeveloper`
 * visible to viewers those pages refuse.
 *
 * Both directions are asserted for each tab: presence for an author, absence for a
 * non-author with the SAME summary. Asserting only the absence would pass on a tab that
 * renders for nobody.
 */
describe('AppsSubNavView (collaborator tabs are gated on the author capability)', () => {
  const CASES: Array<[string, keyof AppsNavSummary]> = [
    ['My apps', 'hasEditableApps'],
    ['Invites', 'hasPendingInvites'],
  ];

  for (const [label, flag] of CASES) {
    test(`${label} renders for an AUTHOR whose ${flag} is true`, async () => {
      renderWithProviders(
        <AppsSubNavView summary={{ ...NONE, [flag]: true }} context={AUTHOR} currentPath="/apps" />
      );
      await expect.element(tab(label)).toBeInTheDocument();
    });

    test(`🔴 ${label} is HIDDEN from a NON-author, even with ${flag} true`, async () => {
      // The store-visible tester cohort (`app-listings=true`, `app-blocks-author=false`).
      // `blocks.getNavSummary` is gated on the MARKETPLACE flag, not the author one, so
      // this combination is reachable — an owner can invite any existing user, and an
      // author who loses the capability keeps their listings.
      renderWithProviders(
        <>
          <RenderBarrier />
          <AppsSubNavView
            summary={{ ...NONE, [flag]: true }}
            context={NOT_AUTHOR}
            currentPath="/apps"
          />
        </>
      );
      await awaitCommit();
      expect(tab(label).elements()).toHaveLength(0);
    });
  }

  test('a NON-author invitee gets no sub-nav at all (1 qualifying tab ⇒ hidden)', async () => {
    // Marketplace alone survives, and main's `links.length < 2` rule then hides the bar —
    // so the two changes compose to the right end state rather than merely not crashing.
    renderWithProviders(
      <>
        <RenderBarrier />
        <AppsSubNavView
          summary={{ ...NONE, hasPendingInvites: true }}
          context={NOT_AUTHOR}
          currentPath="/apps"
        />
      </>
    );
    await awaitCommit();
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
  });

  test('an AUTHOR invitee DOES get the bar: Marketplace + Create + Invites', async () => {
    // The positive control for the case above — without it, "the bar is hidden" would
    // pass on a bar that is hidden for everyone.
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasPendingInvites: true }}
        context={AUTHOR}
        currentPath="/apps"
      />
    );
    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    for (const name of ['Marketplace', 'Create', 'Invites']) {
      await expect.element(tab(name)).toBeInTheDocument();
    }
  });
});

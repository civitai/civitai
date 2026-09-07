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
//                  (`isAuthor`, `canBuild`, `canSeeStore`), safe on the first paint.
//
// 🔴 THE ROW SET CHANGED WITH THE `/apps/build` CONSOLIDATION. "Build apps"
// (`/apps/get-started`), "Create" (`/apps/submit`) and "My apps" (`/apps/mine`) are all
// GONE, replaced by a single "Build" row pointing at `/apps/build`; the two retired
// routes 301 there and `/apps/submit` keeps its route but has no tab. Marketplace stopped
// being unconditional and is now gated on `c.canSeeStore`. The full table, in order:
//   Build (/apps/build) · Marketplace (/apps) · Installed (/apps/installed) ·
//   Invites (/apps/invites) · Revenue (/apps/revenue) · Review (/apps/review)
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

/**
 * Sees the store, may reach `/apps/build`, and may AUTHOR (mod, or a non-mod holding
 * `appBlocksAuthor`) — today's live moderator / `app-dev-testers` shape.
 *
 * 🔴 THIS ONE CONSTANT REPLACES THE OLD `AUTHOR` + `AUTHOR_BUILDER` PAIR, AND THE
 * COLLAPSE IS THE POINT, NOT A TIDY-UP. Those were `{isAuthor: true, canGetStarted:
 * false}` and `{isAuthor: true, canGetStarted: true}`, and they rendered different tab
 * sets because "Build apps" keyed on `canGetStarted`. The row that replaced it keys on
 * `canBuild` = `canAccessAppsBuild`, whose author term (`isAppDeveloper`) ALREADY admits
 * a store-visible author — so `appBlocksGetStarted` cannot change ANY tab for this
 * viewer, and the two fixtures now render an identical bar. Keeping both names would
 * assert one rule twice under two labels and read as coverage of a distinction that no
 * longer exists. The get-started term is still exercised, by {@link BUILDER} — the cohort
 * where it is the ONLY thing granting `canBuild`.
 */
const AUTHOR: AppsNavContext = { isAuthor: true, canBuild: true, canSeeStore: true };
/**
 * A store-visible NON-author who may still reach `/apps/build`: `canAccessAppsBuild`'s
 * `appBlocksGetStarted` disjunct. The cohort the recruiting pitch (state A) exists for.
 */
const BUILDER: AppsNavContext = { isAuthor: false, canBuild: true, canSeeStore: true };
/**
 * The widened store-visibility tester cohort: sees the store, cannot author and cannot
 * build (no `appBlocksGetStarted`). This is the LIVE `< 2` collapse cohort — Marketplace
 * is the only row that qualifies for them.
 */
const NOT_AUTHOR: AppsNavContext = { isAuthor: false, canBuild: false, canSeeStore: true };
/**
 * No store access at all. `canBuild` is `false` here BY CONSTRUCTION, not by choice:
 * `canAccessAppsBuild` ANDs `hasAppsStoreAccess`, so `{canBuild: true, canSeeStore:
 * false}` is a shape the container cannot produce.
 */
const NO_STORE: AppsNavContext = { isAuthor: false, canBuild: false, canSeeStore: false };

function tab(name: string) {
  return page.getByRole('tab', { name });
}

/** The tab labels currently in the document, in DOM order. */
function renderedTabs(): string[] {
  return page
    .getByRole('tab')
    .elements()
    .map((el) => (el.textContent ?? '').trim());
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
  test('Build + Marketplace are present for an author with an all-false summary', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    await expect.element(tab('Build')).toBeInTheDocument();
  });

  /**
   * 🔴 THE RETIRED-LABEL GUARD. "Build apps", "Create" and "My apps" were three separate
   * rows until the `/apps/build` consolidation folded them into one. A partial revert —
   * re-adding any one of those rows beside the new "Build" — is the most likely way this
   * table regresses, and every other test in this file would stay green through it
   * (they assert what IS rendered, never what is not). Asserted against the FULLEST
   * context + summary this view can be given, so a re-added row cannot hide behind an
   * unlucky fixture.
   */
  test('🔴 the retired tabs are gone: no Build apps / Create / My apps / My submissions', async () => {
    renderWithProviders(<AppsSubNavView summary={ALL} context={AUTHOR} currentPath="/apps" />);
    // Positive control first: the bar IS rendered and fully populated, so the absences
    // below are observations rather than a consequence of an empty container.
    await expect.element(tab('Build')).toBeInTheDocument();
    await expect.element(tab('Review')).toBeInTheDocument();
    for (const retired of ['Build apps', 'Create', 'My apps', 'My submissions', 'Submit']) {
      expect(tab(retired).elements(), `a tab named "${retired}" is still rendered`).toHaveLength(0);
    }
  });

  test('the Build tab points at /apps/build (the consolidated route)', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Build')).toBeInTheDocument();
    expect(tab('Build').element().getAttribute('href')).toBe('/apps/build');
  });

  test('the Build tab renders its leftSection icon (create affordance)', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Build')).toBeInTheDocument();
    // The tab's leftSection mounts a tabler SVG; assert an <svg> is present
    // inside the Build tab so the icon affordance isn't silently dropped.
    const icon = tab('Build').element().querySelector('svg');
    expect(icon).not.toBeNull();
  });

  test('with an all-false summary the conditional tabs are hidden', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    // None of the summary-driven tabs should render.
    expect(tab('Installed').elements()).toHaveLength(0);
    expect(tab('Invites').elements()).toHaveLength(0);
    expect(tab('Revenue').elements()).toHaveLength(0);
    expect(tab('Review').elements()).toHaveLength(0);
  });

  test('Installed shows ONLY when hasInstalls', async () => {
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasInstalls: true }}
        context={AUTHOR}
        currentPath="/apps"
      />
    );
    await expect.element(tab('Installed')).toBeInTheDocument();
    // The other conditionals stay hidden.
    expect(tab('Invites').elements()).toHaveLength(0);
    expect(tab('Revenue').elements()).toHaveLength(0);
    expect(tab('Review').elements()).toHaveLength(0);
  });

  /**
   * 🔴 RESTATED, NOT DELETED — the old test here was "hasSubmissions alone still lights
   * My apps", pinning the `/apps/my-submissions` → `/apps/mine` migration so a whole
   * population kept a nav route. "My apps" is now gone too, so that exact claim has no
   * subject; the rule that REPLACED it is the inverse and is just as load-bearing:
   *
   *   `hasSubmissions` and `hasEditableApps` must light NO tab at all.
   *
   * They are deliberately absent from the Build row's predicate even though they decide
   * what `/apps/build` RENDERS (`resolveAppsBuildState` reads both), because they arrive
   * from the client-only `getNavSummary` — a tab that appeared after mount is exactly the
   * hydration mismatch this component already survived once. Wiring either flag back into
   * the table fails HERE, and the pinned literal is what makes it fail: a mutant adding
   * `|| s.hasSubmissions` to Build would otherwise be invisible for an author (who
   * already has Build) and for a viewer with no summary flags.
   */
  test('🔴 hasSubmissions / hasEditableApps light NO tab (the Build row must not read them)', async () => {
    renderWithProviders(
      <>
        <RenderBarrier />
        <AppsSubNavView
          summary={{ ...NONE, hasSubmissions: true, hasEditableApps: true }}
          context={NOT_AUTHOR}
          currentPath="/apps"
        />
      </>
    );
    // This viewer qualifies for Marketplace alone, so the `< 2` collapse hides the bar —
    // which is itself the assertion: neither summary flag added a tab. The barrier makes
    // that absence a real observation; the next test is its positive control.
    await awaitCommit();
    expect(renderedTabs()).toEqual([]);
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
  });

  test('POSITIVE CONTROL: a summary flag that IS wired (hasInstalls) does light a tab', async () => {
    // The control for the test above. Same reader, same viewer, one flag changed to one
    // the table genuinely reads — without this, "no tab appeared" would also be satisfied
    // by a view that renders nothing for anyone.
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasSubmissions: true, hasEditableApps: true, hasInstalls: true }}
        context={NOT_AUTHOR}
        currentPath="/apps"
      />
    );
    await expect.element(tab('Installed')).toBeInTheDocument();
    // …and STILL no tab from the two unwired flags: the bar is exactly Marketplace +
    // Installed, so the pinned literal catches a mutant that wires either of them in.
    expect(renderedTabs()).toEqual(['Marketplace', 'Installed']);
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
    expect(tab('Invites').elements()).toHaveLength(0);
    expect(tab('Review').elements()).toHaveLength(0);
  });

  test('Review shows ONLY when isReviewer', async () => {
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, isReviewer: true }}
        context={AUTHOR}
        currentPath="/apps"
      />
    );
    await expect.element(tab('Review')).toBeInTheDocument();
    expect(tab('Installed').elements()).toHaveLength(0);
    expect(tab('Invites').elements()).toHaveLength(0);
    expect(tab('Revenue').elements()).toHaveLength(0);
  });

  test('an all-true summary + a full-capability viewer shows every tab, in table order', async () => {
    renderWithProviders(<AppsSubNavView summary={ALL} context={AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Review')).toBeInTheDocument();
    // Pinned as an ORDERED literal, not a presence loop: order is a real property of this
    // bar (build → discovery → manage → revenue → moderate) and a presence loop cannot
    // see a row that moved.
    expect(renderedTabs()).toEqual([
      'Build',
      'Marketplace',
      'Installed',
      'Invites',
      'Revenue',
      'Review',
    ]);
  });

  // 🔴 THE THREE PURELY SUMMARY-DRIVEN PREDICATES ARE UNCHANGED BY THE VIEWER
  // CAPABILITIES. THREE rows read `context` — `Build`, `Marketplace` and `Invites` — and
  // the three asserted below still read the summary alone. Asserted against a viewer with
  // NO capability but store access, so a predicate that accidentally picked up `isAuthor`
  // or `canBuild` (e.g. `(s, c) => c.isAuthor && s.hasInstalls`) fails here even though
  // the author-context tests above would stay green.
  //
  // 🔴 Do NOT "simplify" `Invites` back to a summary-only predicate. It and the retired
  // "My apps" were exactly that until a merge with main silently reverted them: main
  // widened `visible` to `(summary, context)`, this branch had added both against the OLD
  // one-argument signature, and git merged the two edits with no conflict. It compiled
  // and the whole suite passed while both tabs were un-gated. Its dedicated non-author
  // test below is what pins it now.
  test('the three summary-driven tabs are independent of isAuthor/canBuild (all-true summary)', async () => {
    renderWithProviders(<AppsSubNavView summary={ALL} context={NOT_AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Review')).toBeInTheDocument();
    // Marketplace is present because this viewer HAS store access; Build and Invites are
    // the two rows the capabilities remove.
    expect(renderedTabs()).toEqual(['Marketplace', 'Installed', 'Revenue', 'Review']);
  });
});

/**
 * 🔴 THE BUILD TAB IS GATED ON `canBuild` — i.e. on `canAccessAppsBuild`, the SHARED
 * predicate `/apps/build`'s own `getServerSideProps` calls (`resolveBuildPageAccess`).
 *
 * THIS BLOCK CARRIES THE INTENT OF THE OLD "Create is gated on the author capability"
 * describe. That test existed because `/apps/submit` `notFound`s a non-author while the
 * tab was hardcoded `visible: () => true`, so the widened store-visibility cohort
 * (`app-listings=true`, `app-blocks-author=false` — verified live on a real tester
 * account) was offered a tab straight into a 404. "Create" is gone, but the rule it
 * pinned is not: the SINGLE authoring row left in this bar must be visible to exactly the
 * cohort its page admits. At this level that surfaces as `context.canBuild`; the
 * container derivation (and the moderator floor inside `isAppDeveloper`) is covered in
 * `AppsSubNav.hydration.browser.test.tsx`.
 *
 * Both directions are asserted, because asserting only the absence passes on a tab that
 * renders for nobody and only the presence passes on a tab that renders for everybody.
 */
describe('AppsSubNavView (Build is gated on canBuild)', () => {
  test('Build is HIDDEN for a store-visible viewer who cannot build', async () => {
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
    // …and Build is absent from it.
    expect(tab('Build').elements()).toHaveLength(0);
  });

  test('Build is VISIBLE when canBuild is held', async () => {
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasInstalls: true }}
        context={AUTHOR}
        currentPath="/apps"
      />
    );
    await expect.element(tab('Build')).toBeInTheDocument();
    expect(tab('Build').element().getAttribute('href')).toBe('/apps/build');
  });

  test('a viewer without canBuild gets no Build tab even with every summary flag true', async () => {
    // 🔴 The summary can never substitute for the capability. `hasSubmissions` /
    // `hasEditableApps` describe someone who has genuinely built something, and it is
    // still not enough — the page's gate is what decides, and it does not read them.
    renderWithProviders(<AppsSubNavView summary={ALL} context={NOT_AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Review')).toBeInTheDocument();
    expect(tab('Build').elements()).toHaveLength(0);
  });

  test('canBuild WITHOUT the author capability is enough (the get-started disjunct)', async () => {
    // `canAccessAppsBuild` is `store && (isAppDeveloper || appBlocksGetStarted)`, so a
    // non-author holding the get-started flag gets the tab. Fails if the row is
    // "simplified" to `c.isAuthor`.
    renderWithProviders(<AppsSubNavView summary={NONE} context={BUILDER} currentPath="/apps" />);
    await expect.element(tab('Build')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Build', 'Marketplace']);
  });
});

/**
 * 🔴 THE MARKETPLACE ROW IS STORE-GATED NOW — THE EXPOSURE THIS CHANGE CLOSED.
 *
 * It was `visible: () => true` while `/apps` gates on `resolveAppsPageAccess`
 * (`hasAppsStoreAccess`), a mismatch documented on three files and left open ON PURPOSE:
 * closing it used to drop the get-started-only cohort to ONE tab, where the `< 2`
 * collapse deletes the whole bar, so the exposure was the lesser evil. "Build" becoming
 * store-gated (`canAccessAppsBuild` ANDs `hasAppsStoreAccess`) removed that objection —
 * such a viewer now has no `/apps/*` destination at all — so the row was gated.
 *
 * 🔴 THE PAIR IS THE TEST. A bare "no Marketplace for `canSeeStore: false`" would also
 * pass on a row that renders for nobody, so the SAME summary is rendered against the SAME
 * viewer with ONLY `canSeeStore` moved. Nothing else differs between the two arms, which
 * is what attributes the tab to the flag.
 *
 * ⚠️ HONEST ABOUT THE FIXTURE: the container cannot produce "no store access + a populated
 * summary" (the `getNavSummary` query is `enabled` on `appBlocks`, one of the store
 * disjuncts), and it returns `null` outright for a viewer with no store access. Two
 * summary flags are used here purely so the bar clears the `< 2` floor and the MISSING
 * ROW is observable at all — this is a test of the ROW predicate. The container-level
 * claim (no store access ⇒ no bar whatsoever) is pinned in
 * `AppsSubNav.storeGate.browser.test.tsx`.
 */
describe('AppsSubNavView (Marketplace is gated on canSeeStore)', () => {
  const TWO_SUMMARY_TABS: AppsNavSummary = { ...NONE, hasInstalls: true, isReviewer: true };

  test('🔴 canSeeStore=false ⇒ NO Marketplace tab (was `visible: () => true`)', async () => {
    renderWithProviders(
      <AppsSubNavView summary={TWO_SUMMARY_TABS} context={NO_STORE} currentPath="/apps" />
    );
    // Positive control: the bar renders, on the two summary-driven rows.
    await expect.element(tab('Installed')).toBeInTheDocument();
    await expect.element(tab('Review')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Installed', 'Review']);
    expect(tab('Marketplace').elements()).toHaveLength(0);
  });

  test('🔴 DISCRIMINATING CONTROL: the same viewer WITH canSeeStore does get Marketplace', async () => {
    renderWithProviders(
      <AppsSubNavView summary={TWO_SUMMARY_TABS} context={NOT_AUTHOR} currentPath="/apps" />
    );
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Installed', 'Review']);
    expect(tab('Marketplace').element().getAttribute('href')).toBe('/apps');
  });
});

/**
 * 🔴 THE <2-TAB COLLAPSE, AND THE COHORT THAT STILL REACHES IT.
 *
 * RE-DERIVED FOR THE NEW ROW SET rather than carried over. With Marketplace now gated on
 * `canSeeStore`, "qualifies for exactly one tab" needs re-deriving from scratch — and the
 * answer is the SAME LIVE COHORT as before, for a different reason:
 *
 *   store-visible (`canSeeStore: true`) · NOT an author · no `appBlocksGetStarted`
 *   (⇒ `canBuild: false`) · empty summary  ⇒  Marketplace ALONE ⇒ no bar.
 *
 * Before this change that viewer had Marketplace because the row was unconditional; now
 * they have it because they genuinely hold store access. Either way it is one tab and the
 * bar hides itself. The cohort is real: `app-dev-testers` with the kill switch off.
 *
 * The OTHER shape — no store access — does not reach this collapse at all: the CONTAINER
 * returns `null` before the view is rendered (see the storeGate suite).
 *
 * Both directions are asserted for the Build row — absent without the capability, present
 * with it — because asserting only one of them passes on a tab that renders for nobody,
 * and asserting only the other passes on a tab that renders for everybody. The second
 * shape is the defect this block exists to catch: an unconditional "Build" offers the
 * store-visible non-author cohort a tab whose page answers `notFound`, and defeats the
 * `app-blocks-get-started` kill switch for every non-author.
 */
describe('AppsSubNavView (the collapse, and the canBuild gate that keeps it live)', () => {
  test('🔴 a store-visible non-author with an EMPTY summary and no canBuild renders NOTHING', async () => {
    // The `< 2` collapse: Marketplace alone. Making "Build" unconditional fails HERE, on
    // all three readers.
    renderWithProviders(
      <>
        <RenderBarrier />
        <AppsSubNavView summary={NONE} context={NOT_AUTHOR} currentPath="/apps" />
      </>
    );
    await awaitCommit(); // without this the assertions below cannot fail — see RENDER_BARRIER
    expect(tab('Marketplace').elements()).toHaveLength(0);
    expect(page.getByRole('tablist').elements()).toHaveLength(0);
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
  });

  test('🔴 canBuild is what brings the bar back for that same viewer', async () => {
    // Identical summary and identical `isAuthor`/`canSeeStore` — ONLY `canBuild` moves.
    // That is what makes the pair attribute the bar to the build capability rather than
    // to some other difference between two fixtures.
    renderWithProviders(<AppsSubNavView summary={NONE} context={BUILDER} currentPath="/apps" />);
    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Build', 'Marketplace']);
  });

  test('🔴 Build is ABSENT for a store-visible viewer WITHOUT the capability', async () => {
    // The cohort the defect would have 404'd. Given an install so the bar clears the
    // floor on Marketplace + Installed, making this an assertion about the TAB rather
    // than about the bar.
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasInstalls: true }}
        context={NOT_AUTHOR}
        currentPath="/apps"
      />
    );
    await expect.element(tab('Marketplace')).toBeInTheDocument(); // positive control
    await expect.element(tab('Installed')).toBeInTheDocument();
    expect(tab('Build').elements()).toHaveLength(0);
  });

  test('the Build tab points at /apps/build, NOT the retired /apps/get-started', async () => {
    renderWithProviders(<AppsSubNavView summary={NONE} context={BUILDER} currentPath="/apps" />);
    await expect.element(tab('Build')).toBeInTheDocument();
    expect(tab('Build').element().getAttribute('href')).toBe('/apps/build');
    // `/apps/get-started` is deleted and 301s to `/apps/build`; a tab still pointing at
    // it would send every click through a redirect (and would be dead the day the
    // redirect is retired). Read from the RENDERED anchors, so a row that kept the old
    // href under any label is caught.
    const hrefs = page
      .getByRole('tab')
      .elements()
      .map((el) => el.getAttribute('href'));
    expect(hrefs).toEqual(['/apps/build', '/apps']); // non-empty: the check below can fail
    expect(hrefs).not.toContain('/apps/get-started');
  });

  test('it leads the bar — Build is the FIRST tab when it renders', async () => {
    renderWithProviders(<AppsSubNavView summary={ALL} context={AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Build')).toBeInTheDocument();
    expect(renderedTabs()[0]).toBe('Build');
  });

  test('a summary flag alone brings the bar back (one install, no canBuild)', async () => {
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasInstalls: true }}
        context={NOT_AUTHOR}
        currentPath="/apps"
      />
    );
    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Installed']);
  });

  // 🔴 NEGATIVE CONTROL for the counts above. Every assertion in this block is
  // "the bar IS there with these tabs", and a reader wired to nothing would satisfy
  // none of them — but a `visible` predicate that had silently become `() => true`
  // for a conditional tab would satisfy all of them too. This one fails in that
  // case: a non-author must still NOT get Invites, however full their summary is.
  test('NEGATIVE CONTROL: the conditional tabs are still conditional', async () => {
    renderWithProviders(<AppsSubNavView summary={ALL} context={BUILDER} currentPath="/apps" />);
    await expect.element(tab('Build')).toBeInTheDocument();
    expect(tab('Invites').elements()).toHaveLength(0);
    expect(renderedTabs()).toEqual(['Build', 'Marketplace', 'Installed', 'Revenue', 'Review']);
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
    expect(tab('Build').element().getAttribute('aria-selected')).toBe('false');
  });

  test('the Build tab is selected on /apps/build (and Marketplace is not)', async () => {
    renderWithProviders(
      <AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps/build" />
    );
    await expect.element(tab('Build')).toBeInTheDocument();
    expect(tab('Build').element().getAttribute('aria-selected')).toBe('true');
    expect(tab('Marketplace').element().getAttribute('aria-selected')).toBe('false');
  });

  /**
   * 🔴 `/apps/submit` KEPT ITS ROUTE AND LOST ITS TAB, so the bar must light NOTHING
   * there — no tab may claim a route it does not own. This is the one assertion that
   * fails if the retired "Create" row is re-added to the table, and it fails from the
   * OPPOSITE direction to the retired-label guard above (that one reads labels; this one
   * reads the active-route resolution), so a partial revert cannot slip past both.
   */
  test('🔴 on /apps/submit — which has no tab any more — no tab is selected', async () => {
    renderWithProviders(
      <AppsSubNavView summary={ALL} context={AUTHOR} currentPath="/apps/submit" />
    );
    await expect.element(tab('Build')).toBeInTheDocument(); // the bar IS rendered
    for (const name of ['Build', 'Marketplace', 'Installed', 'Invites', 'Revenue', 'Review']) {
      expect(tab(name).element().getAttribute('aria-selected'), `${name} is selected`).toBe(
        'false'
      );
    }
  });

  // 🔴 Highlighting with `Build` ABSENT. `activeAppsTab` resolves against the
  // full link table, so a hidden tab must not steal or suppress the highlight on
  // the tabs that DID render.
  test('with Build hidden, the active route still lights the right tab', async () => {
    renderWithProviders(
      <AppsSubNavView summary={ALL} context={NOT_AUTHOR} currentPath="/apps/installed" />
    );
    await expect.element(tab('Installed')).toBeInTheDocument();
    expect(tab('Build').elements()).toHaveLength(0);
    expect(tab('Installed').element().getAttribute('aria-selected')).toBe('true');
    // Every other rendered tab is unselected — exactly one highlight.
    for (const name of ['Marketplace', 'Revenue', 'Review']) {
      expect(tab(name).element().getAttribute('aria-selected')).toBe('false');
    }
  });

  test('with Build hidden, /apps still lights Marketplace', async () => {
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasInstalls: true }}
        context={NOT_AUTHOR}
        currentPath="/apps"
      />
    );
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(tab('Build').elements()).toHaveLength(0);
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
      // The consolidated authoring surface — absorbed `/apps/get-started` (301) and
      // `/apps/mine` (301); `/apps/submit` survives as a route reached from the page's
      // create buttons and the `?edit=` deep link, not from this bar.
      ['Build', '/apps/build'],
      ['Marketplace', '/apps'],
      ['Installed', '/apps/installed'],
      // The collaborator inbox: `appCollaborators.listMyPendingInvites`. Owner-INDEPENDENT
      // — an invitee who owns nothing reaches every other tab's page empty.
      ['Invites', '/apps/invites'],
      ['Revenue', '/apps/revenue'],
      ['Review', '/apps/review'],
    ];
    for (const [name, href] of cases) {
      await expect.element(tab(name)).toBeInTheDocument();
      expect(tab(name).element().getAttribute('href')).toBe(href);
    }
    // The set is CLOSED: exactly these six, so a re-added retired row (whose href would
    // not be in `cases`) fails here rather than being silently ignored by the loop.
    expect(renderedTabs()).toHaveLength(cases.length);
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
  //
  // 🔴 THREE tabs, and we arrow from the SELECTED one onto an UNSELECTED one. With the
  // two-tab bar this file used to have, `Build` + `Marketplace` on `/apps`, arrowing off
  // Marketplace lands back on Build and the "selection did not follow focus" assertion
  // would be about a tab that was never selected — much weaker.
  test('ArrowRight moves focus but does NOT change the selected tab (no auto-activate)', async () => {
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasInstalls: true }}
        context={AUTHOR}
        currentPath="/apps"
      />
    );
    // Wait for the async render before reaching into the DOM synchronously.
    await expect.element(tab('Installed')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Build', 'Marketplace', 'Installed']);

    const marketplace = tab('Marketplace').element() as HTMLElement;
    const installed = tab('Installed').element() as HTMLElement;

    // Marketplace (= current route) is the selected tab; Installed is not.
    expect(marketplace.getAttribute('aria-selected')).toBe('true');
    expect(installed.getAttribute('aria-selected')).toBe('false');

    // Focus the selected tab, then arrow to the next one.
    marketplace.focus();
    expect(document.activeElement).toBe(marketplace);
    await userEvent.keyboard('{ArrowRight}');

    // Focus moved to Installed (keyboard-reachable scan)…
    expect(document.activeElement).toBe(installed);
    // …but selection (aria-selected, driven by the route) did NOT follow focus.
    // If activateTabWithKeyboard were on, Installed would now be aria-selected=true.
    expect(installed.getAttribute('aria-selected')).toBe('false');
    expect(marketplace.getAttribute('aria-selected')).toBe('true');
  });

  test('Enter/Space still activate: the focused tab is a real anchor with the right href', async () => {
    // We don't fire Enter (it would trigger a real navigation in browser mode);
    // instead we assert the keyboard-activation contract structurally — the
    // focusable element IS the `<a href>` the route points at, so native
    // anchor activation (Enter) navigates correctly even with arrow-activation off.
    renderWithProviders(<AppsSubNavView summary={NONE} context={AUTHOR} currentPath="/apps" />);
    await expect.element(tab('Build')).toBeInTheDocument();
    const build = tab('Build').element() as HTMLElement;
    build.focus();
    expect(document.activeElement).toBe(build);
    expect(build.tagName.toLowerCase()).toBe('a');
    expect(build.getAttribute('href')).toBe('/apps/build');
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
    expect(isActiveAppsRoute('/apps/installedX', '/apps/installed')).toBe(false);
    expect(isActiveAppsRoute('/apps/build', '/apps/installed')).toBe(false);
  });

  test('activeAppsTab resolves the active tab href, or null when none matches', () => {
    expect(activeAppsTab('/apps')).toBe('/apps');
    expect(activeAppsTab('/apps/build')).toBe('/apps/build');
    expect(activeAppsTab('/apps/revenue')).toBe('/apps/revenue');
    // A deep /apps/* route with no corresponding tab → no active tab.
    expect(activeAppsTab('/apps/run/some-slug')).toBeNull();
  });

  /**
   * 🔴 THE RETIRED ROUTES RESOLVE TO NO TAB. `/apps/get-started` and `/apps/mine` are
   * deleted (both 301 to `/apps/build`) and `/apps/submit` kept its route but lost its
   * row — so none of the three may resolve to an active tab. `activeAppsTab` reads the
   * table directly, so this fails the moment any of those rows is re-added, without
   * needing to render anything.
   */
  test('🔴 the retired/tab-less routes resolve to NO active tab', () => {
    expect(activeAppsTab('/apps/get-started')).toBeNull();
    expect(activeAppsTab('/apps/mine')).toBeNull();
    expect(activeAppsTab('/apps/submit')).toBeNull();
  });
});

/**
 * 🔴 `Invites` IS THE ONE SURVIVING `isAuthor`-GATED ROW — the semantic defect that a
 * CLEAN git merge produced and that no test would have caught.
 *
 * `origin/main` (#3899) widened `SubNavLink.visible` to `(summary, context)` and gated
 * "Create" on `context.isAuthor`, because `/apps/submit` `notFound`s a non-author. This
 * branch added "My apps" and "Invites" against the OLD one-argument signature. Git
 * auto-merged the table with no conflict, the result compiled, and every test passed —
 * leaving two tabs whose pages gate on `features.appBlocksAuthor` + `isAppDeveloper`
 * visible to viewers those pages refuse.
 *
 * "My apps" is gone (absorbed by `/apps/build`), so `Invites` now carries this block
 * alone. Its gate is NOT redundant with `canBuild`: `/apps/invites` gates on
 * `appBlocksAuthor` + `isAppDeveloper`, which the get-started term does not satisfy — a
 * {@link BUILDER} has `canBuild` and must still be refused this tab.
 *
 * Both directions are asserted: presence for an author, absence for a non-author with the
 * SAME summary. Asserting only the absence would pass on a tab that renders for nobody.
 */
describe('AppsSubNavView (Invites is gated on the author capability)', () => {
  test('Invites renders for an AUTHOR whose hasPendingInvites is true', async () => {
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasPendingInvites: true }}
        context={AUTHOR}
        currentPath="/apps"
      />
    );
    await expect.element(tab('Invites')).toBeInTheDocument();
    expect(tab('Invites').element().getAttribute('href')).toBe('/apps/invites');
  });

  test('🔴 Invites is HIDDEN from a NON-author, even with hasPendingInvites true', async () => {
    // The store-visible tester cohort (`app-listings=true`, `app-blocks-author=false`).
    // `blocks.getNavSummary` is gated on the MARKETPLACE flag, not the author one, so
    // this combination is reachable — an owner can invite any existing user, and an
    // author who loses the capability keeps their listings.
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
    expect(tab('Invites').elements()).toHaveLength(0);
  });

  test('🔴 canBuild is NOT enough for Invites — a BUILDER is still refused it', async () => {
    // The get-started cohort holds `canBuild` but not `appBlocksAuthor`, and
    // `/apps/invites` gates on the latter. Fails if `Invites` is "simplified" to
    // `c.canBuild && s.hasPendingInvites`, which the presence/absence pair above cannot
    // see (a BUILDER differs from both of those fixtures).
    renderWithProviders(
      <AppsSubNavView
        summary={{ ...NONE, hasPendingInvites: true }}
        context={BUILDER}
        currentPath="/apps"
      />
    );
    await expect.element(tab('Build')).toBeInTheDocument(); // the bar IS rendered
    expect(renderedTabs()).toEqual(['Build', 'Marketplace']);
    expect(tab('Invites').elements()).toHaveLength(0);
  });

  test('a NON-author invitee gets no sub-nav at all (1 qualifying tab ⇒ hidden)', async () => {
    // Marketplace alone survives the author gate and the `< 2` collapse then hides the
    // bar — so the two changes compose to the right end state rather than merely not
    // crashing. (This viewer cannot build either; the same fixture WITH `canBuild` is
    // covered in the collapse block.)
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
    expect(tab('Invites').elements()).toHaveLength(0);
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
  });

  test('an AUTHOR invitee DOES get the bar: Build + Marketplace + Invites', async () => {
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
    expect(renderedTabs()).toEqual(['Build', 'Marketplace', 'Invites']);
  });
});

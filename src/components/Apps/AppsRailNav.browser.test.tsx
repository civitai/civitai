import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import Router from 'next/router';
import {
  activeAppsSection,
  getAppsSectionHref,
  isActiveAppsRoute,
  visibleAppsSections,
  type AppsNavContext,
  type AppsNavSummary,
  type AppsSection,
} from '~/components/Apps/apps-sections';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The `/apps/*` LEFT RAIL — conditional section visibility, the `< 2` collapse, the
 * navigation landmark, and active-route highlighting.
 *
 * 🔴 THIS FILE IS THE PORT OF `AppsSubNav.browser.test.tsx`, AND THE PORT CHANGED WHAT
 * IT RENDERS RATHER THAN WHAT IT CLAIMS. The horizontal tab strip became a vertical
 * rail, so three things moved and everything else is carried over verbatim:
 *
 *   • the REGISTRY moved from `SUB_NAV_LINKS` (module-private in `AppsSubNav.tsx`) to
 *     the exported `appsSections` (`apps-sections.ts`), so the visibility predicates can
 *     be driven directly here instead of through a presentational component's props;
 *   • the `< 2 sections ⇒ render nothing` COLLAPSE moved from the view into
 *     `AppsPageLayout`, because the layout also has to stop reserving the rail's 276px of
 *     horizontal chrome. So this file renders the REAL `AppsPageLayout` with the data
 *     hook stubbed, rather than a presentational view in isolation — which exercises the
 *     collapse where it now lives instead of re-implementing it in a fixture;
 *   • the ROLE changed. Tabs were `role="tab"` with `aria-selected`; rail entries are
 *     plain anchors in a `<nav>` landmark, so they are `role="link"` with
 *     `aria-current="page"`. The keyboard block that pinned
 *     `activateTabWithKeyboard={false}` is GONE and is not replaced — see the note on
 *     `AppsRailNavView`: Mantine's roving-tabindex handler was what made arrow keys
 *     navigate, and a list of anchors has no such handler, so the defect is structurally
 *     absent rather than suppressed by a prop. There is nothing left to assert about it.
 *
 * TWO input objects, on purpose (they have different provenance and different
 * hydration behaviour — see the type docs):
 *   - `summary`  — the `blocks.getNavSummary` booleans (client-only, revealed
 *                  post-mount).
 *   - `context`  — viewer CAPABILITIES resolved from SSR-seeded values
 *                  (`isAuthor`, `canBuild`, `canSeeStore`), safe on the first paint.
 *
 * NOTE: this env does not load `@mantine/core/styles.css`, so we assert
 * presence / ARIA attributes / href — never computed styles.
 */

const NONE: AppsNavSummary = {
  hasInstalls: false,
  hasActivity: false,
  hasSubmissions: false,
  hasApprovedApps: false,
  isReviewer: false,
  hasEditableApps: false,
  hasPendingInvites: false,
};

const ALL: AppsNavSummary = {
  hasInstalls: true,
  hasActivity: true,
  hasSubmissions: true,
  hasApprovedApps: true,
  isReviewer: true,
  hasEditableApps: true,
  hasPendingInvites: true,
};

/**
 * Sees the store, may reach `/apps/build`, and may AUTHOR (mod, or a non-mod holding
 * `appBlocksAuthor`) — today's live moderator / `app-dev-testers` shape.
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

/**
 * 🔴 THE DATA HOOK IS STUBBED; THE LAYOUT AND THE RAIL ARE REAL. That split is what lets
 * this file drive the predicates directly (through `visibleAppsSections`, the registry's
 * own filter) while still exercising the production collapse and the production markup.
 * Stubbing the RAIL instead would leave both untested here.
 */
const state: { sections: AppsSection[] } = { sections: [] };
vi.mock('~/components/Apps/useAppsNavSections', () => ({
  useAppsNavSections: () => state.sections,
}));

const { AppsPageLayout } = await import('~/components/Apps/AppsPageLayout');

/**
 * 🔴 RENDER BARRIER — required for every "this renders NOTHING" assertion here.
 *
 * `render()` mounts through a React 18 concurrent root, so the DOM is committed on a
 * LATER task, not synchronously. A bare `expect(locator.elements()).toHaveLength(0)`
 * straight after `renderWithProviders` therefore observes an EMPTY container and passes
 * no matter what the component does — structurally unfailable. Caught by mutation on the
 * tab-strip original: deleting the `< 2` hide left the collapse tests GREEN until the
 * barrier was added. The layout's own `children` slot IS the barrier here, so every
 * render below gets one for free.
 */
const RENDER_BARRIER = 'render-barrier';
async function awaitCommit() {
  await expect.element(page.getByTestId(RENDER_BARRIER)).toBeInTheDocument();
}

/**
 * 🔴 EVERY RENDER SETS A DESKTOP VIEWPORT FIRST, AND IT IS NOT OPTIONAL HERE.
 * `AppsPageLayout.module.scss` hides the rail with `display: none` below
 * `APPS_RAIL_MIN_VIEWPORT` (1300) and shows the drawer trigger instead — that is the
 * whole responsive mechanism, and it is CSS rather than a hook precisely so the server
 * and the first client paint agree. A browser-mode iframe defaults NARROWER than 1300,
 * so without this every `getByRole('link', …)` below resolves nothing: the anchors are in
 * the DOM but are not in the accessibility tree, and the failure reads as "the rail did
 * not render" when the rail rendered correctly for the width it was given. Measured: 39
 * tests failed this way before the viewport was set.
 *
 * The NARROW form is exercised deliberately in its own block at the end of this file.
 */
async function renderNav(summary: AppsNavSummary, context: AppsNavContext, currentPath: string) {
  await page.viewport(1440, 900);
  state.sections = visibleAppsSections(summary, context);
  // The scaffold's `next/router` mock is a mutable singleton — `useRouter()` hands back
  // this same object — so the rail's `router.pathname` read is driven by assignment.
  (Router as unknown as { pathname: string }).pathname = currentPath;
  renderWithProviders(
    <AppsPageLayout>
      <div data-testid={RENDER_BARRIER} />
    </AppsPageLayout>
  );
}

/** The rail's `<nav>`, or null when the collapse removed it. */
function navEl(): HTMLElement | null {
  return document.querySelector('nav[aria-label="App sections"]');
}

function link(name: string) {
  return page.getByRole('link', { name });
}

/** The section labels currently in the rail, in DOM order. */
function renderedSections(): string[] {
  const nav = navEl();
  if (!nav) return [];
  return Array.from(nav.querySelectorAll('a')).map((el) => (el.textContent ?? '').trim());
}

/** The group HEADINGS currently in the rail, in DOM order. */
function renderedGroups(): string[] {
  const nav = navEl();
  if (!nav) return [];
  return Array.from(nav.children)
    .filter((el) => el.tagName.toLowerCase() !== 'a')
    .map((el) => (el.textContent ?? '').trim())
    .filter(Boolean);
}

describe('the rail renders the conditional section set', () => {
  test('Build + Marketplace are present for an author with an all-false summary', async () => {
    await renderNav(NONE, AUTHOR, '/apps');
    await expect.element(link('Marketplace')).toBeInTheDocument();
    await expect.element(link('Build')).toBeInTheDocument();
  });

  /**
   * 🔴 THE RETIRED-LABEL GUARD. "Build apps", "Create" and "My apps" were three separate
   * rows until the `/apps/build` consolidation folded them into one. A partial revert —
   * re-adding any one of those rows beside the new "Build" — is the most likely way this
   * table regresses, and every other test in this file would stay green through it
   * (they assert what IS rendered, never what is not). Asserted against the FULLEST
   * context + summary the registry can be given, so a re-added row cannot hide behind an
   * unlucky fixture.
   */
  test('🔴 the retired entries are gone: no Build apps / Create / My apps / My submissions', async () => {
    await renderNav(ALL, AUTHOR, '/apps');
    // Positive control first: the rail IS rendered and fully populated, so the absences
    // below are observations rather than a consequence of an empty container.
    await expect.element(link('Build')).toBeInTheDocument();
    await expect.element(link('Review')).toBeInTheDocument();
    for (const retired of ['Build apps', 'Create', 'My apps', 'My submissions', 'Submit']) {
      expect(renderedSections(), `an entry named "${retired}" is still rendered`).not.toContain(
        retired
      );
    }
  });

  test('the Build entry points at /apps/build (the consolidated route)', async () => {
    await renderNav(NONE, AUTHOR, '/apps');
    await expect.element(link('Build')).toBeInTheDocument();
    expect(link('Build').element().getAttribute('href')).toBe('/apps/build');
  });

  test('the Build entry renders its icon (create affordance)', async () => {
    await renderNav(NONE, AUTHOR, '/apps');
    await expect.element(link('Build')).toBeInTheDocument();
    expect(link('Build').element().querySelector('svg')).not.toBeNull();
  });

  test('with an all-false summary the conditional entries are hidden', async () => {
    await renderNav(NONE, AUTHOR, '/apps');
    await expect.element(link('Build')).toBeInTheDocument();
    expect(renderedSections()).toEqual(['Marketplace', 'Build']);
  });

  test('Activity shows when hasInstalls', async () => {
    await renderNav({ ...NONE, hasInstalls: true }, AUTHOR, '/apps');
    await expect.element(link('Activity')).toBeInTheDocument();
    expect(renderedSections()).toEqual(['Marketplace', 'Activity', 'Build']);
  });

  /**
   * 🔴 THE ROW-LEVEL HALF OF THE `hasActivity` FIX, AND THE ASSERTION THAT MATTERS: a
   * viewer with ACTIVITY and ZERO INSTALLS must get the entry.
   *
   * That viewer is not hypothetical, they are the cohort `/apps/installed` →
   * `/apps/activity` was renamed for. A full-page app (`/apps/run/<slug>`) is STATELESS by
   * design, so someone who only runs page apps has generations, scope-gated API calls and
   * Buzz spends in the feed, and `hasInstalls: false` forever. The row shipped as
   * `visible: (s) => s.hasInstalls`, which is dark for exactly them while `/apps/activity`
   * (gated on `appBlocks || appBlocksPages`) serves them.
   *
   * 🔴 RED WITHOUT THE PREDICATE, AND FOR THIS TEST'S OWN REASON. Restore
   * `visible: (s) => s.hasInstalls` and this fails on the `expect.element` timing out —
   * no Activity entry renders — while `Activity shows when hasInstalls` above stays
   * green. A test that only asserted the summary FIELD exists could not tell those two
   * implementations apart.
   */
  test('🔴 Activity shows for hasActivity with NO installs (the page-app cohort)', async () => {
    await renderNav({ ...NONE, hasActivity: true }, NOT_AUTHOR, '/apps');
    await expect.element(link('Activity')).toBeInTheDocument();
    // …and it is the ONLY conditional entry this summary lights, so the pass cannot be a
    // row that became unconditional.
    expect(renderedSections()).toEqual(['Marketplace', 'Activity']);
  });

  test('NEGATIVE CONTROL: neither installs nor activity ⇒ no Activity entry', async () => {
    await renderNav(
      { ...NONE, hasInstalls: false, hasActivity: false, isReviewer: true },
      AUTHOR,
      '/apps'
    );
    await expect.element(link('Review')).toBeInTheDocument();
    expect(renderedSections()).not.toContain('Activity');
  });

  /**
   * 🔴 `hasSubmissions` and `hasEditableApps` must light NO entry at all.
   *
   * They are deliberately absent from the Build row's predicate even though they decide
   * what `/apps/build` RENDERS (`resolveAppsBuildState` reads both), because they arrive
   * from the client-only `getNavSummary` — an entry that appeared after mount is exactly
   * the hydration mismatch this surface already survived once. Wiring either flag back
   * into the table fails HERE, and the pinned literal is what makes it fail: a mutant
   * adding `|| s.hasSubmissions` to Build would otherwise be invisible for an author (who
   * already has Build) and for a viewer with no summary flags.
   */
  test('🔴 hasSubmissions / hasEditableApps light NO entry (the Build row must not read them)', async () => {
    await renderNav({ ...NONE, hasSubmissions: true, hasEditableApps: true }, NOT_AUTHOR, '/apps');
    // This viewer qualifies for Marketplace alone, so the `< 2` collapse removes the rail
    // — which is itself the assertion: neither summary flag added an entry. The barrier
    // makes that absence a real observation; the next test is its positive control.
    await awaitCommit();
    expect(renderedSections()).toEqual([]);
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
  });

  test('POSITIVE CONTROL: a summary flag that IS wired (hasInstalls) does light an entry', async () => {
    await renderNav(
      { ...NONE, hasSubmissions: true, hasEditableApps: true, hasInstalls: true },
      NOT_AUTHOR,
      '/apps'
    );
    await expect.element(link('Activity')).toBeInTheDocument();
    // …and STILL no entry from the two unwired flags, so the pinned literal catches a
    // mutant that wires either of them in.
    expect(renderedSections()).toEqual(['Marketplace', 'Activity']);
  });

  test('Revenue shows ONLY when hasApprovedApps', async () => {
    await renderNav({ ...NONE, hasApprovedApps: true }, AUTHOR, '/apps');
    await expect.element(link('Revenue')).toBeInTheDocument();
    expect(renderedSections()).toEqual(['Marketplace', 'Revenue', 'Build']);
  });

  test('Review shows ONLY when isReviewer', async () => {
    await renderNav({ ...NONE, isReviewer: true }, AUTHOR, '/apps');
    await expect.element(link('Review')).toBeInTheDocument();
    expect(renderedSections()).toEqual(['Marketplace', 'Build', 'Review']);
  });

  test('an all-true summary + a full-capability viewer shows every entry, in registry order', async () => {
    await renderNav(ALL, AUTHOR, '/apps');
    await expect.element(link('Review')).toBeInTheDocument();
    // Pinned as an ORDERED literal, not a presence loop: order is a real property of this
    // nav (discovery → manage → revenue → build → moderate) and a presence loop cannot
    // see a row that moved.
    //
    // 🔴 `Build` SITS SECOND-TO-LAST, and this literal is what makes that a checked fact
    // rather than a claim in a comment. It is the narrowest-audience entry here, so
    // leading with it put the smallest cohort's destination in the position that reads as
    // "what this nav is for".
    expect(renderedSections()).toEqual([
      'Marketplace',
      'Activity',
      'Invites',
      'Revenue',
      'Build',
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
  // widened `visible` to `(summary, context)`, a branch had added both against the OLD
  // one-argument signature, and git merged the two edits with no conflict. It compiled
  // and the whole suite passed while both entries were un-gated.
  test('the three summary-driven entries are independent of isAuthor/canBuild', async () => {
    await renderNav(ALL, NOT_AUTHOR, '/apps');
    await expect.element(link('Review')).toBeInTheDocument();
    expect(renderedSections()).toEqual(['Marketplace', 'Activity', 'Revenue', 'Review']);
  });
});

/**
 * 🔴 THE GROUP HEADINGS — the rail's one genuinely NEW affordance, and the only place
 * this port adds a claim rather than carrying one over.
 *
 * A horizontal strip had no room to name its phases, so `SUB_NAV_LINKS` carried its
 * ordering rule in prose ("discovery → manage → revenue → build → moderate"). The rail
 * renders those phases as headings. The risk that introduces is a heading with nothing
 * under it: a group whose every section is invisible for this viewer must not render its
 * own label into an otherwise-empty gap.
 */
describe('the rail groups sections, and never renders an empty group', () => {
  test('a full-capability viewer sees all four groups, in registry order', async () => {
    await renderNav(ALL, AUTHOR, '/apps');
    await expect.element(link('Review')).toBeInTheDocument();
    expect(renderedGroups()).toEqual(['Discover', 'Yours', 'Build', 'Moderate']);
  });

  test('🔴 a group with no visible section renders NO heading', async () => {
    // Marketplace + Build only: `Yours` and `Moderate` have nothing in them.
    await renderNav(NONE, AUTHOR, '/apps');
    await expect.element(link('Build')).toBeInTheDocument();
    expect(renderedSections()).toEqual(['Marketplace', 'Build']);
    expect(renderedGroups()).toEqual(['Discover', 'Build']);
  });
});

/**
 * 🔴 THE BUILD ENTRY IS GATED ON `canBuild` — i.e. on `canAccessAppsBuild`, the SHARED
 * predicate `/apps/build`'s own `getServerSideProps` calls (`resolveBuildPageAccess`).
 *
 * Both directions are asserted, because asserting only the absence passes on an entry
 * that renders for nobody and only the presence passes on one that renders for
 * everybody.
 */
describe('Build is gated on canBuild', () => {
  test('Build is HIDDEN for a store-visible viewer who cannot build', async () => {
    // Give the viewer an install so the rail still has two entries and renders —
    // otherwise the `< 2` collapse would remove the whole nav and this assertion would
    // pass for the WRONG reason (see the dedicated collapse tests below).
    await renderNav({ ...NONE, hasInstalls: true }, NOT_AUTHOR, '/apps');
    await expect.element(link('Marketplace')).toBeInTheDocument();
    await expect.element(link('Activity')).toBeInTheDocument();
    expect(renderedSections()).not.toContain('Build');
  });

  test('Build is VISIBLE when canBuild is held', async () => {
    await renderNav({ ...NONE, hasInstalls: true }, AUTHOR, '/apps');
    await expect.element(link('Build')).toBeInTheDocument();
    expect(link('Build').element().getAttribute('href')).toBe('/apps/build');
  });

  test('a viewer without canBuild gets no Build entry even with every summary flag true', async () => {
    // 🔴 The summary can never substitute for the capability. `hasSubmissions` /
    // `hasEditableApps` describe someone who has genuinely built something, and it is
    // still not enough — the page's gate is what decides, and it does not read them.
    await renderNav(ALL, NOT_AUTHOR, '/apps');
    await expect.element(link('Review')).toBeInTheDocument();
    expect(renderedSections()).not.toContain('Build');
  });

  test('canBuild WITHOUT the author capability is enough (the get-started disjunct)', async () => {
    // `canAccessAppsBuild` is `store && (isAppDeveloper || appBlocksGetStarted)`, so a
    // non-author holding the get-started flag gets the entry. Fails if the row is
    // "simplified" to `c.isAuthor`.
    await renderNav(NONE, BUILDER, '/apps');
    await expect.element(link('Build')).toBeInTheDocument();
    expect(renderedSections()).toEqual(['Marketplace', 'Build']);
  });
});

/**
 * 🔴 THE MARKETPLACE ROW IS STORE-GATED — THE EXPOSURE THAT GATING CLOSED.
 *
 * It was `visible: () => true` while `/apps` gates on `resolveAppsPageAccess`
 * (`hasAppsStoreAccess`), a mismatch documented on three files and left open ON PURPOSE:
 * closing it used to drop the get-started-only cohort to ONE entry, where the `< 2`
 * collapse deletes the whole nav, so the exposure was the lesser evil. "Build" becoming
 * store-gated (`canAccessAppsBuild` ANDs `hasAppsStoreAccess`) removed that objection.
 *
 * 🔴 THE PAIR IS THE TEST. A bare "no Marketplace for `canSeeStore: false`" would also
 * pass on a row that renders for nobody, so the SAME summary is rendered against the SAME
 * viewer with ONLY `canSeeStore` moved.
 *
 * ⚠️ HONEST ABOUT THE FIXTURE: the data hook cannot produce "no store access + a populated
 * summary" (the `getNavSummary` query is `enabled` on `appBlocks`, one of the store
 * disjuncts), and it returns `[]` outright for a viewer with no store access. Two summary
 * flags are used here purely so the rail clears the `< 2` floor and the MISSING ROW is
 * observable at all — this is a test of the ROW predicate. The container-level claim (no
 * store access ⇒ no rail whatsoever) is pinned in `AppsRailNav.storeGate.browser.test.tsx`.
 */
describe('Marketplace is gated on canSeeStore', () => {
  const TWO_SUMMARY_SECTIONS: AppsNavSummary = { ...NONE, hasInstalls: true, isReviewer: true };

  test('🔴 canSeeStore=false ⇒ NO Marketplace entry (was `visible: () => true`)', async () => {
    await renderNav(TWO_SUMMARY_SECTIONS, NO_STORE, '/apps');
    // Positive control: the rail renders, on the two summary-driven rows.
    await expect.element(link('Activity')).toBeInTheDocument();
    await expect.element(link('Review')).toBeInTheDocument();
    expect(renderedSections()).toEqual(['Activity', 'Review']);
  });

  test('🔴 DISCRIMINATING CONTROL: the same viewer WITH canSeeStore does get Marketplace', async () => {
    await renderNav(TWO_SUMMARY_SECTIONS, NOT_AUTHOR, '/apps');
    await expect.element(link('Marketplace')).toBeInTheDocument();
    expect(renderedSections()).toEqual(['Marketplace', 'Activity', 'Review']);
    expect(link('Marketplace').element().getAttribute('href')).toBe('/apps');
  });
});

/**
 * 🔴 THE `< 2` COLLAPSE, AND THE COHORT THAT STILL REACHES IT.
 *
 *   store-visible (`canSeeStore: true`) · NOT an author · no `appBlocksGetStarted`
 *   (⇒ `canBuild: false`) · empty summary  ⇒  Marketplace ALONE ⇒ no rail.
 *
 * 🔴 IT IS ASSERTED HERE AGAINST THE REAL `AppsPageLayout`, WHICH IS WHERE THE RULE NOW
 * LIVES. As a tab strip the collapse saved a row's height; as a rail it saves 276px of
 * every apps page's WIDTH, which is a bigger claim and a worse regression to miss.
 *
 * ⚠️ THE SHAPE IS REAL; THE COHORT THIS USED TO NAME IS NOT. An earlier version said
 * "`app-dev-testers` with the kill switch off", which the Flipt state refutes:
 * `app-blocks-author` rolls out to `app-dev-testers`, so such a member IS an author. The
 * shape is reachable through the store flags that do NOT imply authorship
 * (`app-listings-public-external` rolls out to `testers`). No replacement cohort claim is
 * made here — the segment sets live in `civitai/flipt-state`, not in this repo.
 */
describe('the collapse, and the canBuild gate that keeps it live', () => {
  test('🔴 a store-visible non-author with an EMPTY summary and no canBuild renders NO rail', async () => {
    await renderNav(NONE, NOT_AUTHOR, '/apps');
    await awaitCommit(); // without this the assertions below cannot fail — see RENDER_BARRIER
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
    expect(renderedSections()).toEqual([]);
  });

  test('🔴 …and the page BODY still renders (the collapse removes chrome, not content)', async () => {
    // The rail-specific half of the collapse: as a tab strip, hiding the bar could not
    // affect the body. As a rail it decides the body's WIDTH, so "renders nothing" has to
    // mean the chrome only.
    await renderNav(NONE, NOT_AUTHOR, '/apps');
    await awaitCommit();
    expect(document.querySelector('[data-apps-chrome="rail"]')).toBeNull();
    expect(document.querySelector('[data-apps-chrome="drawer-trigger"]')).toBeNull();
  });

  test('🔴 canBuild is what brings the rail back for that same viewer', async () => {
    // Identical summary and identical `isAuthor`/`canSeeStore` — ONLY `canBuild` moves.
    // That is what makes the pair attribute the rail to the build capability rather than
    // to some other difference between two fixtures.
    await renderNav(NONE, BUILDER, '/apps');
    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    expect(renderedSections()).toEqual(['Marketplace', 'Build']);
  });

  test('the Build entry points at /apps/build, NOT the retired /apps/get-started', async () => {
    await renderNav(NONE, BUILDER, '/apps');
    await expect.element(link('Build')).toBeInTheDocument();
    // `/apps/get-started` is deleted and 301s to `/apps/build`; an entry still pointing at
    // it would send every click through a redirect (and would be dead the day the
    // redirect is retired). Read from the RENDERED anchors, so a row that kept the old
    // href under any label is caught.
    const hrefs = Array.from(navEl()!.querySelectorAll('a')).map((el) => el.getAttribute('href'));
    expect(hrefs).toEqual(['/apps', '/apps/build']); // non-empty: the check below can fail
    expect(hrefs).not.toContain('/apps/get-started');
  });

  test('🔴 Build sits SECOND-TO-LAST, before Review — not first', async () => {
    await renderNav(ALL, AUTHOR, '/apps');
    await expect.element(link('Build')).toBeInTheDocument();
    const sections = renderedSections();
    expect(sections[0]).toBe('Marketplace');
    expect(sections[sections.length - 2]).toBe('Build');
    expect(sections[sections.length - 1]).toBe('Review');
  });

  test('a summary flag alone brings the rail back (one install, no canBuild)', async () => {
    await renderNav({ ...NONE, hasInstalls: true }, NOT_AUTHOR, '/apps');
    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    expect(renderedSections()).toEqual(['Marketplace', 'Activity']);
  });

  // 🔴 NEGATIVE CONTROL for the counts above. Every assertion in this block is
  // "the rail IS there with these entries", and a reader wired to nothing would satisfy
  // none of them — but a `visible` predicate that had silently become `() => true`
  // for a conditional entry would satisfy all of them too. This one fails in that
  // case: a non-author must still NOT get Invites, however full their summary is.
  test('NEGATIVE CONTROL: the conditional entries are still conditional', async () => {
    await renderNav(ALL, BUILDER, '/apps');
    await expect.element(link('Build')).toBeInTheDocument();
    expect(renderedSections()).toEqual(['Marketplace', 'Activity', 'Revenue', 'Build', 'Review']);
  });
});

describe('navigation landmark and anchor semantics', () => {
  // HIGH-severity a11y regression the original audit flagged on the tab strip: the Tabs
  // conversion dropped the `role="navigation"` landmark, leaving a bare `role="tablist"`
  // (an ARIA anti-pattern for cross-page navigation). The rail keeps the landmark, and
  // has no tablist to confuse it with.
  test('the rail is exposed as a `navigation` landmark named "App sections"', async () => {
    await renderNav(NONE, AUTHOR, '/apps');
    const nav = page.getByRole('navigation', { name: 'App sections' });
    await expect.element(nav).toBeInTheDocument();
    expect(nav.element().tagName.toLowerCase()).toBe('nav');
  });

  test('🔴 there is NO tablist any more — the entries are plain anchors', async () => {
    // The port's own claim. The strip needed `activateTabWithKeyboard={false}` to stop
    // Mantine's roving-tabindex handler synthesising a click (a full page navigation) on
    // every arrow key. A list of anchors has no such handler, so that defect is
    // structurally absent rather than suppressed — which is only true while nothing here
    // is a tab.
    await renderNav(ALL, AUTHOR, '/apps');
    await expect.element(link('Review')).toBeInTheDocument();
    expect(page.getByRole('tablist').elements()).toHaveLength(0);
    expect(page.getByRole('tab').elements()).toHaveLength(0);
    for (const el of navEl()!.querySelectorAll('a')) {
      expect(el.tagName.toLowerCase()).toBe('a');
      expect(el.getAttribute('href')).toBeTruthy();
    }
  });

  test('Enter/Space still activate: the focused entry is a real anchor with the right href', async () => {
    // We don't fire Enter (it would trigger a real navigation in browser mode); instead
    // we assert the keyboard-activation contract structurally — the focusable element IS
    // the `<a href>` the route points at, so native anchor activation navigates
    // correctly.
    await renderNav(NONE, AUTHOR, '/apps');
    await expect.element(link('Build')).toBeInTheDocument();
    const build = link('Build').element() as HTMLElement;
    build.focus();
    expect(document.activeElement).toBe(build);
    expect(build.tagName.toLowerCase()).toBe('a');
    expect(build.getAttribute('href')).toBe('/apps/build');
  });
});

describe('the active entry reflects the current route', () => {
  const current = (name: string) => link(name).element().getAttribute('aria-current');

  test('the current route is the current entry (aria-current=page)', async () => {
    await renderNav({ ...NONE, hasInstalls: true }, AUTHOR, '/apps/activity');
    await expect.element(link('Activity')).toBeInTheDocument();
    expect(current('Activity')).toBe('page');
  });

  test('/apps (Marketplace) is NOT current on a child route — exact-match guard', async () => {
    await renderNav({ ...NONE, hasInstalls: true }, AUTHOR, '/apps/activity');
    await expect.element(link('Activity')).toBeInTheDocument();
    expect(current('Marketplace')).toBeNull();
  });

  test('Marketplace IS current on the exact /apps route', async () => {
    await renderNav(NONE, AUTHOR, '/apps');
    await expect.element(link('Marketplace')).toBeInTheDocument();
    expect(current('Marketplace')).toBe('page');
    expect(current('Build')).toBeNull();
  });

  test('the Build entry is current on /apps/build (and Marketplace is not)', async () => {
    await renderNav(NONE, AUTHOR, '/apps/build');
    await expect.element(link('Build')).toBeInTheDocument();
    expect(current('Build')).toBe('page');
    expect(current('Marketplace')).toBeNull();
  });

  /**
   * 🔴 `/apps/submit` KEPT ITS ROUTE AND LOST ITS ENTRY, so the rail must light NOTHING
   * there — no entry may claim a route it does not own. This is the one assertion that
   * fails if the retired "Create" row is re-added, and it fails from the OPPOSITE
   * direction to the retired-label guard above (that one reads labels; this one reads the
   * active-route resolution), so a partial revert cannot slip past both.
   */
  test('🔴 on /apps/submit — which has no entry any more — nothing is current', async () => {
    await renderNav(ALL, AUTHOR, '/apps/submit');
    await expect.element(link('Build')).toBeInTheDocument(); // the rail IS rendered
    for (const name of ['Build', 'Marketplace', 'Activity', 'Invites', 'Revenue', 'Review']) {
      expect(current(name), `${name} is current`).toBeNull();
    }
  });

  // 🔴 Highlighting with `Build` ABSENT. The active-route resolution reads the full
  // registry, so a hidden section must not steal or suppress the highlight on the
  // sections that DID render.
  test('with Build hidden, the active route still lights the right entry', async () => {
    await renderNav(ALL, NOT_AUTHOR, '/apps/activity');
    await expect.element(link('Activity')).toBeInTheDocument();
    expect(renderedSections()).not.toContain('Build');
    expect(current('Activity')).toBe('page');
    for (const name of ['Marketplace', 'Revenue', 'Review']) {
      expect(current(name)).toBeNull();
    }
  });

  test('with Build hidden, /apps still lights Marketplace', async () => {
    await renderNav({ ...NONE, hasInstalls: true }, NOT_AUTHOR, '/apps');
    await expect.element(link('Marketplace')).toBeInTheDocument();
    expect(renderedSections()).not.toContain('Build');
    expect(current('Marketplace')).toBe('page');
    expect(current('Activity')).toBeNull();
  });
});

describe('every visible entry navigates to its route', () => {
  // Each entry is a Next `<Link>` anchor — the `href` IS the navigation target a click
  // follows. Asserting the href is the deterministic equivalent of "a click navigates to
  // the right route" for a link-based nav.
  test('every visible entry points its href at the matching /apps route', async () => {
    await renderNav(ALL, AUTHOR, '/apps');
    const cases: Array<[string, string]> = [
      ['Build', '/apps/build'],
      ['Marketplace', '/apps'],
      ['Activity', '/apps/activity'],
      // The collaborator inbox: `appCollaborators.listMyPendingInvites`. Owner-INDEPENDENT
      // — an invitee who owns nothing reaches every other entry's page empty.
      ['Invites', '/apps/invites'],
      ['Revenue', '/apps/revenue'],
      ['Review', '/apps/review'],
    ];
    for (const [name, href] of cases) {
      await expect.element(link(name)).toBeInTheDocument();
      expect(link(name).element().getAttribute('href')).toBe(href);
    }
    // The set is CLOSED: exactly these six, so a re-added retired row (whose href would
    // not be in `cases`) fails here rather than being silently ignored by the loop.
    expect(renderedSections()).toHaveLength(cases.length);
  });
});

describe('isActiveAppsRoute / activeAppsSection (route-matching helpers)', () => {
  const activeHref = (p: string) => {
    const s = activeAppsSection(p);
    return s ? getAppsSectionHref(s) : null;
  };

  test('/apps matches ONLY the exact marketplace route', () => {
    expect(isActiveAppsRoute('/apps', '/apps')).toBe(true);
    expect(isActiveAppsRoute('/apps', '/apps/activity')).toBe(false);
    expect(isActiveAppsRoute('/apps', '/apps/run/foo')).toBe(false);
  });

  test('sub-routes match exact + deeper child paths (prefix)', () => {
    expect(isActiveAppsRoute('/apps/activity', '/apps/activity')).toBe(true);
    expect(isActiveAppsRoute('/apps/activity', '/apps/activity/123')).toBe(true);
    expect(isActiveAppsRoute('/apps/activityX', '/apps/activity')).toBe(false);
    expect(isActiveAppsRoute('/apps/build', '/apps/activity')).toBe(false);
  });

  test('activeAppsSection resolves the active href, or null when none matches', () => {
    expect(activeHref('/apps')).toBe('/apps');
    expect(activeHref('/apps/build')).toBe('/apps/build');
    expect(activeHref('/apps/revenue')).toBe('/apps/revenue');
    // A deep /apps/* route with no corresponding section → nothing active.
    expect(activeHref('/apps/run/some-slug')).toBeNull();
  });

  /**
   * 🔴 THE RETIRED ROUTES RESOLVE TO NO SECTION. `/apps/get-started` and `/apps/mine` are
   * deleted (both 301 to `/apps/build`) and `/apps/submit` kept its route but lost its
   * row — so none of the three may resolve to an active section. This reads the registry
   * directly, so it fails the moment any of those rows is re-added, without needing to
   * render anything.
   */
  test('🔴 the retired/entry-less routes resolve to NO active section', () => {
    expect(activeHref('/apps/get-started')).toBeNull();
    expect(activeHref('/apps/mine')).toBeNull();
    expect(activeHref('/apps/submit')).toBeNull();
  });
});

/**
 * 🔴 `Invites` IS THE ONE SURVIVING `isAuthor`-GATED ROW — the semantic defect that a
 * CLEAN git merge produced and that no test would have caught.
 *
 * `origin/main` (#3899) widened the predicate signature to `(summary, context)` and gated
 * "Create" on `context.isAuthor`, because `/apps/submit` `notFound`s a non-author. A
 * branch added "My apps" and "Invites" against the OLD one-argument signature. Git
 * auto-merged the table with no conflict, the result compiled, and every test passed —
 * leaving two entries whose pages gate on `features.appBlocksAuthor` + `isAppDeveloper`
 * visible to viewers those pages refuse.
 *
 * "My apps" is gone (absorbed by `/apps/build`), so `Invites` now carries this block
 * alone. Its gate is NOT redundant with `canBuild`: `/apps/invites` gates on
 * `appBlocksAuthor` + `isAppDeveloper`, which the get-started term does not satisfy — a
 * {@link BUILDER} has `canBuild` and must still be refused this entry.
 */
describe('Invites is gated on the author capability', () => {
  test('Invites renders for an AUTHOR whose hasPendingInvites is true', async () => {
    await renderNav({ ...NONE, hasPendingInvites: true }, AUTHOR, '/apps');
    await expect.element(link('Invites')).toBeInTheDocument();
    expect(link('Invites').element().getAttribute('href')).toBe('/apps/invites');
  });

  test('🔴 Invites is HIDDEN from a NON-author, even with hasPendingInvites true', async () => {
    // The store-visible non-author SHAPE (`app-listings=true`, `app-blocks-author=false`).
    // ⚠️ Not a named live cohort — `app-blocks-author` rolls out to the same segment as
    // `app-listings`, so that pairing is empty under the current Flipt state. The shape is
    // reachable via a store flag that does not imply authorship
    // (`app-listings-public-external` → `testers`), and via an author who loses the
    // capability and keeps their listings. `blocks.getNavSummary` is gated on the
    // MARKETPLACE flag, not the author one, so the summary still populates — an owner can
    // invite any existing user.
    await renderNav({ ...NONE, hasPendingInvites: true }, NOT_AUTHOR, '/apps');
    await awaitCommit();
    expect(renderedSections()).not.toContain('Invites');
  });

  test('🔴 canBuild is NOT enough for Invites — a BUILDER is still refused it', async () => {
    // The get-started cohort holds `canBuild` but not `appBlocksAuthor`, and
    // `/apps/invites` gates on the latter. Fails if `Invites` is "simplified" to
    // `c.canBuild && s.hasPendingInvites`, which the presence/absence pair above cannot
    // see (a BUILDER differs from both of those fixtures).
    await renderNav({ ...NONE, hasPendingInvites: true }, BUILDER, '/apps');
    await expect.element(link('Build')).toBeInTheDocument(); // the rail IS rendered
    expect(renderedSections()).toEqual(['Marketplace', 'Build']);
  });

  test('a NON-author invitee gets no rail at all (1 qualifying section ⇒ hidden)', async () => {
    // Marketplace alone survives the author gate and the `< 2` collapse then hides the
    // rail — so the two rules compose to the right end state rather than merely not
    // crashing.
    await renderNav({ ...NONE, hasPendingInvites: true }, NOT_AUTHOR, '/apps');
    await awaitCommit();
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
  });

  test('an AUTHOR invitee DOES get the rail: Marketplace + Invites + Build', async () => {
    // The positive control for the case above — without it, "the rail is hidden" would
    // pass on a rail that is hidden for everyone.
    await renderNav({ ...NONE, hasPendingInvites: true }, AUTHOR, '/apps');
    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    expect(renderedSections()).toEqual(['Marketplace', 'Invites', 'Build']);
  });
});

/**
 * 🔴 THE NARROW FORM — below `APPS_RAIL_MIN_VIEWPORT` the rail is replaced by a DRAWER,
 * and the swap is a CSS media query rather than a hook.
 *
 * That choice is the whole hydration argument for this surface (`window.matchMedia` has
 * no server answer, and a differing tree between the SSR render and the first client
 * paint is the mismatch that once left every `/apps` page inert), so BOTH shapes are
 * always in the DOM and exactly one is displayed. This block is what makes "exactly one"
 * an observation rather than a claim: a stylesheet that forgot to hide one of them would
 * render two navigations at once, and nothing in TypeScript could see it.
 */
describe('the narrow-viewport drawer', () => {
  async function renderAt(width: number) {
    await page.viewport(width, 900);
    state.sections = visibleAppsSections(ALL, AUTHOR);
    (Router as unknown as { pathname: string }).pathname = '/apps';
    renderWithProviders(
      <AppsPageLayout>
        <div data-testid={RENDER_BARRIER} />
      </AppsPageLayout>
    );
    await awaitCommit();
    // Two frames so layout and the injected stylesheet have both settled.
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  }

  const shown = (selector: string) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    return getComputedStyle(el).display;
  };

  test('🔴 both shapes are always RENDERED — the swap is CSS, not a conditional', async () => {
    // If either shape were mounted conditionally on a media-query hook, one of these
    // lookups would be null at one of the two widths, and the SSR HTML could not match
    // the first client paint on both.
    for (const width of [1024, 1440]) {
      await renderAt(width);
      expect(document.querySelector('[data-apps-chrome="rail"]'), `@${width}`).not.toBeNull();
      expect(
        document.querySelector('[data-apps-chrome="drawer-trigger"]'),
        `@${width}`
      ).not.toBeNull();
    }
  });

  test('🔴 exactly ONE of them is displayed, at each side of the threshold', async () => {
    await renderAt(1440);
    expect(shown('[data-apps-chrome="rail"]'), 'rail @1440').toBe('block');
    expect(shown('[data-apps-chrome="drawer-trigger"]'), 'trigger @1440').toBe('none');

    await renderAt(1024);
    expect(shown('[data-apps-chrome="rail"]'), 'rail @1024').toBe('none');
    expect(shown('[data-apps-chrome="drawer-trigger"]'), 'trigger @1024').toBe('flex');
  });

  test('the drawer opens the SAME section list the rail renders', async () => {
    await renderAt(1024);
    // The rail's own `<nav>` is display:none at this width, so the landmark the viewer
    // can reach is the drawer's — and it must not exist before the drawer is opened,
    // or there would be two.
    expect(document.querySelectorAll('nav[aria-label="App sections"]')).toHaveLength(1);

    await page.getByRole('button', { name: 'App sections' }).click();
    const navs = document.querySelectorAll('nav[aria-label="App sections"]');
    expect(navs, 'the drawer did not render a nav').toHaveLength(2);
    // The drawer's list is the one that is actually visible, and it carries every entry.
    const drawerNav = navs[1] as HTMLElement;
    expect(
      Array.from(drawerNav.querySelectorAll('a')).map((a) => (a.textContent ?? '').trim())
    ).toEqual(['Marketplace', 'Activity', 'Invites', 'Revenue', 'Build', 'Review']);
  });
});

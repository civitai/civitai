/**
 * `/apps/*` LEFT RAIL — THE COLLAPSE TOGGLE SHARES THE FIRST GROUP HEADING'S ROW.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS PINS
 * ─────────────────────────────────────────────────────────────────────────────
 * The toggle used to render in a `<Group justify={…} gap={0} mb={4}>` of its own,
 * ABOVE `AppsRailNavView`, which then drew the first group heading ("Discover") with
 * its own `pt="sm"`. So the rail opened with a row holding nothing but a 28px button,
 * then whitespace, then the heading — a whole row of chrome spent on a control that
 * fits beside a six-character word. Measured in this harness at 1440 on pre-change
 * code: the heading's vertical centre sat at 64.4 and the toggle's at 30 — 34.4px apart.
 * It is now passed into the nav as `headerAction` and the two share one row (0px apart).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THE `geometry` PROJECT AND NOT `component`
 * ─────────────────────────────────────────────────────────────────────────────
 * The COLLAPSED half of this claim is unmeasurable without Tailwind. When the rail is
 * collapsed the heading is `sr-only`, which is a Tailwind utility — and `sr-only` is
 * what takes the heading OUT OF FLOW (`position: absolute`), which is in turn what lets
 * `justify-content: center` centre the toggle alone. In the `component` tier Tailwind is
 * inert, so the heading stays in flow and `center` centres the PAIR: the toggle lands
 * ~12px off the rail's centre and the assertion would be measuring a layout production
 * never renders. `AppsRailNav.railState.browser.test.tsx` says exactly this about itself
 * ("`sr-only` IS A TAILWIND UTILITY AND THIS TIER LOADS NO TAILWIND") and confines itself
 * to the accessibility tree for that reason.
 *
 * 🔴 AND THE SECOND REASON IS CI VISIBILITY — NOT "IT BLOCKS", BECAUSE NOTHING IN THIS
 * REPO DOES. Verified 2026-10-03 against the API: `civitai/civitai` `main` carries
 * `required_status_checks: null`, so no check can block a merge here at all. What the
 * tiers differ on is whether a red is ever SEEN. `.github/workflows/lint.yml`'s
 * `geometry:` job runs `vitest run --project geometry` with a collected-count ledger and
 * is `continue-on-error` only for `pull_request` — report-only on a PR, a real red on a
 * push to `main`. The `component` tier matches NO project selector in that workflow
 * (`unit*`, `@civitai/*`, `app:*`), so its only home is the preview pipeline's
 * `preview / component-tests`. A new rendered-pixel claim is worth more in the tier
 * somebody will see go red.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE REST OF THE RAIL'S VERTICAL GEOMETRY LIVES
 * ─────────────────────────────────────────────────────────────────────────────
 * `AppsPageLayout.geometry.browser.test.tsx` owns the PAGE chrome's vertical geometry
 * (the container's pads, the band→body gap, the sticky offset and the scroll-pinning).
 * This file owns the rail's INTERNAL vertical geometry, which is a different subject and
 * is the only part this change moves. `AppsPageLayout.railSurface.browser.test.tsx` also
 * reads vertical numbers, but about the painted panel's bleed rather than about the rail's
 * height — left there deliberately.
 *
 * `AppsPageLayout.chromeAlignment.browser.test.tsx` carried a SECOND copy of the
 * band→body 32px gap and no longer does; that consolidation is recorded in its docstring.
 */
import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import {
  box,
  cascadeEvidence,
  renderAtViewport,
  type Viewport,
} from '../../../test/geometry-setup';
import type * as TrpcMod from '~/utils/trpc';

// 🔴 THE VIEWER MUST BE ONE THE RAIL RENDERS FOR. `AppsPageLayout` drops the rail
// entirely below two qualifying sections, and the summary query is stubbed empty here, so
// an anonymous viewer would render NO rail and every lookup below would resolve nothing.
// An author yields Marketplace (group `Discover`) + Build (group `Build`) — two sections
// in two groups, which is also what makes "the action goes on the FIRST group only" a
// real reading rather than a single-group tautology.
// Same mock set, and the same reasons, as the `component`-tier rail suites.
// `next/router` is already mocked by `test/geometry-setup.tsx`.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true }),
  useFeatureFlagsReady: () => true,
}));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'author', isModerator: false }),
}));
// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-mock) —
// a wholesale factory makes every export it forgets `undefined` for this file's whole
// module graph, and the file then fails to IMPORT and reports `no tests` rather than a
// failure.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: { blocks: { getNavSummary: { useQuery: () => ({ data: undefined }) } } },
}));

const { AppsPageLayout } = await import('./AppsPageLayout');
const { AppsRailProvider, APPS_RAIL_COLLAPSED_WIDTH, APPS_RAIL_WIDTH } = await import(
  './appsRailState'
);
const { appsSectionGroups } = await import('./apps-sections');

/** A desktop, comfortably above `APPS_RAIL_MIN_VIEWPORT` (1300). */
const DESKTOP = { width: 1440, height: 900 } as const;
/**
 * A tablet/phone width, comfortably BELOW 1300 — where the rail is `display: none` and
 * the `Drawer` is the only route between apps pages.
 */
const NARROW = { width: 900, height: 800 } as const;

/**
 * The first group label the rail will actually render.
 *
 * DERIVED from the registry rather than typed as `'Discover'`: a rename or a reorder of
 * `appsSectionGroups` is not what this file is about, and hardcoding the word would red it
 * for a reason that says nothing about the row.
 */
const FIRST_GROUP_LABEL = appsSectionGroups[0].label;

async function renderRail(collapsed: boolean, viewport: Viewport = DESKTOP) {
  return renderAtViewport(
    // 🔴 SEEDED THROUGH THE REAL PROVIDER, not a prop. The layout takes no rail prop,
    // deliberately — a per-route value is what the 12-route alignment ledger forbids.
    <AppsRailProvider value={collapsed ? 'collapsed' : 'open'}>
      <AppsPageLayout>
        <div data-testid="body" style={{ height: 200 }}>
          body
        </div>
      </AppsPageLayout>
    </AppsRailProvider>,
    viewport
  );
}

function required(selector: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector(selector) as HTMLElement | null;
  expect(
    el,
    `\`${selector}\` is not in the document. The rail renders only for a viewer with >=2 ` +
      'qualifying sections AND at a viewport >= APPS_RAIL_MIN_VIEWPORT — check the mocks ' +
      'and the viewport before re-baselining anything.'
  ).not.toBeNull();
  return el as HTMLElement;
}

/**
 * 🔴 THE CASCADE CONTROL. Without the real stylesheet `sr-only` is inert, Mantine's
 * `Group` computes `display: block`, and every "they are on one row" / "it is centred"
 * reading below is about a layout nothing renders. `ruleCount` and the Tailwind probe are
 * the two readings `geometry-setup` measured as DISAGREEING between the two browser
 * tiers, so they attribute rather than reassure.
 */
function expectCascade() {
  const evidence = cascadeEvidence();
  expect(evidence.ruleCount, 'the app cascade did not load').toBeGreaterThan(1000);
  expect(
    evidence.tailwindFlexUtilityResolves,
    'Tailwind did not load, so `sr-only` is inert and the collapsed reading is meaningless'
  ).toBe(true);
}

const toggle = () => page.getByRole('button', { name: /(Collapse|Expand) navigation/ });

/**
 * The group headings inside the DESKTOP rail, in DOM order.
 *
 * 🔴 FOUND BY THEIR TEXT, NOT BY `data-apps-chrome="rail-group-heading"`, AND THAT IS
 * DELIBERATE EVEN THOUGH THAT ATTRIBUTE EXISTS AND THE SIBLING SUITES USE IT. The
 * attribute ARRIVED WITH THIS CHANGE, so selecting by it makes every assertion below
 * red on pre-change code for the trivial reason that the hook is absent — "no heading
 * found" rather than "the heading and the toggle are 32px apart". A selector that
 * resolves the same node in BOTH revisions is what makes the red-at-base reading the
 * GEOMETRIC one. The structural test below ties the text-found node back to the
 * attribute, so the sibling suites' selector cannot silently stop naming it.
 *
 * `closest('a')` is load-bearing: `Build` is both a GROUP label and a SECTION label, so
 * without it the Build entry's own `<span>` matches too.
 */
function headings(): HTMLElement[] {
  const nav = document.querySelector('[data-apps-chrome="rail"] nav[aria-label="App sections"]');
  if (!nav) return [];
  const labels = new Set<string>(appsSectionGroups.map((g) => g.label));
  return Array.from(nav.querySelectorAll<HTMLElement>('*')).filter(
    (el) =>
      el.children.length === 0 &&
      el.closest('a') == null &&
      labels.has((el.textContent ?? '').trim())
  );
}

describe('the rail is EXPANDED at 1440', () => {
  test('🔴 the heading and the toggle are on ONE row, heading left, toggle right', async () => {
    const { observed } = await renderRail(false);
    expect(observed).toEqual({ width: 1440, height: 900 });
    expectCascade();
    expect(required('[data-apps-chrome="rail"]').offsetWidth).toBe(APPS_RAIL_WIDTH);

    const heading = headings()[0];
    expect(heading, 'the rail rendered no group heading').toBeTruthy();
    expect(heading.textContent?.trim()).toBe(FIRST_GROUP_LABEL);

    const headingBox = box(heading);
    const toggleBox = box(toggle().element());

    // 🔴 THE LOAD-BEARING ASSERTION, AND IT IS A RELATION RATHER THAN A HEIGHT. Two boxes
    // are on one row when their vertical CENTRES coincide; pinning a pixel height would
    // go stale on any type-scale or icon-size change and would say nothing about whether
    // they are beside each other. Measured here: 34.4px apart before, 0 after.
    const headingCentre = headingBox.top + headingBox.height / 2;
    const toggleCentre = toggleBox.top + toggleBox.height / 2;
    expect(
      Math.abs(headingCentre - toggleCentre),
      `the heading's centre is at ${headingCentre} and the toggle's at ${toggleCentre} — ` +
        'they are not on the same row'
    ).toBeLessThanOrEqual(1);

    // …and the ORDER, so "one row" cannot be satisfied by the toggle sitting on top of
    // the word.
    expect(toggleBox.left, 'the toggle is not to the right of the heading').toBeGreaterThanOrEqual(
      headingBox.right
    );

    // Both are inside the rail, not in the gutter — the constraint the layout's own
    // comment says the `CollectionsLayout` precedent was rejected for.
    const rail = box(required('[data-apps-chrome="rail"]'));
    expect(toggleBox.right).toBeLessThanOrEqual(rail.right + 0.5);
    expect(toggleBox.left).toBeGreaterThanOrEqual(rail.left - 0.5);
  });

  test('🔴 the toggle lives INSIDE the nav landmark, on the heading row element', async () => {
    // The structural half of the same change, and the half that makes the drawer guard
    // below meaningful: the control is now rendered BY `AppsRailNavView` (as its
    // `headerAction`) rather than by the layout's own wrapper, so "which callers pass one"
    // is the thing that decides where it appears.
    const { observed } = await renderRail(false);
    expect(observed).toEqual({ width: 1440, height: 900 });

    const nav = required('[data-apps-chrome="rail"] nav[aria-label="App sections"]');
    const button = toggle().element() as HTMLElement;
    expect(nav.contains(button), 'the toggle is not inside the rail nav').toBe(true);

    // The same ROW element holds both, which is what the pixel assertion above measures
    // the consequence of.
    const row = required('[data-apps-chrome="rail-group-header"]');
    expect(row.contains(button)).toBe(true);
    expect(row.contains(headings()[0])).toBe(true);

    // 🔴 SEAM GUARD BETWEEN THIS FILE AND THE SIBLING SUITES. `AppsRailNav.browser.test.tsx`
    // and `AppsRailNav.railState.browser.test.tsx` both select the heading by
    // `data-apps-chrome="rail-group-heading"`; this file deliberately finds it by text (see
    // `headings()`). Asserting the two resolve the SAME node is what stops the attribute
    // being renamed or dropped and those two suites silently measuring nothing.
    expect(
      headings()[0].getAttribute('data-apps-chrome'),
      'the heading lost the hook the sibling rail suites select it by'
    ).toBe('rail-group-heading');
  });

  test('🔴 only the FIRST rendered group gets the row — the others are bare headings', async () => {
    // Two groups render for this viewer (Discover + Build). Without this, an
    // implementation that put a toggle on EVERY group heading would satisfy every
    // assertion above.
    const { observed } = await renderRail(false);
    expect(observed).toEqual({ width: 1440, height: 900 });

    const inRail = required('[data-apps-chrome="rail"]');
    expect(
      headings().length,
      'the fixture rendered fewer than two groups, so "only the first" is vacuous'
    ).toBeGreaterThan(1);
    expect(
      inRail.querySelectorAll('[data-apps-chrome="rail-group-header"]').length,
      'more than one group heading was given an action row'
    ).toBe(1);
    expect(
      inRail.querySelectorAll('button[aria-label$="navigation"]').length,
      'the rail renders more than one collapse toggle'
    ).toBe(1);
  });
});

describe('the rail is COLLAPSED at 1440', () => {
  test('⚠️ INVARIANT GUARD — the toggle is still CENTRED in the 56px rail', async () => {
    // ⚠️ GREEN ON PRE-CHANGE CODE, so this is not regression coverage for this change:
    // the old standalone row was `justify="center"` when collapsed and centred the toggle
    // too. It is here because the mechanism changed underneath an unchanged behaviour —
    // the toggle now shares a flex row with a heading, and it is only centred because
    // `sr-only` takes that heading out of flow. Mutation-tested by dropping the
    // `collapsed ? 'center' : 'space-between'` branch to a constant `'space-between'`:
    // this arm alone goes red, with the toggle's centre at 30 against the rail's at 44.
    const { observed } = await renderRail(true);
    expect(observed).toEqual({ width: 1440, height: 900 });
    expectCascade();

    const rail = required('[data-apps-chrome="rail"]');
    expect(rail.offsetWidth, 'the rail did not collapse — the rest of this is vacuous').toBe(
      APPS_RAIL_COLLAPSED_WIDTH
    );

    const railBox = box(rail);
    const toggleBox = box(toggle().element());
    const railCentre = railBox.left + railBox.width / 2;
    const toggleCentre = toggleBox.left + toggleBox.width / 2;
    expect(
      Math.abs(railCentre - toggleCentre),
      `the rail's centre is at ${railCentre} and the toggle's at ${toggleCentre}`
    ).toBeLessThanOrEqual(1.5);
  });

  test('⚠️ INVARIANT GUARD — the heading is CLIPPED, not removed from the accessibility tree', async () => {
    // ⚠️ ALSO GREEN BEFORE THIS CHANGE. Restated here rather than left to the
    // `component`-tier sibling because the heading gained a flex-row PARENT, and the
    // obvious way to "tidy up" a row whose visible content is one button is to stop
    // rendering the invisible half of it. The sibling asserts the same thing on the
    // accessibility tree; this one adds the reading that tier cannot make — that the
    // clipping is REAL, i.e. the heading occupies no layout.
    const { observed } = await renderRail(true);
    expect(observed).toEqual({ width: 1440, height: 900 });
    expectCascade();

    const heading = headings()[0];
    expect(heading, 'the collapsed rail rendered no group heading at all').toBeTruthy();
    expect(heading.textContent?.trim()).toBe(FIRST_GROUP_LABEL);
    expect(heading.getAttribute('aria-hidden')).toBeNull();
    expect(heading.hasAttribute('hidden')).toBe(false);
    expect(heading.className).toContain('sr-only');
    // The Tailwind-dependent half, and the one the `component` tier structurally cannot
    // make: `sr-only` really RESOLVED. Both values are the CSS initial/UA ones (`static`,
    // `visible`) in a tier with no Tailwind, so this pair is also the discriminator
    // between "the utility applied" and "nothing applied".
    const clipped = getComputedStyle(heading);
    expect(clipped.position, 'sr-only did not apply — the heading is still in flow').toBe(
      'absolute'
    );
    expect(clipped.overflow).toBe('hidden');
    // ⚠️ NO WIDTH ASSERTION, DELIBERATELY. `sr-only` sets `width: 1px`, but Mantine's
    // `px="sm"` style prop lands as an INLINE `padding-inline` that outranks the utility's
    // `padding: 0`, and under Preflight's `border-box` the used width resolves to the 24px
    // of surviving padding. Both `getComputedStyle().width` and the rect therefore read
    // 24px on CORRECT markup — asserting either is how this arm first went red against
    // code that was working. Out-of-flow is the property that matters, and the previous
    // test measures its consequence (a centred toggle).
  });
});

describe('⚠️ the mobile DRAWER renders the same nav and NO collapse toggle', () => {
  test('⚠️ INVARIANT GUARD — the drawer has no toggle, while the desktop rail does', async () => {
    // 🔴 THE SEAM THIS CHANGE CREATES. `AppsRailNavView` is rendered TWICE by
    // `AppsPageLayout` — desktop rail and mobile `Drawer` — so moving the toggle INTO that
    // component put it one careless prop away from appearing in a panel that is always
    // full width and has nothing to collapse. The guard is a RELATIONSHIP (one surface has
    // it, the other does not), because either half alone passes on a component that
    // renders no toggle anywhere.
    //
    // ⚠️ GREEN ON PRE-CHANGE CODE — the toggle lived in the layout's rail wrapper, so the
    // drawer never had one. Mutation-tested by passing a `headerAction` to the `Drawer`'s
    // `AppsRailNavView`: this test alone goes red, on its own message ("the mobile drawer
    // rendered a collapse toggle"), while the five rail-side arms stay green.
    const { observed } = await renderRail(false, NARROW);
    expect(observed).toEqual({ width: 900, height: 800 });
    expectCascade();

    // Below the threshold the rail is `display: none` and the trigger stands in for it.
    const railEl = required('[data-apps-chrome="rail"]');
    expect(
      getComputedStyle(railEl).display,
      'the rail is still displayed at 900px, so this is not the narrow form'
    ).toBe('none');

    await userEvent.click(page.getByRole('button', { name: 'App sections' }).element());

    // Mantine portals the Drawer, so scope every read to its own content element rather
    // than to the document — the hidden rail's nav and toggle are still in the DOM.
    const drawerContent = await vi.waitFor(() => required('.mantine-Drawer-content'));
    const drawerNav = required('nav[aria-label="App sections"]', drawerContent);
    // POSITIVE CONTROL for the zero below: the drawer really did render the nav, with real
    // entries, so "no toggle in here" is a reading rather than a silence.
    expect(drawerNav.querySelectorAll('a').length).toBeGreaterThan(0);
    expect(
      drawerContent.querySelectorAll('button[aria-label$="navigation"]').length,
      'the mobile drawer rendered a collapse toggle — it is always full width'
    ).toBe(0);
    expect(
      drawerContent.querySelectorAll('[data-apps-chrome="rail-group-header"]').length,
      'the drawer rendered an action row, which only the rail should have'
    ).toBe(0);

    // THE OTHER HALF, in the same run: at a desktop width the rail DOES carry one.
    await cleanup();
    const desktop = await renderRail(false, DESKTOP);
    expect(desktop.observed).toEqual({ width: 1440, height: 900 });
    expect(
      required('[data-apps-chrome="rail"]').querySelectorAll('button[aria-label$="navigation"]')
        .length,
      'the desktop rail lost its collapse toggle'
    ).toBe(1);
  });
});

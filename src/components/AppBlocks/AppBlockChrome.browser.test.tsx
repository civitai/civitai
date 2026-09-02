import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

// AppBlockChrome now calls useCurrentUser() (moderator gate for the platform-nav
// "Review" item). This suite renders it WITHOUT a CivitaiSessionProvider, and
// useCurrentUser → useCivitaiSessionContext throws "missing CivitaiSessionContext"
// with no provider. Mock it to a stable anon (non-mod) viewer so these
// pre-existing chrome/breadcrumb assertions keep rendering network-free.
/**
 * This suite mounts ANONYMOUSLY (`useCurrentUser` is mocked to null below), and
 * recents are ACCOUNT-scoped (#4048): the store hands a component back only the
 * entries recorded by the SAME viewer, with `null` (signed out) as its own
 * bucket. So every seed here must be written as `null` or the chrome's read
 * returns nothing and the assertions below go red for the wrong reason.
 */
const SESSION_OWNER_ID: number | null = null;

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => null,
}));

// eslint-disable-next-line import/first
import { AppBlockChrome } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import {
  clearRecentlyOpenedApps,
  recordRecentlyOpenedApp,
} from '~/components/Apps/recentlyOpenedAppsStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
// eslint-disable-next-line import/first
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';

/**
 * 🔴 THIS FILE PINS A DESKTOP VIEWPORT, AND UNTIL F3 IT PINNED NONE — WHICH MEANT
 * IT HAD BEEN RUNNING ON A PHONE ALL ALONG WITHOUT SAYING SO.
 *
 * `test/component-setup.tsx` sets no viewport, so every test here inherited Vitest's
 * default of **414×896** (`resolved.browser.viewport.width ??= 414` in
 * `vitest/dist/chunks/coverage.*.js`). Nothing depended on that while the chrome was
 * width-blind, so nothing said which width these claims were about. F3 makes the
 * page-surface chrome swap its whole structure below the `sm` breakpoint (768), and
 * 414 is below it — so the breadcrumb, the platform-nav trigger and the ⋮ DROPDOWN
 * that this file asserts are, at the inherited viewport, the mobile shell's back
 * chevron, folded nav and bottom SHEET instead.
 *
 * Every assertion in this file is about the DESKTOP chrome, so it says so now. The
 * mobile shell has its own suite (`AppBlockChromeMobileShell.browser.test.tsx`) that
 * names its viewport in the same way. Naming the viewport is the fix; leaving it
 * unnamed and adjusting the assertions to whatever 414 produces would have quietly
 * moved this file's subject.
 */
const DESKTOP: [number, number] = [1440, 900];
beforeEach(async () => {
  await page.viewport(...DESKTOP);
});

// H2: the host-rendered "trust frame" around an in-model app block must NAME the
// app (host-side, spoof-proof) — not just carry it in the invisible iframe
// `title`. `AppBlockChrome` is exported from IframeHost solely so this renders in
// isolation (the full IframeHost needs a token + postMessage wiring). Props are
// identical to the render site. Queries go through the global `page`;
// `cleanup()` after each test (component-setup.tsx) keeps the document clean.
//
// NOTE: this env does not load `@mantine/core/styles.css`, so we assert
// behaviour/attributes — never computed styles (the visual ellipsis is verified
// via Playwright on a preview, not here).
describe('AppBlockChrome (H2 host-rendered app name)', () => {
  test('renders the app name in the chrome', async () => {
    renderWithProviders(<AppBlockChrome blockInstanceId="inst-1" appName="Background Remover" />);
    await expect.element(page.getByText('Background Remover')).toBeInTheDocument();
  });

  test('a long app name renders in full and the name node stays a single truncating row', async () => {
    // Long enough to need VISUAL truncation (maw=160 ellipsizes well before this),
    // but deliberately under sanitizeAppChromeName's APP_CHROME_NAME_MAX (64) so the
    // *accessible* name is rendered in full here — the over-cap length-bound is a
    // separate concern covered by the sanitizer unit test (appChromeName.test.ts).
    const longName = 'Background Remover Pro Max Ultra Deluxe Edition Plus';
    renderWithProviders(<AppBlockChrome blockInstanceId="inst-2" appName={longName} />);

    // Full text present (the visual ellipsis clips the box, not the DOM text).
    await expect.element(page.getByText(longName)).toBeInTheDocument();

    // Truncation is locked via Mantine's `data-truncate` attribute (CSS-independent;
    // the ellipsis rule itself ships in @mantine/core/styles.css, not loaded here).
    // This catches a regression that drops the `truncate` prop from the name node.
    const nameEl = page.getByTestId('app-block-name').element();
    expect(nameEl.getAttribute('data-truncate')).toBe('end');
  });

  test('falls back to "App" when appName is undefined (never blank)', async () => {
    renderWithProviders(<AppBlockChrome blockInstanceId="inst-3" />);
    // Copy sweep: the provenance fallback now reads "App" (not "App block").
    // Mutation-sanity: reverting the fallback to "App block" fails this exact-text
    // assertion. exact:true so a future "App block" string can't satisfy it.
    await expect.element(page.getByText('App', { exact: true })).toBeInTheDocument();
    // The old "App block" copy must be gone.
    expect(page.getByText('App block', { exact: true }).elements()).toHaveLength(0);
    // Guard against a blank/whitespace-only label.
    const nameEl = page.getByTestId('app-block-name').element();
    expect((nameEl.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  test('the ⋯ menu trigger is still present', async () => {
    renderWithProviders(<AppBlockChrome blockInstanceId="inst-4" appName="Background Remover" />);
    await expect.element(page.getByRole('button', { name: 'App menu' })).toBeInTheDocument();
  });
});

// Task 2: the "Hide app block" menu item is meaningless on the full-page run
// surface (`/apps/run/<slug>`, slot kind `page`) — there's no model-page slot to
// dismiss the block FROM; the page IS the block. The chrome takes the rendering
// `slotId` and drops "Hide" when `isPageSlot(slotId)` is true. "Manage apps" +
// the provenance badge stay on every surface. (Mirrors PR #2747's `isPageSlot`
// page-vs-model distinction.)
//
// The menu items live in a Mantine `<Menu>` dropdown that only mounts its
// contents once the trigger is opened — so each test clicks the ⋯ trigger first,
// then asserts on the dropdown contents.
describe('AppBlockChrome "Hide" item is surface-aware (page vs model)', () => {
  async function openMenu() {
    await page.getByRole('button', { name: 'App menu' }).click();
    // "Manage apps" is present on every surface — wait on it so the dropdown has
    // mounted before asserting on the conditional "Hide" item.
    await expect.element(page.getByRole('menuitem', { name: 'Manage apps' })).toBeInTheDocument();
  }

  test('model surface (model.sidebar_top) renders the "Hide app block" item', async () => {
    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-model"
        appName="Background Remover"
        slotId="model.sidebar_top"
      />
    );
    await openMenu();
    await expect.element(page.getByRole('menuitem', { name: 'Hide app' })).toBeInTheDocument();
  });

  test('no slotId (back-compat default = model surface) renders the "Hide app block" item', async () => {
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-default" appName="Background Remover" />
    );
    await openMenu();
    await expect.element(page.getByRole('menuitem', { name: 'Hide app' })).toBeInTheDocument();
  });

  test('page surface (app.page) does NOT render the "Hide app block" item, keeps "Manage apps"', async () => {
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-page" appName="Budgeted Generator" slotId="app.page" />
    );
    await openMenu();
    // "Manage apps" stays …
    await expect.element(page.getByRole('menuitem', { name: 'Manage apps' })).toBeInTheDocument();
    // … but "Hide app block" is suppressed on the full-page surface.
    await expect.element(page.getByRole('menuitem', { name: 'Hide app' })).not.toBeInTheDocument();
  });
});

// The run-page frame border carries a `Marketplace / <app name>` breadcrumb on
// the full-page run surface (`/apps/run/<slug>`, slot kind `page`) —
// "Marketplace" links back to /apps, the app name reuses the SAME sanitized
// (spoof-proof) chrome name as the provenance badge. The breadcrumb is page-only:
// the compact model-slot chrome (badge + ⋯ menu) gets nothing extra. The
// page-context predicate is `isPageSlot(slotId)`, the same signal that suppresses
// "Hide".
//
// 🔴 WHICH BRANCH OF THE TRAILING CRUMB THIS SUITE ACTUALLY EXERCISES — read this
// before adding a popover assertion here and wondering why it never fires. F2 made
// that crumb a control whose whole cluster is gated on `hasAppsStoreAccess`, read
// through `useOptionalFeatureFlags`. This file renders via `renderWithProviders`,
// which supplies Mantine + React-Query and NOT a `FeatureFlagsProvider` — so the
// optional hook returns `null`, the gate fails closed, and every test below sees
// the STATIC `<Text>` crumb. That is deliberate and is itself the coverage for the
// ineligible-viewer branch: it proves the pre-change rendering survives untouched
// for a viewer the store would refuse. The CONTROL branch (button semantics,
// popover, keyboard, blur-close, store href) is covered in
// `AppNameCrumb.browser.test.tsx`, which mounts the flags.
describe('AppBlockChrome run-page breadcrumb (Marketplace / <app name>)', () => {
  test('page surface (app.page) renders the breadcrumb with the app name + a "Marketplace" link to /apps', async () => {
    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-bc-page"
        appName="Budgeted Generator"
        slotId="app.page"
      />
    );
    // The breadcrumb container is present on the page surface.
    await expect.element(page.getByTestId('app-block-breadcrumb')).toBeInTheDocument();
    // The leading crumb is a link back to the store, and it NAMES the store the way
    // the store's own subnav does ("Marketplace"), not "Apps". The testid keeps its
    // `-apps` spelling: it addresses the crumb by ROUTE, which has not moved.
    const appsLink = page.getByTestId('app-block-breadcrumb-apps').element();
    expect(appsLink.tagName.toLowerCase()).toBe('a');
    expect(appsLink.getAttribute('href')).toBe('/apps');
    expect((appsLink.textContent ?? '').trim()).toBe('Marketplace');
    // The current app's (sanitized) name is the trailing crumb.
    const crumbName = page.getByTestId('app-block-breadcrumb-name').element();
    expect((crumbName.textContent ?? '').trim()).toBe('Budgeted Generator');
  });

  // The "Apps" crumb must read as obviously CLICKABLE — visually distinct from the
  // static dimmed crumb text + separators. It carries the SITE'S link treatment
  // (Mantine `Anchor`: the themed `--mantine-color-anchor`, plus an explicit
  // `underline="always"`) with a `data-clickable` marker and a real `<a href>`. The
  // trailing crumb (the app name) carries NONE of these.
  //
  // 🔴 WHAT MOVED, AND WHAT DELIBERATELY DID NOT. The crumb used to be a hand-styled
  // `Text` with `td="underline"` + `style={{cursor:'pointer'}}`; both were assertions
  // about a one-off local style and both are gone. The RESTING UNDERLINE ITSELF IS
  // NOT — it is now asked for with `Anchor`'s own `underline` prop and asserted below,
  // because dropping it (as an earlier revision of this change did, by taking the
  // library default `hover`) leaves colour as the sole resting cue against dimmed
  // neighbours at 1.07:1 and fails WCAG 1.4.1 F73. The inline `cursor: pointer` did go:
  // a real `<a href>` gets that from the UA stylesheet.
  //
  // ⚠️ An earlier version of this note said the resting underline "had to go" when the
  // crumb adopted `Anchor`. It did not, and a reader who acted on that would relax
  // `always` back to `hover` and reintroduce the Level-A regression the assertion
  // below exists to prevent.
  test('the "Apps" crumb carries a clickable link affordance distinguishing it from the static crumb', async () => {
    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-bc-link"
        appName="Budgeted Generator"
        slotId="app.page"
      />
    );
    await expect.element(page.getByTestId('app-block-breadcrumb-apps')).toBeInTheDocument();
    const appsLink = page.getByTestId('app-block-breadcrumb-apps').element() as HTMLElement;

    // Explicit clickable marker.
    expect(appsLink.getAttribute('data-clickable')).toBe('true');

    // A REAL anchor with a real destination — the property keyboard / middle-click /
    // long-press all depend on, and the one a purely visual restyle must never cost.
    expect(appsLink.tagName).toBe('A');
    expect(appsLink.getAttribute('href')).toBe('/apps');

    // 🔴 ASSERTED AS ATTRIBUTES, NOT COMPUTED COLOUR, AND NOT BY CHOICE. This env
    // injects only the `:root` custom properties parsed out of `globals.css` (see
    // `test/component-setup.tsx`) — it does NOT load `@mantine/core/styles.css`. So
    // `--mantine-color-anchor` does not resolve here and every Mantine class is
    // styleless: a `getComputedStyle(...).color` comparison would read the same
    // inherited colour for the link and for its dimmed neighbour and pass or fail for
    // reasons that have nothing to do with this component. The colour claim is made
    // where it can actually be checked — the node-tier guard in
    // `__tests__/chromeCrumbLinkStyle.test.ts`, which reads the shipped Mantine
    // stylesheet directly.
    //
    // What IS observable here is that the crumb is a real Mantine `Anchor` and which
    // `underline` mode it is in — `Anchor` renders that prop as `data-underline`.
    //
    // 🔴 `always`, NOT THE LIBRARY DEFAULT `hover`, AND THE DIFFERENCE IS AN ACCESSIBILITY
    // DECISION RATHER THAN A STYLE PREFERENCE. At rest this crumb sits between two dimmed
    // `/` separators and a dimmed app-name crumb, so with a hover-only underline the sole
    // resting differentiator would be hue — measured 1.07:1 on light, 1.29:1 on dark, where
    // WCAG 1.4.1 (failure F73) allows colour alone only above 3:1, and Mantine emits no
    // `:focus-visible` underline to fall back on. Reverting this to `hover` looks like
    // "adopting the library default" and is a Level-A regression; that is exactly why it is
    // asserted rather than left to the default.
    expect(
      appsLink.getAttribute('data-underline'),
      'the crumb is not a Mantine `Anchor` with `underline="always"`. Either it went back ' +
        'to a hand-styled `Text` (re-forking the site link idiom), or it was relaxed to the ' +
        'library default `hover` — which removes the only resting cue distinguishing it from ' +
        'its dimmed neighbours at 1.07:1 contrast. See the note above before changing this.'
    ).toBe('always');

    // …and it carries NO local colour or decoration override — the mutation that would
    // re-introduce the fork. The old implementation set both (`c="blue.6"`,
    // `td="underline"`), which Mantine emits as inline styles, so this pair is red on
    // the pre-change code and green after it.
    expect(appsLink.style.color, 'the crumb hard-codes a link colour again').toBe('');
    expect(appsLink.style.textDecoration, 'the crumb hard-codes a text-decoration again').toBe('');

    // The trailing crumb (app name) is NOT styled as a LINK — no clickable marker —
    // so the two stay visually distinguishable. 🔴 That remains true after F2 made
    // the trailing crumb a popover TRIGGER: `data-clickable` marks the link
    // affordance specifically (distinct color + underline + pointer), and a button
    // that opens a panel is a different affordance from a link that navigates. If
    // this ever goes red because the crumb grew `data-clickable`, the fix is to
    // remove it from the button, not to relax this.
    const crumbName = page.getByTestId('app-block-breadcrumb-name').element() as HTMLElement;
    expect(crumbName.getAttribute('data-clickable')).toBeNull();
  });

  // De-dup (audit fix): on the page surface the app name must appear EXACTLY
  // ONCE — in the breadcrumb crumb. Before the fix the standalone provenance
  // badge `Text` (`app-block-name`) ALSO rendered the name, so the page chrome
  // read `[icon] <name>  /  Apps  /  <name>`. The badge name is now suppressed on
  // the page surface (the breadcrumb carries it); the provenance ICON stays.
  test('page surface (app.page) shows the app name exactly once — breadcrumb crumb only, no duplicate badge name; provenance icon kept', async () => {
    const name = 'Budgeted Generator';
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-bc-dedup" appName={name} slotId="app.page" />
    );
    // The breadcrumb (and its trailing crumb) is the SOLE app-name node.
    await expect.element(page.getByTestId('app-block-breadcrumb-name')).toBeInTheDocument();
    const crumbName = page.getByTestId('app-block-breadcrumb-name').element();
    expect((crumbName.textContent ?? '').trim()).toBe(name);

    // The name must render exactly once across the whole chrome. getByText with a
    // non-exact match would also catch the crumb; count nodes whose trimmed text
    // is exactly the name. Reverting the badge-name suppression makes this 2.
    const matches = page.getByText(name, { exact: true }).all();
    expect(matches.length).toBe(1);

    // The standalone provenance badge name `Text` is gone on the page surface.
    await expect.element(page.getByTestId('app-block-name')).not.toBeInTheDocument();

    // Provenance trust signal preserved: the app-block icon still carries its
    // "App" provenance label (role=img + aria-label) even though the badge
    // name Text was dropped.
    await expect.element(page.getByRole('img', { name: 'App' })).toBeInTheDocument();

    // "Apps" link still routes to /apps (no regression to the breadcrumb).
    const appsLink = page.getByTestId('app-block-breadcrumb-apps').element();
    expect(appsLink.getAttribute('href')).toBe('/apps');
  });

  test('model surface (model.sidebar_top) does NOT render the breadcrumb; badge name present once (no regression)', async () => {
    const name = 'Background Remover';
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-bc-model" appName={name} slotId="model.sidebar_top" />
    );
    // Badge name still present (compact model chrome) — unchanged by the page-surface de-dup …
    await expect.element(page.getByTestId('app-block-name')).toBeInTheDocument();
    const badgeName = page.getByTestId('app-block-name').element();
    expect((badgeName.textContent ?? '').trim()).toBe(name);
    // … the name renders exactly once (the badge; no breadcrumb crumb on a model slot) …
    expect(page.getByText(name, { exact: true }).all().length).toBe(1);
    // … and no breadcrumb on a model slot.
    await expect.element(page.getByTestId('app-block-breadcrumb')).not.toBeInTheDocument();
  });

  test('omitted slotId (back-compat default = model surface) does NOT render the breadcrumb', async () => {
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-bc-default" appName="Background Remover" />
    );
    await expect.element(page.getByTestId('app-block-name')).toBeInTheDocument();
    await expect.element(page.getByTestId('app-block-breadcrumb')).not.toBeInTheDocument();
  });

  test('the breadcrumb app name is sanitized (bidi/control chars stripped)', async () => {
    // RLO override + control char + zero-width space — sanitizeAppChromeName strips
    // the format/control chars and collapses whitespace; the accessible breadcrumb
    // text must read the clean name, never the raw untrusted string.
    const rawName = 'Evil‮App​Name';
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-bc-sanitize" appName={rawName} slotId="app.page" />
    );
    await expect.element(page.getByTestId('app-block-breadcrumb-name')).toBeInTheDocument();
    const crumbName = page.getByTestId('app-block-breadcrumb-name').element();
    const text = crumbName.textContent ?? '';
    // No bidi-override / bell / zero-width chars survive into the rendered crumb.
    expect(text).not.toMatch(/[‮​]/);
    // The legible characters are preserved (control char became a space → collapsed).
    expect(text.replace(/\s+/g, '')).toBe('EvilAppName');
  });
});

// "Recently run" section in the platform-nav ("Civitai Apps") dropdown — a
// 1-click return to recently-run apps, sourced from the localStorage recents
// store. Icon + name per entry, links to `/apps/run/<blockId>`, EXCLUDES the
// current app, and the whole label+section is omitted when there are no other
// recents. The store is real localStorage in browser mode, so seed it directly.
//
// 🔴 EVERY RENDER IN THIS BLOCK MUST PASS `canOpenPage` — the prop carries the
// run route's `appBlocks && appBlocksPages` gate and it FAILS CLOSED (defaults
// to false), so a render that omits it can never show the section. That makes a
// presence assertion permanently red and, worse, an ABSENCE assertion
// permanently green: it would keep passing with the exclusion logic, the store
// and the cap all deleted. The deliberate fail-closed case is its own test at
// the bottom of this block, where the omission is the thing under test rather
// than an accident.
describe('AppBlockChrome "Recently run" section (platform-nav dropdown)', () => {
  beforeEach(() => {
    clearRecentlyOpenedApps();
  });

  // The platform-nav Menu mounts its dropdown lazily — open it first (its trigger
  // is "Apps menu", distinct from the ⋯ "App menu").
  async function openPlatformNav() {
    await page.getByRole('button', { name: 'Apps menu' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'Marketplace' })).toBeInTheDocument();
  }

  test('renders recents (icon + name), EXCLUDES the current app, links to /apps/run/<blockId>', async () => {
    // Seed newest-last so the resulting order is [other, noicon, current].
    recordRecentlyOpenedApp(
      { id: 'current', blockId: 'current-block', name: 'Current App' },
      SESSION_OWNER_ID
    );
    recordRecentlyOpenedApp(
      { id: 'noicon', blockId: 'noicon-block', name: 'No Icon App' },
      SESSION_OWNER_ID
    );
    recordRecentlyOpenedApp(
      {
        id: 'other',
        blockId: 'other-block',
        name: 'Other App',
        iconUrl: LOADABLE_IMAGE_DATA_URI,
      },
      SESSION_OWNER_ID
    );

    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-recents"
        appBlockId="current"
        appName="Current App"
        slotId="app.page"
        canOpenPage
      />
    );
    await openPlatformNav();

    // Section label present.
    await expect.element(page.getByText('Recently run', { exact: true })).toBeInTheDocument();

    // Rich entry: icon (Avatar <img>) + name, links to the run route.
    const other = page.getByRole('menuitem', { name: 'Other App' }).element() as HTMLElement;
    expect(other.getAttribute('href')).toBe('/apps/run/other-block');
    const otherImg = other.querySelector('img');
    expect(otherImg).not.toBeNull();
    expect(otherImg?.getAttribute('src')).toBe(LOADABLE_IMAGE_DATA_URI);

    // Icon-less entry falls back to a generic app icon (an <svg>, no <img>).
    const noicon = page.getByRole('menuitem', { name: 'No Icon App' }).element() as HTMLElement;
    expect(noicon.getAttribute('href')).toBe('/apps/run/noicon-block');
    expect(noicon.querySelector('img')).toBeNull();
    expect(noicon.querySelector('svg')).not.toBeNull();

    // The current app is EXCLUDED — no menuitem links to its run route.
    const currentLinks = page
      .getByRole('menuitem')
      .all()
      .map((el) => el.element().getAttribute('href'));
    expect(currentLinks).not.toContain('/apps/run/current-block');
  });

  test('the whole "Recently run" section is ABSENT when there are no OTHER recents', async () => {
    // Only the current app is a recent → nothing to offer after exclusion.
    // `canOpenPage` is ON so the absence below is caused by SELF-EXCLUSION, not
    // by the fail-closed gate. Mutation-sanity: deleting the `r.id !==
    // currentAppBlockId` filter in selectChromeRecentApps makes this red.
    recordRecentlyOpenedApp(
      { id: 'solo', blockId: 'solo-block', name: 'Solo App' },
      SESSION_OWNER_ID
    );

    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-solo"
        appBlockId="solo"
        appName="Solo App"
        slotId="app.page"
        canOpenPage
      />
    );
    await openPlatformNav();

    // The menu really did mount its dropdown (otherwise every `not.toBe…`
    // below would pass against an empty document) …
    await expect.element(page.getByRole('menuitem', { name: 'Marketplace' })).toBeInTheDocument();
    // … and neither the label nor the section wrapper renders in it.
    await expect.element(page.getByText('Recently run', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByTestId('app-recently-run')).not.toBeInTheDocument();
  });

  test('an EMPTY recents store renders no "Recently run" section', async () => {
    // `canOpenPage` is ON so the absence is caused by the EMPTY STORE. Mutation-
    // sanity: seeding one other app here makes this red.
    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-empty"
        appBlockId="anything"
        appName="Anything"
        slotId="app.page"
        canOpenPage
      />
    );
    await openPlatformNav();
    await expect.element(page.getByRole('menuitem', { name: 'Marketplace' })).toBeInTheDocument();
    await expect.element(page.getByTestId('app-recently-run')).not.toBeInTheDocument();
  });

  // 🔴 The fail-closed case, stated deliberately: a mounter that cannot prove the
  // viewer holds BOTH `appBlocks` and `appBlocksPages` omits the prop, and the
  // section must not render even though the store HAS offerable entries. This is
  // the one render in this block that leaves `canOpenPage` off, and the seeded
  // store is what makes it a real assertion — the same seed with `canOpenPage`
  // renders two items (asserted in the first test above).
  test('OMITTING canOpenPage hides the section even with offerable recents (fail-closed)', async () => {
    recordRecentlyOpenedApp(
      { id: 'other', blockId: 'other-block', name: 'Other App' },
      SESSION_OWNER_ID
    );
    recordRecentlyOpenedApp(
      { id: 'third', blockId: 'third-block', name: 'Third App' },
      SESSION_OWNER_ID
    );

    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-failclosed"
        appBlockId="current"
        appName="Current App"
        slotId="app.page"
      />
    );
    await openPlatformNav();

    await expect.element(page.getByRole('menuitem', { name: 'Marketplace' })).toBeInTheDocument();
    await expect.element(page.getByTestId('app-recently-run')).not.toBeInTheDocument();
    // And no `/apps/run/` link leaked in via some other menu item.
    const hrefs = page
      .getByRole('menuitem')
      .all()
      .map((el) => el.element().getAttribute('href'));
    expect(hrefs.some((h) => h?.startsWith('/apps/run/'))).toBe(false);
  });

  // Security-adjacent consistency: the persisted `name` is publisher-controlled
  // (laundered through localStorage) — the SAME untrusted source the host trust
  // label sanitizes. The recents item must route it through sanitizeAppChromeName
  // too, so a bidi-override / zero-width / oversized name can't render raw in the
  // dropdown. Mutation-sanity: dropping the sanitizer call (rendering `r.name`
  // raw) fails the "dangerous chars stripped" assertions below.
  test('a hostile persisted name is rendered SANITIZED (bidi/zero-width stripped) + length-bounded', async () => {
    // RLO override + zero-width space + a long tail well past APP_CHROME_NAME_MAX
    // (64). sanitizeAppChromeName strips the bidi/format chars and caps length.
    const rawName = 'Evil‮Hack​App' + 'X'.repeat(200);
    recordRecentlyOpenedApp(
      { id: 'hostile', blockId: 'hostile-block', name: rawName },
      SESSION_OWNER_ID
    );

    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-hostile"
        appBlockId="viewer"
        appName="Viewer App"
        slotId="app.page"
        canOpenPage
      />
    );
    await openPlatformNav();

    // The item is present and still links to its run route (blockId unaffected).
    const item = page.getByTestId('app-recently-run-item').element() as HTMLElement;
    expect(item.getAttribute('href')).toBe('/apps/run/hostile-block');

    const text = item.textContent ?? '';
    // The bidi RLO override + zero-width space must NOT survive into the DOM.
    expect(text).not.toMatch(/[‮​]/);
    // The legible characters are preserved (format chars removed, not the letters).
    expect(text).toContain('EvilHackApp');
    // Length is bounded by the sanitizer (rawName was 200+ chars; the rendered
    // string must be far shorter — proves the length cap ran, not just a CSS clamp).
    expect(text.length).toBeLessThan(rawName.length);
    expect(text.length).toBeLessThanOrEqual(70); // APP_CHROME_NAME_MAX (64) + ellipsis slack
  });

  // Freshness: the store is read on mount AND re-read every time the menu opens,
  // so a within-session client-nav (open app A → open app B, no full reload)
  // shows the CURRENT recents — not a snapshot frozen at first mount.
  test('re-reads the recents store on menu OPEN (fresh within an SPA session)', async () => {
    // Mount with an EMPTY store — first open shows no recents section.
    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-fresh"
        appBlockId="viewer"
        appName="Viewer App"
        slotId="app.page"
        canOpenPage
      />
    );
    await openPlatformNav();
    await expect.element(page.getByTestId('app-recently-run')).not.toBeInTheDocument();

    // Close the menu (Escape), then a NEW app is recorded mid-session (simulating
    // the viewer running another app via client-nav elsewhere in the SPA).
    await page.getByRole('button', { name: 'Apps menu' }).click();
    await expect
      .element(page.getByRole('menuitem', { name: 'Marketplace' }))
      .not.toBeInTheDocument();
    recordRecentlyOpenedApp(
      { id: 'fresh', blockId: 'fresh-block', name: 'Fresh App' },
      SESSION_OWNER_ID
    );

    // Re-open — the open-refresh read must surface the newly-recorded app.
    await openPlatformNav();
    await expect.element(page.getByTestId('app-recently-run')).toBeInTheDocument();
    const item = page.getByRole('menuitem', { name: 'Fresh App' }).element() as HTMLElement;
    expect(item.getAttribute('href')).toBe('/apps/run/fresh-block');
  });
});

// Iframe-aware close (the reported bug): the run page is dominated by a
// cross-origin app iframe that SWALLOWS the click, so Mantine's default
// outside-click close never sees the mousedown and the menu appears stuck open.
// The controlled Menu closes on the window `blur` event, which DOES fire when
// focus/pointer moves into the iframe.
describe('AppBlockChrome platform-nav closes on window blur (iframe-aware)', () => {
  beforeEach(() => {
    clearRecentlyOpenedApps();
  });

  test('opening works, and a window blur (click into the app iframe) closes the menu', async () => {
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-blur" appName="Any App" slotId="app.page" />
    );

    // Target toggles the menu open.
    await page.getByRole('button', { name: 'Apps menu' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'Marketplace' })).toBeInTheDocument();

    // Simulate the click landing INSIDE the cross-origin iframe: the parent
    // window loses focus → `blur`. The controlled menu must close.
    window.dispatchEvent(new Event('blur'));
    await expect
      .element(page.getByRole('menuitem', { name: 'Marketplace' }))
      .not.toBeInTheDocument();

    // The target still opens the menu again after the blur-close (toggle intact).
    await page.getByRole('button', { name: 'Apps menu' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'Marketplace' })).toBeInTheDocument();
  });
});

// The ⋮ OVERFLOW menu, same iframe-aware close — and this is the arm that was
// MISSING. The platform-nav suite above has covered the blur close since the bug
// was first reported; the ⋮ menu sitting inches away in the same component was a
// bare uncontrolled `<Menu>` with no `opened`/`onChange` and no blur handling, so
// clicking into the app left it open on top of the app. Both menus now share
// `useIframeAwareMenu`, and this suite is what holds the ⋮ half down.
//
// 🔴 RED AT BASE: with the uncontrolled `<Menu>`, "Manage apps" is STILL in the
// document after `window.dispatchEvent(new Event('blur'))`, so the
// `not.toBeInTheDocument()` assertion below fails. The `data-testid` assertion
// fails at base too — the trigger carried no testid.
describe('AppBlockChrome ⋮ overflow menu closes on window blur (iframe-aware)', () => {
  beforeEach(() => {
    clearRecentlyOpenedApps();
  });

  // Distinct from the platform-nav trigger ("Apps menu"): this is the ⋮ one.
  //
  // 🔴 DELIBERATELY BY ACCESSIBLE NAME, NOT BY THE NEW TESTID. The testid does
  // not exist at `origin/main`, so keying the open step on it would make the blur
  // tests below fail at base with `Cannot find element` — red, but for the wrong
  // reason, and they would say nothing about the close behaviour. Opening by a
  // locator that resolves on BOTH trees is what makes the failing assertion at
  // base the `not.toBeInTheDocument()` one. The testid gets its own test.
  async function openOverflow() {
    await page.getByRole('button', { name: 'App menu' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'Manage apps' })).toBeInTheDocument();
  }

  test('the ⋮ trigger is addressable by testid, not only by accessible name', async () => {
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-dots-testid" appName="Any App" slotId="app.page" />
    );
    // 🔴 AWAIT BEFORE READING. `render` returns before React has committed, so a
    // synchronous `.element()` throws `Cannot find element` against an empty
    // container — which is the SAME error a genuinely missing testid produces.
    // Written that way first, this test was red at base for a reason unrelated to
    // what it claims. Awaiting the retrying matcher makes the two distinguishable.
    await expect.element(page.getByTestId('app-block-menu-trigger')).toBeInTheDocument();
    // Same element the accessible-name query finds — the testid must be ON the
    // trigger, not on some wrapper that merely contains it.
    expect(page.getByTestId('app-block-menu-trigger').element()).toBe(
      page.getByRole('button', { name: 'App menu' }).element()
    );
  });

  test('opening works, and a window blur (click into the app iframe) closes the ⋮ menu', async () => {
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-dots-blur" appName="Any App" slotId="app.page" />
    );

    await openOverflow();

    // Simulate the click landing INSIDE the cross-origin iframe: the parent
    // window loses focus → `blur`. The controlled menu must close.
    window.dispatchEvent(new Event('blur'));
    await expect
      .element(page.getByRole('menuitem', { name: 'Manage apps' }))
      .not.toBeInTheDocument();

    // The trigger still opens the menu again after the blur-close (the toggle is
    // intact — a `useState` that got stuck `true` would fail here, and so would a
    // fix that closed the menu by unmounting its target).
    await openOverflow();
  });

  test('the two menus are independent — blurring closes both, and neither wedges the other', async () => {
    // Both menus now read the same hook, but each must own its OWN state: a
    // single shared `opened` flag would make one trigger close the other, and a
    // module-level flag would leak between mounts. Open the ⋮ menu, close it by
    // blur, then confirm the platform-nav menu still opens normally.
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-dots-both" appName="Any App" slotId="app.page" />
    );

    await openOverflow();
    window.dispatchEvent(new Event('blur'));
    await expect
      .element(page.getByRole('menuitem', { name: 'Manage apps' }))
      .not.toBeInTheDocument();

    await page.getByRole('button', { name: 'Apps menu' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'Marketplace' })).toBeInTheDocument();
    // …and that one still closes on blur too (the pre-existing behaviour is not
    // regressed by moving it onto the shared hook).
    window.dispatchEvent(new Event('blur'));
    await expect
      .element(page.getByRole('menuitem', { name: 'Marketplace' }))
      .not.toBeInTheDocument();
  });
});

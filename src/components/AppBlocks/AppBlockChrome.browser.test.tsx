import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

// AppBlockChrome now calls useCurrentUser() (moderator gate for the platform-nav
// "Review" item). This suite renders it WITHOUT a CivitaiSessionProvider, and
// useCurrentUser → useCivitaiSessionContext throws "missing CivitaiSessionContext"
// with no provider. Mock it to a stable anon (non-mod) viewer so these
// pre-existing chrome/breadcrumb assertions keep rendering network-free.
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
import { renderWithProviders } from '../../../test/component-setup';

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
      <AppBlockChrome blockInstanceId="inst-model" appName="Background Remover" slotId="model.sidebar_top" />
    );
    await openMenu();
    await expect
      .element(page.getByRole('menuitem', { name: 'Hide app' }))
      .toBeInTheDocument();
  });

  test('no slotId (back-compat default = model surface) renders the "Hide app block" item', async () => {
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-default" appName="Background Remover" />
    );
    await openMenu();
    await expect
      .element(page.getByRole('menuitem', { name: 'Hide app' }))
      .toBeInTheDocument();
  });

  test('page surface (app.page) does NOT render the "Hide app block" item, keeps "Manage apps"', async () => {
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-page" appName="Budgeted Generator" slotId="app.page" />
    );
    await openMenu();
    // "Manage apps" stays …
    await expect.element(page.getByRole('menuitem', { name: 'Manage apps' })).toBeInTheDocument();
    // … but "Hide app block" is suppressed on the full-page surface.
    await expect
      .element(page.getByRole('menuitem', { name: 'Hide app' }))
      .not.toBeInTheDocument();
  });
});

// New: the run-page frame border carries an `Apps / <app name>` breadcrumb on
// the full-page run surface (`/apps/run/<slug>`, slot kind `page`) — "Apps"
// links back to /apps, the app name reuses the SAME sanitized (spoof-proof)
// chrome name as the provenance badge. The breadcrumb is page-only: the compact
// model-slot chrome (badge + ⋯ menu) gets nothing extra. The page-context
// predicate is `isPageSlot(slotId)`, the same signal that suppresses "Hide".
describe('AppBlockChrome run-page breadcrumb (Apps / <app name>)', () => {
  test('page surface (app.page) renders the breadcrumb with the app name + an "Apps" link to /apps', async () => {
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-bc-page" appName="Budgeted Generator" slotId="app.page" />
    );
    // The breadcrumb container is present on the page surface.
    await expect.element(page.getByTestId('app-block-breadcrumb')).toBeInTheDocument();
    // "Apps" is a link back to the apps list.
    const appsLink = page.getByTestId('app-block-breadcrumb-apps').element();
    expect(appsLink.tagName.toLowerCase()).toBe('a');
    expect(appsLink.getAttribute('href')).toBe('/apps');
    expect((appsLink.textContent ?? '').trim()).toBe('Apps');
    // The current app's (sanitized) name is the trailing crumb.
    const crumbName = page.getByTestId('app-block-breadcrumb-name').element();
    expect((crumbName.textContent ?? '').trim()).toBe('Budgeted Generator');
  });

  // The "Apps" crumb must read as obviously CLICKABLE — visually distinct from the
  // static dimmed crumb text + separators. It gets a link affordance: a distinct
  // link color + underline (Mantine `td="underline"` → `data-underline`/inline
  // text-decoration) plus an explicit `data-clickable` marker + `cursor:pointer`.
  // The trailing crumb (the static app name) carries NONE of these. Mutation-
  // sanity: dropping the link styling (so the crumb looks like plain text again)
  // fails these assertions.
  test('the "Apps" crumb carries a clickable link affordance distinguishing it from the static crumb', async () => {
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-bc-link" appName="Budgeted Generator" slotId="app.page" />
    );
    await expect.element(page.getByTestId('app-block-breadcrumb-apps')).toBeInTheDocument();
    const appsLink = page.getByTestId('app-block-breadcrumb-apps').element() as HTMLElement;

    // Explicit clickable marker + pointer cursor (link affordance).
    expect(appsLink.getAttribute('data-clickable')).toBe('true');
    expect(appsLink.style.cursor).toBe('pointer');

    // Underline affordance: Mantine renders `td="underline"` as a text-decoration
    // (inline style or a `data-`/`style` attribute). Assert an underline decoration
    // is present on the link via its computed/inline text-decoration.
    const decorated =
      appsLink.style.textDecoration.includes('underline') ||
      getComputedStyle(appsLink).textDecorationLine.includes('underline');
    expect(decorated).toBe(true);

    // The static trailing crumb (app name) is NOT styled as a link — no clickable
    // marker — so the two are visually distinguishable.
    const crumbName = page.getByTestId('app-block-breadcrumb-name').element() as HTMLElement;
    expect(crumbName.getAttribute('data-clickable')).toBeNull();
  });

  // Contrast (audit L3): the "Apps" link color must clear WCAG AA on the
  // near-white light-mode chrome surface. The original `c="blue.4"` was borderline
  // on a light background; it was bumped to a DARKER shade (`blue.6`). Mantine emits
  // `c="blue.6"` as an inline `color: var(--mantine-color-blue-6)`. Assert the link
  // resolves to the blue-6 token and is NOT the too-light blue-4 — mutation-sanity:
  // reverting to `blue.4` (or any lighter shade) fails this.
  test('the "Apps" link uses a darker blue (blue.6) that clears AA on the light chrome surface, not the borderline blue.4', async () => {
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-bc-contrast" appName="Budgeted Generator" slotId="app.page" />
    );
    await expect.element(page.getByTestId('app-block-breadcrumb-apps')).toBeInTheDocument();
    const appsLink = page.getByTestId('app-block-breadcrumb-apps').element() as HTMLElement;

    // Mantine's `c` prop renders as an inline color referencing the Mantine color
    // CSS variable for the chosen shade.
    const inlineColor = appsLink.style.color;
    expect(inlineColor).toContain('--mantine-color-blue-6');
    expect(inlineColor).not.toContain('--mantine-color-blue-4');
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
      <AppBlockChrome
        blockInstanceId="inst-bc-model"
        appName={name}
        slotId="model.sidebar_top"
      />
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
describe('AppBlockChrome "Recently run" section (platform-nav dropdown)', () => {
  beforeEach(() => {
    clearRecentlyOpenedApps();
  });

  // The platform-nav Menu mounts its dropdown lazily — open it first (its trigger
  // is "Apps menu", distinct from the ⋯ "App menu").
  async function openPlatformNav() {
    await page.getByRole('button', { name: 'Apps menu' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'Apps home' })).toBeInTheDocument();
  }

  test('renders recents (icon + name), EXCLUDES the current app, links to /apps/run/<blockId>', async () => {
    // Seed newest-last so the resulting order is [other, noicon, current].
    recordRecentlyOpenedApp({ id: 'current', blockId: 'current-block', name: 'Current App' });
    recordRecentlyOpenedApp({ id: 'noicon', blockId: 'noicon-block', name: 'No Icon App' });
    recordRecentlyOpenedApp({
      id: 'other',
      blockId: 'other-block',
      name: 'Other App',
      iconUrl: 'https://cdn.example/icon.png',
    });

    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-recents"
        appBlockId="current"
        appName="Current App"
        slotId="app.page"
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
    expect(otherImg?.getAttribute('src')).toBe('https://cdn.example/icon.png');

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
    recordRecentlyOpenedApp({ id: 'solo', blockId: 'solo-block', name: 'Solo App' });

    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-solo"
        appBlockId="solo"
        appName="Solo App"
        slotId="app.page"
      />
    );
    await openPlatformNav();

    // Neither the label nor the section wrapper renders.
    await expect.element(page.getByText('Recently run', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByTestId('app-recently-run')).not.toBeInTheDocument();
  });

  test('an EMPTY recents store renders no "Recently run" section', async () => {
    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-empty"
        appBlockId="anything"
        appName="Anything"
        slotId="app.page"
      />
    );
    await openPlatformNav();
    await expect.element(page.getByTestId('app-recently-run')).not.toBeInTheDocument();
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
    recordRecentlyOpenedApp({ id: 'hostile', blockId: 'hostile-block', name: rawName });

    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-hostile"
        appBlockId="viewer"
        appName="Viewer App"
        slotId="app.page"
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
      />
    );
    await openPlatformNav();
    await expect.element(page.getByTestId('app-recently-run')).not.toBeInTheDocument();

    // Close the menu (Escape), then a NEW app is recorded mid-session (simulating
    // the viewer running another app via client-nav elsewhere in the SPA).
    await page.getByRole('button', { name: 'Apps menu' }).click();
    await expect
      .element(page.getByRole('menuitem', { name: 'Apps home' }))
      .not.toBeInTheDocument();
    recordRecentlyOpenedApp({ id: 'fresh', blockId: 'fresh-block', name: 'Fresh App' });

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
    await expect.element(page.getByRole('menuitem', { name: 'Apps home' })).toBeInTheDocument();

    // Simulate the click landing INSIDE the cross-origin iframe: the parent
    // window loses focus → `blur`. The controlled menu must close.
    window.dispatchEvent(new Event('blur'));
    await expect
      .element(page.getByRole('menuitem', { name: 'Apps home' }))
      .not.toBeInTheDocument();

    // The target still opens the menu again after the blur-close (toggle intact).
    await page.getByRole('button', { name: 'Apps menu' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'Apps home' })).toBeInTheDocument();
  });
});

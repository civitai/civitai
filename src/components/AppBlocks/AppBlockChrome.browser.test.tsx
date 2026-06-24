import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { AppBlockChrome } from '~/components/AppBlocks/IframeHost';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
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

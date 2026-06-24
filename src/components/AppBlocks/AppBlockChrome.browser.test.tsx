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

  test('falls back to "App block" when appName is undefined (never blank)', async () => {
    renderWithProviders(<AppBlockChrome blockInstanceId="inst-3" />);
    await expect.element(page.getByText('App block')).toBeInTheDocument();
    // Guard against a blank/whitespace-only label.
    const nameEl = page.getByTestId('app-block-name').element();
    expect((nameEl.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  test('the ⋯ menu trigger is still present', async () => {
    renderWithProviders(<AppBlockChrome blockInstanceId="inst-4" appName="Background Remover" />);
    await expect.element(page.getByRole('button', { name: 'App block menu' })).toBeInTheDocument();
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
    await page.getByRole('button', { name: 'App block menu' }).click();
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
      .element(page.getByRole('menuitem', { name: 'Hide app block' }))
      .toBeInTheDocument();
  });

  test('no slotId (back-compat default = model surface) renders the "Hide app block" item', async () => {
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-default" appName="Background Remover" />
    );
    await openMenu();
    await expect
      .element(page.getByRole('menuitem', { name: 'Hide app block' }))
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
      .element(page.getByRole('menuitem', { name: 'Hide app block' }))
      .not.toBeInTheDocument();
  });
});

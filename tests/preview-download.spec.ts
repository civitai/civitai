import { expect, test, type Page } from '@playwright/test';
import { storageStatePath, type PreviewRole } from './preview-fixtures';

/**
 * E2E for the model-detail page + download affordance on a deployed PR preview.
 *
 * Navigates from the /models listing to a real model detail page (PROD-CLONE
 * data) WITHOUT hardcoding a model id, then asserts a gate-passing member sees a
 * download control. Runs only under playwright.preview.config.ts.
 *
 * Why only `tester` (FREE) and `gold` (PAID), never `restricted`: the preview
 * gate (preview-auth.middleware) bounces `restricted` to /preview-restricted, so
 * it never reaches an in-app page. tester + gold both clear the gate, so they are
 * the meaningful in-app comparison.
 *
 * Free-vs-paid download difference — read from the source, NOT assumed:
 *   ModelVersionDetails.tsx: `canDownload = version.canDownload || hasDownloadPermissions`.
 *   For a normal public model `version.canDownload` is true for any member, so the
 *   Download section + button render identically for tester and gold. A tier/price
 *   difference only appears on EARLY-ACCESS versions (earlyAccessConfig.chargeForDownload
 *   → DownloadButton shows a Buzz `downloadPrice` badge and wraps in JoinPopover when
 *   !canDownload). We can't deterministically land on an early-access model without
 *   hardcoding an id, so this spec asserts the shared truth — both gate-passing members
 *   see a Download affordance — and does NOT assert a difference the code doesn't
 *   guarantee for an arbitrary listing model.
 */

const DETAIL_URL = /\/models\/\d+(\/|$|\?)/;

/**
 * Click the first model card on /models and land on a detail page.
 * Returns the resolved detail URL.
 *
 * NOTE (riskiest selector): the listing is client-fetched (ModelsInfinite →
 * MasonryGridVirtual → ModelCard). Each ModelCard renders an
 * `<a href="/models/<id>/<slug>">` via AspectRatioImageCard → LinkOrClick →
 * NextLink (getModelUrl() in src/utils/string-helpers.ts builds that path). So we
 * target the first anchor whose href matches /models/<digits>. Derived from
 * src/components/Cards/ModelCard.tsx (href) + CardTemplates/AspectRatioImageCard.tsx
 * (NextLink) + ModelsInfinite.tsx (render={ModelCard}).
 * FALLBACK if the anchor shape changes: switch to
 * `page.getByRole('link').filter({ has: page.locator('img') })` first match, or
 * read an id from a card and `page.goto('/models/<id>')` — but DO NOT hardcode an id.
 */
async function reachFirstModelDetail(page: Page): Promise<string> {
  await page.goto('/models', { waitUntil: 'domcontentloaded' });

  // The listing populates via client fetch. Prefer a role-based locator for the
  // first real model card link (anchor wrapping the card image).
  const firstCard = page
    .getByRole('link')
    .filter({ has: page.locator('img') })
    .first();

  // Wait for the client-fetched grid to render at least one card-with-image.
  await expect(firstCard).toBeVisible({ timeout: 30_000 });

  // Resolve the href and assert it is a model-detail URL before clicking, so a
  // stray image-link (e.g. an ad) doesn't silently navigate us off-target.
  const href = await firstCard.getAttribute('href');
  expect(href, 'first card href should point at a model detail page').toMatch(
    /^\/models\/\d+/
  );

  await Promise.all([
    page.waitForURL(DETAIL_URL, { timeout: 45_000 }),
    firstCard.click(),
  ]);

  await page.waitForLoadState('domcontentloaded');
  return page.url();
}

/** Assert we did not get bounced to either gate destination. */
function assertNoGateBounce(page: Page) {
  expect(page.url(), 'should not redirect to /login').not.toContain('/login');
  expect(page.url(), 'should not redirect to /preview-restricted').not.toContain(
    '/preview-restricted'
  );
}

/**
 * Assert a download affordance is present + visible on the current detail page.
 * The Download section (ModelVersionDetails.tsx ~L780) renders a card whose
 * header is the text "Download", and DownloadVariantDropdown renders a button
 * labelled "Download (<size>)" / "Download Selected" (DownloadButton.tsx, icon
 * IconDownload). We accept any of these as the affordance and require at least one
 * to be visible.
 *
 * NOTE: model.canDownload is true for members on normal public models, so the
 * control renders enabled. We assert presence/visibility, NOT a real download.
 */
async function assertDownloadAffordance(page: Page) {
  // A download-labelled control: button "Download ..." or "Download Selected",
  // OR the section header text "Download". Tolerant to size suffix / "Selected".
  const downloadButton = page
    .getByRole('button', { name: /download/i })
    .or(page.getByRole('link', { name: /download/i }))
    .first();

  const downloadText = page.getByText(/^Download( |$)/).first();

  // Wait for client hydration of the version details panel.
  await expect(downloadButton.or(downloadText)).toBeVisible({ timeout: 30_000 });

  // If a download button/link resolved, it must not be disabled for a gate-passing
  // member on a normal model. (When absent — e.g. component-only/generation-only —
  // we fall back to the section text, which the .or() above already covered.)
  if (await downloadButton.count()) {
    const first = downloadButton.first();
    if (await first.isVisible()) {
      await expect(first).toBeEnabled();
    }
  }
}

const GATE_PASSING_ROLES: PreviewRole[] = ['gold', 'tester'];

for (const role of GATE_PASSING_ROLES) {
  test.describe(`model detail + download affordance (${role})`, () => {
    test.use({ storageState: storageStatePath(role) });

    test(`${role} reaches a model detail page from the listing`, async ({ page }) => {
      const url = await reachFirstModelDetail(page);
      expect(url, 'landed on a /models/<id> detail URL').toMatch(DETAIL_URL);
      assertNoGateBounce(page);

      // The detail page renders an <h1> (Title order={1}) with the model name.
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({
        timeout: 30_000,
      });
    });

    test(`${role} sees a download affordance on the detail page`, async ({ page }) => {
      await reachFirstModelDetail(page);
      assertNoGateBounce(page);
      await assertDownloadAffordance(page);
    });
  });
}

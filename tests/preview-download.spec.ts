import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';

/**
 * E2E: a model detail page renders + a download affordance is present for a
 * gate-passing member, on a deployed PR preview.
 *
 * Resolves a real model id from the PUBLIC API (`/api/v1/models`) and navigates
 * DIRECTLY to `/models/<id>` — deliberately NOT browsing the heavy `/models`
 * infinite-scroll listing. An earlier draft clicked the first listing card;
 * loading that feed concurrently across workers crashed the single-replica
 * preview pod (exit 139) and cascaded failures into the rest of the suite (see
 * PR #2467 run pr-preview-2467-jpcgz). Direct navigation is light and has no
 * fragile card selector.
 *
 * Only `gold` (a gate-passing PAID member): per the source there is no
 * free-vs-paid download difference outside early-access models
 * (`ModelVersionDetails.tsx`: `canDownload = version.canDownload ||
 * hasDownloadPermissions`), so one member role suffices to assert "a member sees
 * a download affordance". `restricted` is never used — it fails the gate.
 */

const DETAIL_URL = /\/models\/\d+(\/|$|\?)/;

test.describe('model detail + download affordance (gold)', () => {
  test.use({ storageState: storageStatePath('gold') });

  test('gold reaches a model detail page and sees a download affordance', async ({ page }) => {
    // Resolve a real, well-formed public model id from the documented v1 API.
    // page.request shares the gold session cookies; the list endpoint is public
    // regardless. nsfw=false keeps us on a model without browsing-level gating.
    const res = await page.request.get('/api/v1/models?limit=1&nsfw=false');
    expect(res.ok(), `/api/v1/models returned HTTP ${res.status()}`).toBeTruthy();
    const body = await res.json();
    const modelId = body?.items?.[0]?.id;
    expect(modelId, 'public API returned at least one model id').toBeTruthy();

    await page.goto(`/models/${modelId}`, { waitUntil: 'domcontentloaded' });

    // Cleared the gate (not bounced to either gate destination) and on a detail URL.
    expect(page.url(), 'should not redirect to /login').not.toContain('/login');
    expect(page.url(), 'should not redirect to /preview-restricted').not.toContain(
      '/preview-restricted'
    );
    await expect(page).toHaveURL(DETAIL_URL);

    // Detail page renders its <h1> model title.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });

    // A download affordance: a "Download…" button/link, or the "Download" section
    // header (ModelVersionDetails.tsx). Tolerant to a size suffix / "Selected".
    const downloadControl = page
      .getByRole('button', { name: /download/i })
      .or(page.getByRole('link', { name: /download/i }))
      .or(page.getByText(/^Download( |$)/))
      .first();
    await expect(downloadControl).toBeVisible({ timeout: 30_000 });
  });
});

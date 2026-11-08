import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import JSZip from 'jszip';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery } from './preview-trpc';

/**
 * Preview-e2e: the moderator REVIEW PAGE flow (`/apps/review/<id>`), run as `mod`.
 *
 *  1. A bare review URL opens on the OVERVIEW tab.
 *  2. With the Code tab's diff EXPANDED and the page scrolled to the bottom at 1124×1305, the
 *     sticky action bar's "Approve & next" and "Reject…" are fully on screen and are the
 *     top-most element at their own centre (not covered by the site footer or the floating
 *     buttons).
 *  3. "Approve & next" lands on ANOTHER pending submission at once; Undo returns to the first
 *     one, which is still pending.
 *  4. At an iPhone-sized viewport the queue's tab bar is ONE row, and every queue row's Review
 *     button is on screen without scrolling sideways.
 *  Screenshots of the review page (1124×1305) and the queue (iPhone size) are attached to the
 *  report.
 *
 * 🔴 SAFE ON THE SHARED DEV DB — NOTHING IS EVER APPROVED. Every `blocks.approveRequest` call is
 * intercepted and ABORTED at the network layer (`page.route`), so even a run slow enough to let
 * the 10-second undo window lapse cannot approve (which would create a canonical repo and fire
 * a real build — see `preview-apps-publish.spec.ts`). The interception doubles as the
 * assertion that Undo sent nothing: the count of approve requests is checked to be zero.
 * Both submissions use per-preview slugs and are withdrawn in `finally`.
 */

const ROLE = 'mod' as const;
const PREVIEW_URL = process.env.PREVIEW_URL ?? '';

function previewSlug(suffix: string): string {
  let label = 'local';
  try {
    label = new URL(PREVIEW_URL).hostname.split('.')[0] || 'local';
  } catch {
    /* default */
  }
  const sanitized = label.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const slug = `ci-rvux-${suffix}-${sanitized}`.slice(0, 40).replace(/-+$/, '');
  return /[a-z0-9]$/.test(slug) ? slug : `${slug}0`;
}

const SLUG_A = previewSlug('a');
const SLUG_B = previewSlug('b');

async function bundle(slug: string): Promise<string> {
  const manifest = {
    blockId: slug,
    version: '0.1.0',
    name: `CI review flow ${slug.slice(-6)}`,
    contentRating: 'g',
    scopes: [] as string[],
    iframe: { minHeight: 300, sandbox: 'allow-scripts allow-forms' },
  };
  const zip = new JSZip();
  zip.file('block.manifest.json', JSON.stringify(manifest, null, 2));
  // Enough lines that an expanded diff makes the page long.
  zip.file(
    'index.html',
    `<!doctype html><html><body>\n${Array.from({ length: 120 }, (_, i) => `<p>line ${i}</p>`).join(
      '\n'
    )}\n</body></html>`
  );
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf.toString('base64');
}

async function submit(request: APIRequestContext, slug: string): Promise<string> {
  const res = await request.post('/api/blocks/submit-version', {
    headers: {
      'content-type': 'application/json',
      origin: PREVIEW_URL,
      referer: `${PREVIEW_URL}/`,
    },
    data: { bundleBase64: await bundle(slug) },
  });
  const body = (await res.json().catch(() => ({}))) as { publishRequestId?: string };
  if (!res.ok() || !body.publishRequestId) {
    throw new Error(`submit-version ${slug} -> HTTP ${res.status()}`);
  }
  return body.publishRequestId;
}

async function withdrawForSlug(request: APIRequestContext, slug: string) {
  const r = await trpcQuery<{ pending: { id: string } | null }>(
    request,
    'blocks.getMyPendingForSlug',
    {
      slug,
    }
  ).catch(() => ({ pending: null }));
  if (r?.pending?.id) {
    await trpcMutation(request, 'blocks.withdrawPublishRequest', {
      publishRequestId: r.pending.id,
    }).catch(() => undefined);
  }
}

/** Abort every approve and count the attempts. */
async function blockApprovals(page: Page): Promise<{ count: () => number }> {
  let n = 0;
  await page.route('**/api/trpc/**', async (route) => {
    if (route.request().url().includes('blocks.approveRequest')) {
      n += 1;
      await route.abort();
      return;
    }
    await route.continue();
  });
  return { count: () => n };
}

/** Fully inside the viewport AND the top-most element at its own centre. */
async function expectUncovered(page: Page, name: string | RegExp) {
  const btn = page.getByRole('button', { name, exact: typeof name === 'string' });
  await expect(btn).toBeVisible();
  const box = await btn.boundingBox();
  const vp = page.viewportSize()!;
  expect(box, `${String(name)} has a box`).not.toBeNull();
  expect(box!.y, `${String(name)} top on screen`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${String(name)} bottom on screen`).toBeLessThanOrEqual(vp.height);
  expect(box!.x + box!.width, `${String(name)} right edge on screen`).toBeLessThanOrEqual(vp.width);
  const onTop = await btn.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  });
  expect(onTop, `${String(name)} is covered by another element`).toBe(true);
}

async function attachShot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test.describe('App review page: overview, sticky actions, approve & next (mod, nothing approved)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('desktop 1124×1305', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1124, height: 1305 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const request = page.request;
    await withdrawForSlug(request, SLUG_A);
    await withdrawForSlug(request, SLUG_B);
    const approvals = await blockApprovals(page);
    try {
      const idA = await submit(request, SLUG_A);
      await submit(request, SLUG_B);

      // 1. Overview is the default.
      await page.goto(`/apps/review/${idA}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await expect(page.getByTestId('apps-review-overview')).toBeVisible();
      await expect(page.getByTestId('apps-review-detail-header')).toContainText(SLUG_A);
      await attachShot(page, testInfo, 'review-overview-1124x1305');

      // 2. Code tab, diff expanded, scrolled to the bottom: the bar is still uncovered.
      await page.getByRole('tab', { name: 'Code' }).click();
      const toggle = page.getByTestId('apps-review-diff-file-toggle').first();
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('End');
      await page.mouse.wheel(0, 20_000);
      await expectUncovered(page, 'Approve & next');
      await expectUncovered(page, 'Reject…');
      await attachShot(page, testInfo, 'review-code-expanded-1124x1305');

      // 3. Approve & next → another pending submission, at once. Undo → back, nothing sent.
      await page.getByTestId('apps-review-approve-next').click();
      await expect(page).not.toHaveURL(new RegExp(`/apps/review/${idA}(\\?|$)`));
      await expect(page).toHaveURL(/\/apps\/review\/[^/?]+/);
      await page.getByTestId('apps-review-approve-undo').click();
      await expect(page).toHaveURL(new RegExp(`/apps/review/${idA}`));
      expect(approvals.count(), 'Undo inside the window must send nothing').toBe(0);
      const still = await trpcQuery<{ pending: { id: string } | null }>(
        request,
        'blocks.getMyPendingForSlug',
        { slug: SLUG_A }
      );
      expect(still.pending?.id, 'the undone submission is still pending').toBe(idA);
    } finally {
      await withdrawForSlug(request, SLUG_A);
      await withdrawForSlug(request, SLUG_B);
    }
  });

  test('iPhone size: one-row tab bar, every Review button on screen', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/apps/review', { waitUntil: 'domcontentloaded' });
    const tabs = page.getByTestId('review-queue-tabs').getByRole('tab');
    await expect(tabs.first()).toBeVisible();
    const tops = new Set<number>();
    for (const t of await tabs.all()) {
      const b = await t.boundingBox();
      if (b) tops.add(Math.round(b.y));
    }
    expect([...tops], 'the tab bar wrapped onto more than one row').toHaveLength(1);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(391);
    const buttons = page.locator('[data-testid^="apps-unified-review-action-"]');
    const n = await buttons.count();
    for (let i = 0; i < n; i++) {
      const b = await buttons.nth(i).boundingBox();
      expect(b, `row ${i} Review button is laid out`).not.toBeNull();
      expect(b!.x).toBeGreaterThanOrEqual(0);
      expect(b!.x + b!.width).toBeLessThanOrEqual(390);
    }
    await attachShot(page, testInfo, 'review-queue-iphone-390x844');
  });
});

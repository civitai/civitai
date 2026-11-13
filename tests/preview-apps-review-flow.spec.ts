import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import JSZip from 'jszip';
import { previewAppBlockManifest } from './preview-app-block-manifest';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery } from './preview-trpc';

/**
 * 🔴 NO `getByTestId` HERE: production builds strip `data-testid` (`next.config.mjs`,
 * `reactRemoveProperties`) and the preview is a production build. Everything is located by
 * role, accessible name or visible text.
 *
 * Preview-e2e: the moderator REVIEW PAGE (`/apps/review/<id>`) and queue, run as `mod`, asserting
 * what only a real PRODUCTION build on a real page can show:
 *
 *  1. A bare review URL opens on the OVERVIEW tab, with the submission's header.
 *  2. The real approve gate: a fresh submission's listing has no icon or cover, so Approve &
 *     next and Approve are disabled with the reason shown, and Reject… is enabled.
 *  3. With the Code tab's diff EXPANDED and the page scrolled to the bottom at 1124×1305, the
 *     sticky bar's Approve & next, Approve and Reject… are fully on screen and top-most at
 *     their own centre (not covered by the site footer or its floating buttons).
 *  4. No MODAL dialog is open over the review page.
 *  5. At an iPhone-sized viewport the queue's tab bar is ONE row, and every queue row's Review
 *     button is on screen without scrolling sideways.
 *  Screenshots are attached to the run's report.
 *
 * 🔴 THE APPROVE & NEXT → NEXT REQUEST → UNDO FLOW IS NOT DRIVEN HERE, deliberately. A fresh
 * submission is not approvable (no store media), and making it so would mean uploading media
 * through the CDN and scan pipeline on the shared dev database. That flow is pinned instead by
 * `src/components/Apps/__tests__/pendingApprovalQueue.test.ts` (the engine, hand-driven clock)
 * and `src/components/Apps/ReviewDecisionFlow.browser.test.tsx` (the page wiring).
 *
 * 🔴 SAFE ON THE SHARED DEV DB. Nothing here clicks an approve, and every `blocks.approveRequest`
 * is aborted at the network layer anyway (belt). The submission uses a per-preview slug and is
 * withdrawn in `finally`.
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
  // Must be approvable (submit runs the approve-time manifest validator, #8240) AND pass the build
  // pipeline's manifest check — the same builder `preview-apps-publish.spec.ts` uses.
  const manifest = previewAppBlockManifest({ slug, name: `CI review flow ${slug.slice(-6)}` });
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
    // The body names the reason (e.g. the manifest validator's `manifestErrors`).
    throw new Error(
      `submit-version ${slug} -> HTTP ${res.status()}: ${JSON.stringify(body).slice(0, 400)}`
    );
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

/** Belt: abort any `blocks.approveRequest` the page might send. Nothing in this spec clicks one. */
async function abortApprovals(page: Page) {
  await page.route('**/api/trpc/**', async (route) => {
    if (route.request().url().includes('blocks.approveRequest')) {
      await route.abort();
      return;
    }
    await route.continue();
  });
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
    if (!hit) return false;
    if (hit === el || el.contains(hit)) return true;
    // A DISABLED button may not be hit-testable (pointer-events), so the point then lands on
    // the bar behind it. That still proves nothing else is on top: the hit must be inside the
    // same "Review actions" bar, never the footer or a floating button.
    const bar = el.closest('[role="group"][aria-label="Review actions"]');
    return !!bar && bar.contains(hit);
  });
  expect(onTop, `${String(name)} is covered by another element`).toBe(true);
}

async function attachShot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

/**
 * Every open dialog / Mantine modal on the page: its accessible name, the start of its text,
 * its classes and whether it is visible. Read for the diagnostics, and to name whatever is
 * covering the page before the spec clicks through it.
 */
async function describeDialogs(page: Page) {
  return page.evaluate(() => {
    const roots = new Set<Element>();
    document
      .querySelectorAll(
        '[role="dialog"], [role="alertdialog"], .mantine-Modal-root, .mantine-Modal-overlay, .mantine-Drawer-root, .mantine-Overlay-root'
      )
      .forEach((el) => roots.add(el));
    return Array.from(roots).map((el) => {
      const h = el as HTMLElement;
      const labelledBy = h.getAttribute('aria-labelledby');
      const labelText = labelledBy
        ? labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
            .trim()
        : '';
      const r = h.getBoundingClientRect();
      const style = getComputedStyle(h);
      return {
        tag: h.tagName.toLowerCase(),
        role: h.getAttribute('role'),
        ariaModal: h.getAttribute('aria-modal'),
        cls: (h.className && typeof h.className === 'string' ? h.className : '').slice(0, 160),
        ariaLabel: h.getAttribute('aria-label'),
        labelledByText: labelText.slice(0, 120),
        text: (h.innerText ?? h.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
        visible:
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 &&
          r.width > 0 &&
          r.height > 0,
        // The portal's whole subtree, to name a modal whose content box carries no text.
        portalHtml: (h.closest('[data-portal]')?.outerHTML ?? '').slice(0, 600),
      };
    });
  });
}

/**
 * 🔴 WHY THIS SPEC MARKS THE TERMS OF SERVICE AS ACCEPTED. The smoke `mod` account is seeded
 * with onboarding complete but no `tos*AcceptedHash`, so once the ToS body changes from the
 * rollout baseline the site opens its forced, un-dismissable ToS re-acceptance modal on every
 * page (`useToSUpdateModal`: re-prompt iff the accepted hash differs from the served one). It
 * covered the review page and swallowed every click — measured on the PR preview: the
 * `section[role=dialog][aria-label="Terms of Service"]` overlay intercepted the Code-tab click,
 * and neither its close affordance nor Escape closes it.
 *
 * So the spec records acceptance the way the modal's own Accept does — `user.setSettings`
 * with the domain's date field and accepted-hash field — using the metadata the page itself
 * was served (`tosMeta`: which fields this domain reads, and the hash to store). Nothing is
 * clicked through, and nothing is dismissed: any OTHER dialog on the review page is a failure
 * (`expectNoOpenDialog`).
 */
async function acceptTermsForThisDomain(page: Page) {
  const meta = await page.evaluate(() => {
    const d = (window as unknown as { __NEXT_DATA__?: { props?: Record<string, unknown> } })
      .__NEXT_DATA__;
    const props = d?.props ?? {};
    const m = (props.tosMeta ??
      (props.pageProps as Record<string, unknown> | undefined)?.tosMeta) as
      | { hash?: string; fieldKey?: string; hashFieldKey?: string }
      | undefined;
    return m ?? null;
  });
  if (!meta?.hash || !meta.fieldKey || !meta.hashFieldKey) {
    throw new Error(`could not read the served ToS metadata: ${JSON.stringify(meta)}`);
  }
  // superjson body: the date field is a `z.date()`, so it needs the Date meta.
  const res = await page.request.post('/api/trpc/user.setSettings?batch=1', {
    headers: {
      'content-type': 'application/json',
      origin: PREVIEW_URL,
      referer: `${PREVIEW_URL}/`,
    },
    data: {
      '0': {
        json: { [meta.fieldKey]: new Date().toISOString(), [meta.hashFieldKey]: meta.hash },
        meta: { values: { [meta.fieldKey]: ['Date'] } },
      },
    },
  });
  if (!res.ok()) {
    throw new Error(`user.setSettings (ToS acceptance) -> HTTP ${res.status()}`);
  }
  console.log(
    `[review-flow diag] ToS accepted for this domain via ${meta.fieldKey}/${meta.hashFieldKey}`
  );
}

/**
 * No dialog may be open over the review page. Logged first (so a failure names it), then
 * asserted — a future change that opens a modal on this page fails here, loudly, instead of
 * being clicked through.
 */
async function expectNoOpenDialog(page: Page, where: string) {
  const dialogs = await describeDialogs(page);
  for (const d of dialogs) console.log(`[review-flow diag] ${where}: dialog ${JSON.stringify(d)}`);
  // MODAL dialogs only (`aria-modal="true"`, which Mantine's Modal and Drawer content carry).
  // A non-modal popover with `role="dialog"` — e.g. the site's "Make this nav yours" tip —
  // blocks nothing and would only make this flaky.
  const open = dialogs.filter(
    (d) => d.visible && (d.role === 'dialog' || d.role === 'alertdialog') && d.ariaModal === 'true'
  );
  expect(
    open.map((d) => d.ariaLabel || d.labelledByText || d.text),
    `${where}: open dialog(s)`
  ).toEqual([]);
}

test.describe('App review page: overview, sticky actions, approve & next (mod, nothing approved)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  /*
    ON-FAILURE DIAGNOSTICS. The pipeline log is the only artifact this tier hands back
    (screenshots and error-context are not retrievable), so a failure prints where the page
    actually was and what it rendered: URL, title, the start of the visible text, and the
    testids present. Text only — no request headers, cookies or storage.
  */
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    try {
      const diag = await page.evaluate(() => ({
        title: document.title,
        text: (document.body?.innerText ?? '').slice(0, 1500),
        testIds: Array.from(document.querySelectorAll('[data-testid]'))
          .map((el) => el.getAttribute('data-testid'))
          .filter((v, i, a) => !!v && a.indexOf(v) === i)
          .slice(0, 50),
      }));
      console.log(`[review-flow diag] test: ${testInfo.title}`);
      console.log(`[review-flow diag] url: ${page.url()}`);
      console.log(`[review-flow diag] title: ${diag.title}`);
      console.log(`[review-flow diag] testids: ${diag.testIds.join(', ')}`);
      console.log(`[review-flow diag] body text:\n${diag.text}`);
      for (const d of await describeDialogs(page)) {
        console.log(`[review-flow diag] dialog at failure: ${JSON.stringify(d)}`);
      }
    } catch (err) {
      console.log(`[review-flow diag] could not read the page: ${String(err)}`);
    }
  });

  test('desktop 1124×1305', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1124, height: 1305 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await acceptTermsForThisDomain(page);
    const request = page.request;
    await withdrawForSlug(request, SLUG_A);
    // Pre-clean only: earlier revisions of this spec submitted a second fixture.
    await withdrawForSlug(request, SLUG_B);
    await abortApprovals(page);
    try {
      const idA = await submit(request, SLUG_A);

      // 1. Overview is the default, under the submission's header.
      await page.goto(`/apps/review/${idA}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await expect(page.getByRole('region', { name: 'Submission overview' })).toBeVisible();
      await expect(
        page.getByRole('region', { name: new RegExp(`^Review of ${SLUG_A} v`) })
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: /^CI review flow / })).toBeVisible();

      // 2. The real gate: no icon or cover → no approve, and the bar says why.
      await expect(page.getByText(/Cannot approve yet:.*no icon or cover/)).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Approve & next', exact: true })
      ).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Reject…', exact: true })).toBeEnabled();

      // 4. No modal over the page.
      await expectNoOpenDialog(page, 'review page');
      await attachShot(page, testInfo, 'review-overview-1124x1305');

      // 3. Code tab, diff expanded, scrolled to the bottom: the bar is still uncovered.
      await page.getByRole('tab', { name: 'Code' }).click();
      // The diff file header is a real button named "Expand <path>" / "Collapse <path>".
      const codePanel = page.getByRole('tabpanel', { name: 'Code' });
      const expand = codePanel.getByRole('button', { name: /^Expand / }).first();
      await expect(expand).toBeVisible();
      await expand.click();
      await expect(codePanel.getByRole('button', { name: /^Collapse / }).first()).toHaveAttribute(
        'aria-expanded',
        'true'
      );
      await page.keyboard.press('End');
      await page.mouse.wheel(0, 20_000);
      await expectUncovered(page, 'Approve & next');
      await expectUncovered(page, 'Approve');
      await expectUncovered(page, 'Reject…');
      await attachShot(page, testInfo, 'review-code-expanded-1124x1305');
    } finally {
      await withdrawForSlug(request, SLUG_A);
    }
  });

  test('iPhone size: one-row tab bar, every Review button on screen', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await acceptTermsForThisDomain(page);
    await page.goto('/apps/review', { waitUntil: 'domcontentloaded' });
    await expectNoOpenDialog(page, 'queue page');
    const tabs = page.getByRole('tablist', { name: 'Review queues' }).getByRole('tab');
    await expect(tabs.first()).toBeVisible();
    const tops = new Set<number>();
    for (const t of await tabs.all()) {
      const b = await t.boundingBox();
      if (b) tops.add(Math.round(b.y));
    }
    expect([...tops], 'the tab bar wrapped onto more than one row').toHaveLength(1);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(391);
    // Each queue row's action is a button named exactly "Review".
    const buttons = page.getByRole('button', { name: 'Review', exact: true });
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

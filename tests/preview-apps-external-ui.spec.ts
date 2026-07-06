import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery } from './preview-trpc';

/**
 * Preview-e2e: App Blocks W13 P3a — OFF-SITE (external-link) UI (PR-c).
 *
 * The UI over the merged submit/withdraw/approve/reject backend, run as `mod`:
 *   (1) UI SUBMIT — drive the `/apps/submit` "External link" form in the browser
 *       (toggle mode, fill slug/name/url, Create draft) → the draft shows in
 *       `/apps/my-submissions` → withdraw (trpc) to clean.
 *   (2) REVIEW RENDER + REJECT — a submitted off-site pending row renders in
 *       `/apps/review`; the mod OPENS its content-only review modal in the browser
 *       and we assert the CONTENT-ONLY checklist mounts ("URL is https and opens
 *       externally"), then the reject itself is driven through the proc.
 *
 * SELECTORS — deterministic `data-testid` (NOT text/role): the interactive Mantine
 * widgets this spec drives (the `SegmentedControl` mode toggle, the form inputs, the
 * per-row Review button) resolve by text/role to inner label spans / off-screen /
 * indicator-overlaid nodes that never satisfy Playwright's visible+stable+enabled
 * actionability gate → 90s click timeouts. Every interaction here targets an
 * additive `apps-offsite-*` testid on the real actionable element (+ a
 * `scrollIntoViewIfNeeded()` before button clicks). These testids are innocuous,
 * behavior/style-neutral additions to the components — NOT a UI change.
 *
 * SCENARIO 2 APPROACH — hybrid (render-in-UI, reject-via-proc): the review modal
 * MOUNT is proven in the browser (open it via the row's testid'd Review button;
 * assert the off-site checklist renders), but the actual reject is issued via
 * `trpcMutation('appListings.rejectExternalRequest', …)` rather than driving the
 * modal's Reject… → textarea(≥10 chars) → Reject confirm → close → invalidate chain.
 * That chain is inherently timing-fragile (a disabled-until-valid button, a modal
 * close + tRPC cache-invalidation refetch) and authored blind, where every failed
 * cycle costs a full Tekton round-trip. The hybrid is a robust proof that the UI
 * mounts the queue + modal AND the backend wiring works — the goal per the spec.
 * (The modal's Reject controls carry testids too, so a future full-drive is cheap.)
 *
 * NO APPROVE-SUCCESS e2e: P3a has no delete-approved path, so an approved offsite
 * listing can't be self-cleaned on the SHARED dev store (a re-run would then
 * collide on `AppListing.slug @unique`). The approve happy-path stays UNIT-covered
 * (offsite-listing.service.test) until P3b adds a delist/delete path. The reject
 * path IS self-cleaning (reject deletes the draft listing → releases the slug).
 *
 * ROLE — why `mod`: submit/withdraw are `appDeveloperProcedure` (`app-blocks-author`)
 * and the review page + approve/reject are moderator-gated; the `mod` fixture
 * satisfies BOTH (mods are authors via the app-blocks-author floor). The synthetic
 * preview `tester` fixture is NOT in the real app-blocks-author cohort, so it 403s
 * submit by design (author-gate rejection is covered by the unit router-authz tests).
 *
 * GATES: Tekton `pr-smoke-test` is authoritative — do NOT run browser-mode locally
 * on NixOS.
 *
 * SAFE + SELF-CLEANING (dev DB shared across concurrent previews): per-preview slug
 * (`ci-smoke-extui-<host-label>`) so previews never collide on `AppListing.slug
 * @unique`; each test pre-cleans any leftover pending row for its slug and withdraws
 * in `finally`. No asset upload / approve → NO Image rows, NO Tekton build, NO CF DNS.
 */

const ROLE = 'mod' as const;
const PREVIEW_URL = process.env.PREVIEW_URL ?? '';

/** Per-preview slug (distinct prefix from the submit-backend spec's slug). */
function previewSlug(): string {
  let label = 'local';
  try {
    label = new URL(PREVIEW_URL).hostname.split('.')[0] || 'local';
  } catch {
    /* default */
  }
  const sanitized = label.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const slug = `ci-smoke-extui-${sanitized}`.slice(0, 40).replace(/-+$/, '');
  return /[a-z0-9]$/.test(slug) ? slug : `${slug}0`;
}

const SLUG = previewSlug();
const EXTERNAL_URL = 'https://example.com/ci-smoke-external-ui';

type PendingItem = { id: string; slug: string; appListingId: string | null };
type PendingList = { items: PendingItem[]; nextCursor: string | null };
type MySubmission = { id: string; slug: string; status: string };
type MyList = { items: MySubmission[]; nextCursor: string | null };

/** Page the oldest-first pending queue to find our row by slug. */
async function findPendingBySlug(
  request: APIRequestContext,
  slug: string
): Promise<PendingItem | null> {
  let cursor: string | null = null;
  for (let p = 0; p < 25; p++) {
    const input: { limit: number; cursor?: string } = { limit: 100 };
    if (cursor) input.cursor = cursor;
    const list = await trpcQuery<PendingList>(request, 'appListings.listPendingRequests', input);
    const hit = list.items.find((i) => i.slug === slug);
    if (hit) return hit;
    if (!list.nextCursor) break;
    cursor = list.nextCursor;
  }
  return null;
}

/** Find the caller's own submission (any status) by slug. */
async function findMySubmissionBySlug(
  request: APIRequestContext,
  slug: string
): Promise<MySubmission | null> {
  let cursor: string | null = null;
  for (let p = 0; p < 25; p++) {
    const input: { limit: number; cursor?: string } = { limit: 100 };
    if (cursor) input.cursor = cursor;
    const list = await trpcQuery<MyList>(request, 'appListings.listMySubmissions', input);
    const hit = list.items.find((i) => i.slug === slug);
    if (hit) return hit;
    if (!list.nextCursor) break;
    cursor = list.nextCursor;
  }
  return null;
}

/** Best-effort: withdraw any leftover pending row for this slug (self-clean). */
async function withdrawPendingForSlug(request: APIRequestContext, slug: string): Promise<void> {
  const row = await findMySubmissionBySlug(request, slug).catch(() => null);
  if (row?.id && row.status === 'pending') {
    await trpcMutation(request, 'appListings.withdrawExternalRequest', {
      publishRequestId: row.id,
    }).catch(() => {});
  }
}

test.describe('App Blocks P3a UI: external-link submit + review-reject (mod, self-cleaning)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('UI submit → row in my-submissions → withdraw', async ({ page }) => {
    await page.goto('/apps/submit', { waitUntil: 'domcontentloaded' });
    const request = page.request;

    try {
      await withdrawPendingForSlug(request, SLUG);

      // Toggle to "External link" mode (testid targets the real actionable option,
      // not the SegmentedControl's inner label span).
      const modeExternal = page.getByTestId('apps-offsite-submit-mode-external');
      await modeExternal.scrollIntoViewIfNeeded();
      await modeExternal.click();

      // The external form mounts once the mode flips.
      await expect(page.getByTestId('apps-offsite-submit-form')).toBeVisible({ timeout: 10000 });

      // Fill the required metadata (metadata-only — NO asset upload in the e2e; the
      // asset step is separate, and withdraw deletes the draft).
      await page.getByTestId('apps-offsite-submit-slug').fill(SLUG);
      await page.getByTestId('apps-offsite-submit-name').fill('CI Smoke — external UI (P3a)');
      await page.getByTestId('apps-offsite-submit-url').fill(EXTERNAL_URL);

      const createBtn = page.getByTestId('apps-offsite-submit-create');
      await createBtn.scrollIntoViewIfNeeded();
      await createBtn.click();

      // On success the form advances to the asset step (deterministic success signal).
      await expect(page.getByTestId('apps-offsite-submit-success')).toBeVisible({ timeout: 15000 });

      // The draft shows up in the author's own submissions.
      const mine = await findMySubmissionBySlug(request, SLUG);
      expect(mine, 'the submitted draft appears in my-submissions').not.toBeNull();
      expect(mine!.status, 'the new submission is pending').toBe('pending');

      // The /apps/my-submissions page renders the external row (testid scoped by slug).
      await page.goto('/apps/my-submissions', { waitUntil: 'domcontentloaded' });
      await expect(
        page.getByTestId(`apps-offsite-submission-row-${SLUG}`)
      ).toBeVisible({ timeout: 15000 });

      // Withdraw (terminal — deletes the draft, releases the slug).
      await trpcMutation(request, 'appListings.withdrawExternalRequest', {
        publishRequestId: mine!.id,
      });
      const after = await findPendingBySlug(request, SLUG);
      expect(after, 'the withdrawn request leaves the pending queue').toBeNull();
    } finally {
      await withdrawPendingForSlug(request, SLUG);
    }
  });

  test('review renders the offsite pending row with the content checklist → Reject removes it', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const request = page.request;

    let publishRequestId: string | null = null;
    try {
      await withdrawPendingForSlug(request, SLUG);

      // Seed a pending off-site request via trpc (this test focuses on the review
      // render + reject UI, not the submit form — that's the first test).
      const submit = await trpcMutation<{ publishRequestId: string; slug: string }>(
        request,
        'appListings.submitExternalListing',
        {
          slug: SLUG,
          name: 'CI Smoke — external UI reject (P3a)',
          externalUrl: EXTERNAL_URL,
          tagline: 'reject-path fixture',
          category: 'utility',
          contentRating: 'g',
          changelog: 'ci-smoke reject',
        }
      );
      publishRequestId = submit.publishRequestId;

      // The review page renders the kind-aware off-site queue with our row.
      await page.goto('/apps/review', { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('External-link submissions')).toBeVisible({ timeout: 15000 });

      // Open the content-only review modal for OUR row (testid scoped by slug — no
      // fragile `.last()` / off-screen button).
      const reviewBtn = page.getByTestId(`apps-offsite-review-${SLUG}`);
      await expect(reviewBtn).toBeVisible({ timeout: 15000 });
      await reviewBtn.scrollIntoViewIfNeeded();
      await reviewBtn.click();

      // The modal mounts the content-only checklist (proves the review UI renders).
      await expect(page.getByText('URL is https and opens externally')).toBeVisible({
        timeout: 10000,
      });

      // Reject via the proc (see header: the modal render is UI-verified above; the
      // reject mutation is driven through the proc for a deterministic self-clean).
      await trpcMutation(request, 'appListings.rejectExternalRequest', {
        publishRequestId,
        rejectionReason: 'Not a real app — smoke test reject.',
      });

      // Gone from the pending queue (reject deletes the draft listing).
      await expect
        .poll(async () => (await findPendingBySlug(request, SLUG)) === null, { timeout: 15000 })
        .toBe(true);
      publishRequestId = null; // rejected — nothing to withdraw
    } finally {
      if (publishRequestId) {
        await trpcMutation(request, 'appListings.withdrawExternalRequest', {
          publishRequestId,
        }).catch(() => {});
      } else {
        await withdrawPendingForSlug(request, SLUG);
      }
    }
  });
});

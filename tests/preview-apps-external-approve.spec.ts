import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery } from './preview-trpc';

/**
 * Preview-e2e: App Blocks W13 P3a — OFF-SITE (external-link) APPROVE/REJECT leg
 * (PR-b), run as `mod`. Exercises the two SAFE + SELF-CLEANING moderation paths:
 *
 *   (1) REJECT: submit (mod, per-preview slug) → `rejectExternalRequest(reason)`
 *       → the request leaves the pending queue and its DRAFT listing is deleted
 *       (reject is terminal + releases the slug → self-cleaning, no leftover row).
 *
 *   (2) APPROVE-GATE: submit (mod, NO assets — no icon/cover/screenshot) →
 *       `approveExternalRequest` → asserts a BAD_REQUEST (the dark P1
 *       `assertListingAssetsComplete` gate fires: "missing required assets"),
 *       proving approve is BLOCKED without assets. Then `withdrawExternalRequest`
 *       cleans the still-pending draft.
 *
 * WHY NOT an approve-SUCCESS → store-render spec here: a successful approve leaves
 * an APPROVED listing with NO delete path in P3a (approve is one-way; there is no
 * un-approve / delete-approved proc yet), which would POLLUTE the shared dev store
 * across concurrent previews. That path (approve success + the store Visit-anchor
 * invariant) is DEFERRED to PR-c (the UI + a listing-management surface). This spec
 * deliberately only drives the two self-cleaning paths.
 *
 * ROLE — why `mod`: `submit/withdrawExternalRequest` are `appDeveloperProcedure`
 * (`app-blocks-author`) and `approve/rejectExternalRequest`/`listPendingRequests`
 * are `moderatorProcedure`. The `mod` fixture satisfies BOTH (mods author via the
 * app-blocks-author floor), and v1 ALLOWS mod self-approve (reviewer==submitter),
 * so the whole leg runs as a single mod — like every sibling apps smoke spec.
 *
 * GATES (Tekton `pr-smoke-test` is authoritative — do NOT run browser-mode locally
 * on NixOS).
 *
 * SAFE + SELF-CLEANING (the dev DB is shared across concurrent previews):
 *   - Each scenario uses its OWN per-preview slug so two previews never collide on
 *     `AppListing.slug @unique`. A same-preview re-run pre-withdraws any leftover
 *     pending row before submitting.
 *   - No asset upload / no successful approve → NO Image rows, NO Tekton build, NO
 *     CF DNS, NO approved store row.
 *   - We withdraw in `finally` (deletes the draft + releases the slug) so a
 *     mid-test failure leaves nothing behind.
 */

const ROLE = 'mod' as const;
const PREVIEW_URL = process.env.PREVIEW_URL ?? '';

/** Per-preview + per-scenario slug so concurrent previews never collide. */
function previewSlug(suffix: string): string {
  let label = 'local';
  try {
    label = new URL(PREVIEW_URL).hostname.split('.')[0] || 'local';
  } catch {
    /* fall through to default */
  }
  const sanitized = label.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const slug = `ci-ext-${suffix}-${sanitized}`.slice(0, 40).replace(/-+$/, '');
  return /[a-z0-9]$/.test(slug) ? slug : `${slug}0`;
}

const EXTERNAL_URL = 'https://example.com/ci-smoke-external-approve';

type SubmitResult = { listingId: string; publishRequestId: string; slug: string };
type PendingItem = { id: string; slug: string; appListingId: string | null };
type PendingList = { items: PendingItem[]; nextCursor: string | null };

function submitInput(slug: string) {
  return {
    slug,
    name: 'CI Smoke — external approve/reject (P3a PR-b)',
    externalUrl: EXTERNAL_URL,
    tagline: 'a pure external-link app',
    category: 'utility',
    contentRating: 'g',
    changelog: 'ci-smoke approve/reject',
  };
}

/** Page the oldest-first pending queue to find our row by slug. */
async function findPendingBySlug(
  request: APIRequestContext,
  slug: string
): Promise<PendingItem | null> {
  let cursor: string | null = null;
  for (let page = 0; page < 25; page++) {
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

/** Best-effort: withdraw any leftover pending row for this slug (self-clean). */
async function withdrawPendingForSlug(
  request: APIRequestContext,
  slug: string
): Promise<void> {
  const row = await findPendingBySlug(request, slug).catch(() => null);
  if (row?.id) {
    await trpcMutation(request, 'appListings.withdrawExternalRequest', {
      publishRequestId: row.id,
    }).catch(() => {});
  }
}

test.describe('App Blocks P3a PR-b: off-site approve/reject (mod, self-cleaning)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('REJECT: submit → reject(reason) → request leaves the pending queue (draft deleted)', async ({
    page,
  }) => {
    const SLUG = previewSlug('rej');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const request = page.request;

    let publishRequestId: string | null = null;
    try {
      await withdrawPendingForSlug(request, SLUG);

      const result = await trpcMutation<SubmitResult>(
        request,
        'appListings.submitExternalListing',
        submitInput(SLUG)
      );
      publishRequestId = result.publishRequestId;
      expect(result.slug, 'slug echoes the submission').toBe(SLUG);

      // It's in the pending queue before review.
      const pending = await findPendingBySlug(request, SLUG);
      expect(pending, 'the submitted request is pending before review').not.toBeNull();

      // REJECT (reason ≥10) — terminal; deletes the draft listing.
      await trpcMutation(request, 'appListings.rejectExternalRequest', {
        publishRequestId,
        rejectionReason: 'ci-smoke reject: not a real app, rejecting',
      });
      publishRequestId = null; // rejected + draft deleted — nothing to clean

      // Gone from the pending queue.
      const afterReject = await findPendingBySlug(request, SLUG);
      expect(afterReject, 'the rejected request no longer appears in the pending queue').toBeNull();
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

  test('APPROVE-GATE: submit with NO assets → approve is BLOCKED (missing assets) → withdraw cleans', async ({
    page,
  }) => {
    const SLUG = previewSlug('gate');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const request = page.request;

    let publishRequestId: string | null = null;
    try {
      await withdrawPendingForSlug(request, SLUG);

      const result = await trpcMutation<SubmitResult>(
        request,
        'appListings.submitExternalListing',
        submitInput(SLUG)
      );
      publishRequestId = result.publishRequestId;

      // APPROVE with NO icon/cover/screenshot attached → the assertListingAssetsComplete
      // gate MUST fire (the router maps it to a BAD_REQUEST / HTTP 400 whose message
      // names the missing assets). trpcMutation throws on a non-2xx response.
      let approveError: Error | null = null;
      try {
        await trpcMutation(request, 'appListings.approveExternalRequest', {
          publishRequestId,
          approvalNotes: 'ci-smoke approve (expected to be gate-blocked)',
        });
      } catch (err) {
        approveError = err as Error;
      }
      expect(approveError, 'approve without assets must be rejected by the gate').not.toBeNull();
      expect(
        approveError?.message ?? '',
        'the gate error names the missing required assets'
      ).toMatch(/missing required assets/i);

      // The gate fired BEFORE any mutation → the request is still pending.
      const stillPending = await findPendingBySlug(request, SLUG);
      expect(stillPending, 'the gate-blocked request is still pending (no mutation)').not.toBeNull();

      // WITHDRAW to clean (deletes the draft + releases the slug).
      await trpcMutation(request, 'appListings.withdrawExternalRequest', { publishRequestId });
      publishRequestId = null;

      const afterWithdraw = await findPendingBySlug(request, SLUG);
      expect(afterWithdraw, 'the withdrawn request no longer appears in the queue').toBeNull();
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

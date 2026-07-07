import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery } from './preview-trpc';

/**
 * Preview-e2e: App Blocks W13 P3b PR3/PR4 — OFF-SITE moderation ACTIONS (delist /
 * relist / claim / purge / resolve / dismiss), tRPC-driven, SELF-CLEANING.
 *
 * WHAT THIS COVERS (deterministically, in a preview) and WHY NOT the full
 * approve-success → store-render → delist/claim round-trip:
 *
 *   The full "approve an off-site listing, see it in the store, delist/claim it,
 *   purge to self-clean" round-trip requires a SUCCESSFUL approve, which the dark P1
 *   asset gate (`assertListingAssetsComplete`) blocks unless the draft has an
 *   icon+cover+≥1 screenshot whose backing Image is `ingestion = Scanned`. In a PR
 *   preview the external image scanner is UNREACHABLE, so uploaded images stay
 *   `Pending` forever (see `tests/preview-post-images.spec.ts`: "image ingestion …
 *   is unreachable in preview so the row stays Pending"). An attach of a Pending
 *   image is rejected ("scan is not complete"), so an off-site listing can NOT reach
 *   `approved`/`removed` in preview — i.e. a CLAIMABLE-state listing is not
 *   constructible here. So the claim HAPPY-PATH (approved/removed → reassigned +
 *   audit event) is covered EXHAUSTIVELY in the unit tests instead
 *   (`offsite-moderation.service.mod-actions.test.ts`), NOT here. This preview spec
 *   exercises only what is reachable: the claim GUARD rejections (claiming a draft /
 *   a nonexistent listing → typed error, zero events) + the mod-only AUTHZ (a tester
 *   is FORBIDDEN). Same rationale as the delist/purge legs below.
 *
 *   `purge` (the PR3 self-clean primitive) DOES solve the P3a "un-cleanable approved
 *   row" problem the sibling approve spec deferred on — and it works on ANY off-site
 *   status, so this spec exercises purge END-TO-END on a self-seeded DRAFT (the one
 *   listing state reachable in preview), plus the report/delist/claim GUARDS (a draft
 *   is not reportable / not delistable / not claimable) and the full mod-only AUTHZ
 *   matrix. All self-cleaning via `purge` / `withdrawExternalRequest`.
 *
 * ROLE — `mod` for the action legs (every PR3/PR4 proc is `moderatorProcedure`; mod
 * also authors via the app-blocks-author floor, so a single mod runs submit +
 * purge), `tester` for the authz-denial matrix.
 *
 * GATES (Tekton `pr-smoke-test` is authoritative — do NOT run browser-mode locally
 * on NixOS). SAFE + SELF-CLEANING: per-preview unique slugs; purge/withdraw in
 * `finally` so a mid-test failure leaves nothing behind.
 */

const PREVIEW_URL = process.env.PREVIEW_URL ?? '';

/** Per-preview + per-scenario slug so concurrent previews never collide. */
function previewSlug(suffix: string): string {
  let label = 'local';
  try {
    label = new URL(PREVIEW_URL).hostname.split('.')[0] || 'local';
  } catch {
    /* default */
  }
  const sanitized = label.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const slug = `ci-del-${suffix}-${sanitized}`.slice(0, 40).replace(/-+$/, '');
  return /[a-z0-9]$/.test(slug) ? slug : `${slug}0`;
}

const EXTERNAL_URL = 'https://example.com/ci-smoke-external-delist';

type SubmitResult = { listingId: string; publishRequestId: string; slug: string };
type ModEventList = { items: Array<{ id: string; action: string }>; nextCursor: string | null };

function submitInput(slug: string) {
  return {
    slug,
    name: 'CI Smoke — external delist/purge (P3b PR3)',
    externalUrl: EXTERNAL_URL,
    tagline: 'a pure external-link app',
    category: 'utility',
    contentRating: 'g',
    changelog: 'ci-smoke delist/purge',
  };
}

/** Best-effort: flip any leftover pending request for this preview's request id. */
async function withdrawQuietly(request: APIRequestContext, publishRequestId: string | null) {
  if (!publishRequestId) return;
  await trpcMutation(request, 'appListings.withdrawExternalRequest', { publishRequestId }).catch(
    () => {}
  );
}

async function expectRejects(p: Promise<unknown>, why: string): Promise<Error> {
  const err = await p.then(
    () => {
      throw new Error(`expected a rejection: ${why}`);
    },
    (e: Error) => e
  );
  return err;
}

test.describe('App Blocks P3b PR3: off-site moderation actions (mod, self-cleaning)', () => {
  test.use({ storageState: storageStatePath('mod') });

  test('GUARDS: a DRAFT is not reportable / not delistable, and writes ZERO audit events', async ({
    page,
  }) => {
    const SLUG = previewSlug('guard');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const request = page.request;

    let publishRequestId: string | null = null;
    try {
      const result = await trpcMutation<SubmitResult>(
        request,
        'appListings.submitExternalListing',
        submitInput(SLUG)
      );
      publishRequestId = result.publishRequestId;
      const listingId = result.listingId;

      // A draft (non-approved) listing is NOT reportable — the report-state gate
      // fires (NOT_REPORTABLE → BAD_REQUEST → HTTP 400; trpcMutation throws).
      await expectRejects(
        trpcMutation(request, 'appListings.reportListing', { appListingId: listingId, reason: 'spam' }),
        'reporting a draft listing must be rejected'
      );

      // A draft is NOT delistable — the status guard (approved-only) fires
      // (NOT_TRANSITIONABLE → BAD_REQUEST). No event is written on the guarded fail.
      await expectRejects(
        trpcMutation(request, 'appListings.delistListing', {
          appListingId: listingId,
          reason: 'ci-smoke delist guard probe',
        }),
        'delisting a draft listing must be rejected'
      );

      // A draft is NOT claimable — the status guard (approved|removed-only) fires
      // (NOT_TRANSITIONABLE → BAD_REQUEST) BEFORE the target-user validation, so this
      // rejects regardless of targetUserId. No event on the guarded fail.
      await expectRejects(
        trpcMutation(request, 'appListings.claimListing', {
          appListingId: listingId,
          targetUserId: 1,
          reason: 'ci-smoke claim guard probe',
        }),
        'claiming a draft listing must be rejected'
      );

      // Claiming a NONEXISTENT listing → the kind/existence guard (generic NOT_FOUND
      // → 404). Also zero events (no such listing to record against).
      await expectRejects(
        trpcMutation(request, 'appListings.claimListing', {
          appListingId: 'apl_ci_nonexistent',
          targetUserId: 1,
          reason: 'ci-smoke claim missing probe',
        }),
        'claiming a nonexistent listing must 404'
      );

      // The guarded failures wrote NO moderation events (zero-event-on-guard).
      const history = await trpcQuery<ModEventList>(request, 'appListings.listModerationEvents', {
        appListingId: listingId,
      });
      expect(history.items, 'a guarded/rejected mutation writes no audit event').toHaveLength(0);
    } finally {
      await withdrawQuietly(request, publishRequestId);
    }
  });

  test('PURGE hard-deletes a listing end-to-end (the self-clean primitive)', async ({ page }) => {
    const SLUG = previewSlug('purge');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const request = page.request;

    let publishRequestId: string | null = null;
    try {
      const result = await trpcMutation<SubmitResult>(
        request,
        'appListings.submitExternalListing',
        submitInput(SLUG)
      );
      publishRequestId = result.publishRequestId;
      const listingId = result.listingId;

      // PURGE succeeds on an off-site listing regardless of status (here: draft) —
      // the mod final-expunge that also makes the delist round-trip self-cleaning.
      const purged = await trpcMutation<{ appListingId: string; purged: boolean }>(
        request,
        'appListings.purgeListing',
        { appListingId: listingId, reason: 'ci-smoke purge cleanup' }
      );
      expect(purged.purged, 'purge returns purged:true').toBe(true);

      // The listing is GONE: a second purge → NOT_FOUND (→ HTTP 404; throws).
      await expectRejects(
        trpcMutation(request, 'appListings.purgeListing', {
          appListingId: listingId,
          reason: 'ci-smoke purge again',
        }),
        're-purging a deleted listing must 404'
      );
    } finally {
      // The submit's publish request is now an orphan (appListingId SET NULL by the
      // purge). Flip it out of the pending queue so nothing lingers.
      await withdrawQuietly(request, publishRequestId);
    }
  });
});

test.describe('App Blocks P3b PR3: mod actions are moderator-only (tester denied)', () => {
  test.use({ storageState: storageStatePath('tester') });

  test('a non-mod is FORBIDDEN on every mod action + read', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const request = page.request;

    // Every mutating mod action → FORBIDDEN (moderatorProcedure; HTTP 403 → throws).
    // Schema-valid throwaway ids: the middleware denies before the resolver runs.
    await expectRejects(
      trpcMutation(request, 'appListings.delistListing', {
        appListingId: 'apl_ci_authz',
        reason: 'ci authz probe reason',
      }),
      'tester delist must be forbidden'
    );
    await expectRejects(
      trpcMutation(request, 'appListings.relistListing', {
        appListingId: 'apl_ci_authz',
        reason: 'ci authz probe reason',
      }),
      'tester relist must be forbidden'
    );
    await expectRejects(
      trpcMutation(request, 'appListings.claimListing', {
        appListingId: 'apl_ci_authz',
        targetUserId: 1,
        reason: 'ci authz probe reason',
      }),
      'tester claim must be forbidden (mod-only is the whole boundary; no self-claim)'
    );
    await expectRejects(
      trpcMutation(request, 'appListings.purgeListing', {
        appListingId: 'apl_ci_authz',
        reason: 'ci authz probe reason',
      }),
      'tester purge must be forbidden'
    );
    await expectRejects(
      trpcMutation(request, 'appListings.resolveReport', { reportId: 'alrp_ci_authz' }),
      'tester resolveReport must be forbidden'
    );
    await expectRejects(
      trpcMutation(request, 'appListings.dismissReport', { reportId: 'alrp_ci_authz' }),
      'tester dismissReport must be forbidden'
    );

    // The mod-only READS (report queue + moderation history) are likewise denied.
    await expectRejects(
      trpcQuery(request, 'appListings.listListingReports', {}),
      'tester listListingReports must be forbidden'
    );
    await expectRejects(
      trpcQuery(request, 'appListings.listModerationEvents', { appListingId: 'apl_ci_authz' }),
      'tester listModerationEvents must be forbidden'
    );
  });
});

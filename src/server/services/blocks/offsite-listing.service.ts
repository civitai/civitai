import { TRPCError } from '@trpc/server';

import { dbRead, dbWrite } from '~/server/db/client';
import {
  assertNoOnPlatformSurface,
  validateExternalUrl,
} from '~/server/schema/blocks/external-app.schema';
import {
  OFFSITE_CONTENT_RATINGS,
  OFFSITE_REJECTION_REASON_MAX,
  OFFSITE_REJECTION_REASON_MIN,
  type PersistListingAssetImageInput,
  type SubmitExternalListingInput,
} from '~/server/schema/blocks/offsite-listing.schema';
import { assertListingAssetsComplete } from '~/server/services/blocks/app-listing-assets.service';
import { isMarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import { newAppListingId, newAppListingPublishRequestId } from '~/server/utils/app-block-ids';

/**
 * App Store Listings (W13) — P3a OFF-SITE submission service (Design B1).
 *
 * The author-facing submit / withdraw / my-submissions surface for a pure
 * external-link off-site app, plus the mod-facing read-only review-queue lists.
 * The mirror of the on-site `publish-request.service` state machine, but over the
 * `AppListingPublishRequest` + `AppListing` tables (no bundle / build / deploy).
 *
 * DESIGN B1 (locked): `submitExternalListing` creates, in ONE transaction, a
 * DRAFT `AppListing(kind='offsite', status='draft')` PLUS a `pending`
 * `AppListingPublishRequest(kind='offsite', appListingId=<draft id>)`. The draft
 * lets the author reuse the P1 asset CRUD (owner-gated) to attach icon/cover/
 * screenshots before approval; the read path hides non-approved rows, so a draft
 * never surfaces in the store. Slug-squat protection is FREE from
 * `AppListing.slug @unique` (no pending-per-slug partial-unique migration).
 *
 * TERMINAL cleanup: `withdrawExternalRequest` DELETES the draft `AppListing`
 * (releasing the slug + cascading its screenshots). Approve/reject (PR-b) are NOT
 * in this PR.
 *
 * DARK: submit/withdraw/my-submissions are gated by `app-blocks-author` (mods +
 * app-dev-testers) at the router; the queue lists are `moderatorProcedure`.
 * Nothing renders any UI in PR-a.
 */

// ---------------------------------------------------------------------------
// Typed failure modes for withdrawExternalRequest (mirror WithdrawRequestError).
// ---------------------------------------------------------------------------

export type OffsiteRequestErrorCode = 'NOT_FOUND' | 'NOT_OWNED' | 'NOT_PENDING';

export class OffsiteRequestError extends Error {
  readonly code: OffsiteRequestErrorCode;
  constructor(code: OffsiteRequestErrorCode, message: string) {
    super(message);
    this.name = 'OffsiteRequestError';
    this.code = code;
  }
}

/** Friendly, deterministic slug-collision error (pre-check + P2002-race branch). */
function slugTakenError(slug: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message: `slug "${slug}" already taken` });
}

/**
 * Per-user cap on OUTSTANDING (`pending`) off-site submissions. Drafts only clear
 * on withdraw/reject (no TTL), so an unbounded submit rate would let one author
 * accrue orphan drafts + squat slugs; this bounds the standing count (the router
 * `rateLimit` bounds the submit RATE). Mods bypass the router rate-limit but are
 * still subject to this cap.
 */
export const MAX_PENDING_OFFSITE_SUBMISSIONS = 10;

// ---------------------------------------------------------------------------
// submitExternalListing (author).
// ---------------------------------------------------------------------------

export type SubmitExternalListingResult = {
  listingId: string;
  publishRequestId: string;
  slug: string;
};

/**
 * Create a DRAFT off-site listing + a pending publish request in one transaction.
 *
 * Owner-binding (IDOR): both the `AppListing.userId` and the
 * `AppListingPublishRequest.submittedByUserId` are set from the AUTHENTICATED
 * caller (`userId`) — the input carries NO owner field, so a caller can never
 * submit on another user's behalf.
 *
 * Slug collision: pre-checked against BOTH `AppListing.slug` (unique across both
 * kinds) AND an existing `AppBlock.block_id` (an on-site slug), then backstopped
 * inside the tx — the `AppListing.slug @unique` constraint (P2002) closes the
 * AppListing check→create race, and a PRIMARY re-read of `AppBlock.block_id`
 * closes the (constraint-less) block-id replica-lag window. Every path → the SAME
 * friendly `slug "X" already taken`.
 *
 * Abuse bounds: a per-user cap on OUTSTANDING pending submissions
 * ({@link MAX_PENDING_OFFSITE_SUBMISSIONS}) bounds standing orphan-draft accrual
 * (drafts have no TTL); the router adds a submit-RATE limit.
 */
export async function submitExternalListing(opts: {
  input: SubmitExternalListingInput;
  userId: number;
}): Promise<SubmitExternalListingResult> {
  const { input, userId } = opts;

  // Defense-in-depth: re-run the shared URL + surface validators (this fn is
  // exported and unit-tested directly, not only reached through the schema).
  const url = validateExternalUrl(input.externalUrl);
  if (!url.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: url.error });
  const surface = assertNoOnPlatformSurface({
    page: input.page,
    targets: input.targets,
    iframe: input.iframe,
  });
  if (!surface.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: surface.error });

  if (input.category != null && !isMarketplaceCategory(input.category)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `unknown category "${input.category}"` });
  }

  // Re-assert the author-declared maturity against the shared enum (this fn is
  // exported + unit-tested directly, so mirror the URL/surface/category re-checks
  // rather than trusting the caller). Absent → the SFW `'g'` default below.
  const contentRating = input.contentRating ?? 'g';
  if (!(OFFSITE_CONTENT_RATINGS as readonly string[]).includes(contentRating)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `unknown content rating "${contentRating}"`,
    });
  }

  // Per-user pending-submission cap: bound the standing orphan-draft count (drafts
  // only clear on withdraw/reject, no TTL). At/over the cap → TOO_MANY_REQUESTS.
  const pendingCount = await dbRead.appListingPublishRequest.count({
    where: { submittedByUserId: userId, kind: 'offsite', status: 'pending' },
  });
  if (pendingCount >= MAX_PENDING_OFFSITE_SUBMISSIONS) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `You have ${pendingCount} pending submissions (max ${MAX_PENDING_OFFSITE_SUBMISSIONS}). Withdraw one or wait for review before submitting another.`,
    });
  }

  const slug = input.slug;

  // Pre-check both the store slug (both kinds) and an on-site block id so the
  // author gets a friendly error rather than a raw constraint violation.
  const existingListing = await dbRead.appListing.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (existingListing) throw slugTakenError(slug);
  const existingBlock = await dbRead.appBlock.findFirst({
    where: { blockId: slug },
    select: { id: true },
  });
  if (existingBlock) throw slugTakenError(slug);

  const listingId = newAppListingId();
  const publishRequestId = newAppListingPublishRequestId();

  try {
    await dbWrite.$transaction(async (tx) => {
      // Cross-kind block_id collision — PRIMARY re-check. The AppListing.slug
      // pre-check is backstopped by its @unique (P2002), but AppBlock.block_id
      // has no such constraint against AppListing, so its replica pre-check above
      // has a lag window. Re-read from the PRIMARY inside the tx to close it —
      // same friendly `slug "X" already taken`.
      const blockOnPrimary = await tx.appBlock.findFirst({
        where: { blockId: slug },
        select: { id: true },
      });
      if (blockOnPrimary) throw slugTakenError(slug);

      await tx.appListing.create({
        data: {
          id: listingId,
          kind: 'offsite',
          status: 'draft',
          slug,
          name: input.name,
          tagline: input.tagline ?? null,
          description: input.description ?? null,
          category: input.category ?? null,
          // Author-declared, re-asserted against the enum above; defaults to SFW
          // so an omitted rating is never mature.
          contentRating,
          externalUrl: url.url,
          // External-link sub-kind only — the OAuth-connect seam stays inert.
          connectClientId: null,
          // A natively-created off-site listing has no backing AppBlock.
          appBlockId: null,
          userId,
        },
      });
      await tx.appListingPublishRequest.create({
        data: {
          id: publishRequestId,
          appListingId: listingId,
          kind: 'offsite',
          slug,
          submittedByUserId: userId,
          status: 'pending',
          changelog: input.changelog ?? null,
        },
      });
    });
  } catch (err) {
    // Lost the check→create race (or a slug the pre-check missed): the
    // AppListing.slug @unique fires P2002. Collapse to the same friendly error.
    if ((err as { code?: unknown })?.code === 'P2002') throw slugTakenError(slug);
    throw err;
  }

  return { listingId, publishRequestId, slug };
}

// ---------------------------------------------------------------------------
// withdrawExternalRequest (author) — mirror publish-request.service withdrawRequest.
// ---------------------------------------------------------------------------

/**
 * Author-initiated, terminal withdrawal of their OWN pending off-site request.
 * Idempotent (re-withdrawing an already-withdrawn row is a no-op success). Throws
 * a typed {@link OffsiteRequestError} on a missing row, another user's row, or a
 * non-`pending` row.
 *
 * Deletes the DRAFT `AppListing` on success (B1) so the slug is released and no
 * orphan draft accrues; the delete is status-guarded (`status:'draft'`) so it can
 * never remove an approved listing.
 *
 * CONCURRENCY (TOCTOU): the `findUnique` only CLASSIFIES; the mutation is a
 * status-guarded `updateMany({ id, status:'pending' })`, so a withdraw that read
 * `pending` can't clobber a row a concurrent approve flipped. If the guarded
 * write matches 0 rows despite the earlier pending classification, we re-read
 * from the PRIMARY and resolve: now `withdrawn` → idempotent success; now
 * `approved`/`rejected` → NOT_PENDING. Mirrors `withdrawRequest`
 * (publish-request.service.ts).
 */
export async function withdrawExternalRequest(opts: {
  publishRequestId: string;
  userId: number;
}): Promise<void> {
  const { publishRequestId, userId } = opts;

  const row = await dbRead.appListingPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: { id: true, status: true, submittedByUserId: true, appListingId: true },
  });
  if (!row) {
    throw new OffsiteRequestError('NOT_FOUND', `publish request ${publishRequestId} not found`);
  }
  if (row.submittedByUserId !== userId) {
    throw new OffsiteRequestError('NOT_OWNED', 'you can only withdraw your own publish requests');
  }
  if (row.status === 'withdrawn') return;
  if (row.status !== 'pending') {
    throw new OffsiteRequestError(
      'NOT_PENDING',
      `cannot withdraw a request in status ${row.status}`
    );
  }

  // Status-guarded write: only flip a STILL-`pending` row (closes the TOCTOU
  // window against a concurrent approve).
  const { count } = await dbWrite.appListingPublishRequest.updateMany({
    where: { id: publishRequestId, status: 'pending' },
    data: { status: 'withdrawn' },
  });
  if (count > 0) {
    await deleteDraftListing(row.appListingId);
    return;
  }

  // Raced: re-read from the PRIMARY (a replica read could be lag-stale and still
  // report `pending`) to decide the authoritative outcome.
  const after = await dbWrite.appListingPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: { status: true },
  });
  if (!after || after.status === 'withdrawn') {
    // Raced into withdrawn (or vanished) → idempotent success. The concurrent
    // withdraw owns the draft cleanup, so we do NOT re-delete here.
    return;
  }
  // Raced into approved/rejected → the not-pending guarantee, now true under
  // concurrency.
  throw new OffsiteRequestError(
    'NOT_PENDING',
    `cannot withdraw a request in status ${after.status}`
  );
}

/**
 * Delete a still-DRAFT off-site listing (releases the slug; cascades its
 * screenshots via `onDelete: Cascade`). Status-guarded so an approved listing is
 * never removed; no-op when the request had no linked listing. Accepts an optional
 * transaction client so the caller can make the flip + delete atomic (reject);
 * defaults to `dbWrite` (autocommit) for withdraw.
 */
async function deleteDraftListing(
  appListingId: string | null,
  client: Pick<typeof dbWrite, 'appListing'> = dbWrite
): Promise<void> {
  if (!appListingId) return;
  await client.appListing.deleteMany({ where: { id: appListingId, status: 'draft' } });
}

// ---------------------------------------------------------------------------
// approveExternalRequest / rejectExternalRequest (moderator) — PR-b.
//
// Mirror the on-site `publish-request.service` approve/reject state machine over
// the `AppListingPublishRequest` + `AppListing` tables (no bundle / build /
// deploy). Approve flips the DRAFT listing → approved (the read path then
// surfaces it in the store); reject DELETES the draft (releases the slug). Both
// writes are status-guarded `updateMany`/`deleteMany` so a concurrent
// approve/reject/withdraw can never double-act (TOCTOU).
// ---------------------------------------------------------------------------

export type ApproveExternalRequestResult = {
  publishRequestId: string;
  listingId: string;
  slug: string;
};

/**
 * MOD approve of a pending off-site request. Loads the request + its draft
 * `AppListing`, asserts `pending`, and enforces two gates BEFORE any mutation:
 *
 *   1. {@link assertListingAssetsComplete} — **THE P3 ACTIVATION.** Approve FAILS
 *      `BAD_REQUEST { missing }` unless the draft has an icon AND a cover AND ≥1
 *      screenshot (a screenshot whose backing Image was deleted — `imageId` null
 *      — does NOT count, mirroring `getListingAssets`' completeness math). This is
 *      the intended live wiring of the dark P1 gate.
 *   2. `validateExternalUrl` on the STORED `externalUrl` (defense-in-depth — a
 *      somehow-bad stored value blocks approve; the card link opens in the user's
 *      browser, so a non-https stored URL must never reach the store).
 *
 * The asset gate is a CHEAP FAIL-FAST on the replica; it is RE-ASSERTED
 * authoritatively on the PRIMARY inside the tx (row-consistent with the flip) —
 * the sibling asset mutators write to `dbWrite`, so under replica lag the replica
 * gate could otherwise pass on stale-complete state.
 *
 * Then, in ONE transaction: re-assert the asset+URL gate on the primary, flip the
 * request `pending → approved` (status-guarded TOCTOU), flip the listing
 * `draft → approved` (status-guarded), and supersede any sibling pending request
 * for the same slug (parity with the on-site approve).
 *
 * NOTE (self-approve): v1 deliberately ALLOWS a moderator to approve their OWN
 * submission (reviewer == submitter) — this enables single-mod dogfooding + the
 * approve e2e, and mods are trusted. A reviewer≠submitter restriction is DEFERRED
 * to GA / P3b hardening (alongside report → verify-ownership → delist/claim). Do
 * NOT add a self-approve block here without that product decision.
 */
export async function approveExternalRequest(opts: {
  publishRequestId: string;
  reviewerUserId: number;
  approvalNotes?: string | null;
}): Promise<ApproveExternalRequestResult> {
  const { publishRequestId, reviewerUserId } = opts;
  const approvalNotes = opts.approvalNotes ?? null;

  // (1) Classify: an off-site + pending request pointing at a draft listing.
  const request = await dbRead.appListingPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: { id: true, status: true, kind: true, slug: true, appListingId: true },
  });
  if (!request) {
    throw new OffsiteRequestError('NOT_FOUND', `publish request ${publishRequestId} not found`);
  }
  if (request.kind !== 'offsite') {
    throw new OffsiteRequestError(
      'NOT_FOUND',
      `publish request ${publishRequestId} is not an off-site request`
    );
  }
  if (request.status !== 'pending') {
    throw new OffsiteRequestError(
      'NOT_PENDING',
      `cannot approve a request in status ${request.status}`
    );
  }
  if (!request.appListingId) {
    throw new OffsiteRequestError(
      'NOT_FOUND',
      `publish request ${publishRequestId} has no draft listing`
    );
  }
  // Narrow once for the tx closures below (findUnique needs a non-null id).
  const appListingId = request.appListingId;

  // (2) CHEAP PRE-TX FAIL-FAST on the replica: load the draft listing + count its
  // REAL (imageId-bearing) screenshots so an obviously-incomplete listing is
  // rejected before we open a transaction. This is NOT authoritative — the
  // AUTHORITATIVE gate re-reads the PRIMARY inside the tx below (the sibling asset
  // mutators write to dbWrite, so under replica lag this replica read can be
  // stale-complete). See step (5).
  const listing = await dbRead.appListing.findUnique({
    where: { id: appListingId },
    select: { id: true, status: true, externalUrl: true, iconId: true, coverId: true },
  });
  if (!listing) {
    throw new OffsiteRequestError('NOT_FOUND', `draft listing ${appListingId} not found`);
  }
  const screenshotCount = await dbRead.appListingScreenshot.count({
    where: { appListingId, imageId: { not: null } },
  });

  // (3) THE P3 ACTIVATION — mandatory-asset gate (throws BAD_REQUEST { missing }).
  // Fail-fast copy on the replica; re-asserted authoritatively on the primary in (5).
  assertListingAssetsComplete({
    iconId: listing.iconId,
    coverId: listing.coverId,
    screenshotCount,
  });

  // (4) Defense-in-depth: re-validate the STORED externalUrl before it can reach
  // the store (mirrors submit + the read-path `safeExternalUrl`). Also re-checked
  // on the primary inside the tx.
  const url = validateExternalUrl(listing.externalUrl);
  if (!url.ok) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `stored externalUrl is invalid and cannot be approved: ${url.error}`,
    });
  }

  // (5) One transaction: RE-ASSERT the asset gate on the PRIMARY (row-consistent
  // with the flip) + guarded request flip + guarded listing flip + supersede.
  await dbWrite.$transaction(async (tx) => {
    // AUTHORITATIVE asset gate — re-read from the PRIMARY (`tx`), not the replica.
    // The sibling asset mutators (add/reorder/removeListingScreenshot,
    // setListingIcon/Cover) deliberately read+write dbWrite to avoid replica-lag
    // races, so under lag + a concurrent owner asset-edit the pre-tx replica gate
    // in (3) can pass on stale-complete state. Re-reading iconId/coverId + the
    // imageId-bearing screenshot count via `tx` (and re-validating the stored URL)
    // makes the security-relevant gate row-consistent with the status flip below;
    // any failure rolls the whole tx back BEFORE anything is flipped.
    const primaryListing = await tx.appListing.findUnique({
      where: { id: appListingId },
      select: { externalUrl: true, iconId: true, coverId: true },
    });
    if (!primaryListing) {
      throw new OffsiteRequestError('NOT_FOUND', `draft listing ${appListingId} not found`);
    }
    const primaryScreenshotCount = await tx.appListingScreenshot.count({
      where: { appListingId, imageId: { not: null } },
    });
    assertListingAssetsComplete({
      iconId: primaryListing.iconId,
      coverId: primaryListing.coverId,
      screenshotCount: primaryScreenshotCount,
    });
    const primaryUrl = validateExternalUrl(primaryListing.externalUrl);
    if (!primaryUrl.ok) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `stored externalUrl is invalid and cannot be approved: ${primaryUrl.error}`,
      });
    }

    const req = await tx.appListingPublishRequest.updateMany({
      where: { id: publishRequestId, status: 'pending' },
      data: {
        status: 'approved',
        reviewedByUserId: reviewerUserId,
        reviewedAt: new Date(),
        approvalNotes,
      },
    });
    if (req.count === 0) {
      // Lost the TOCTOU race to a concurrent withdraw/reject/approve — the whole
      // tx rolls back.
      throw new OffsiteRequestError(
        'NOT_PENDING',
        `cannot approve — the request is no longer pending`
      );
    }
    const flipped = await tx.appListing.updateMany({
      where: { id: appListingId, status: 'draft' },
      data: { status: 'approved' },
    });
    if (flipped.count === 0) {
      // The draft was concurrently deleted / already flipped — abort (rolls back
      // the request flip) rather than approve a request whose listing is gone.
      throw new OffsiteRequestError(
        'NOT_PENDING',
        `cannot approve — the draft listing is no longer available`
      );
    }
    // Supersede any OTHER pending off-site request for this slug (parity with the
    // on-site approve). With `AppListing.slug @unique` a sibling draft can't exist,
    // so this is a rarely-non-empty safety net; scoped to NOT touch the approved
    // row.
    await tx.appListingPublishRequest.updateMany({
      where: {
        slug: request.slug,
        status: 'pending',
        kind: 'offsite',
        NOT: { id: publishRequestId },
      },
      data: { status: 'withdrawn' },
    });
  });

  return { publishRequestId, listingId: appListingId, slug: request.slug };
}

/**
 * MOD reject of a pending off-site request. Requires a `rejectionReason` of ≥10
 * (trimmed) chars, then — in ONE transaction — flips the request
 * `pending → rejected` + sets `reviewedBy*` / `rejectionReason` and DELETES the
 * draft `AppListing` (status-guarded `deleteMany({ id, status:'draft' })` so it can
 * never remove an approved listing — releases the slug). Wrapping the flip + delete
 * in a single tx means a crash between them can't orphan a hidden `draft` listing
 * that keeps squatting the slug (parity with approve). The flip is a status-guarded
 * `updateMany` so a concurrent approve/withdraw that already flipped the row yields
 * NOT_PENDING (and, having matched 0, the tx rolls back before the delete).
 * Non-pending → NOT_PENDING.
 */
export async function rejectExternalRequest(opts: {
  publishRequestId: string;
  reviewerUserId: number;
  rejectionReason: string;
}): Promise<void> {
  const { publishRequestId, reviewerUserId } = opts;
  const reason = opts.rejectionReason.trim();
  if (reason.length < OFFSITE_REJECTION_REASON_MIN) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `rejection reason must be at least ${OFFSITE_REJECTION_REASON_MIN} characters`,
    });
  }
  if (reason.length > OFFSITE_REJECTION_REASON_MAX) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `rejection reason must be at most ${OFFSITE_REJECTION_REASON_MAX} characters`,
    });
  }

  const request = await dbRead.appListingPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: { id: true, status: true, kind: true, appListingId: true },
  });
  if (!request) {
    throw new OffsiteRequestError('NOT_FOUND', `publish request ${publishRequestId} not found`);
  }
  if (request.kind !== 'offsite') {
    throw new OffsiteRequestError(
      'NOT_FOUND',
      `publish request ${publishRequestId} is not an off-site request`
    );
  }
  if (request.status !== 'pending') {
    throw new OffsiteRequestError(
      'NOT_PENDING',
      `cannot reject a request in status ${request.status}`
    );
  }

  // ONE transaction: status-guarded flip + draft delete, so a crash between them
  // can't orphan a hidden `draft` listing that keeps squatting the slug. The flip
  // is TOCTOU-guarded (`status:'pending'`): a concurrent approve/withdraw that
  // already flipped the row matches 0 → NOT_PENDING (throwing rolls the tx back
  // before any delete); only the winner deletes. The delete is status-guarded
  // (`status:'draft'`) so it can never remove an approved listing.
  await dbWrite.$transaction(async (tx) => {
    const { count } = await tx.appListingPublishRequest.updateMany({
      where: { id: publishRequestId, status: 'pending' },
      data: {
        status: 'rejected',
        reviewedByUserId: reviewerUserId,
        reviewedAt: new Date(),
        rejectionReason: reason,
      },
    });
    if (count === 0) {
      throw new OffsiteRequestError(
        'NOT_PENDING',
        `cannot reject — the request is no longer pending`
      );
    }
    await deleteDraftListing(request.appListingId, tx);
  });
}

// ---------------------------------------------------------------------------
// persistListingAssetImage (author) — asset-step glue for the submit form.
// ---------------------------------------------------------------------------

/**
 * Materialise a CF-uploaded image into an `Image` row (owned by the caller) and
 * return its numeric id, so the submit form's asset step can attach it to the
 * draft listing via the P1 asset-CRUD procs. Kicks off the standard ingestion/scan
 * pipeline (`createImage` with default ingestion) — the P1 attach proc enforces
 * `ingestion === Scanned` + the per-kind image validation, so this proc does NOT
 * re-validate dimensions/mime (it only persists). `createImage` is dynamically
 * imported so the heavy `image.service` module stays out of this service's static
 * graph (mirrors the router's dynamic-import discipline + keeps the unit tests,
 * which mock only `dbRead`/`dbWrite`, light).
 */
export async function persistListingAssetImage(opts: {
  input: PersistListingAssetImageInput;
  userId: number;
}): Promise<{ imageId: number }> {
  const { input, userId } = opts;
  const { createImage } = await import('~/server/services/image.service');
  const image = await createImage({
    url: input.url,
    name: input.name ?? undefined,
    type: 'image',
    width: input.width,
    height: input.height,
    mimeType: input.mimeType,
    // The P1 image validator reads the byte size from `Image.metadata.size`.
    metadata: input.sizeBytes != null ? { size: input.sizeBytes } : undefined,
    userId,
  });
  return { imageId: image.id };
}

// ---------------------------------------------------------------------------
// Read-only lists.
// ---------------------------------------------------------------------------

const submissionSelect = {
  id: true,
  appListingId: true,
  slug: true,
  status: true,
  submittedAt: true,
  reviewedAt: true,
  rejectionReason: true,
  approvalNotes: true,
  changelog: true,
  appListing: {
    select: { name: true, externalUrl: true, category: true, contentRating: true },
  },
} as const;

const submitterChip = { select: { id: true, username: true, image: true } } as const;

export type ListOffsiteRequestsOptions = { limit?: number; cursor?: string };

/**
 * The caller's OWN off-site submissions, newest-first, keyset-paginated. Scoped
 * to `submittedByUserId` — never another user's rows.
 */
export async function listMySubmissions(
  opts: { userId: number } & ListOffsiteRequestsOptions
) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appListingPublishRequest.findMany({
    where: { submittedByUserId: opts.userId, kind: 'offsite' },
    orderBy: { submittedAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: submissionSelect,
  });
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}

/** Mod queue: pending off-site requests, oldest-first (FIFO), keyset-paginated. */
export async function listPendingOffsiteRequests(opts: ListOffsiteRequestsOptions = {}) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appListingPublishRequest.findMany({
    where: { status: 'pending', kind: 'offsite' },
    orderBy: { submittedAt: 'asc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: { ...submissionSelect, submittedBy: submitterChip },
  });
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}

/** Mod history: approved off-site requests, most-recently-reviewed first. */
export async function listApprovedOffsiteRequests(opts: ListOffsiteRequestsOptions = {}) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appListingPublishRequest.findMany({
    where: { status: 'approved', kind: 'offsite' },
    orderBy: { reviewedAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      ...submissionSelect,
      submittedBy: submitterChip,
      reviewedBy: submitterChip,
    },
  });
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}

/** Mod history: rejected off-site requests, most-recently-reviewed first. */
export async function listRejectedOffsiteRequests(opts: ListOffsiteRequestsOptions = {}) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appListingPublishRequest.findMany({
    where: { status: 'rejected', kind: 'offsite' },
    orderBy: { reviewedAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      ...submissionSelect,
      submittedBy: submitterChip,
      reviewedBy: submitterChip,
    },
  });
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}

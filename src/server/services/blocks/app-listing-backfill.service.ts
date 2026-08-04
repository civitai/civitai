import { dbRead, dbWrite } from '~/server/db/client';
// The AppBlock→AppListing mapping is the SINGLE SOURCE OF TRUTH for the listing
// shape, shared with `publish-request.service.approveRequest` (the go-forward
// auto-create-on-approve path) so the two can never drift. Re-exported below so
// existing importers of this module keep resolving the mapper + helpers here.
import {
  mapAppBlockToListing,
  resolveListingDescription,
  resolveListingName,
  type SourceAppBlock,
} from './app-listing-mapper';
import {
  buildActionabilityError,
  checkOffsiteListingActionable,
} from '~/server/services/blocks/app-listing-actionable.service';

export { mapAppBlockToListing, resolveListingDescription, resolveListingName };
export type { SourceAppBlock };

/**
 * App Store Listings (W13) — P0 backfill.
 *
 * Creates one store-facing `AppListing` per existing APPROVED `AppBlock` so the
 * new listing entity is populated before any read path is cut over (P2). Fully
 * DARK: this only writes `app_listings` rows (read by nothing in the running
 * image) and NEVER touches the runtime `app_blocks` rows, the maturity gate, or
 * verify-runner.
 *
 * Two source shapes, one listing model (plan §5/§6):
 *   - on-site  — an `AppBlock` we host (external_url IS NULL) → kind='onsite',
 *                slug = AppBlock.blockId.
 *   - off-site — the #2821 external-link rows (external_url IS NOT NULL) →
 *                kind='offsite', `externalUrl` copied, NO connectClientId.
 *
 * NOTE: BOTH shapes set `appBlockId` — every backfilled row (on-site AND the
 * #2821 off-site rows) originates from an `app_blocks` row, and `appBlockId` is
 * the 1:1 idempotency key. So `appBlockId` is NOT a kind discriminator here:
 * downstream (P2/P3) readers MUST discriminate on the explicit `kind` column,
 * never on `appBlockId IS NULL`. (A future natively-created off-site listing —
 * no backing AppBlock — is what leaves `appBlockId` NULL.)
 *
 * INVARIANTS:
 *   - Idempotent on `appBlockId` (the 1:1 unique). A re-run creates no dupes and
 *     does NOT clobber a listing a creator may have edited (skip, don't update).
 *   - contentRating derives from `AppBlock.contentRating` — the listing is NOT a
 *     second source of truth for the .red/.com maturity/serving gate.
 *   - Assets (icon/cover/screenshots) are left NULL — the mandatory-asset gate +
 *     placeholder generation are P1. This backfill does NOT enforce it.
 *   - Owner = the `AppBlock`'s OauthClient owner (`app.userId`).
 */

export type BackfillAppListingsParams = {
  /** Cap the number of AppBlocks processed (newest-first). Omit = all. */
  limit?: number;
  /** Preview only: compute the plan but write nothing. */
  dryRun?: boolean;
};

export type BackfillAppListingsResult = {
  scanned: number;
  created: number;
  skipped: number; // already had a listing (idempotent re-run) or P2002 concurrent create
  skippedNoOwner: number; // ANOMALY: approved AppBlock with no resolvable owner (surfaced, not hidden)
  dryRun: boolean;
  createdIds: string[];
  byKind: { onsite: number; offsite: number };
  /** Rows that threw a non-P2002 error (per-row isolation — batch continues). */
  failed: { appBlockId: string; error: string }[];
};

export async function backfillAppListings(
  params: BackfillAppListingsParams = {}
): Promise<BackfillAppListingsResult> {
  const { limit, dryRun = false } = params;

  const appBlocks = (await dbRead.appBlock.findMany({
    where: { status: 'approved' },
    select: {
      id: true,
      blockId: true,
      manifest: true,
      contentRating: true,
      category: true,
      featured: true,
      featuredOrder: true,
      externalUrl: true,
      app: { select: { userId: true } },
    },
    orderBy: { createdAt: 'desc' },
    ...(typeof limit === 'number' ? { take: limit } : {}),
  })) as SourceAppBlock[];

  const result: BackfillAppListingsResult = {
    scanned: appBlocks.length,
    created: 0,
    skipped: 0,
    skippedNoOwner: 0,
    dryRun,
    createdIds: [],
    byKind: { onsite: 0, offsite: 0 },
    failed: [],
  };

  for (const ab of appBlocks) {
    // Skip an AppBlock with no resolvable owner — a listing needs an owner FK.
    // (Every approved AppBlock has an OauthClient owner; this is a defensive
    // guard, not an expected path.)
    if (!ab.app || typeof ab.app.userId !== 'number') {
      result.skippedNoOwner += 1;
      continue;
    }

    // Idempotency: skip if a listing already exists for this AppBlock. Don't
    // update — a re-run must not clobber creator edits.
    const existing = await dbRead.appListing.findUnique({
      where: { appBlockId: ab.id },
      select: { id: true },
    });
    if (existing) {
      result.skipped += 1;
      continue;
    }

    const data = mapAppBlockToListing(ab);

    // 🔴 GO-LIVE ACTIONABILITY gate. `mapAppBlockToListing` hardcodes
    // `status: 'approved'`, so every row this loop writes is minted DIRECTLY LIVE —
    // this is a go-live path, not merely a data migration. It also derives
    // `kind: 'offsite'` from a merely NON-EMPTY `externalUrl`, with no https
    // requirement, while the public projection null-guards anything that is not
    // https. An AppBlock carrying e.g. an `http://` URL therefore mints an approved
    // off-site listing whose store CTA renders "Unavailable" with no link — the
    // exact defect class this gate exists to stop, arrived at from a different
    // direction than the connect stub.
    //
    // PER-ROW ISOLATION, not a batch abort: one unpublishable block must not wedge
    // every other block on every re-run, so the failure is collected as a per-row
    // diagnostic exactly like the poison-row handling below. Runs BEFORE the dryRun
    // branch so a preview reports the same verdict the real run would produce.
    const actionable = checkOffsiteListingActionable(data);
    if (!actionable.ok) {
      result.failed.push({
        appBlockId: ab.id,
        error: buildActionabilityError(data.slug, actionable.action),
      });
      continue;
    }

    if (dryRun) {
      result.created += 1;
      result.byKind[data.kind as 'onsite' | 'offsite'] += 1;
      continue;
    }

    try {
      const row = await dbWrite.appListing.create({ data, select: { id: true } });
      result.created += 1;
      result.createdIds.push(row.id);
      result.byKind[data.kind as 'onsite' | 'offsite'] += 1;
    } catch (err) {
      // P2002 = unique violation on appBlockId (a concurrent run beat us).
      // Treat as skipped, not an error — the invariant (one listing per app)
      // still holds. Duck-type on the Prisma error `code` (no `instanceof`, so it
      // typechecks without the generated client and matches the P2002 handling in
      // publish-request.service).
      const code = (err as { code?: unknown })?.code;
      if (code === 'P2002') {
        result.skipped += 1;
        continue;
      }
      // Per-row isolation: a poison row (an out-of-domain contentRating hitting
      // the CHECK, a dangling FK, etc.) must NOT abort the whole batch — collect
      // it and continue so one bad recent block can't wedge every older block on
      // every re-run. The moderator gets a per-row diagnostic instead of a 500.
      result.failed.push({
        appBlockId: ab.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

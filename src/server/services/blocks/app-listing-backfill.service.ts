import { Prisma } from '@prisma/client';

import { dbRead, dbWrite } from '~/server/db/client';
import { newAppListingId } from '~/server/utils/app-block-ids';

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
  skipped: number; // already had a listing (idempotent re-run)
  dryRun: boolean;
  createdIds: string[];
  byKind: { onsite: number; offsite: number };
  /** Rows that threw a non-P2002 error (per-row isolation — batch continues). */
  failed: { appBlockId: string; error: string }[];
};

type SourceAppBlock = {
  id: string;
  blockId: string;
  manifest: unknown;
  contentRating: string;
  category: string | null;
  featured: boolean;
  featuredOrder: number | null;
  externalUrl: string | null;
  app: { userId: number } | null;
};

/**
 * Extract a display name from the block manifest, mirroring the marketplace's
 * own fallback (user-app-surface.service): manifest.name if a non-empty string,
 * else the slug (blockId).
 */
export function resolveListingName(manifest: unknown, blockId: string): string {
  const m = (manifest ?? {}) as { name?: unknown };
  return typeof m.name === 'string' && m.name.trim().length > 0 ? m.name : blockId;
}

/** Extract an optional description from the manifest (null when absent). */
export function resolveListingDescription(manifest: unknown): string | null {
  const m = (manifest ?? {}) as { description?: unknown };
  return typeof m.description === 'string' && m.description.length > 0 ? m.description : null;
}

/**
 * Pure mapping from an approved AppBlock to the AppListing create payload.
 * Requires a resolved owner (`app.userId`) — the caller (`backfillAppListings`)
 * guards the null-owner case; a missing owner here is misuse, so throw loudly
 * rather than silently minting an invalid `userId` that would fail the FK.
 */
export function mapAppBlockToListing(ab: SourceAppBlock): Prisma.AppListingUncheckedCreateInput {
  if (!ab.app || typeof ab.app.userId !== 'number') {
    throw new Error(`mapAppBlockToListing: AppBlock ${ab.id} has no resolvable owner`);
  }
  const isOffsite = typeof ab.externalUrl === 'string' && ab.externalUrl.length > 0;
  return {
    id: newAppListingId(),
    kind: isOffsite ? 'offsite' : 'onsite',
    slug: ab.blockId,
    name: resolveListingName(ab.manifest, ab.blockId),
    description: resolveListingDescription(ab.manifest),
    // Assets are P1 — left NULL here (no mandatory-asset enforcement in P0).
    iconId: null,
    coverId: null,
    category: ab.category,
    status: 'approved',
    // Single source of truth: mirror the runtime AppBlock rating.
    contentRating: ab.contentRating,
    // Off-site external-link target; NULL for on-site. No OAuth-connect in the
    // backfill (#2821 rows are pure external-link).
    externalUrl: isOffsite ? ab.externalUrl : null,
    connectClientId: null,
    appBlockId: ab.id,
    featured: ab.featured,
    featuredOrder: ab.featuredOrder,
    userId: ab.app.userId,
  };
}

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
      result.skipped += 1;
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
      // still holds.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
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

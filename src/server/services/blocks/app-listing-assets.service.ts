import { TRPCError } from '@trpc/server';
import { randomUUID } from 'crypto';

import { dbRead, dbWrite } from '~/server/db/client';
import { newAppListingScreenshotId } from '~/server/utils/app-block-ids';
import {
  MAX_LISTING_SCREENSHOTS,
  validateListingImage,
  type ListingAssetKind,
} from '~/server/schema/blocks/app-listing.schema';
import type { SessionUser } from '~/types/session';

/**
 * App Store Listings (W13) — P1 asset pipeline service.
 *
 * Two halves, both DARK/additive (no live read path or UI in P1):
 *
 *   1. Creator asset management (owner/mod-gated): attach ALREADY-ingested
 *      `Image` rows (uploaded via the site's standard media path) to an
 *      `AppListing` as icon / cover / ordered screenshots, with per-kind
 *      validation (see app-listing.schema `validateListingImage`) and a
 *      contiguously-maintained `order` column + the ≤8 screenshot cap.
 *
 *   2. Mod-only placeholder backfill: for approved listings missing assets,
 *      populate REAL stored `Image` rows so the mandatory-asset gate
 *      (`assertListingAssetsComplete`) passes universally (locked decision §6.1
 *      "auto-generate placeholders — no grandfather branch"). Screenshots prefer
 *      migrating the backing `AppBlock.screenshots` (bundle MinIO) → Image rows,
 *      else verify-runner autogen, else an SVG placeholder; cover = the first
 *      screenshot's Image; icon = a deterministic category-glyph SVG→PNG.
 *
 * The gate helper is defined + exported here but NOT wired into any live approval
 * path in P1 (that is P3) — it is pure and unit-tested only.
 */

// ---------------------------------------------------------------------------
// Mandatory-asset gate (pure — defined + tested in P1, wired to approve in P3).
// ---------------------------------------------------------------------------

export type ListingAssetCompleteness = {
  iconId: number | null;
  coverId: number | null;
  screenshotCount: number;
};

export type MissingAsset = 'icon' | 'cover' | 'screenshots';

export type ListingAssetsCompleteResult =
  | { complete: true }
  | { complete: false; missing: MissingAsset[] };

/**
 * Pure completeness check: a listing is asset-complete when it has an icon AND a
 * cover AND at least one screenshot. Returns the structured set of what's
 * missing (never throws) so a caller can build a precise error. This is the gate
 * P3 will enforce at approve; in P1 it is dark (exported + tested only).
 */
export function checkListingAssetsComplete(
  listing: ListingAssetCompleteness
): ListingAssetsCompleteResult {
  const missing: MissingAsset[] = [];
  if (listing.iconId == null) missing.push('icon');
  if (listing.coverId == null) missing.push('cover');
  if (!(listing.screenshotCount > 0)) missing.push('screenshots');
  return missing.length === 0 ? { complete: true } : { complete: false, missing };
}

/**
 * Throwing wrapper around {@link checkListingAssetsComplete} for the future
 * approve gate. NOT called on any live path in P1.
 */
export function assertListingAssetsComplete(listing: ListingAssetCompleteness): void {
  const result = checkListingAssetsComplete(listing);
  if (!result.complete) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Listing is missing required assets: ${result.missing.join(', ')}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Off-site icon prefill helper (tiny pure helper; the off-site CREATION flow is
// P3 — this only normalises an OauthClient.logoUrl into a usable http(s) URL).
// ---------------------------------------------------------------------------

/**
 * Pick a usable icon-prefill URL from an off-site app's `OauthClient.logoUrl`.
 * Returns the trimmed https/http URL or null (a dev can replace it later). Pure;
 * the actual ingest of the URL into an Image lands with the P3 off-site flow.
 */
export function pickLogoPrefillUrl(logoUrl: string | null | undefined): string | null {
  if (typeof logoUrl !== 'string') return null;
  const trimmed = logoUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Deterministic SVG placeholder builders (pure — unit-tested; rasterised to PNG
// by the impure default deps below via sharp).
// ---------------------------------------------------------------------------

/** Category → glyph letter/emoji-free monogram seed (kept ASCII for the SVG). */
const CATEGORY_GLYPH: Record<string, string> = {
  generation: '✦',
  games: '◆',
  utility: '⚙',
  discovery: '◈',
  moderation: '⛨',
  analytics: '▤',
  other: '●',
};

/** FNV-1a → a stable 0..359 hue from a seed string (deterministic per slug). */
export function seededHue(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % 360;
}

/** The app's display initial (first alphanumeric of name, else slug), uppercased. */
export function appInitial(name: string, slug: string): string {
  // A whitespace-only name must fall through to the slug (not resolve to '?').
  const src = (name?.trim() || slug?.trim() || '?').trim();
  const m = src.match(/[A-Za-z0-9]/);
  return (m ? m[0] : '?').toUpperCase();
}

function gradientDefs(seed: string): { hue: number; hue2: number } {
  const hue = seededHue(seed);
  const hue2 = (hue + 40) % 360;
  return { hue, hue2 };
}

/** Escape the few chars that are unsafe inside SVG text content. */
function svgEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Deterministic square icon SVG: a diagonal gradient (hue seeded by slug/
 * category) with the app's initial centered. Mirrors the marketplace coverless-
 * card look (gradient + glyph) so generated + real assets feel consistent.
 */
export function buildPlaceholderIconSvg(args: {
  slug: string;
  category: string | null;
  name: string;
  size?: number;
}): string {
  const size = args.size ?? 512;
  const seed = `${args.category ?? 'other'}:${args.slug}`;
  const { hue, hue2 } = gradientDefs(seed);
  const initial = svgEscape(appInitial(args.name, args.slug));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0%" stop-color="hsl(${hue} 55% 42%)"/>`,
    `<stop offset="100%" stop-color="hsl(${hue2} 60% 22%)"/>`,
    `</linearGradient></defs>`,
    `<rect width="${size}" height="${size}" rx="${Math.round(size * 0.18)}" fill="url(#g)"/>`,
    `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="700" font-size="${Math.round(size * 0.5)}" fill="#ffffff" fill-opacity="0.92">${initial}</text>`,
    `</svg>`,
  ].join('');
}

/**
 * Deterministic landscape cover/screenshot SVG placeholder: same seeded gradient
 * with a category glyph + the app name. Used as the cover/screenshot fallback
 * when no real screenshot can be produced (off-site rows, autogen failures).
 */
export function buildPlaceholderCoverSvg(args: {
  slug: string;
  category: string | null;
  name: string;
  width?: number;
  height?: number;
}): string {
  const width = args.width ?? 1280;
  const height = args.height ?? 720;
  const seed = `${args.category ?? 'other'}:${args.slug}`;
  const { hue, hue2 } = gradientDefs(seed);
  const glyph = svgEscape(CATEGORY_GLYPH[args.category ?? 'other'] ?? CATEGORY_GLYPH.other);
  const name = svgEscape((args.name || args.slug).slice(0, 48));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0%" stop-color="hsl(${hue} 45% 32%)"/>`,
    `<stop offset="100%" stop-color="hsl(${hue2} 50% 16%)"/>`,
    `</linearGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="url(#g)"/>`,
    `<text x="50%" y="44%" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="${Math.round(height * 0.22)}" fill="#ffffff" fill-opacity="0.85">${glyph}</text>`,
    `<text x="50%" y="66%" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="600" font-size="${Math.round(height * 0.07)}" fill="#ffffff" fill-opacity="0.9">${name}</text>`,
    `</svg>`,
  ].join('');
}

// ---------------------------------------------------------------------------
// Owner/mod authorization helpers.
// ---------------------------------------------------------------------------

type OwnedListing = {
  id: string;
  kind: string;
  slug: string;
  name: string;
  category: string | null;
  userId: number;
  iconId: number | null;
  coverId: number | null;
};

/**
 * Load a listing and assert the caller owns it (or is a moderator). Throws
 * NOT_FOUND for a missing listing, FORBIDDEN for a non-owner non-mod.
 */
async function loadOwnedListing(listingId: string, user: SessionUser): Promise<OwnedListing> {
  const listing = await dbRead.appListing.findUnique({
    where: { id: listingId },
    select: {
      id: true,
      kind: true,
      slug: true,
      name: true,
      category: true,
      userId: true,
      iconId: true,
      coverId: true,
    },
  });
  if (!listing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Listing not found' });
  if (listing.userId !== user.id && !user.isModerator) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this listing' });
  }
  return listing;
}

/**
 * Load an Image, assert the caller owns it (or is a mod), and validate it for
 * the given asset kind. Returns the imageId once validated.
 */
async function loadValidatedImage(
  imageId: number,
  kind: ListingAssetKind,
  user: SessionUser
): Promise<number> {
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: { id: true, userId: true, type: true, width: true, height: true, mimeType: true, metadata: true },
  });
  if (!image) throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found' });
  if (image.userId !== user.id && !user.isModerator) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this image' });
  }
  const size = (image.metadata as { size?: unknown } | null)?.size;
  const result = validateListingImage(
    {
      type: image.type,
      width: image.width,
      height: image.height,
      mimeType: image.mimeType,
      sizeBytes: typeof size === 'number' ? size : null,
    },
    kind
  );
  if (!result.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: result.reason });
  return image.id;
}

// ---------------------------------------------------------------------------
// Creator asset management (owner/mod-gated).
// ---------------------------------------------------------------------------

export async function setListingIcon(
  args: { listingId: string; imageId: number },
  user: SessionUser
): Promise<{ iconId: number }> {
  await loadOwnedListing(args.listingId, user);
  const iconId = await loadValidatedImage(args.imageId, 'icon', user);
  await dbWrite.appListing.update({ where: { id: args.listingId }, data: { iconId } });
  return { iconId };
}

export async function setListingCover(
  args: { listingId: string; imageId: number },
  user: SessionUser
): Promise<{ coverId: number }> {
  await loadOwnedListing(args.listingId, user);
  const coverId = await loadValidatedImage(args.imageId, 'cover', user);
  await dbWrite.appListing.update({ where: { id: args.listingId }, data: { coverId } });
  return { coverId };
}

export async function addListingScreenshot(
  args: { listingId: string; imageId: number; caption?: string | null },
  user: SessionUser
): Promise<{ id: string; order: number }> {
  await loadOwnedListing(args.listingId, user);
  const imageId = await loadValidatedImage(args.imageId, 'screenshot', user);

  // COUNT cap — reject the (N+1)th (mirrors E5 MAX_SCREENSHOTS "reject, not truncate").
  const existing = await dbRead.appListingScreenshot.findMany({
    where: { appListingId: args.listingId },
    select: { order: true },
    orderBy: { order: 'desc' },
    take: 1,
  });
  const count = await dbRead.appListingScreenshot.count({
    where: { appListingId: args.listingId },
  });
  if (count >= MAX_LISTING_SCREENSHOTS) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `A listing may have at most ${MAX_LISTING_SCREENSHOTS} screenshots`,
    });
  }
  const nextOrder = existing.length > 0 ? existing[0].order + 1 : 0;
  const id = newAppListingScreenshotId();
  await dbWrite.appListingScreenshot.create({
    data: {
      id,
      appListingId: args.listingId,
      imageId,
      order: nextOrder,
      caption: args.caption ?? null,
    },
  });
  return { id, order: nextOrder };
}

/**
 * Reorder a listing's screenshots. `orderedIds` MUST be exactly the current set
 * of screenshot ids (a permutation) — otherwise BAD_REQUEST. Writes contiguous
 * 0..n-1 orders in a single transaction.
 */
export async function reorderListingScreenshots(
  args: { listingId: string; orderedIds: string[] },
  user: SessionUser
): Promise<{ reordered: number }> {
  await loadOwnedListing(args.listingId, user);
  const current = await dbRead.appListingScreenshot.findMany({
    where: { appListingId: args.listingId },
    select: { id: true },
  });
  const currentIds = new Set(current.map((s) => s.id));
  const nextIds = new Set(args.orderedIds);
  const samePermutation =
    currentIds.size === nextIds.size &&
    args.orderedIds.length === current.length &&
    args.orderedIds.every((id) => currentIds.has(id));
  if (!samePermutation) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'orderedIds must be exactly the listing’s current screenshot ids',
    });
  }
  await dbWrite.$transaction(
    args.orderedIds.map((id, index) =>
      dbWrite.appListingScreenshot.update({ where: { id }, data: { order: index } })
    )
  );
  return { reordered: args.orderedIds.length };
}

export async function updateListingScreenshotCaption(
  args: { screenshotId: string; caption?: string | null },
  user: SessionUser
): Promise<{ id: string }> {
  const shot = await dbRead.appListingScreenshot.findUnique({
    where: { id: args.screenshotId },
    select: { id: true, appListing: { select: { userId: true } } },
  });
  if (!shot) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screenshot not found' });
  if (shot.appListing.userId !== user.id && !user.isModerator) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this listing' });
  }
  await dbWrite.appListingScreenshot.update({
    where: { id: args.screenshotId },
    data: { caption: args.caption ?? null },
  });
  return { id: args.screenshotId };
}

/**
 * Remove a screenshot, then RE-PACK the remaining orders to a contiguous 0..n-1
 * so no gaps accumulate (the read path can rely on dense ordering).
 */
export async function removeListingScreenshot(
  args: { screenshotId: string },
  user: SessionUser
): Promise<{ removed: string }> {
  const shot = await dbRead.appListingScreenshot.findUnique({
    where: { id: args.screenshotId },
    select: { id: true, appListingId: true, appListing: { select: { userId: true } } },
  });
  if (!shot) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screenshot not found' });
  if (shot.appListing.userId !== user.id && !user.isModerator) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this listing' });
  }
  await dbWrite.appListingScreenshot.delete({ where: { id: args.screenshotId } });

  // Re-pack: contiguous orders over the survivors (ordered by their old order).
  const remaining = await dbRead.appListingScreenshot.findMany({
    where: { appListingId: shot.appListingId },
    select: { id: true },
    orderBy: { order: 'asc' },
  });
  if (remaining.length > 0) {
    await dbWrite.$transaction(
      remaining.map((s, index) =>
        dbWrite.appListingScreenshot.update({ where: { id: s.id }, data: { order: index } })
      )
    );
  }
  return { removed: args.screenshotId };
}

export type ListingAssetsView = {
  listingId: string;
  iconId: number | null;
  coverId: number | null;
  screenshots: { id: string; imageId: number | null; order: number; caption: string | null }[];
  completeness: ListingAssetsCompleteResult;
};

/** Owner/mod read of a listing's current assets for the creator dashboard. */
export async function getListingAssets(
  args: { listingId: string },
  user: SessionUser
): Promise<ListingAssetsView> {
  const listing = await loadOwnedListing(args.listingId, user);
  const screenshots = await dbRead.appListingScreenshot.findMany({
    where: { appListingId: args.listingId },
    select: { id: true, imageId: true, order: true, caption: true },
    orderBy: { order: 'asc' },
  });
  return {
    listingId: listing.id,
    iconId: listing.iconId,
    coverId: listing.coverId,
    screenshots,
    completeness: checkListingAssetsComplete({
      iconId: listing.iconId,
      coverId: listing.coverId,
      screenshotCount: screenshots.length,
    }),
  };
}

// ---------------------------------------------------------------------------
// Placeholder / asset backfill (mod-only, idempotent, dark).
// ---------------------------------------------------------------------------

export type BackfillListingAssetsParams = {
  limit?: number;
  dryRun?: boolean;
};

export type BackfillListingAssetsResult = {
  scanned: number;
  /** Listings that were already asset-complete (idempotent skip). */
  skippedComplete: number;
  /** Listings we filled at least one asset on (or would, in dryRun). */
  processed: number;
  iconsCreated: number;
  coversSet: number;
  screenshotsCreated: number;
  /** How the screenshots were sourced, for observability. */
  bySource: { migrated: number; autogen: number; placeholder: number };
  dryRun: boolean;
  failed: { listingId: string; error: string }[];
};

/** A backfill-candidate listing (approved + its current asset state). */
export type BackfillCandidate = {
  id: string;
  kind: string;
  slug: string;
  name: string;
  category: string | null;
  userId: number;
  iconId: number | null;
  coverId: number | null;
  appBlockId: string | null;
  /** The backing AppBlock's stored screenshots (bundle MinIO records), if any. */
  appBlockScreenshots: unknown;
  /** Existing AppListingScreenshot rows (imageId + order). */
  screenshots: { imageId: number | null; order: number }[];
};

export type ScreenshotSourcePlan =
  | { mode: 'existing' }
  | { mode: 'migrate'; count: number }
  | { mode: 'autogen' }
  | { mode: 'placeholder' };

/**
 * Decide where a candidate's screenshots come from (pure):
 *   - existing rows      → nothing to do,
 *   - on-site with bundle screenshots → migrate them to Image rows,
 *   - on-site without    → verify-runner autogen,
 *   - anything else (off-site, no bundle) → an SVG placeholder screenshot.
 * The impure backfill falls THROUGH autogen→placeholder if autogen returns null.
 */
export function chooseScreenshotSource(candidate: BackfillCandidate): ScreenshotSourcePlan {
  if (candidate.screenshots.length > 0) return { mode: 'existing' };
  const isOnsite = candidate.kind === 'onsite' && !!candidate.appBlockId;
  if (isOnsite) {
    const bundle = Array.isArray(candidate.appBlockScreenshots)
      ? (candidate.appBlockScreenshots as { key?: unknown }[]).filter(
          (s) => s && typeof s === 'object' && typeof s.key === 'string'
        )
      : [];
    if (bundle.length > 0) return { mode: 'migrate', count: bundle.length };
    return { mode: 'autogen' };
  }
  return { mode: 'placeholder' };
}

/**
 * Impure operations the backfill needs (Image ingest, MinIO reads, verify-
 * runner, sharp rasterize). Injectable so the orchestration is unit-testable
 * with no network/DB/native deps; the default implementation is
 * {@link defaultBackfillDeps}.
 */
export interface ListingAssetBackfillDeps {
  /** Migrate the backing AppBlock's bundle screenshots → Image rows (in order). */
  migrateBlockScreenshots(args: {
    ownerId: number;
    appBlockId: string;
    blockScreenshots: { key?: unknown }[];
  }): Promise<number[]>;
  /** Autogenerate ONE screenshot via verify-runner, stored as an Image. Null on failure. */
  autogenScreenshot(args: { ownerId: number; slug: string }): Promise<number | null>;
  /** Render an SVG placeholder screenshot → PNG → Image row. */
  generatePlaceholderScreenshot(args: {
    ownerId: number;
    slug: string;
    category: string | null;
    name: string;
  }): Promise<number>;
  /** Render the deterministic category-glyph icon → PNG → Image row. */
  generateIcon(args: {
    ownerId: number;
    slug: string;
    category: string | null;
    name: string;
  }): Promise<number>;
}

/**
 * Backfill placeholder assets for approved listings missing any. Idempotent
 * (fills only NULL/empty; never clobbers a creator-uploaded asset). Per-row
 * isolation like the P0 backfill (a poison row → `failed[]`, batch continues).
 * Verify-runner calls are serialised (single warm browser). DARK: writes only
 * to the (unread-in-P1) `app_listings*` + `Image` tables.
 */
export async function backfillListingAssets(
  params: BackfillListingAssetsParams = {},
  deps: ListingAssetBackfillDeps = defaultBackfillDeps
): Promise<BackfillListingAssetsResult> {
  const { limit, dryRun = false } = params;

  const listings = (await dbRead.appListing.findMany({
    where: { status: 'approved' },
    select: {
      id: true,
      kind: true,
      slug: true,
      name: true,
      category: true,
      userId: true,
      iconId: true,
      coverId: true,
      appBlockId: true,
      appBlock: { select: { screenshots: true } },
      screenshots: { select: { imageId: true, order: true }, orderBy: { order: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
    ...(typeof limit === 'number' ? { take: limit } : {}),
  })) as unknown as Array<
    Omit<BackfillCandidate, 'appBlockScreenshots'> & {
      appBlock: { screenshots: unknown } | null;
    }
  >;

  const result: BackfillListingAssetsResult = {
    scanned: listings.length,
    skippedComplete: 0,
    processed: 0,
    iconsCreated: 0,
    coversSet: 0,
    screenshotsCreated: 0,
    bySource: { migrated: 0, autogen: 0, placeholder: 0 },
    dryRun,
    failed: [],
  };

  for (const row of listings) {
    const candidate: BackfillCandidate = {
      id: row.id,
      kind: row.kind,
      slug: row.slug,
      name: row.name,
      category: row.category,
      userId: row.userId,
      iconId: row.iconId,
      coverId: row.coverId,
      appBlockId: row.appBlockId,
      appBlockScreenshots: row.appBlock?.screenshots ?? null,
      screenshots: row.screenshots,
    };

    const hasScreenshots = candidate.screenshots.length > 0;
    const complete =
      candidate.iconId != null && candidate.coverId != null && hasScreenshots;
    if (complete) {
      result.skippedComplete += 1;
      continue;
    }

    if (dryRun) {
      // Count what WOULD change without touching storage/DB.
      result.processed += 1;
      const plan = chooseScreenshotSource(candidate);
      if (plan.mode === 'migrate') {
        result.screenshotsCreated += plan.count;
        result.bySource.migrated += plan.count;
      } else if (plan.mode === 'autogen') {
        result.screenshotsCreated += 1;
        result.bySource.autogen += 1;
      } else if (plan.mode === 'placeholder') {
        result.screenshotsCreated += 1;
        result.bySource.placeholder += 1;
      }
      if (candidate.coverId == null) result.coversSet += 1;
      if (candidate.iconId == null) result.iconsCreated += 1;
      continue;
    }

    try {
      let changed = false;

      // 1) Ensure at least one screenshot exists.
      let firstScreenshotImageId: number | null = hasScreenshots
        ? candidate.screenshots[0].imageId
        : null;
      if (!hasScreenshots) {
        const plan = chooseScreenshotSource(candidate);
        let imageIds: number[] = [];
        if (plan.mode === 'migrate' && candidate.appBlockId) {
          imageIds = await deps.migrateBlockScreenshots({
            ownerId: candidate.userId,
            appBlockId: candidate.appBlockId,
            blockScreenshots: (candidate.appBlockScreenshots as { key?: unknown }[]) ?? [],
          });
          result.bySource.migrated += imageIds.length;
        } else if (plan.mode === 'autogen') {
          const shot = await deps.autogenScreenshot({
            ownerId: candidate.userId,
            slug: candidate.slug,
          });
          if (shot != null) {
            imageIds = [shot];
            result.bySource.autogen += 1;
          }
        }
        // Fallback: any path that produced nothing gets an SVG placeholder so
        // the mandatory-asset gate is universal (locked decision §6.1).
        if (imageIds.length === 0) {
          const ph = await deps.generatePlaceholderScreenshot({
            ownerId: candidate.userId,
            slug: candidate.slug,
            category: candidate.category,
            name: candidate.name,
          });
          imageIds = [ph];
          result.bySource.placeholder += 1;
        }
        await dbWrite.appListingScreenshot.createMany({
          data: imageIds.map((imageId, index) => ({
            id: newAppListingScreenshotId(),
            appListingId: candidate.id,
            imageId,
            order: index,
            caption: null,
          })),
        });
        result.screenshotsCreated += imageIds.length;
        firstScreenshotImageId = imageIds[0] ?? null;
        changed = true;
      }

      // 2) Cover = the first screenshot's Image (mirrors #2838 coverUrl pattern).
      if (candidate.coverId == null && firstScreenshotImageId != null) {
        await dbWrite.appListing.update({
          where: { id: candidate.id },
          data: { coverId: firstScreenshotImageId },
        });
        result.coversSet += 1;
        changed = true;
      }

      // 3) Icon = deterministic category-glyph SVG→PNG.
      if (candidate.iconId == null) {
        const iconId = await deps.generateIcon({
          ownerId: candidate.userId,
          slug: candidate.slug,
          category: candidate.category,
          name: candidate.name,
        });
        await dbWrite.appListing.update({
          where: { id: candidate.id },
          data: { iconId },
        });
        result.iconsCreated += 1;
        changed = true;
      }

      if (changed) result.processed += 1;
    } catch (err) {
      // Per-row isolation: one poison listing (a MinIO fetch failure, an FK
      // violation) must not abort the batch.
      result.failed.push({
        listingId: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Default (impure) backfill dependencies — dynamic imports so the pure helpers
// above stay unit-testable without booting env/native modules.
// ---------------------------------------------------------------------------

/**
 * Create a REAL stored Image row from a server-side buffer, following the
 * canonical site pattern (product-badge.service / uploadImageFromUrl):
 * upload the bytes to the image backend, register the media location, then
 * `image.create` with the storage key as `url`. Machine-generated/vetted assets
 * are stored `Scanned` + safe (they bypass the user-content ingestion pipeline,
 * exactly like the autogenerated marketplace screenshots do today).
 */
async function createStoredImage(args: {
  ownerId: number;
  buffer: Buffer;
  contentType: string;
  width: number;
  height: number;
  assetKind: ListingAssetKind;
  autogenerated: boolean;
}): Promise<number> {
  const [{ PutObjectCommand }, s3utils, storageResolver, { ImageIngestionStatus, MediaType }, { NsfwLevel }] =
    await Promise.all([
      import('@aws-sdk/client-s3'),
      import('~/utils/s3-utils'),
      import('~/server/services/storage-resolver'),
      import('~/shared/utils/prisma/enums'),
      import('~/server/common/enums'),
    ]);
  const key = randomUUID();
  const { s3, bucket, backend } = await s3utils.getImageUploadBackend();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: args.buffer,
      ContentType: args.contentType,
    })
  );
  await storageResolver.registerMediaLocation(key, backend, args.buffer.length);

  const created = await dbWrite.image.create({
    data: {
      url: key,
      userId: args.ownerId,
      type: MediaType.image,
      width: args.width,
      height: args.height,
      mimeType: args.contentType,
      nsfwLevel: NsfwLevel.PG,
      ingestion: ImageIngestionStatus.Scanned,
      metadata: {
        size: args.buffer.length,
        width: args.width,
        height: args.height,
        // Marker so a later creator upload can be preferred / these can be
        // identified as generated placeholders (task §3). Stored on the EXISTING
        // Image.metadata Json — no schema migration needed.
        appListingAutogenerated: true,
        appListingAssetKind: args.assetKind,
      },
    },
    select: { id: true },
  });
  return created.id;
}

/** Rasterize an SVG string to a PNG buffer via sharp. */
async function rasterizeSvg(svg: string, width: number, height: number): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp(Buffer.from(svg)).resize(width, height).png().toBuffer();
}

export const defaultBackfillDeps: ListingAssetBackfillDeps = {
  async migrateBlockScreenshots({ ownerId, blockScreenshots }) {
    const { getBundleBucket, getBundleS3Client } = await import('~/utils/bundle-s3');
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = getBundleS3Client();
    const bucket = getBundleBucket();
    const imageIds: number[] = [];
    // Bound the migrate to the screenshot cap; ordered by the bundle index.
    const records = blockScreenshots
      .filter((s) => s && typeof s === 'object' && typeof s.key === 'string')
      .slice(0, MAX_LISTING_SCREENSHOTS) as { key: string }[];
    for (const rec of records) {
      const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: rec.key }));
      const bytes = await obj.Body?.transformToByteArray();
      if (!bytes || bytes.length === 0) continue;
      const buffer = Buffer.from(bytes);
      const contentType = (obj.ContentType as string) || 'image/png';
      // Dimensions aren't stored on the bundle record; probe with sharp.
      const sharp = (await import('sharp')).default;
      const meta = await sharp(buffer).metadata();
      const id = await createStoredImage({
        ownerId,
        buffer,
        contentType,
        width: meta.width ?? 1280,
        height: meta.height ?? 720,
        assetKind: 'screenshot',
        autogenerated: true,
      });
      imageIds.push(id);
    }
    return imageIds;
  },

  async autogenScreenshot({ ownerId, slug }) {
    // Reuse the verify-runner fetch from the App Blocks autogen path, but store
    // the PNG as an Image row (not the bundle-MinIO screenshots path).
    const { env } = await import('~/env/server');
    const base = env.BLOCK_SCREENSHOT_RUNNER_URL;
    if (!base) return null;
    const url = `https://${slug}.${env.APPS_DOMAIN}/`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/screenshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, width: 1280, height: 720, wait_until: 'networkidle' }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) return null;
      const { detectImageType } = await import('~/server/services/blocks/publish-request.service');
      if (!detectImageType(buffer, 'png')) return null;
      return createStoredImage({
        ownerId,
        buffer,
        contentType: 'image/png',
        width: 1280,
        height: 720,
        assetKind: 'screenshot',
        autogenerated: true,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  async generatePlaceholderScreenshot({ ownerId, slug, category, name }) {
    const svg = buildPlaceholderCoverSvg({ slug, category, name, width: 1280, height: 720 });
    const buffer = await rasterizeSvg(svg, 1280, 720);
    return createStoredImage({
      ownerId,
      buffer,
      contentType: 'image/png',
      width: 1280,
      height: 720,
      assetKind: 'screenshot',
      autogenerated: true,
    });
  },

  async generateIcon({ ownerId, slug, category, name }) {
    const svg = buildPlaceholderIconSvg({ slug, category, name, size: 512 });
    const buffer = await rasterizeSvg(svg, 512, 512);
    return createStoredImage({
      ownerId,
      buffer,
      contentType: 'image/png',
      width: 512,
      height: 512,
      assetKind: 'icon',
      autogenerated: true,
    });
  },
};

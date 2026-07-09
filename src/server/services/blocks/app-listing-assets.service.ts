import { TRPCError } from '@trpc/server';
import { randomUUID } from 'crypto';

import { dbRead, dbWrite } from '~/server/db/client';
import { NsfwLevel } from '~/server/common/enums';
import {
  getHighestBrowsingLevelBit,
  orchestratorNsfwLevelMap,
} from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
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
 *   2. Mod-only asset backfill: for approved listings missing assets, populate
 *      REAL stored `Image` rows. Screenshots migrate the backing
 *      `AppBlock.screenshots` (bundle MinIO) → Image rows ONLY for GENUINE
 *      dev-uploaded records; cover = the first screenshot's Image; icon = a
 *      deterministic category-glyph SVG→PNG (always generated).
 *
 *      NOTE: the standalone-URL verify-runner autogen + the SVG-placeholder
 *      screenshot fallback are DISABLED. The standalone `<slug>.<APPS_DOMAIN>` URL
 *      renders only a waiting-for-host skeleton (blocks need the host
 *      `BLOCK_INIT` postMessage), so a listing with no real dev-uploaded
 *      screenshots is left with NO screenshot → null cover → the card's
 *      category-glyph placeholder (the desired clean state). This means the
 *      mandatory-asset gate (`assertListingAssetsComplete`, still dark/P3) is no
 *      longer force-satisfied for screenshot/cover — that gate must be revisited
 *      before it is wired live, or real screenshots must come from creator/dev
 *      upload (or a future in-host `/apps/run/<slug>` capture).
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
  contentRating: string | null;
  userId: number;
  iconId: number | null;
  coverId: number | null;
  status: string;
  revisionOfId: string | null;
};

/**
 * 🔴 Owner asset-edit guard (defense-in-depth). An APPROVED, non-shadow (live,
 * `revisionOfId == null`) listing must NOT have its assets mutated directly by its
 * owner — those edits go through a SHADOW revision (mod re-review), so a direct
 * add/remove/replace on the live row can never silently change the served listing.
 * Draft / pending / shadow (`revisionOfId != null`) listings are freely editable.
 *
 * Moderators BYPASS (they may curate a live listing). The mod placeholder backfill
 * writes assets via `dbWrite` DIRECTLY, NOT through these owner procs, so it is
 * unaffected by this guard.
 */
function assertOwnerAssetEditable(
  listing: { status: string; revisionOfId: string | null },
  user: SessionUser
): void {
  if (user.isModerator) return;
  if (listing.status === 'approved' && listing.revisionOfId == null) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'This listing is live; edit its assets through a revision instead of directly.',
    });
  }
}

/**
 * Map an `AppListing.contentRating` (`g|pg|pg13|r|x` — nullable) to the MAXIMUM
 * `NsfwLevel` bit its published assets may carry. Reuses the canonical
 * `orchestratorNsfwLevelMap` (which lacks the SFW `g` rating → PG). A
 * null/unknown rating FAILS CLOSED to PG (SFW) — never widen on ambiguity.
 */
export function nsfwLevelFromContentRating(rating: string | null | undefined): NsfwLevel {
  if (!rating || rating === 'g') return NsfwLevel.PG;
  return orchestratorNsfwLevelMap[rating] ?? NsfwLevel.PG;
}

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
      contentRating: true,
      userId: true,
      iconId: true,
      coverId: true,
      status: true,
      revisionOfId: true,
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
  user: SessionUser,
  contentRating: string | null
): Promise<number> {
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: {
      id: true,
      userId: true,
      type: true,
      width: true,
      height: true,
      mimeType: true,
      metadata: true,
      ingestion: true,
      nsfwLevel: true,
    },
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

  // Content-status gate: a listing asset is publicly rendered (P2), so the Image
  // must be scan-complete AND within the listing's maturity ceiling. This mirrors
  // the site-wide "don't publish un-scanned / over-rated media" invariant.
  if (image.ingestion !== ImageIngestionStatus.Scanned) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'image is not approved for publishing (scan is not complete)',
    });
  }
  // Fail closed: a null contentRating clamps to SFW (PG). NsfwLevel bits are
  // severity-ordered (PG=1 < PG13=2 < R=4 < X=8 < XXX=16 < Blocked=32), so a
  // numeric compare of the image's highest bit vs the ceiling is exact.
  const maxLevel = nsfwLevelFromContentRating(contentRating);
  const imageLevel = getHighestBrowsingLevelBit(image.nsfwLevel ?? 0);
  if (imageLevel > maxLevel) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: "image exceeds the listing's content rating",
    });
  }
  return image.id;
}

// ---------------------------------------------------------------------------
// Creator asset management (owner/mod-gated).
// ---------------------------------------------------------------------------

export async function setListingIcon(
  args: { listingId: string; imageId: number },
  user: SessionUser
): Promise<{ iconId: number }> {
  const listing = await loadOwnedListing(args.listingId, user);
  assertOwnerAssetEditable(listing, user);
  const iconId = await loadValidatedImage(args.imageId, 'icon', user, listing.contentRating);
  await dbWrite.appListing.update({ where: { id: args.listingId }, data: { iconId } });
  return { iconId };
}

export async function setListingCover(
  args: { listingId: string; imageId: number },
  user: SessionUser
): Promise<{ coverId: number }> {
  const listing = await loadOwnedListing(args.listingId, user);
  assertOwnerAssetEditable(listing, user);
  const coverId = await loadValidatedImage(args.imageId, 'cover', user, listing.contentRating);
  await dbWrite.appListing.update({ where: { id: args.listingId }, data: { coverId } });
  return { coverId };
}

export async function addListingScreenshot(
  args: { listingId: string; imageId: number; caption?: string | null },
  user: SessionUser
): Promise<{ id: string; order: number }> {
  const listing = await loadOwnedListing(args.listingId, user);
  assertOwnerAssetEditable(listing, user);
  const imageId = await loadValidatedImage(args.imageId, 'screenshot', user, listing.contentRating);

  // COUNT cap — reject the (N+1)th (mirrors E5 MAX_SCREENSHOTS "reject, not truncate").
  // Read the count + max order from dbWrite (primary), NOT the replica: under
  // replica lag two concurrent adds could both pass `count < 8` (a 9th row) or
  // compute the same `order`.
  const existing = await dbWrite.appListingScreenshot.findMany({
    where: { appListingId: args.listingId },
    select: { order: true },
    orderBy: { order: 'desc' },
    take: 1,
  });
  const count = await dbWrite.appListingScreenshot.count({
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
  assertOwnerAssetEditable(await loadOwnedListing(args.listingId, user), user);
  // Read the current set from dbWrite (primary): under replica lag the reorder
  // could target a just-deleted id (P2025 → 500 after the delete committed) or
  // miss a just-added row.
  const current = await dbWrite.appListingScreenshot.findMany({
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
    select: {
      id: true,
      appListing: { select: { userId: true, status: true, revisionOfId: true } },
    },
  });
  if (!shot) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screenshot not found' });
  if (shot.appListing.userId !== user.id && !user.isModerator) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this listing' });
  }
  assertOwnerAssetEditable(shot.appListing, user);
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
    select: {
      id: true,
      appListingId: true,
      appListing: { select: { userId: true, status: true, revisionOfId: true } },
    },
  });
  if (!shot) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screenshot not found' });
  if (shot.appListing.userId !== user.id && !user.isModerator) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this listing' });
  }
  // 🔴 Never delete a screenshot from a LIVE approved listing directly (bypasses
  // review) — edits go through a shadow revision. Mods bypass (curation).
  assertOwnerAssetEditable(shot.appListing, user);
  await dbWrite.appListingScreenshot.delete({ where: { id: args.screenshotId } });

  // Re-pack: contiguous orders over the survivors (ordered by their old order).
  // Read the survivor set from dbWrite (primary): under replica lag the replica
  // may still return the just-deleted row → an `update` on it would P2025/500
  // after the delete already committed.
  const remaining = await dbWrite.appListingScreenshot.findMany({
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
      // A row whose Image was deleted (imageId → null via onDelete: SetNull) must
      // NOT count as a present screenshot, else the gate passes but the card
      // renders blank.
      screenshotCount: screenshots.filter((s) => s.imageId != null).length,
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
  contentRating: string | null;
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
  | { mode: 'none' };

/**
 * Filter an `AppBlock.screenshots` bundle value down to GENUINE dev-uploaded
 * records — those with a string `key` AND WITHOUT the `autogenerated: true`
 * marker. The standalone-URL screenshot autogen (now disabled — see
 * `autogenerate-screenshot.service`) stamped `autogenerated: true` on its
 * captures, which are "waiting for host" loading skeletons, NOT real
 * screenshots. Those must NOT be migrated into listing assets. Mirrors
 * `hasDevScreenshots` in `autogenerate-screenshot.service`.
 */
export function realDevBundleScreenshots(value: unknown): { key: string }[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (s): s is { key: string } =>
      s != null &&
      typeof s === 'object' &&
      typeof (s as { key?: unknown }).key === 'string' &&
      (s as { autogenerated?: unknown }).autogenerated !== true
  );
}

/**
 * Decide where a candidate's screenshots come from (pure):
 *   - existing rows                          → nothing to do,
 *   - on-site with GENUINE dev-uploaded bundle screenshots → migrate them,
 *   - anything else                          → none (no screenshot).
 *
 * The standalone-URL verify-runner autogen + the SVG-placeholder-screenshot
 * fallback are intentionally GONE: the standalone `<slug>.<APPS_DOMAIN>` URL only
 * ever rendered a waiting-for-host skeleton, so a listing with no real dev
 * screenshots is left with NONE → null cover → the card's category-glyph
 * placeholder (the desired clean state). Real screenshots come from creator/dev
 * upload (or a future in-host `/apps/run/<slug>` capture rework).
 */
export function chooseScreenshotSource(candidate: BackfillCandidate): ScreenshotSourcePlan {
  if (candidate.screenshots.length > 0) return { mode: 'existing' };
  const isOnsite = candidate.kind === 'onsite' && !!candidate.appBlockId;
  if (isOnsite) {
    const bundle = realDevBundleScreenshots(candidate.appBlockScreenshots);
    if (bundle.length > 0) return { mode: 'migrate', count: bundle.length };
  }
  return { mode: 'none' };
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
    /** Maturity level to stamp on the created Image rows (from contentRating). */
    nsfwLevel: NsfwLevel;
  }): Promise<number[]>;
  /**
   * DORMANT — retained for a future in-host capture rework but NOT wired into
   * {@link backfillListingAssets}. Autogenerated ONE screenshot via verify-runner
   * against the STANDALONE `<slug>.<APPS_DOMAIN>` URL, which only renders a
   * waiting-for-host skeleton, so it is no longer called. Null on failure.
   */
  autogenScreenshot(args: {
    ownerId: number;
    slug: string;
    /** Maturity level to stamp on the created Image row (from contentRating). */
    nsfwLevel: NsfwLevel;
  }): Promise<number | null>;
  /**
   * DORMANT — retained but NOT wired into {@link backfillListingAssets}. Rendered
   * an SVG placeholder screenshot → PNG → Image row so the mandatory-asset gate
   * was force-satisfied; now a listing with no real screenshot is left empty (→
   * null cover → the card's category-glyph placeholder) instead.
   */
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
      contentRating: true,
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
      contentRating: row.contentRating,
      userId: row.userId,
      iconId: row.iconId,
      coverId: row.coverId,
      appBlockId: row.appBlockId,
      appBlockScreenshots: row.appBlock?.screenshots ?? null,
      screenshots: row.screenshots,
    };

    // A screenshot row whose Image was deleted (imageId → null) does NOT count
    // as a present screenshot — it must be re-filled, not treated as complete.
    const hasScreenshots = candidate.screenshots.some((s) => s.imageId != null);
    const complete =
      candidate.iconId != null && candidate.coverId != null && hasScreenshots;
    if (complete) {
      result.skippedComplete += 1;
      continue;
    }

    if (dryRun) {
      // Count what WOULD change without touching storage/DB. Mirrors the real
      // path exactly: a listing with no migratable dev screenshots (plan 'none')
      // gets NO screenshot and NO cover — only its icon (if missing).
      const plan = chooseScreenshotSource(candidate);
      let willChange = false;
      if (plan.mode === 'migrate') {
        result.screenshotsCreated += plan.count;
        result.bySource.migrated += plan.count;
        willChange = true;
      }
      // Cover is derived from the first screenshot; only settable when a
      // screenshot exists ('existing') or will be migrated ('migrate'). Under
      // plan 'none' the cover stays null → the card's category-glyph placeholder.
      if (candidate.coverId == null && plan.mode !== 'none') {
        result.coversSet += 1;
        willChange = true;
      }
      if (candidate.iconId == null) {
        result.iconsCreated += 1;
        willChange = true;
      }
      if (willChange) result.processed += 1;
      continue;
    }

    try {
      let changed = false;

      // Maturity ceiling for creator-derived (migrated/autogen) screenshots,
      // derived from the listing's contentRating (fail-closed to PG). Synthetic
      // SVG placeholders + the icon stay PG regardless.
      const derivedNsfwLevel = nsfwLevelFromContentRating(candidate.contentRating);

      // 1) Ensure at least one screenshot exists.
      let firstScreenshotImageId: number | null = hasScreenshots
        ? candidate.screenshots.find((s) => s.imageId != null)?.imageId ?? null
        : null;
      if (!hasScreenshots) {
        const plan = chooseScreenshotSource(candidate);
        let imageIds: number[] = [];
        if (plan.mode === 'migrate' && candidate.appBlockId) {
          // Migrate ONLY genuine dev-uploaded bundle screenshots (skeleton
          // autogen captures are filtered out by realDevBundleScreenshots).
          imageIds = await deps.migrateBlockScreenshots({
            ownerId: candidate.userId,
            appBlockId: candidate.appBlockId,
            blockScreenshots: realDevBundleScreenshots(candidate.appBlockScreenshots),
            nsfwLevel: derivedNsfwLevel,
          });
          result.bySource.migrated += imageIds.length;
        }
        // NO verify-runner autogen and NO SVG-placeholder fallback: the
        // standalone `<slug>.<APPS_DOMAIN>` URL only renders a waiting-for-host
        // skeleton, so a listing with no real dev-uploaded screenshots is left
        // with NONE → null cover → the card's category-glyph placeholder (the
        // desired clean state). Real screenshots come from creator/dev upload (or
        // a future in-host `/apps/run/<slug>` capture).
        if (imageIds.length > 0) {
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
  /** Maturity level to stamp (synthetic assets = PG; creator-derived = from rating). */
  nsfwLevel: NsfwLevel;
  /**
   * Whether to mark the row `appListingAutogenerated` in metadata. TRUE only for
   * MACHINE-generated assets (SVG icon/placeholder, verify-runner autogen screen-
   * shot). FALSE for MIGRATED bundle screenshots — those are creator-authored.
   */
  autogenerated: boolean;
}): Promise<number> {
  const [{ PutObjectCommand, DeleteObjectCommand }, s3utils, storageResolver, { MediaType }] =
    await Promise.all([
      import('@aws-sdk/client-s3'),
      import('~/utils/s3-utils'),
      import('~/server/services/storage-resolver'),
      import('~/shared/utils/prisma/enums'),
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

  try {
    await storageResolver.registerMediaLocation(key, backend, args.buffer.length);

    // TODO(W13 P2): migrated/autogen (creator-derived) screenshots are stored
    // `Scanned` here (they bypass the user-content ingestion pipeline). P2 should
    // route them through the real per-image scan instead of trusting the rating.
    const created = await dbWrite.image.create({
      data: {
        url: key,
        userId: args.ownerId,
        type: MediaType.image,
        width: args.width,
        height: args.height,
        mimeType: args.contentType,
        nsfwLevel: args.nsfwLevel,
        ingestion: ImageIngestionStatus.Scanned,
        metadata: {
          size: args.buffer.length,
          width: args.width,
          height: args.height,
          // Provenance kind is always recorded; the `appListingAutogenerated`
          // marker is set ONLY for truly machine-generated assets so it reflects
          // reality (a migrated creator screenshot is NOT autogenerated).
          ...(args.autogenerated ? { appListingAutogenerated: true } : {}),
          appListingAssetKind: args.assetKind,
        },
      },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    // Best-effort orphan cleanup: the bytes are already in S3 but registering /
    // the DB row failed. Delete the object so we don't leak; never mask the
    // original error with a cleanup failure.
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
      // ignore — cleanup is best-effort
    }
    throw err;
  }
}

/** Rasterize an SVG string to a PNG buffer via sharp. */
async function rasterizeSvg(svg: string, width: number, height: number): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp(Buffer.from(svg)).resize(width, height).png().toBuffer();
}

export const defaultBackfillDeps: ListingAssetBackfillDeps = {
  async migrateBlockScreenshots({ ownerId, blockScreenshots, nsfwLevel }) {
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
        nsfwLevel,
        // Migrated bundle screenshots are CREATOR-authored, not autogenerated.
        autogenerated: false,
      });
      imageIds.push(id);
    }
    return imageIds;
  },

  async autogenScreenshot({ ownerId, slug, nsfwLevel }) {
    // DORMANT + kill-switch-gated. Standalone-URL capture only ever yields a
    // waiting-for-host loading skeleton (blocks render only when embedded), so
    // the whole autogen path is disabled. Gate here too — single source of truth
    // — so a future `'autogen'` plan mode can't silently re-arm standalone
    // capture without flipping BLOCK_SCREENSHOT_AUTOGEN_ENABLED.
    const { BLOCK_SCREENSHOT_AUTOGEN_ENABLED } = await import(
      '~/server/services/blocks/autogenerate-screenshot.service'
    );
    if (!BLOCK_SCREENSHOT_AUTOGEN_ENABLED) return null;
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
        nsfwLevel,
        // A verify-runner capture of the live app IS machine-generated.
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
      // Fully machine-generated SVG placeholder → always SFW/PG + autogenerated.
      nsfwLevel: NsfwLevel.PG,
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
      // Deterministic machine-generated glyph icon → always SFW/PG + autogenerated.
      nsfwLevel: NsfwLevel.PG,
      autogenerated: true,
    });
  },
};

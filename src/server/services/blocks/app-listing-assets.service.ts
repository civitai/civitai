import { TRPCError } from '@trpc/server';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { NsfwLevel } from '~/server/common/enums';
import {
  deriveContentRatingFromAssets,
  nsfwLevelFromContentRating,
} from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { newAppListingScreenshotId } from '~/server/utils/app-block-ids';
import {
  MAX_LISTING_SCREENSHOTS,
  validateListingImage,
  type ListingAssetKind,
} from '~/server/schema/blocks/app-listing.schema';
import type { SessionUser } from '~/types/session';
// TYPE-ONLY (erased at compile time) — the runtime reach into `app-access.service` stays
// a dynamic import (it imports this module back). See `resolveListingRole`.
import type { AppRole } from '~/server/services/blocks/app-access.service';
import {
  classifyStoredObjectIntegrity,
  readRecordedEtag,
} from '~/server/services/blocks/stored-object-integrity';
import {
  appInitial,
  categoryGlyph,
  listingPlaceholderSeed,
  placeholderHues,
  placeholderStop,
  seededHue,
} from '~/shared/constants/app-listing-placeholder.constants';

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
 * Throwing wrapper around {@link checkListingAssetsComplete}. ADVISORY-ONLY as of
 * the partial-media relaxation: no live path calls this any more — the live
 * submit/approve/apply gates use {@link assertListingMeetsFloor} (icon+cover floor,
 * screenshots optional). Kept exported + unit-tested as the full-completeness
 * assertion so the two helpers stay distinct and the completeness contract is
 * pinned; {@link checkListingAssetsComplete} remains the "what's still missing"
 * source for advisory surfacing (my-submissions problems / mod review).
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
// Minimum-FLOOR gate (icon + cover REQUIRED; screenshots OPTIONAL).
//
// This is the LIVE gate for submit + approve/apply as of the partial-media
// relaxation: an owner can publish icon+cover now and add screenshots later.
// Screenshots stay surfaced as advisory incompleteness (via
// checkListingAssetsComplete), never a hard block. This is a pure relaxation of
// the previous full-completeness gate — nothing gets stricter.
// ---------------------------------------------------------------------------

/** The assets a listing MUST have before it can be published. Screenshots are
 * deliberately excluded — they are advisory/optional. */
export const FLOOR_ASSETS = ['icon', 'cover'] as const;

export type FloorAsset = (typeof FLOOR_ASSETS)[number];

export type ListingFloorResult = { ok: true } | { ok: false; missing: FloorAsset[] };

/**
 * Pure floor check: a listing meets the publish floor when it has an icon AND a
 * cover. Screenshots are ignored (optional). Returns the structured set of
 * missing FLOOR assets (never throws) so a caller can build a precise error.
 * Distinct from {@link checkListingAssetsComplete}, which additionally requires
 * ≥1 screenshot for FULL completeness (advisory).
 */
export function checkListingMeetsFloor(listing: ListingAssetCompleteness): ListingFloorResult {
  const missing: FloorAsset[] = [];
  if (listing.iconId == null) missing.push('icon');
  if (listing.coverId == null) missing.push('cover');
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * Throwing wrapper around {@link checkListingMeetsFloor}. This is the LIVE gate at
 * submit + approve/apply — throws BAD_REQUEST only when icon or cover is missing;
 * a listing with icon+cover but ZERO screenshots passes (screenshots optional).
 */
export function assertListingMeetsFloor(listing: ListingAssetCompleteness): void {
  const result = checkListingMeetsFloor(listing);
  if (!result.ok) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Listing needs at least an icon and cover before it can be published (missing: ${result.missing.join(
        ', '
      )}).`,
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

// The placeholder PRIMITIVES (glyphs / seeded hue / initial / gradient stops)
// now live in `~/shared/constants/app-listing-placeholder.constants` so the
// CLIENT render-time fallback (AppListingCard / AppListingDetailBody) can derive
// its colours from the SAME seed as these generated assets. They are re-exported
// below to keep this module's public API (and its existing tests) unchanged.
export { seededHue, appInitial };

function gradientDefs(seed: string): { hue: number; hue2: number } {
  return placeholderHues(seed);
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
  const seed = listingPlaceholderSeed(args.slug, args.category);
  const { hue, hue2 } = gradientDefs(seed);
  const initial = svgEscape(appInitial(args.name, args.slug));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0%" stop-color="${placeholderStop('icon', 'from', hue)}"/>`,
    `<stop offset="100%" stop-color="${placeholderStop('icon', 'to', hue2)}"/>`,
    `</linearGradient></defs>`,
    `<rect width="${size}" height="${size}" rx="${Math.round(size * 0.18)}" fill="url(#g)"/>`,
    `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="700" font-size="${Math.round(
      size * 0.5
    )}" fill="#ffffff" fill-opacity="0.92">${initial}</text>`,
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
  const seed = listingPlaceholderSeed(args.slug, args.category);
  const { hue, hue2 } = gradientDefs(seed);
  const glyph = svgEscape(categoryGlyph(args.category));
  const name = svgEscape((args.name || args.slug).slice(0, 48));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0%" stop-color="${placeholderStop('cover', 'from', hue)}"/>`,
    `<stop offset="100%" stop-color="${placeholderStop('cover', 'to', hue2)}"/>`,
    `</linearGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="url(#g)"/>`,
    `<text x="50%" y="44%" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="${Math.round(
      height * 0.22
    )}" fill="#ffffff" fill-opacity="0.85">${glyph}</text>`,
    `<text x="50%" y="66%" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="600" font-size="${Math.round(
      height * 0.07
    )}" fill="#ffffff" fill-opacity="0.9">${name}</text>`,
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
 * Re-export the canonical `AppListing.contentRating` → max-`NsfwLevel` ceiling map
 * (its home is `browsingLevel.constants`, shared with the client-side review-modal
 * derive so the forward + inverse can never diverge). The backfill below uses it to
 * clamp creator-derived screenshots.
 */
export { nsfwLevelFromContentRating };

/**
 * Load a listing and assert the caller may edit it. Throws NOT_FOUND for a missing
 * listing, FORBIDDEN otherwise.
 *
 * PERMITTED: the listing owner, an ACCEPTED collaborator ON THE LISTING (seats are
 * listing-keyed since the re-key — the backing AppBlock is not the seat key and an
 * off-site listing has none), or a moderator. The mod bypass is UNCHANGED from before
 * collaborators existed — this
 * file's gate always had one, unlike `offsite-listing.service`'s
 * `loadOwnedEditableListing`, which deliberately has none. That divergence is
 * pre-existing and is recorded in `app-access.call-site-ledger.test.ts` rather than
 * silently normalised here.
 *
 * 🔴 BOTH halves route through `resolveListingAccess` — the owner one too, not just the
 * collaborator fallback. It is SHADOW-AWARE (a shadow revision carries `appBlockId: null`, so both the seat and
 * the canonical owner are resolved via its parent; without that an editor would lose
 * access to their own in-flight revision the moment their first media edit minted it)
 * and it is KIND-AWARE about ownership (`appBlock.app.userId ?? listing.userId`).
 *
 * 🔴 THIS IS THE ONLY OWNERSHIP GATE ON THE ASSET PATH. `resolveOwnerScreenshotTarget`
 * used to run a second, denormalized-column copy of it one line before calling this;
 * that copy is gone.
 */
async function loadOwnedListing(
  listingId: string,
  user: SessionUser,
  /**
   * Pool override. Defaults to the replica. Pass `dbWrite` when the row may have
   * been INSERTed milliseconds ago — i.e. a shadow this request just minted
   * ({@link resolveOwnerAssetEditTarget}); the replica would miss it and the load
   * would 404 the owner's very first edit.
   */
  db: typeof dbRead = dbRead
): Promise<OwnedListing> {
  const listing = await db.appListing.findUnique({
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
  if (!user.isModerator) {
    // Not a mod — the way in is an owner or an ACCEPTED collaborator ROLE, resolved
    // canonically. Mods short-circuit first, so their path still costs no extra query.
    //
    // 🔴 THE OWNER HALF IS RESOLVED, NOT COMPARED. `listing.userId` (selected above) is
    // a DENORMALIZED copy of the owner for an ON-SITE listing — the canonical owner is
    // `AppBlock.app.userId`. Comparing against the copy inverts this gate in BOTH
    // directions on a drifted row: the real owner is refused FORBIDDEN on their own
    // listing, and whoever the stale row names is let in. `resolveListingAccess` is the
    // one place that resolution lives.
    //
    // 🔴 THE DRIFT COMES FROM A SHADOW REVISION, not from the transfer's listing write —
    // an earlier version of this comment blamed the latter and was wrong.
    // `beginListingRevision` clones the parent with `userId: parent.userId` and nothing
    // ever revisits the clone (`acceptTransfer` step 3 updates only `{ id: <parent> }`;
    // the revision-apply copies assets back, never `userId`), so a shadow that outlives a
    // transfer names the OLD owner forever. That matters HERE specifically: this gate is
    // handed a shadow id on the whole approved-listing edit flow — see
    // `resolveOwnerAssetEditTarget`, which calls `loadOwnedListing(shadowId, user,
    // dbWrite)` directly. The transfer's own write to the parent is unconditional and in
    // the same transaction as the OauthClient move, so it HEALS the parent rather than
    // drifting it.
    //
    // 🔴 `db` IS THREADED THROUGH, not dropped. An EDITOR never resolves as the owner —
    // a shadow's canonical owner is the PARENT's — so this is the ONLY branch an editor
    // ever reaches. Resolving it off the replica while the caller handed us `dbWrite`
    // would re-open, as a 403, the very read-after-write hole the override exists to
    // close for the owner's 404.
    const role = await resolveListingRole(listingId, user.id, db);
    if (role === null) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this listing' });
    }
  }
  return listing;
}

/**
 * The caller's role on this listing — `'owner'`, `'editor'`, or `null` for no access.
 *
 * Extracted so every gate in this file asks the question the SAME way
 * (`resolveListingAccess` is the single predicate; this is a thin read of it) and so the
 * seam has one name to mock in tests. It answers BOTH halves: the canonical owner
 * (kind-aware — `appBlock.app.userId ?? listing.userId`, never the denormalized column
 * alone) and the ACCEPTED seat, in one call.
 *
 * `db` defaults to the replica and MUST be passed on by any caller that itself received
 * a pool override — see the note at the `loadOwnedListing` call site.
 */
async function resolveListingRole(
  listingId: string,
  userId: number,
  db: typeof dbRead = dbRead
): Promise<AppRole | null> {
  const { resolveListingAccess } = await import('~/server/services/blocks/app-access.service');
  const access = await resolveListingAccess(listingId, userId, db);
  return access?.role ?? null;
}

// ---------------------------------------------------------------------------
// LAZY shadow-revision minting — "a shadow exists once you EDIT, not once you LOOK".
// ---------------------------------------------------------------------------

/**
 * Resolve the EFFECTIVE target of an OWNER asset mutation, minting the shadow
 * revision on the FIRST edit.
 *
 * `getMyListingForApp` no longer creates a shadow just to render the media editor
 * (a `.query` that writes; measured on prod as 78% of approved onsite parents
 * carrying a never-edited shadow, self-refilling on every page view). So the id the
 * client hands an asset proc is the LIVE PARENT until the first mutation. This is
 * where that mutation becomes a revision:
 *
 *   - moderator → returns the listing UNCHANGED. Mods deliberately curate the live
 *     row ({@link assertOwnerAssetEditable}'s bypass + {@link
 *     reDeriveContentRatingForModLiveEdit}); auto-staging their edit on a shadow
 *     would silently change what "mod edits a live listing" means.
 *   - not `approved`, or already a shadow → UNCHANGED (edited in place, as before).
 *   - owner + `approved` + not a shadow → `beginListingRevision` (idempotent: reuses
 *     an in-flight shadow) and the shadow becomes the target.
 *
 * Read back from the PRIMARY — the shadow may have been INSERTed microseconds ago.
 *
 * 🔴 Callers MUST still run {@link assertOwnerAssetEditable} on the RESOLVED target.
 * That is the defence-in-depth that makes this fail CLOSED: if this ever returns the
 * live parent for an owner (a bug here, a `beginListingRevision` that resolved to the
 * wrong row), the guard throws BAD_REQUEST instead of mutating the served listing.
 */
async function resolveOwnerAssetEditTarget(
  listing: OwnedListing,
  user: SessionUser
): Promise<OwnedListing> {
  if (user.isModerator) return listing;
  if (listing.status !== 'approved' || listing.revisionOfId != null) return listing;
  // Dynamic import: `offsite-listing.service` imports THIS module (the floor gates),
  // so a static import would close a cycle at module-eval time.
  const { beginListingRevision } = await import('~/server/services/blocks/offsite-listing.service');
  const { shadowId } = await beginListingRevision({ listingId: listing.id, userId: user.id });
  return loadOwnedListing(shadowId, user, dbWrite);
}

/**
 * Match ONE screenshot row against the clone-set of another listing — the pure core
 * of the parent-row-id re-map.
 *
 * 🔴 WHY THIS EXISTS. `removeListingScreenshot` / `updateListingScreenshotCaption` /
 * `reorderListingScreenshots` take `AppListingScreenshot` ROW ids. Before a shadow
 * exists the ids the client holds are the LIVE PARENT's rows — so a "remove
 * screenshot" issued against them would delete a row from the listing that is
 * currently being served, bypassing moderator review entirely. That is the exact
 * data-loss hazard the 🔴 SECURITY note on `GetMyListingForAppResult.assets` warns
 * about. Under lazy creation the write path therefore re-keys the row id onto the
 * freshly-cloned shadow row before mutating anything.
 *
 * `beginListingRevision` clones each parent screenshot with the SAME `imageId`,
 * `order` and `caption`, so immediately after a mint the mapping is exact. Matching
 * is deliberately conservative and FAILS CLOSED (`null` → the caller throws and asks
 * the client to refresh) rather than guessing:
 *
 *   1. exactly one candidate with the same `(imageId, order)` — the fresh-clone case;
 *   2. else exactly one candidate with the same non-null `imageId` — survives a
 *      reorder on the shadow (a second tab) that moved the row;
 *   3. else `null` — ambiguous (the same image attached twice) or gone.
 *
 * Re-keying on `imageId` rather than changing the procs' signatures keeps the wire
 * contract (and the `civitai` CLI's `AppBlocksSubmit`-scoped calls) unchanged.
 */
export function matchClonedScreenshotRow(
  source: { imageId: number | null; order: number },
  candidates: { id: string; imageId: number | null; order: number }[]
): string | null {
  const exact = candidates.filter((c) => c.imageId === source.imageId && c.order === source.order);
  if (exact.length === 1) return exact[0].id;
  if (source.imageId != null) {
    const byImage = candidates.filter((c) => c.imageId === source.imageId);
    if (byImage.length === 1) return byImage[0].id;
  }
  return null;
}

/**
 * Re-map screenshot ROW ids from `sourceListingId` onto `targetListingId` (the shadow
 * that {@link resolveOwnerAssetEditTarget} just minted). Reads BOTH sides from the
 * PRIMARY — the target's rows were created in the mint transaction. Throws
 * BAD_REQUEST if any id can't be matched, so an unmappable request is refused rather
 * than applied to the wrong row (and never to the parent's).
 */
/**
 * 🔴 A row-id-keyed write matched NOTHING under the listing it was RESOLVED against.
 *
 * Every screenshot write below is scoped `{ id, appListingId: <resolved listing> }`
 * rather than `{ id }`, because the resolved id can stop belonging to that listing
 * between the resolve and the write: `applyApprovedRevision` REPARENTS the shadow's
 * rows onto the live parent (`updateMany({ where: { appListingId: shadowId } }, {
 * appListingId: parentId })`). A moderator approving in that window would turn a
 * resolved SHADOW row id into a PARENT row id — and an unscoped
 * `delete({ where: { id } })` would then delete a screenshot off the LIVE served
 * listing, which is the exact hazard the whole re-map exists to prevent. Scoping the
 * write makes it structurally impossible: the write matches 0 rows and this throws,
 * instead of hitting the parent.
 *
 * Same client-facing copy as the fail-closed re-map — from the owner's side it is the
 * same situation (their revision moved under them; refresh and retry).
 */
function throwScreenshotNoLongerOnRevision(): never {
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message:
      'This screenshot is no longer available on your revision. Refresh the page and try again.',
  });
}

/**
 * Aborts the post-delete re-pack transaction WITHOUT surfacing an error.
 *
 * The re-pack is the one screenshot write on this path where `count !== 1` must NOT
 * become a refusal — see the note at its call site in {@link removeListingScreenshot}.
 * Rolling back needs a throw, but the caller's delete already succeeded, so the throw
 * is caught and swallowed one frame up. Never escapes this module.
 */
class ListingScreenshotRepackAborted extends Error {}

async function remapScreenshotRowIds(args: {
  screenshotIds: string[];
  sourceListingId: string;
  targetListingId: string;
}): Promise<string[]> {
  const [sourceRows, targetRows] = await Promise.all([
    dbWrite.appListingScreenshot.findMany({
      where: { appListingId: args.sourceListingId },
      select: { id: true, imageId: true, order: true },
    }),
    dbWrite.appListingScreenshot.findMany({
      where: { appListingId: args.targetListingId },
      select: { id: true, imageId: true, order: true },
    }),
  ]);
  const sourceById = new Map(sourceRows.map((r) => [r.id, r]));
  return args.screenshotIds.map((id) => {
    const source = sourceById.get(id);
    const mapped = source ? matchClonedScreenshotRow(source, targetRows) : null;
    if (!mapped) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'This screenshot is no longer available on your revision. Refresh the page and try again.',
      });
    }
    return mapped;
  });
}

/**
 * Re-check that the stored object an `Image` row was MEASURED from is still the
 * object at that key, and refuse the attach if it demonstrably is not.
 *
 * WHY THIS EXISTS. Every rule {@link loadValidatedImage} applies — the per-kind
 * dimension bounds, the aspect ratio, the MIME allowlist, the byte cap — reads the
 * `Image` row's own columns. Those columns are trustworthy at the moment they are
 * written, because the persist procs derive them from the stored bytes rather than
 * from anything the client said. They are not automatically trustworthy LATER: the
 * upload grant for a key outlives the measurement, so an object can be replaced
 * after its row was written, leaving the row describing bytes that are no longer
 * there. Validating the columns then validates a description, not the media.
 *
 * Persist records the store's entity tag next to the measurement; this compares it
 * to the live one at the point the measurement is relied upon, which is the only
 * place the guarantee actually has to hold.
 *
 * 🔴 FAILS CLOSED ON DISAGREEMENT ONLY. A row with no recorded tag (written before
 * this existed, or by a path that never measures an uploaded object), an object the
 * store says is gone, or a store that cannot be consulted all classify as
 * `unverifiable` — and are ALLOWED through, because none of them is evidence that
 * anything changed, and rejecting on them would turn a store hiccup into a blocked
 * attach for images that are perfectly fine. See
 * {@link classifyStoredObjectIntegrity}, which owns that distinction, and the same
 * three-state posture on `headObject` in `~/utils/s3-utils`.
 *
 * The head request is issued ONLY when the row actually carries a tag, so rows that
 * cannot be checked cost no extra round trip — and `stored-image-probe` (and the
 * S3 client graph behind it) stays out of this module's static import graph.
 *
 * 🔴 EVERY OUTCOME THAT IS NOT `match` IS LOGGED, and the three `unverifiable`
 * reasons reachable from here are kept apart on the way out. (Three, not the
 * classifier's four: `no-recorded-etag` is short-circuited above and can never be
 * emitted from this consumer — see the note at the end of this block.) Without that,
 * a guard that is firing and a guard that is inert produce exactly the same
 * observable — nothing — and the reasons are operationally different signals rather
 * than one blob: a rising `store-unreachable` is an infrastructure incident, a rising
 * `no-current-etag` is a backend that stopped returning tags (which quietly disarms
 * this check for every row), and `mismatch` is the case the guard exists for. A
 * steady trickle of any of them is the only way to notice that the fail-open branch
 * has become the ONLY branch.
 *
 * 🔴 The event carries NO storage key, bucket, URL or caller identity — the reason
 * plus the asset kind plus the row id is everything an operator needs to tell these
 * classes apart, and an object key in a log is an upload location in a log.
 *
 * `no-recorded-etag` is deliberately unreachable from here: the early return above
 * skips the head entirely for a row that has nothing recorded, which is the expected
 * steady state for every row written before this existed and is not worth an event
 * each. It stays in the classifier's vocabulary for callers that do not short-circuit.
 */
async function assertStoredObjectUnchanged(
  image: { id: number; url: string; metadata: unknown },
  kind: ListingAssetKind
) {
  const recordedEtag = readRecordedEtag(image.metadata);
  if (recordedEtag === null) return;

  const { headStoredImage } = await import('~/server/utils/stored-image-probe');
  const verdict = classifyStoredObjectIntegrity(recordedEtag, await headStoredImage(image.url));
  if (verdict.status === 'match') return;

  logToAxiom({
    name: 'listing-asset-integrity',
    /**
     * 🔴 `warning`, INCLUDING for `mismatch`, and deliberately so.
     *
     * `type` is what the Alloy→Loki pipeline reads as the log level (see the
     * SEVERITY FIELD note in `~/server/logging/client`), and that same file states
     * the rule this obeys: a BAD_REQUEST-class fault is normal user feedback and
     * "must never be logged at error severity, or they drown out the real
     * server-side failures on the error board". A `mismatch` ends in exactly such a
     * rejection, and any author can produce one at will simply by replacing the
     * object behind a key they own — so at `error` this is an author-controlled tap
     * on the error board, which is the failure mode that rule exists to prevent.
     *
     * The severity was never the discriminator anyway: `status` and `reason` are
     * emitted as their own fields precisely so these outcomes are separable, and a
     * query or alert on `status="mismatch"` is both narrower and more stable than
     * one on a level shared with every other error in the app. Nothing is lost by
     * dropping to `warning` except the flooding.
     */
    type: 'warning',
    status: verdict.status,
    reason: verdict.status === 'unverifiable' ? verdict.reason : null,
    kind,
    imageId: image.id,
  }).catch(() => null);
  // 🔴 That `.catch(() => null)` is LOAD-BEARING, not tidiness. Nothing awaits the
  // call above, so a rejecting sink — `logToAxiom` awaits an ingest that rejects
  // when Axiom itself is degraded — has nowhere to go but `unhandledRejection`, and
  // the attach it is merely OBSERVING would be taken down by the observation. Same
  // reasoning as `~/server/redis/fail-open-log`, `~/server/meilisearch/client` and
  // `~/server/signals/wrapper`. Pinned by
  // `./__tests__/listing-asset-integrity-logging.test.ts`, which needs a file of its
  // own to be falsifiable at all — a `vi.fn()` sink marks the rejection handled.

  if (verdict.status !== 'mismatch') return;

  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: 'that image has changed since it was uploaded — upload it again',
  });
}

/**
 * The result of {@link loadValidatedImage}: a discriminated union.
 *
 *   - `{ pending: true }`  — the Image exists, is owned + format-valid, but its
 *     scan has not reached `Scanned` yet AND the caller did NOT opt into
 *     `allowPending`. NOT an error; NO db write; the caller returns
 *     `{ status: 'pending' }`. (Legacy path — no live caller uses it now that the
 *     LISTING-MEDIA attach procs pass `allowPending: true`.)
 *   - `{ pending: false, imageId, scanPending? }` — attachable NOW (a db write is
 *     safe). `scanPending: true` means the write was allowed while the scan is
 *     STILL in-flight (only possible under `allowPending`) — the image is stored,
 *     but the caller must NOT let the listing go live until the scan lands
 *     `Scanned` (the go-live `assertAssetsScanClean` gate enforces that). Absent /
 *     false ⇒ the image is already `Scanned`.
 */
type LoadValidatedImageResult =
  | { pending: true }
  | { pending: false; imageId: number; scanPending?: boolean };

/**
 * Load an Image, assert the caller owns it (or is a mod), and validate it for the
 * given asset kind. Returns a discriminated {@link LoadValidatedImageResult}.
 *
 * `allowPending` (default `false`) controls what happens while the scan is
 * IN-FLIGHT (a non-terminal `Pending` / `Error`-retry / `PendingManualAssignment`
 * / `Rescan` state):
 *   - `false` (legacy) → `{ pending: true }` (NO write; the caller reports pending).
 *   - `true`           → `{ pending: false, imageId, scanPending: true }` — the
 *     image is attachable NOW so the caller WRITES it immediately (the wait moves
 *     from attach-time to the go-live scan gate). The LISTING-MEDIA attach procs
 *     (`setListingIcon` / `setListingCover` / `addListingScreenshot`) pass `true`.
 *
 * TERMINAL failures ALWAYS THROW regardless of `allowPending` (real errors the
 * client surfaces + stops polling on): missing → NOT_FOUND; not owned → FORBIDDEN;
 * the stored object no longer being the one the row was measured from
 * ({@link assertStoredObjectUnchanged}) → BAD_REQUEST; bad format → BAD_REQUEST;
 * `ImageIngestionStatus.NotFound` (scanner couldn't fetch the bytes) → BAD_REQUEST;
 * `Blocked` (prohibited content) → BAD_REQUEST. A `Blocked` / `NotFound` image is
 * terminal-bad and is NEVER written, even under `allowPending`.
 *
 * 🔴 The integrity re-check runs BEFORE the column validation deliberately: the
 * validation's inputs are the persisted measurements, so confirming they still
 * describe the stored object is a precondition for the bounds meaning anything.
 *
 * Content RATING is deliberately NOT gated here (W13): the scanner's per-image
 * level is imprecise, every off-site listing is mod-reviewed before it is visible,
 * and the rating is derived from + confirmed against the assets at approve. The
 * `Blocked` reject is KEPT — it is a hard integrity reject (prohibited content),
 * not a rating mismatch.
 */
async function loadValidatedImage(
  imageId: number,
  kind: ListingAssetKind,
  user: SessionUser,
  opts: { allowPending?: boolean } = {}
): Promise<LoadValidatedImageResult> {
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: {
      id: true,
      userId: true,
      // The storage key the row's measurements were taken from — the integrity
      // re-check below needs it; nothing else here reads it.
      url: true,
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
  await assertStoredObjectUnchanged(image, kind);
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

  // Content-status gate. A TERMINAL ingestion failure (NotFound = the scanner
  // couldn't fetch the bytes; Blocked = prohibited content) still THROWS
  // BAD_REQUEST — the client shows the message + stops polling. A non-terminal
  // scanning state (Pending / Error-retry / PendingManualAssignment) is NOT an
  // error: return `{ pending: true }` so the caller reports it as a poll-able 200.
  if (image.ingestion === ImageIngestionStatus.NotFound) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: "that image couldn't be imported — upload it manually instead",
    });
  }
  if (image.ingestion === ImageIngestionStatus.Blocked) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'that image was rejected during scanning — choose a different image',
    });
  }
  if (image.ingestion !== ImageIngestionStatus.Scanned) {
    // Still scanning (Pending / Error-retry / PendingManualAssignment / Rescan).
    // Under `allowPending` the caller WRITES the id immediately + flags the pending
    // scan (the go-live `assertAssetsScanClean` gate is the safety net); otherwise
    // it is a NON-error poll-able result (the legacy attach-time wait).
    if (opts.allowPending) return { pending: false, imageId: image.id, scanPending: true };
    return { pending: true };
  }
  return { pending: false, imageId: image.id };
}

// ---------------------------------------------------------------------------
// Go-live scan-clean gate (QUALITY gate — sits ALONGSIDE the icon+cover PRESENCE
// floor `assertListingMeetsFloor`). The presence floor never inspects scan state;
// this one re-reads each attached asset's `ingestion` from the PRIMARY (`dbWrite`,
// or the caller's `tx`) and refuses to let a listing go live while ANY asset is
// still scanning or was `Blocked`. This is what lets attach + submit stay
// permissive with an in-flight scan: the wait is deferred to HERE.
//
// 🔴 INVARIANT: no approved/live listing may ever reference a non-`Scanned` or a
// `Blocked` image. Every go-live path (first-time approve + revision apply) MUST
// call this, and — because a scan can flip between the pre-tx fail-fast and the
// authoritative in-tx read — the in-tx call is the authority (TOCTOU).
// ---------------------------------------------------------------------------

export type ListingScanAssets = {
  iconId: number | null;
  coverId: number | null;
  /** The listing's screenshot Image ids (imageId-bearing rows only). */
  screenshotImageIds: number[];
};

/** A minimal image reader — `dbRead` / `dbWrite` / an interactive `tx` all satisfy it. */
type ImageIngestionReader = {
  image: {
    findMany: (args: {
      where: { id: { in: number[] } };
      select: { id: true; ingestion: true };
    }) => Promise<{ id: number; ingestion: string | null }[]>;
  };
};

/**
 * Re-read every attached asset's `ingestion` and THROW `BAD_REQUEST` if ANY is not
 * terminally `Scanned` — naming which asset is `blocked` vs still `pending`. Reads
 * the PRIMARY by default (`dbWrite`); pass the interactive `tx` at the in-tx
 * (authoritative) go-live site so the check is row-consistent with the status flip.
 *
 * A `Blocked` asset is reported as `blocked` (prohibited content — the owner must
 * replace it); anything else non-`Scanned` (Pending / Error / PendingManualAssignment
 * / Rescan / NotFound / a missing/deleted row) is reported as `pending` (still
 * resolving). An asset with a null id (unset icon/cover) is simply absent — presence
 * is the floor gate's job, not this one.
 */
export async function assertAssetsScanClean(
  assets: ListingScanAssets,
  db: ImageIngestionReader = dbWrite
): Promise<void> {
  const tagged: { kind: 'icon' | 'cover' | 'screenshot'; id: number }[] = [
    ...(assets.iconId != null ? [{ kind: 'icon' as const, id: assets.iconId }] : []),
    ...(assets.coverId != null ? [{ kind: 'cover' as const, id: assets.coverId }] : []),
    ...assets.screenshotImageIds.map((id) => ({ kind: 'screenshot' as const, id })),
  ];
  if (tagged.length === 0) return;

  const rows = await db.image.findMany({
    where: { id: { in: tagged.map((t) => t.id) } },
    select: { id: true, ingestion: true },
  });
  const ingestionById = new Map(rows.map((r) => [r.id, r.ingestion]));

  const blocked = new Set<string>();
  const pending = new Set<string>();
  for (const { kind, id } of tagged) {
    const ingestion = ingestionById.get(id) ?? null;
    if (ingestion === ImageIngestionStatus.Scanned) continue;
    if (ingestion === ImageIngestionStatus.Blocked) blocked.add(kind);
    else pending.add(kind);
  }
  if (blocked.size === 0 && pending.size === 0) return;

  const parts: string[] = [];
  if (blocked.size > 0) parts.push(`blocked: ${[...blocked].join(', ')}`);
  if (pending.size > 0) parts.push(`still scanning: ${[...pending].join(', ')}`);
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: `Listing media has not finished scanning cleanly and cannot go live (${parts.join(
      '; '
    )}). Replace any blocked media and wait for scans to complete.`,
  });
}

/**
 * Convenience wrapper around {@link assertAssetsScanClean} that LOADS a listing's
 * attached assets (icon / cover / imageId-bearing screenshots) by id from the given
 * client and then runs the scan-clean gate. Shared by every `removed`/`pending` →
 * `approved` go-live flip that republishes EXISTING assets (relist / owner-republish /
 * onsite reset re-approve) — a `removed`/`pending` listing is still directly
 * asset-editable, so it may reference a still-scanning / `Blocked` image.
 *
 * `db` is typed `Prisma.TransactionClient` so the in-tx callers pass their `tx` (the
 * authoritative primary read); a non-transactional caller may pass `dbWrite` (a
 * `PrismaClient` is structurally a `TransactionClient` for these reads). No-op for a
 * listing with no attached assets / all-`Scanned` assets.
 */
export async function assertListingAssetsScanCleanInTx(
  db: Prisma.TransactionClient,
  appListingId: string
): Promise<void> {
  const listing = await db.appListing.findUnique({
    where: { id: appListingId },
    select: { iconId: true, coverId: true },
  });
  if (!listing) return;
  const shots = await db.appListingScreenshot.findMany({
    where: { appListingId, imageId: { not: null } },
    select: { imageId: true },
  });
  await assertAssetsScanClean(
    {
      iconId: listing.iconId,
      coverId: listing.coverId,
      screenshotImageIds: shots.map((s) => s.imageId).filter((v): v is number => v != null),
    },
    db
  );
}

/**
 * Go-live RATING FLOOR for a listing whose media was attached while it was directly
 * asset-editable (a pre-approval `draft` / reset `pending` listing). Re-derives the
 * rating from the current assets' max `nsfwLevel` and returns `declaredRating` RAISED
 * to the derived value when the media is more mature — never lowered.
 *
 * 🔴 The on-site counterpart of the off-site approve's `resolveApprovalContentRating`
 * floor. It upholds the invariant stated at {@link reDeriveContentRatingForModLiveEdit}:
 * *draft/pending/shadow listings are rated at approve*. Without it a manifest-declared
 * `contentRating` (author-controlled) is stamped verbatim over media the author attached
 * while pending — and nothing else catches it, because the attach path
 * ({@link loadValidatedImage}) rejects only `Blocked`/`NotFound` images, never a
 * `Scanned` mature one. An under-rated listing then passes
 * `listingMatureFilter(redCapable=false)` (`content_rating NOT IN ('r','x')`) and shows
 * mature store art to SFW-only users.
 *
 * RAISE-ONLY, so it can only ever tighten: a deliberately higher rating is never
 * auto-lowered by tamer media, and a listing with no attached assets (or a missing row)
 * returns `declaredRating` unchanged. `db` is typed `Prisma.TransactionClient` so an
 * in-tx caller passes its `tx`; a non-transactional caller may pass `dbWrite` (a
 * `PrismaClient` is structurally a `TransactionClient` for these reads).
 */
export async function resolveListingRatingFloorInTx(
  db: Prisma.TransactionClient,
  appListingId: string,
  declaredRating: string | null
): Promise<string | null> {
  const listing = await db.appListing.findUnique({
    where: { id: appListingId },
    select: { iconId: true, coverId: true },
  });
  if (!listing) return declaredRating;
  const shots = await db.appListingScreenshot.findMany({
    where: { appListingId, imageId: { not: null } },
    select: { imageId: true },
  });
  const imageIds = [listing.iconId, listing.coverId, ...shots.map((s) => s.imageId)].filter(
    (v): v is number => v != null
  );
  if (imageIds.length === 0) return declaredRating;
  const images = await db.image.findMany({
    where: { id: { in: imageIds } },
    select: { nsfwLevel: true },
  });
  const derived = deriveContentRatingFromAssets(images.map((i) => ({ nsfwLevel: i.nsfwLevel })));
  // Floor: only raise. `nsfwLevelFromContentRating` maps null → the SFW floor, so a null
  // declared rating is raised by any mature asset.
  return nsfwLevelFromContentRating(derived) > nsfwLevelFromContentRating(declaredRating)
    ? derived
    : declaredRating;
}

// ---------------------------------------------------------------------------
// Per-asset scan-status poll (owner/mod-gated). The client attaches an in-flight
// image IMMEDIATELY (the server stores the pending id), then polls THIS to flip a
// per-asset "Scanning…" badge to "Scanned" / "Blocked — replace". Owner-scoped:
// only images the caller owns (mods read any) are returned.
// ---------------------------------------------------------------------------

export type AssetScanStatus = 'scanned' | 'pending' | 'blocked';

/**
 * Read the scan status of a set of Image ids the caller owns (mods: any), from the
 * PRIMARY (`dbWrite`) so a just-completed scan is visible promptly. Maps `ingestion`
 * → `scanned` (Scanned) / `blocked` (Blocked) / `pending` (everything else, incl. a
 * missing/not-owned row — never leaks another user's images). Ids not owned by the
 * caller are simply omitted.
 */
export async function getAssetScanStatuses(
  imageIds: number[],
  user: SessionUser
): Promise<{ statuses: { imageId: number; status: AssetScanStatus }[] }> {
  const unique = [...new Set(imageIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (unique.length === 0) return { statuses: [] };
  const rows = await dbWrite.image.findMany({
    where: { id: { in: unique }, ...(user.isModerator ? {} : { userId: user.id }) },
    select: { id: true, ingestion: true },
  });
  const statuses = rows.map((r) => ({
    imageId: r.id,
    status:
      r.ingestion === ImageIngestionStatus.Scanned
        ? ('scanned' as const)
        : r.ingestion === ImageIngestionStatus.Blocked
        ? ('blocked' as const)
        : ('pending' as const),
  }));
  return { statuses };
}

/**
 * After a MODERATOR directly mutates a LIVE approved listing's asset SET (the only
 * path that bypasses the shadow-revision flow — see {@link assertOwnerAssetEditable}),
 * re-derive `contentRating` from the current assets' max nsfwLevel and FLOOR the
 * stored rating at the derived value (RAISE-ONLY — never auto-lower). Without this a
 * mod adding a more-mature icon/cover/screenshot to a live listing leaves it
 * UNDER-rated: the approve path re-derives, but a direct live-asset edit never runs
 * approve. Raise-only so a mod's deliberate higher rating (or an asset REMOVAL) is
 * never auto-lowered — mirrors `resolveApprovalContentRating`'s floor-at-derived.
 *
 * No-op for everyone else: owner edits on a live listing are blocked by the guard and
 * go through a shadow revision (re-derived at approve); draft/pending/shadow listings
 * are rated at approve. So it fires ONLY for `isModerator` on an `approved` non-shadow
 * (`revisionOfId == null`) listing. Runs INSIDE the caller's `dbWrite.$transaction`
 * (the `tx` param) so the derive+floor is ATOMIC with the asset write that triggered
 * it — parity with approve's `resolveApprovalContentRating`. The guard short-circuits
 * BEFORE any query, so a non-mod / draft / pending / shadow edit adds ZERO queries to
 * the (trivial single-write) transaction. Reading the levels through `tx` keeps the
 * derive row-consistent with the asset mutation just written in the same tx.
 */
async function reDeriveContentRatingForModLiveEdit(
  tx: Prisma.TransactionClient,
  listing: {
    id: string;
    status: string;
    revisionOfId: string | null;
    contentRating: string | null;
  },
  user: SessionUser
): Promise<void> {
  if (!user.isModerator) return;
  if (listing.status !== 'approved' || listing.revisionOfId != null) return;

  const current = await tx.appListing.findUnique({
    where: { id: listing.id },
    select: { iconId: true, coverId: true, contentRating: true },
  });
  if (!current) return;
  const shots = await tx.appListingScreenshot.findMany({
    where: { appListingId: listing.id, imageId: { not: null } },
    select: { imageId: true },
  });
  const imageIds = [current.iconId, current.coverId, ...shots.map((s) => s.imageId)].filter(
    (v): v is number => v != null
  );
  const images = imageIds.length
    ? await tx.image.findMany({ where: { id: { in: imageIds } }, select: { nsfwLevel: true } })
    : [];
  const derived = deriveContentRatingFromAssets(images.map((i) => ({ nsfwLevel: i.nsfwLevel })));
  // RAISE-ONLY floor: bump the stored rating up to `derived` only if derived's
  // ceiling is strictly higher (never auto-lower). `nsfwLevelFromContentRating`
  // maps null → the SFW floor, so a null stored rating is raised by any mature asset.
  if (nsfwLevelFromContentRating(derived) <= nsfwLevelFromContentRating(current.contentRating))
    return;
  await tx.appListing.update({ where: { id: listing.id }, data: { contentRating: derived } });
}

// ---------------------------------------------------------------------------
// Creator asset management (owner/mod-gated).
// ---------------------------------------------------------------------------

/**
 * The LISTING-MEDIA attach procs (`setListingIcon` / `setListingCover` /
 * `addListingScreenshot`) STORE a still-scanning image IMMEDIATELY (they pass
 * `allowPending: true`) and resolve `{ status: 'attached', …, scanPending }` — the
 * `scanPending` flag tells the client to keep a "Scanning…" badge and poll
 * {@link getAssetScanStatuses} until the scan lands. The wait moved from attach-time
 * to the go-live `assertAssetsScanClean` gate. A TERMINAL problem (not-found /
 * not-owned / bad-format / NotFound / Blocked) still THROWS from
 * {@link loadValidatedImage} — a `Blocked` / `NotFound` image is never stored. The
 * `{ status: 'pending' }` variant is retained for the type only (legacy
 * `allowPending: false` callers); the live listing-media procs never return it.
 */
export type SetListingIconResult =
  | { status: 'pending' }
  | { status: 'attached'; iconId: number; scanPending?: boolean };
export type SetListingCoverResult =
  | { status: 'pending' }
  | { status: 'attached'; coverId: number; scanPending?: boolean };
export type AddListingScreenshotResult =
  | { status: 'pending' }
  | { status: 'attached'; id: string; order: number; scanPending?: boolean };

export async function setListingIcon(
  args: { listingId: string; imageId: number },
  user: SessionUser
): Promise<SetListingIconResult> {
  // LAZY MINT: an owner's first edit of a live listing opens the shadow revision here.
  const listing = await resolveOwnerAssetEditTarget(
    await loadOwnedListing(args.listingId, user),
    user
  );
  assertOwnerAssetEditable(listing, user);
  const validated = await loadValidatedImage(args.imageId, 'icon', user, { allowPending: true });
  if (validated.pending) return { status: 'pending' };
  await dbWrite.$transaction(async (tx) => {
    await tx.appListing.update({
      where: { id: listing.id },
      data: { iconId: validated.imageId },
    });
    await reDeriveContentRatingForModLiveEdit(tx, listing, user);
  });
  return { status: 'attached', iconId: validated.imageId, scanPending: validated.scanPending };
}

export async function setListingCover(
  args: { listingId: string; imageId: number },
  user: SessionUser
): Promise<SetListingCoverResult> {
  // LAZY MINT: an owner's first edit of a live listing opens the shadow revision here.
  const listing = await resolveOwnerAssetEditTarget(
    await loadOwnedListing(args.listingId, user),
    user
  );
  assertOwnerAssetEditable(listing, user);
  const validated = await loadValidatedImage(args.imageId, 'cover', user, { allowPending: true });
  if (validated.pending) return { status: 'pending' };
  await dbWrite.$transaction(async (tx) => {
    await tx.appListing.update({
      where: { id: listing.id },
      data: { coverId: validated.imageId },
    });
    await reDeriveContentRatingForModLiveEdit(tx, listing, user);
  });
  return { status: 'attached', coverId: validated.imageId, scanPending: validated.scanPending };
}

export async function addListingScreenshot(
  args: { listingId: string; imageId: number; caption?: string | null },
  user: SessionUser
): Promise<AddListingScreenshotResult> {
  // LAZY MINT: an owner's first edit of a live listing opens the shadow revision here.
  const listing = await resolveOwnerAssetEditTarget(
    await loadOwnedListing(args.listingId, user),
    user
  );
  assertOwnerAssetEditable(listing, user);
  const validated = await loadValidatedImage(args.imageId, 'screenshot', user, {
    allowPending: true,
  });
  if (validated.pending) return { status: 'pending' };
  const imageId = validated.imageId;
  const scanPending = validated.scanPending;

  // COUNT cap — reject the (N+1)th (mirrors E5 MAX_SCREENSHOTS "reject, not truncate").
  // Read the count + max order from dbWrite (primary), NOT the replica: under
  // replica lag two concurrent adds could both pass `count < 8` (a 9th row) or
  // compute the same `order`.
  const existing = await dbWrite.appListingScreenshot.findMany({
    where: { appListingId: listing.id },
    select: { order: true },
    orderBy: { order: 'desc' },
    take: 1,
  });
  const count = await dbWrite.appListingScreenshot.count({
    where: { appListingId: listing.id },
  });
  if (count >= MAX_LISTING_SCREENSHOTS) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `A listing may have at most ${MAX_LISTING_SCREENSHOTS} screenshots`,
    });
  }
  const nextOrder = existing.length > 0 ? existing[0].order + 1 : 0;
  const id = newAppListingScreenshotId();
  await dbWrite.$transaction(async (tx) => {
    await tx.appListingScreenshot.create({
      data: {
        id,
        appListingId: listing.id,
        imageId,
        order: nextOrder,
        caption: args.caption ?? null,
      },
    });
    await reDeriveContentRatingForModLiveEdit(tx, listing, user);
  });
  return { status: 'attached', id, order: nextOrder, scanPending };
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
  // LAZY MINT: an owner's first edit of a live listing opens the shadow revision here.
  const listing = await resolveOwnerAssetEditTarget(
    await loadOwnedListing(args.listingId, user),
    user
  );
  assertOwnerAssetEditable(listing, user);
  // 🔴 `orderedIds` are PARENT row ids whenever the mint above just happened. Re-key
  // them onto the shadow's clones BEFORE the permutation check — otherwise the check
  // fails (parent ids aren't in the shadow's set) or, worse without the retarget,
  // reorders the LIVE listing's rows.
  const orderedIds =
    listing.id === args.listingId
      ? args.orderedIds
      : await remapScreenshotRowIds({
          screenshotIds: args.orderedIds,
          sourceListingId: args.listingId,
          targetListingId: listing.id,
        });
  // Read the current set from dbWrite (primary): under replica lag the reorder
  // could target a just-deleted id (P2025 → 500 after the delete committed) or
  // miss a just-added row.
  const current = await dbWrite.appListingScreenshot.findMany({
    where: { appListingId: listing.id },
    select: { id: true },
  });
  const currentIds = new Set(current.map((s) => s.id));
  const nextIds = new Set(orderedIds);
  const samePermutation =
    currentIds.size === nextIds.size &&
    orderedIds.length === current.length &&
    orderedIds.every((id) => currentIds.has(id));
  if (!samePermutation) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'orderedIds must be exactly the listing’s current screenshot ids',
    });
  }
  // 🔴 LISTING-SCOPED writes (see `throwScreenshotNoLongerOnRevision`): if an approve
  // reparents the shadow's rows onto the live parent between the check above and here,
  // every `updateMany` matches 0 rows — the live listing's ordering is left alone and
  // the owner is told to refresh, instead of the reorder silently landing on it.
  //
  // 🔴 …and the refusal is raised INSIDE an INTERACTIVE transaction so it actually
  // ROLLS BACK. The array form (`$transaction([...])`) COMMITS before its results are
  // inspected, so a reparent landing mid-flight under READ COMMITTED left some orders
  // written AND threw — the worst of both. All-or-nothing is the property this guard
  // claims, so it has to be the property it has.
  await dbWrite.$transaction(async (tx) => {
    for (let index = 0; index < orderedIds.length; index++) {
      const { count } = await tx.appListingScreenshot.updateMany({
        where: { id: orderedIds[index], appListingId: listing.id },
        data: { order: index },
      });
      if (count !== 1) throwScreenshotNoLongerOnRevision();
    }
  });
  return { reordered: orderedIds.length };
}

/**
 * Resolve a ROW-ID-keyed screenshot mutation onto its EFFECTIVE row.
 *
 * 🔴 THE data-loss guard for lazy shadow creation. `screenshotId` is an
 * `AppListingScreenshot` row id, and before a shadow exists the client holds the
 * LIVE PARENT's row ids — so this is the one place where a stale id could delete /
 * reorder / re-caption a row off the listing that is currently being served, with no
 * moderator review. It loads the row, enforces ownership, mints the shadow via
 * {@link resolveOwnerAssetEditTarget}, and RE-KEYS the row id onto the shadow's clone
 * ({@link matchClonedScreenshotRow}) — failing closed if it can't.
 *
 * Returns the row id + listing id the caller must use. Callers MUST run
 * {@link assertOwnerAssetEditable} on the returned `listing` (defence in depth: it
 * throws if the resolution ever yields the live parent for an owner).
 */
async function resolveOwnerScreenshotTarget(
  screenshotId: string,
  user: SessionUser
): Promise<{ screenshotId: string; listing: OwnedListing }> {
  // 🔴 The listing's `userId` is deliberately NOT selected any more — see the note on
  // the removed early gate below.
  const select = { id: true, appListingId: true } as const;
  // 🔴 READ-AFTER-WRITE. The replica answers first, but a MISS off the replica is NOT
  // authoritative here: once the first mutation mints the shadow, `getMyListingForApp`
  // re-projects the SHADOW's row ids from the PRIMARY, so the very next call arrives
  // holding ids for rows INSERTed milliseconds ago. Trusting a lagging replica turns
  // the owner's second edit into a spurious `NOT_FOUND: Screenshot not found` — the
  // same class of bug #3476 fixed for `loadListingEditView`, whose window this PR
  // widened by moving the mint onto the write path. A hit on the replica means the row
  // is old, and its listing (created in the SAME clone transaction) is old too, so the
  // pool that answered is also the right pool for the listing load.
  let db: typeof dbRead = dbRead;
  let shot = await dbRead.appListingScreenshot.findUnique({ where: { id: screenshotId }, select });
  if (!shot) {
    db = dbWrite;
    shot = await dbWrite.appListingScreenshot.findUnique({ where: { id: screenshotId }, select });
  }
  if (!shot) throw new TRPCError({ code: 'NOT_FOUND', message: 'Screenshot not found' });
  // 🔴 THE EARLY OWNER CHECK THAT USED TO SIT HERE IS GONE, and its removal is the point
  // rather than a shortcut. It read `shot.appListing.userId` — the DENORMALIZED owner
  // column — and then asked `loadOwnedListing(shot.appListingId, user, db)` the SAME
  // question about the SAME listing on the very next line. Two spellings of one
  // predicate is how they drift: this copy was the stale-column spelling, so on a
  // drifted onsite listing it refused the real owner (and admitted the stale name)
  // BEFORE the correct gate below ever ran. A redundant guard also makes a mutation
  // kill unattributable — whichever copy you break, the other one throws the same
  // FORBIDDEN with the same message. One gate, one line: `loadOwnedListing`.
  //
  // Pool discipline is unchanged: `db` is whichever pool actually answered for this
  // screenshot, and it is handed straight to the gate that now owns the decision.
  const sourceListing = await loadOwnedListing(shot.appListingId, user, db);
  const listing = await resolveOwnerAssetEditTarget(sourceListing, user);
  if (listing.id === shot.appListingId) return { screenshotId, listing };
  const [mapped] = await remapScreenshotRowIds({
    screenshotIds: [screenshotId],
    sourceListingId: shot.appListingId,
    targetListingId: listing.id,
  });
  return { screenshotId: mapped, listing };
}

/**
 * Set/clear a screenshot's caption.
 *
 * 🔴 RETURN-SHAPE NOTE — `id` is the row that was actually written, which is NOT
 * necessarily `args.screenshotId`. When this call is the owner's FIRST edit of a live
 * approved listing it mints the shadow revision and re-keys the caller's PARENT row id
 * onto the shadow's clone ({@link resolveOwnerScreenshotTarget}); the returned id is
 * that clone's. Reporting the caller's own id back would name a row this call did not
 * touch — on the live listing — so the resolved id is the honest answer. Any caller
 * that echoes or compares it (the `civitai` CLI is wire-reachable here under
 * `AppBlocksSubmit`) must treat it as the NEW id, not a round-trip of its input. The
 * INPUT schema is unchanged, so no released client breaks.
 */
export async function updateListingScreenshotCaption(
  args: { screenshotId: string; caption?: string | null },
  user: SessionUser
): Promise<{ id: string }> {
  const { screenshotId, listing } = await resolveOwnerScreenshotTarget(args.screenshotId, user);
  assertOwnerAssetEditable(listing, user);
  // 🔴 LISTING-SCOPED write — see `throwScreenshotNoLongerOnRevision`.
  const { count } = await dbWrite.appListingScreenshot.updateMany({
    where: { id: screenshotId, appListingId: listing.id },
    data: { caption: args.caption ?? null },
  });
  if (count !== 1) throwScreenshotNoLongerOnRevision();
  // NB: `id` is the RESOLVED row id, which differs from `args.screenshotId` whenever
  // this call minted the shadow (the parent row id was re-keyed onto its clone).
  return { id: screenshotId };
}

/**
 * Remove a screenshot, then RE-PACK the remaining orders to a contiguous 0..n-1
 * so no gaps accumulate (the read path can rely on dense ordering).
 *
 * 🔴 RETURN-SHAPE NOTE — `removed` is the row that was actually deleted, which is NOT
 * necessarily `args.screenshotId`: a first edit of a live listing mints the shadow and
 * re-keys the caller's PARENT row id onto the clone, and it is the CLONE that is
 * deleted (deleting the parent's row is the data-loss hazard this whole path exists to
 * prevent). Echoing the caller's id back would therefore report a deletion that did not
 * happen. Same wire-contract note as {@link updateListingScreenshotCaption}: input
 * schema unchanged, only the returned id can differ from the one passed in.
 */
export async function removeListingScreenshot(
  args: { screenshotId: string },
  user: SessionUser
): Promise<{ removed: string }> {
  // 🔴 Re-key a PARENT row id onto the (lazily minted) shadow's clone BEFORE deleting
  // anything — a delete against a parent row id would destroy a screenshot off the
  // LIVE served listing with no moderator review. Fails closed if unmappable.
  const { screenshotId, listing } = await resolveOwnerScreenshotTarget(args.screenshotId, user);
  // 🔴 Never delete a screenshot from a LIVE approved listing directly (bypasses
  // review) — edits go through a shadow revision. Mods bypass (curation). Evaluated
  // on the RESOLVED target, so a re-map that failed to leave the parent throws here.
  assertOwnerAssetEditable(listing, user);
  // 🔴 LISTING-SCOPED delete — see `throwScreenshotNoLongerOnRevision`. This is the
  // one write where the reparent race is destructive: an unscoped
  // `delete({ where: { id } })` would remove the row from the LIVE listing it had just
  // been moved onto.
  const { count } = await dbWrite.appListingScreenshot.deleteMany({
    where: { id: screenshotId, appListingId: listing.id },
  });
  if (count !== 1) throwScreenshotNoLongerOnRevision();
  // (no re-derive: removal/reorder/caption can never RAISE the derived rating)

  // Re-pack: contiguous orders over the survivors (ordered by their old order).
  // Read the survivor set from dbWrite (primary): under replica lag the replica may
  // still return the just-deleted row, and the scoped write below would then match 0
  // rows on it and abandon the whole re-pack (before the write was scoped, the same
  // stale row was a P2025/500 after the delete had already committed).
  const remaining = await dbWrite.appListingScreenshot.findMany({
    where: { appListingId: listing.id },
    select: { id: true },
    orderBy: { order: 'asc' },
  });
  if (remaining.length > 0) {
    // 🔴 LISTING-SCOPED, like every other screenshot write on this path. The unscoped
    // `update({ where: { id } })` this replaces was the last hole in the invariant:
    // an approve reparenting the shadow's rows onto the live parent between the
    // `findMany` above and these writes would have written `order` onto rows that now
    // belong to the LIVE served listing.
    //
    // 🔴 `count !== 1` here is a deliberate NO-OP, NOT the refusal the other three
    // writes raise — this is the one place where refusing is the worse answer. The
    // delete has ALREADY committed and is exactly what the owner asked for; a reparent
    // landing afterwards is a moderator's approve, not user error, so reporting a
    // failure would name a removal that in fact succeeded. And there is no state left
    // to protect: the re-pack only densifies `order`, and the reparented rows keep the
    // orders `applyApprovedRevision` moved them with. The abort is still raised INSIDE
    // the interactive transaction so the rows re-packed before the race are rolled
    // back — abandoning it half-done would leave exactly the `order` gaps the re-pack
    // exists to remove.
    await dbWrite
      .$transaction(async (tx) => {
        for (let index = 0; index < remaining.length; index++) {
          const { count } = await tx.appListingScreenshot.updateMany({
            where: { id: remaining[index].id, appListingId: listing.id },
            data: { order: index },
          });
          if (count !== 1) throw new ListingScreenshotRepackAborted();
        }
      })
      .catch((e) => {
        if (!(e instanceof ListingScreenshotRepackAborted)) throw e;
      });
  }
  return { removed: screenshotId };
}

export type ListingAssetsView = {
  listingId: string;
  iconId: number | null;
  coverId: number | null;
  /** Detected `nsfwLevel` of the icon/cover Image (null if unset/absent). */
  iconNsfwLevel: number | null;
  coverNsfwLevel: number | null;
  /** Scan status of the icon/cover Image (null if unset/absent) — the mod-review
   *  surface shows this + refuses to approve until every asset is `scanned`. */
  iconScanStatus: AssetScanStatus | null;
  coverScanStatus: AssetScanStatus | null;
  screenshots: {
    id: string;
    imageId: number | null;
    order: number;
    caption: string | null;
    /** Detected `nsfwLevel` of the backing Image (null if the Image was deleted). */
    nsfwLevel: number | null;
    /** Scan status of the backing Image (null if the Image was deleted). */
    scanStatus: AssetScanStatus | null;
  }[];
  completeness: ListingAssetsCompleteResult;
  /** True when at least one attached asset is `blocked` — approve MUST be refused. */
  hasBlockedAsset: boolean;
  /** True when at least one attached asset is still `pending` a scan — approve is
   *  refused until it lands (surfaced so the mod knows WHY approve is blocked). */
  hasPendingScan: boolean;
};

/**
 * Owner/mod read of a listing's current assets for the creator dashboard + the mod
 * review modal. Includes each asset's detected `nsfwLevel` (owner/mod-gated, so it
 * is not a public exposure) so the review modal can derive the content rating from
 * the assets' max level.
 */
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

  // Resolve the detected nsfwLevel of every backing Image in ONE query.
  const imageIds = [listing.iconId, listing.coverId, ...screenshots.map((s) => s.imageId)].filter(
    (v): v is number => v != null
  );
  const images = imageIds.length
    ? await dbRead.image.findMany({
        where: { id: { in: imageIds } },
        select: { id: true, nsfwLevel: true, ingestion: true },
      })
    : [];
  const levelById = new Map<number, number | null>(images.map((i) => [i.id, i.nsfwLevel ?? null]));
  const ingestionById = new Map<number, string | null>(
    images.map((i) => [i.id, i.ingestion ?? null])
  );
  const levelOf = (id: number | null): number | null =>
    id == null ? null : levelById.get(id) ?? null;
  const scanOf = (id: number | null): AssetScanStatus | null => {
    if (id == null) return null;
    const ingestion = ingestionById.get(id);
    if (ingestion == null) return null; // Image deleted / not found.
    if (ingestion === ImageIngestionStatus.Scanned) return 'scanned';
    if (ingestion === ImageIngestionStatus.Blocked) return 'blocked';
    return 'pending';
  };

  const iconScanStatus = scanOf(listing.iconId);
  const coverScanStatus = scanOf(listing.coverId);
  const screenshotViews = screenshots.map((s) => ({
    ...s,
    nsfwLevel: levelOf(s.imageId),
    scanStatus: scanOf(s.imageId),
  }));
  const allScans = [iconScanStatus, coverScanStatus, ...screenshotViews.map((s) => s.scanStatus)];

  return {
    listingId: listing.id,
    iconId: listing.iconId,
    coverId: listing.coverId,
    iconNsfwLevel: levelOf(listing.iconId),
    coverNsfwLevel: levelOf(listing.coverId),
    iconScanStatus,
    coverScanStatus,
    screenshots: screenshotViews,
    completeness: checkListingAssetsComplete({
      iconId: listing.iconId,
      coverId: listing.coverId,
      // A row whose Image was deleted (imageId → null via onDelete: SetNull) must
      // NOT count as a present screenshot, else the gate passes but the card
      // renders blank.
      screenshotCount: screenshots.filter((s) => s.imageId != null).length,
    }),
    hasBlockedAsset: allScans.some((s) => s === 'blocked'),
    hasPendingScan: allScans.some((s) => s === 'pending'),
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
    const complete = candidate.iconId != null && candidate.coverId != null && hasScreenshots;
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

/**
 * App Store Listings — the OFF-SITE **go-live actionability gate**.
 *
 * ## What this exists to stop
 *
 * Three approved, live, moderator-visible off-site listings shipped with a DEAD
 * primary call-to-action — a disabled affordance reading *"Connecting this app
 * will be available soon."* with no `href`. Users had no way to open those apps
 * from the store at all. The stub landed 2026-07-01 (#2874); all three listings
 * were approved AFTER it, 07-24 → 07-28. Nothing on the approval path noticed it
 * was publishing a listing onto a route that had never worked.
 *
 * This module is the missing gate: an off-site listing may not be flipped live
 * while the store would render it a primary CTA the viewer cannot click.
 *
 * ## One rule, one place — this file computes NOTHING
 *
 * 🔴 The verdict is delegated, not re-derived. There is deliberately no second
 * "is this listing actionable?" predicate here to drift out of sync with the
 * store: the check runs the SAME `getDetailPrimaryAction` view-model the detail
 * page renders, over the SAME `detailKindData` projection the public DTO is built
 * from, and asks one question of the result — **did it produce an `href`?**
 *
 * A duplicated predicate would regenerate this exact bug at a second site the
 * moment either copy moved. So when the view-model's off-site branches change
 * (e.g. #3585, which makes the destination rather than the sub-kind decide the
 * action), this gate tracks that change with no edit here — which is the whole
 * point. Nothing about the CTA's shape is encoded below.
 *
 * ## Scoped to OFF-SITE, on purpose
 *
 * 🔴 The gate is `kind === 'offsite'` ONLY, and that scoping is load-bearing
 * rather than incidental. An ON-SITE listing has a *legitimate* non-actionable
 * primary action: a model-slot app (no launch page) correctly renders the
 * informational "Runs on model pages" affordance with NO href by design, because
 * it installs from a model page and there is nothing to open from the store. A
 * hard gate that fired on that shape would block a valid listing, which is worse
 * than no gate at all. An off-site listing has no such shape — it is by
 * definition an app that lives at another address, so "live in the store with
 * nowhere to send the user" is unambiguously broken, never a valid state.
 *
 * ## Fails CLOSED, and only on a transition
 *
 * A failed check throws `BAD_REQUEST` and rolls back the surrounding transaction,
 * so nothing is flipped. It runs ONLY on the transitions that put a listing (or
 * new listing content) live — never on read, never as a backfill over existing
 * rows. Already-approved listings are therefore GRANDFATHERED and are not
 * re-validated or taken down by this change; see the callers for the full
 * enumeration of gated vs. deliberately-excluded go-live paths.
 *
 * Sibling of {@link assertListingMeetsFloor} in `app-listing-assets.service.ts`,
 * which gates the same go-live moments on the icon+cover asset floor and whose
 * error copy this one deliberately mirrors. ⚠️ Not to be confused with
 * `assertListingAssetsComplete` in that file, which is ADVISORY-ONLY with no live
 * caller — do not wire anything new into it.
 */

import { TRPCError } from '@trpc/server';
import type { Prisma } from '@prisma/client';

import type { DetailPrimaryAction } from '~/components/Apps/appListingDetailView';
import { getDetailPrimaryAction } from '~/components/Apps/appListingDetailView';
import type { ListingKind } from '~/server/schema/blocks/app-listing-read.schema';
import { detailKindData } from '~/server/services/blocks/app-listing.service';

/**
 * The listing columns the check needs — exactly the ones `detailKindData`'s
 * off-site arm reads, plus `slug`/`kind`. Narrow on purpose so every call site
 * can satisfy it from a read it already performs (or a four-column `select`),
 * mirroring `ListingAssetCompleteness`.
 */
export type ListingActionabilitySource = {
  kind: string;
  slug: string;
  /** `| undefined` so a Prisma create input satisfies this unchanged — see
   *  `DetailKindDataSource`, which treats absent and null identically. */
  externalUrl?: string | null;
  connectClientId?: string | null;
};

export type ListingActionabilityResult =
  /** ON-SITE — out of scope by design (see the module docstring). Not evaluated. */
  | { ok: true; skipped: true; action: null }
  /** OFF-SITE with a navigable primary CTA. */
  | { ok: true; skipped: false; action: DetailPrimaryAction }
  /** OFF-SITE whose primary CTA would render with nothing to click. */
  | { ok: false; skipped: false; action: DetailPrimaryAction };

/**
 * Pure core: would this listing's store detail render a primary CTA the viewer
 * can actually act on? Returns the rendered action alongside the verdict so the
 * caller can quote the real copy a moderator would have seen.
 *
 * 🔴 `canOpenPage` is passed but provably unread: the on-site listing kinds are
 * the only branches that consult it, and those return above via the `skipped`
 * path. Pinned by a test asserting the verdict is identical for `true` and
 * `false`, so this stays true if the view-model is re-branched.
 */
export function checkOffsiteListingActionable(
  listing: ListingActionabilitySource
): ListingActionabilityResult {
  if (listing.kind !== 'offsite') return { ok: true, skipped: true, action: null };

  const action = getDetailPrimaryAction(
    {
      slug: listing.slug,
      kind: listing.kind as ListingKind,
      // The SAME projection the public detail DTO is built from — not a copy.
      kindData: detailKindData(listing),
    },
    { canOpenPage: true }
  );

  // The single question this gate asks. `href` is what the renderer turns into a
  // link/anchor; every non-actionable affordance (the connect stub, the
  // no-valid-link `Unavailable` state) is precisely the case where it is absent.
  return { ok: !!action.href, skipped: false, action };
}

/**
 * Throwing wrapper — the go-live gate proper. Use this at call sites that already
 * hold the four columns (they are re-read on the primary inside the flip's
 * transaction anyway); use {@link assertOffsiteListingActionableInTx} where the
 * row must be re-read authoritatively.
 *
 * The message names what a moderator would have seen AND what fixes it, matching
 * the asset floor's tone — a mod who trips this must not have to read the code to
 * understand it.
 */
export function assertOffsiteListingActionable(listing: ListingActionabilitySource): void {
  const result = checkOffsiteListingActionable(listing);
  if (result.ok) return;
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: buildActionabilityError(listing.slug, result.action),
  });
}

/** The moderator-facing failure copy (shared so every call site reads identically). */
export function buildActionabilityError(slug: string, action: DetailPrimaryAction): string {
  const seen = action.note ? `"${action.label}" — ${action.note}` : `"${action.label}"`;
  return (
    `Listing "${slug}" needs a working link before it can go live: its store button would ` +
    `render as ${seen} with nothing for the viewer to open. Give the listing a valid ` +
    `https external URL (that is the address the store sends people to), then try again.`
  );
}

/**
 * AUTHORITATIVE in-transaction variant — re-reads the row on the PRIMARY (`tx`)
 * so the verdict is row-consistent with the status flip that follows, exactly as
 * `assertListingAssetsScanCleanInTx` does for the scan gate. A missing row is a
 * no-op (the caller's own status-guarded `updateMany` is what fails in that case,
 * with its own clearer message) — same contract as the scan-clean helper.
 */
export async function assertOffsiteListingActionableInTx(
  db: Prisma.TransactionClient,
  appListingId: string
): Promise<void> {
  const listing = await db.appListing.findUnique({
    where: { id: appListingId },
    select: { kind: true, slug: true, externalUrl: true, connectClientId: true },
  });
  if (!listing) return;
  assertOffsiteListingActionable(listing);
}

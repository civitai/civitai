import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { Flags } from '~/shared/utils/flags';

/**
 * App Blocks (Phase-1 seam) — the PURE per-VIEWER display decision for the
 * cross-user gated image read (`blocks.getImagesByIds` → `GET_IMAGES_BY_IDS`),
 * extracted so the load-bearing moderation clamp is unit-testable in the node
 * vitest env (no Prisma / no dbRead — mirrors `block-image-upload.logic.ts`).
 *
 * A benchmark grid stores the ids of images ONE user published (via
 * `blocks.publishGenerationOutputs`) and asks the host to render them for EVERY
 * viewer. This decides, for the REQUESTING viewer, whether an image is:
 *   - `visible` — scanned clean, unflagged, AND within THIS viewer's browsing-
 *     level ceiling → the host returns the moderated projection (incl. a gated
 *     edge url).
 *   - `pending` — NO RATING EXISTS YET. The scan is still in flight (a
 *     non-terminal ingestion) or has not written a level. Distinct from `hidden`
 *     because the two mean opposite things and the caller cannot tell them apart
 *     from one token: `hidden` says "a rating exists and it is not for you",
 *     `pending` says "nothing has been decided". Collapsing them is what made a
 *     freshly-published, never-scanned image render as *"rated mature"* — a
 *     rating claim about an image nothing had rated. Carries NO url of its own;
 *     the caller decides who may see the bytes (see the OWNER note below).
 *   - `hidden`  — withheld from this viewer (flagged, hard-blocked, scan-refused,
 *     or above their browsing ceiling). The host returns NO url — the block
 *     renders a blurred/placeholder cell. This is the cross-user moderation
 *     boundary: an unclamped edge url NEVER crosses to a viewer who can't see it.
 *
 * The clamp mirrors the non-owner path of `getAllImages` (the site's canonical
 * image read): `(nsfwLevel & browsingLevel) != 0 AND nsfwLevel != 0` plus the
 * `needsReview IS NULL` / `acceptableMinor = FALSE` guards, AND additionally
 * requires a terminal `Scanned` ingestion + fails closed on every moderation
 * flag a `Scanned` ingestion does NOT clear (`needsReview`/`poi`/`minor`/
 * `tosViolation`) — the same fail-closed posture as the block image-upload gate,
 * because these images are shown PUBLICLY with no per-image mod review.
 *
 * 🔴 `pending` IS NOT A WEAKENING OF THAT BOUNDARY, AND THE ORDER BELOW IS WHAT
 * MAKES THAT TRUE. Every moderation flag, the hard block, and the two TERMINAL
 * scan refusals (`Blocked` = the scanner rejected the bytes, `NotFound` = it
 * could not fetch them) are decided BEFORE the pending branch, so a flagged or
 * scan-refused row can never come back `pending`. What remains `pending` is
 * exactly "the scanner has not answered yet" — which is why the discriminant
 * mirrors the sibling upload gate (`classifyBlockImageUploadScan`) verbatim
 * rather than inventing a second reading of the same enum.
 *
 * 🔴 THIS FUNCTION STILL HAS NO IDENTITY BRANCH, DELIBERATELY. It does not know
 * who is asking, so it cannot grant an owner bypass and cannot get one wrong. A
 * caller that wants to show a viewer their OWN not-yet-rated image does that at
 * the projection, against the row's `userId` — see `getBlockGatedImagesByIds`.
 * Every caller that is NOT that one must keep treating anything other than
 * `visible` as a refusal; `resolveAppPublishedImages` (the public-Post adoption
 * gate) does, and the seam test in
 * `src/server/services/blocks/__tests__/block-gated-images.seam.test.ts` pins the
 * whole call-site ledger so a new caller cannot quietly join without deciding.
 */
export type GatedImageVerdict =
  | { status: 'visible' }
  | { status: 'pending' }
  | { status: 'hidden' };

/**
 * Pure gate decision for ONE image against a viewer's browsing-level flag.
 * `browsingLevel` is the viewer's already-resolved ceiling (a browsing-level
 * bitmask; the caller intersects the block token's `maxBrowsingLevel` with the
 * public floor and fails closed to PG — a `0`/empty ceiling here hides
 * everything). Fail-closed on every uncertain state.
 */
export function classifyGatedImageForViewer(
  image: {
    ingestion: ImageIngestionStatus | string;
    nsfwLevel: number;
    /** Moderation flags a `Scanned` ingestion does NOT clear. */
    needsReview?: string | null;
    poi?: boolean | null;
    minor?: boolean | null;
    tosViolation?: boolean | null;
    acceptableMinor?: boolean | null;
    /** Non-null once the image has been hard-blocked (a moderation-block reason). */
    blockedFor?: string | null;
  },
  browsingLevel: number
): GatedImageVerdict {
  const { ingestion, nsfwLevel } = image;

  // 🔴 MODERATION FIRST — ahead of the pending branch, not after it. These flags
  // are set at/after scan WITHOUT flipping `ingestion`, so a row can carry one
  // while still reading `Pending`. Deciding them first is what guarantees a
  // flagged or hard-blocked row can never be reported `pending` (and so can never
  // reach the owner-projection that hands `pending` a url). `blockedFor` is the
  // hard-block reason (a Scanned row can still be blocked).
  if (
    image.needsReview != null ||
    image.poi === true ||
    image.minor === true ||
    image.tosViolation === true ||
    image.acceptableMinor === true ||
    image.blockedFor != null
  ) {
    return { status: 'hidden' };
  }

  // TERMINAL scan refusals — the scanner answered, and the answer was no
  // (`Blocked`: prohibited bytes) or it never got the bytes (`NotFound`). Neither
  // is "not decided yet", so neither is `pending`. Same split, same enum values,
  // as `classifyBlockImageUploadScan`.
  if (ingestion === ImageIngestionStatus.Blocked || ingestion === ImageIngestionStatus.NotFound) {
    return { status: 'hidden' };
  }

  // Still scanning — any other non-`Scanned` state is a poll-able pending, and
  // an UNKNOWN ingestion value lands here too (fail-safe: `pending` carries no
  // url of its own, so an unrecognised state can only ever under-share).
  if (ingestion !== ImageIngestionStatus.Scanned) return { status: 'pending' };

  // Scanned, but no level was written: the scan has not produced a rating. This
  // is the SAME state as a non-terminal ingestion as far as a caller is
  // concerned — "nothing has been decided" — so it is `pending`, not `hidden`.
  // (It was `hidden` before, which is what taught the grid to call an unrated
  // image mature.) The cross-user posture is unchanged: `pending` still carries
  // no url, so `getAllImages`' `nsfwLevel != 0` conjunct is still honoured for
  // everyone but the image's own author.
  if (nsfwLevel === 0) return { status: 'pending' };

  // Per-viewer browsing-level clamp: the image's level must intersect the
  // viewer's ceiling, else it's above what THIS viewer may see → hidden.
  if (!Flags.intersects(nsfwLevel, browsingLevel)) return { status: 'hidden' };

  return { status: 'visible' };
}

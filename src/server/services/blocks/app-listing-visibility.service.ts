/**
 * App Store Listings — the guarded reader for `AppListing.visibility`.
 *
 * 🔴 WHY THIS MODULE EXISTS AT ALL. `app_listings.visibility` is a MANUAL-APPLY column.
 * Migrations in this repo are never auto-applied (no `prisma migrate deploy` path; a human
 * runs the SQL per environment), so between the code deploy and that human there is a
 * window in which production runs code naming a column the database does not have. A
 * Prisma `select` naming a missing column does not return `undefined` — it THROWS (P2022 /
 * Postgres 42703), for the WHOLE query. Put `visibility: true` into `listingHydrateSelect`
 * and every public `/apps` store read that shares it — the GRID as well as the detail page
 * — 500s until the SQL is applied.
 *
 * So the column is read HERE and nowhere else, and nothing adds it to an existing
 * `select`. Same posture, and the same reasoning, as `app-listing-beta.service.ts`; read
 * that module's header for the part this one does not repeat (why controlling explicit
 * `select`s is necessary but NOT sufficient, and why the migration is a hard pre-deploy
 * step rather than a thing this file makes safe).
 *
 * 🔴 THE DEGRADED VALUE IS THE PRE-FEATURE BEHAVIOUR, WHICH IS NEITHER FAIL-OPEN NOR
 * FAIL-CLOSED, AND THAT IS THE WHOLE DESIGN. The sibling modules can degrade to a harmless
 * placeholder because an absent beta flag renders nothing. Here BOTH obvious placeholders
 * are wrong in a way that matters:
 *   · degrading to `public` fails OPEN — it would admit a draft listing to the store;
 *   · degrading to `private` fails CLOSED in the wrong place — the store read would stop
 *     admitting listings it admits today, i.e. an unapplied migration would EMPTY the
 *     public grid.
 * The honest third answer is for the read to DEGRADE TO `null` — "no choice expressed" —
 * which {@link listingVisibleInStore} already resolves to the pre-feature rule for the
 * row's status. So an unapplied migration and an unset level reach the same behaviour by
 * the same route, and the store is byte-identical to how it was before this feature.
 *
 * ⚠️ AN EARLIER REVISION PRE-FLIGHT PROBED FOR THE COLUMN INSTEAD, AND THAT WAS REMOVED.
 * It cost a database round trip on EVERY `/apps` grid and detail read — including cache
 * hits, because it was awaited before the cache was even constructed — and its protection
 * was incomplete anyway: many `appListing` call sites pass no explicit `select` and so
 * raise 42703 regardless. Neither in-tree sibling does it: `app-listing-beta.service.ts`
 * and `app-listing-source-repo.service.ts` both degrade via a catch on
 * {@link isMissingColumnError}, and this module now matches them rather than inventing a
 * third posture. The real ordering control is `CLAUDE.md` rule 8 and the migration's own
 * APPLY-BEFORE-DEPLOY header, which this file was never a substitute for and said so.
 *
 * 🔴 THREE STATES, NOT TWO, AND COLLAPSING ANY PAIR IS HOW THIS GOES WRONG. A listing
 * nobody has set a level on reads `{ available: true, visibility: null }`; one carrying a
 * level reads `{ available: true, visibility: <level> }`; an unapplied migration reads
 * `{ available: false, visibility: null }`. Only the first two license a write, and only
 * the third means "do not consult the level at all". `null` is NOT the `private` level.
 */

import { TRPCError } from '@trpc/server';

import { logToAxiom } from '~/server/logging/client';
import { isMissingColumnError } from '~/server/services/blocks/app-listing-source-repo.service';
import type { AppListingVisibility } from '~/shared/utils/app-listing-visibility';
import { parseStoredVisibility } from '~/shared/utils/app-listing-visibility';

/** What a guarded read of the visibility column yields. See the header on `available`. */
export type ListingVisibilityRead = {
  /**
   * True when the column was actually readable. `false` ⇒ the manual-apply migration has
   * not been applied yet, the value below is a placeholder, and NO write may name the
   * column.
   */
  available: boolean;
  /**
   * The stored level, or `null` for "the owner has expressed no choice".
   *
   * 🔴 `null` IS NOT `private`. A NULL column means the pre-feature rule for the row's
   * status applies (approved visible, non-approved not), which is what keeps the feature
   * inert on every row nobody has set a level on — including every row a future approval
   * mints. An UNKNOWN stored string is a different case and still narrows to `private`
   * (fail closed). `available === false` is a third case again: the column could not be
   * read at all.
   */
  visibility: AppListingVisibility | null;
};

/** The read every degraded path returns. One frozen value so no caller can mutate it. */
export const VISIBILITY_UNAVAILABLE: ListingVisibilityRead = Object.freeze({
  available: false,
  visibility: null,
});

/** One row as the guarded reads select it. */
type VisibilityRow = { visibility: string | null };

/**
 * The MINIMAL Prisma-client surface this module needs, structurally typed.
 *
 * Deliberately not `typeof dbRead`: callers pass a replica client, a primary client AND an
 * interactive-transaction client. Structural typing accepts all three, and lets the unit
 * tests hand in a THROWING FAKE — the only way to exercise the degraded branch without a
 * database that is actually missing a column.
 */
export type VisibilityReadClient = {
  appListing: {
    findUnique: (args: {
      where: { id: string } | { slug: string };
      select: { visibility: true };
    }) => Promise<VisibilityRow | null>;
  };
};

/** Shape one raw row (or a miss) into a successful read. A miss is `available: true` — the
 *  column WAS readable, there was simply no row. */
function readFromRow(row: VisibilityRow | null): ListingVisibilityRead {
  return { available: true, visibility: parseStoredVisibility(row?.visibility) };
}

/**
 * Read one listing's level BY ID, degrading to {@link VISIBILITY_UNAVAILABLE} when the
 * manual-apply column is not there yet.
 *
 * 🔴 THE `catch` MATCHES ON THE ERROR CODE, never a message substring, and it delegates to
 * {@link isMissingColumnError} rather than re-deriving the predicate — one rule, one place.
 * Everything else (a connection failure, a timeout, a missing TABLE, a permission error)
 * PROPAGATES: degrading on those would turn a real outage into a silently wrong audience,
 * which is worse than an error on a surface that licenses a write.
 */
export async function readListingVisibility(
  listingId: string,
  db: VisibilityReadClient
): Promise<ListingVisibilityRead> {
  try {
    return readFromRow(
      await db.appListing.findUnique({
        where: { id: listingId },
        select: { visibility: true },
      })
    );
  } catch (err) {
    if (isMissingColumnError(err)) return VISIBILITY_UNAVAILABLE;
    throw err;
  }
}

/**
 * Record a degraded read, without letting the recording break the page.
 *
 * `type: 'error'` because the missing-column case is swallowed UPSTREAM and never reaches
 * a caller's catch — what arrives here is the complement (connection failure, timeout,
 * `42P01`, `42501`), which is a server fault. The `.catch(() => null)` is load-bearing:
 * nothing awaits this, so an unhandled rejection would take down the render this exists
 * only to observe. Same reasoning as `app-listing-beta.service.ts`.
 */
function noteDegradedVisibilityRead(err: unknown): void {
  logToAxiom({
    name: 'app-listing-visibility-read-degraded',
    type: 'error',
    message: err instanceof Error ? err.message : String(err),
    code: (err as { code?: unknown })?.code ?? null,
  }).catch(() => null);
}

/**
 * The message an author sees when they set a level before the manual-apply migration has
 * run.
 *
 * Exported so the tests assert the EXACT string rather than a substring of their own
 * invention, and so a mutant that swaps this guard for a different error is killed by the
 * message rather than merely by "something threw".
 */
export const VISIBILITY_UNAVAILABLE_MESSAGE =
  'Listing visibility is not available on this environment yet. Try again later.';

/**
 * Gate a write of the level on the manual-apply migration.
 *
 * It REFUSES rather than omitting: the caller picked that level and expects to see it
 * again, so a silent drop would report success while the listing stayed where it was, and
 * their only recourse would be to try again. `PRECONDITION_FAILED`, not `BAD_REQUEST` —
 * the value is not malformed and there is nothing the caller can do to make it acceptable.
 * The distinct code is also what lets a test tell this guard from the validator's rejection
 * of an unknown level, which is the mutation that would otherwise pass unnoticed.
 *
 * Callers must run this BEFORE any side effect.
 */
export function assertVisibilityWritable(available: boolean): void {
  if (available === true) return;
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: VISIBILITY_UNAVAILABLE_MESSAGE });
}

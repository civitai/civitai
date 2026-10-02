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
 * The honest third answer is to report the absence (`available: false`) and have the read
 * path then not consult the level at all, so the store behaves exactly as it did before
 * this feature existed. That is why {@link isListingVisibilityColumnAvailable} exists and
 * why the list path probes before it will NAME the column in its statement.
 *
 * 🔴 `available` IS NOT THE SAME QUESTION AS "private", and conflating them is how this
 * goes wrong. A listing nobody has set a level on reads
 * `{ available: true, visibility: 'private' }`; an unapplied migration reads
 * `{ available: false, visibility: 'private' }`. Only the FIRST licenses a write.
 */

import { TRPCError } from '@trpc/server';

import { logToAxiom } from '~/server/logging/client';
import { isMissingColumnError } from '~/server/services/blocks/app-listing-source-repo.service';
import type { AppListingVisibility } from '~/shared/utils/app-listing-visibility';
import { narrowListingVisibility } from '~/shared/utils/app-listing-visibility';

/** What a guarded read of the visibility column yields. See the header on `available`. */
export type ListingVisibilityRead = {
  /**
   * True when the column was actually readable. `false` ⇒ the manual-apply migration has
   * not been applied yet, the value below is a placeholder, and NO write may name the
   * column.
   */
  available: boolean;
  /** The stored level, narrowed. `private` for "not set", for an unknown value, AND for
   *  "could not read" — `available` is what tells those apart. */
  visibility: AppListingVisibility;
};

/** The read every degraded path returns. One frozen value so no caller can mutate it. */
export const VISIBILITY_UNAVAILABLE: ListingVisibilityRead = Object.freeze({
  available: false,
  visibility: 'private' as AppListingVisibility,
});

/** The read a caller uses when it has no listing to ask about (a preview fixture, a
 *  projection default). Distinct from {@link VISIBILITY_UNAVAILABLE} only in `available`. */
export const VISIBILITY_NOT_SET: ListingVisibilityRead = Object.freeze({
  available: true,
  visibility: 'private' as AppListingVisibility,
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
    findMany: (args: {
      where: { id: { in: string[] } };
      select: { id: true; visibility: true };
    }) => Promise<Array<VisibilityRow & { id: string }>>;
  };
};

/** Shape one raw row (or a miss) into a successful read. A miss is `available: true` — the
 *  column WAS readable, there was simply no row. */
function readFromRow(row: VisibilityRow | null): ListingVisibilityRead {
  return { available: true, visibility: narrowListingVisibility(row?.visibility) };
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

/** Read one listing's level BY SLUG. `AppListing.slug` is `@unique`, so this is a single
 *  indexed row read. */
export async function readListingVisibilityBySlug(
  slug: string,
  db: VisibilityReadClient
): Promise<ListingVisibilityRead> {
  try {
    return readFromRow(
      await db.appListing.findUnique({ where: { slug }, select: { visibility: true } })
    );
  } catch (err) {
    if (isMissingColumnError(err)) return VISIBILITY_UNAVAILABLE;
    throw err;
  }
}

/**
 * Read the level for a PAGE of listings, as a `Map` keyed by listing id.
 *
 * 🔴 A LISTING MISSING FROM THE MAP IS NOT "PUBLIC". Callers project a row they already
 * hold, so a missing entry means the row was deleted between the two queries — they must
 * substitute {@link VISIBILITY_NOT_SET}, never an admitting level. Degrades to an EMPTY map
 * when the column is absent, which every caller must read as "do not consult the level",
 * not as "nobody is visible".
 */
export async function readListingVisibilityMany(
  listingIds: readonly string[],
  db: VisibilityReadClient
): Promise<Map<string, ListingVisibilityRead>> {
  if (listingIds.length === 0) return new Map();
  try {
    const rows = await db.appListing.findMany({
      where: { id: { in: [...listingIds] } },
      select: { id: true, visibility: true },
    });
    return new Map(rows.map((r) => [r.id, readFromRow(r)]));
  } catch (err) {
    if (isMissingColumnError(err)) return new Map();
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
 * A listing id that CANNOT exist, used to ask the database about the COLUMN without caring
 * about any row. `AppListing.id` is an `apl_<ULID>`, so nothing can collide with this, and
 * the lookup is a primary-key probe that matches nothing — the query still parses the
 * `select`, which is the only part that can raise P2022.
 */
const VISIBILITY_COLUMN_PROBE_ID = '__app_listing_visibility_column_probe__';

/**
 * Is the manual-apply column present?
 *
 * 🔴 THE STORE LIST PATH CANNOT WORK ANY OTHER WAY. That read is raw SQL inside a cached
 * statement, so a missing column is a PARSE error it cannot catch per-column — the
 * statement either names `al.visibility` or it does not, and that decision has to be taken
 * before the statement is built. This probe is how it is taken.
 *
 * Deliberately NOT memoised: the whole point is that the column APPEARS partway through a
 * deploy's life, and a cached `false` would keep the feature inert until the next restart.
 * It costs one primary-key probe that matches nothing, and the store's own `scope === 'none'`
 * short-circuit means it never runs for the dark majority of traffic.
 *
 * ⚠️ IT DEGRADES TO `false` ON *ANY* ERROR, not only a missing column, and that is the
 * correct direction HERE even though {@link readListingVisibility} propagates. A throw from
 * this probe would 500 the public grid; answering `false` makes the grid behave exactly as
 * it did before this feature, which is the degraded behaviour the module header argues for.
 * Write paths must use {@link readListingVisibility}, whose narrow guard is what keeps a
 * real outage from being reported to an author as "not available on this environment".
 */
export async function isListingVisibilityColumnAvailable(
  db: VisibilityReadClient
): Promise<boolean> {
  try {
    return (await readListingVisibility(VISIBILITY_COLUMN_PROBE_ID, db)).available;
  } catch (err) {
    noteDegradedVisibilityRead(err);
    return false;
  }
}

/**
 * The message an AUTHOR or MODERATOR sees when they set a level before the manual-apply
 * migration has run.
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

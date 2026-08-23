/**
 * App Store Listings — the guarded reader for `AppListing.sourceRepoUrl`.
 *
 * 🔴 WHY THIS MODULE EXISTS AT ALL: `app_listings.source_repo_url` is a MANUAL-APPLY
 * column. Migrations in this repo are never auto-applied (no `prisma migrate deploy`
 * path; a human runs the SQL per environment), so between the code deploy and that
 * human there is a window in which production runs code that names a column the
 * database does not have. A Prisma `select` naming a missing column does not return
 * `undefined` — it THROWS (P2022 / Postgres 42703), and it throws for the whole query.
 * Put `sourceRepoUrl: true` into `listingHydrateSelect` and every public `/apps` store
 * detail read 500s until the SQL is applied: an additive, optional, cosmetic feature
 * turned into an outage on a public page.
 *
 * So the column is read HERE and nowhere else, through one function that swallows
 * exactly the missing-column error and reports the absence honestly. Nothing adds the
 * column to an existing `select`, which is what keeps every pre-existing flow — the
 * store list, the store detail, the author edit prefill, the moderator revision apply —
 * byte-identical to today while the migration is outstanding.
 *
 * This is the same posture `safeCollaboratorQuery` takes for the manual-apply
 * `app_collaborators` TABLE (`app-access.service`), with one deliberate difference:
 * that helper REFUSES a column error (42703) because a half-applied schema must
 * surface rather than become a permanent silent zero. Here the column IS the migration,
 * so 42703 is precisely the expected intermediate state and the table error is the
 * anomaly — hence a separate predicate rather than reusing that one.
 *
 * 🔴 `available` IS NOT THE SAME QUESTION AS `value == null`, and conflating them is how
 * this would go wrong. A listing that simply has no source repo reads
 * `{ available: true, value: null }`; an unapplied migration reads
 * `{ available: false, value: null }`. Both render nothing, but only the FIRST licenses
 * a write — `applyApprovedRevision` copying a revision's `sourceRepoUrl` onto its parent
 * must be able to CLEAR it, and it can only tell "the author removed the link" from "I
 * could not see the column" by asking `available`. Every write path in this feature is
 * gated on it.
 *
 * 🔴 TWO SHAPES OF WRITE, TWO DIFFERENT ANSWERS, AND THEY ARE NOT INTERCHANGEABLE:
 *   - a write the SYSTEM originates (the shadow clone, the revision apply, the on-site
 *     re-sync) carries a value nobody asked for right now, so an absent column means
 *     OMIT THE KEY and carry on — {@link sourceRepoWriteFragment};
 *   - a write an AUTHOR originates (an off-site submit or patch that names
 *     `sourceRepoUrl`) carries a value the author typed and expects to see again, so an
 *     absent column must be an ERROR — {@link assertSourceRepoWritable}. Silently
 *     dropping it would show them a saved form with their link missing and no
 *     explanation, and writing it anyway raises P2022 500 naming a database column.
 * Using the omit-fragment on an author write is the failure this split exists to stop.
 */

import { TRPCError } from '@trpc/server';

/** What a guarded read of the column yields. See the module header on `available`. */
export type ListingSourceRepoRead = {
  /**
   * True when the column was actually readable. `false` ⇒ the manual-apply migration
   * has not been applied yet, `value` is a placeholder, and NO write may include the
   * column.
   */
  available: boolean;
  /** The stored value, or `null` for "no repo set" AND for "could not read". */
  value: string | null;
};

/**
 * The MINIMAL Prisma-client surface this module needs, structurally typed.
 *
 * Deliberately not `typeof dbRead`: the callers pass a replica client, a primary
 * client, AND an interactive-transaction client (`applyApprovedRevision` must read the
 * shadow inside its own tx or it reads a row the tx is about to overwrite). Structural
 * typing accepts all three, and lets the unit tests hand in a throwing fake — which is
 * the only way to exercise the degraded branch without a database missing a column.
 */
export type SourceRepoReadClient = {
  appListing: {
    findUnique: (args: {
      where: { id: string };
      select: { sourceRepoUrl: true };
    }) => Promise<{ sourceRepoUrl: string | null } | null>;
  };
};

/**
 * Is this the "column does not exist" error?
 *
 * Matched on the ERROR CODE, never on a message substring: the message is driver text
 * that carries the table and column name and changes between Prisma versions, and a
 * substring test on it is exactly the kind of guard that silently stops matching.
 *   - `P2022` — Prisma's own "The column `X` does not exist in the current database."
 *   - `42703` — Postgres `undefined_column`, which reaches us on a `$queryRaw` path and
 *     is also what Prisma reports in `meta.code` for some engine versions.
 *
 * 🔴 NARROW ON PURPOSE. A connection failure, a timeout, a missing TABLE (42P01) and a
 * permission error all propagate — degrading on those would turn a real outage into a
 * silently missing field, which is the failure mode this module is meant to avoid, not
 * cause.
 */
export function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; meta?: unknown };
  if (e.code === 'P2022' || e.code === '42703') return true;
  if (e.meta && typeof e.meta === 'object') {
    const metaCode = (e.meta as { code?: unknown }).code;
    if (metaCode === '42703' || metaCode === 'P2022') return true;
  }
  return false;
}

/**
 * Read one listing's `sourceRepoUrl`, degrading to `{ available: false, value: null }`
 * when the manual-apply column is not there yet.
 *
 * A listing id that matches no row also yields `value: null` with `available: true` —
 * the column was readable, there was simply nothing to read. Callers that care about
 * row existence have already established it (they are projecting a row they hold).
 */
export async function readListingSourceRepoUrl(
  listingId: string,
  db: SourceRepoReadClient
): Promise<ListingSourceRepoRead> {
  try {
    const row = await db.appListing.findUnique({
      where: { id: listingId },
      select: { sourceRepoUrl: true },
    });
    return { available: true, value: row?.sourceRepoUrl ?? null };
  } catch (err) {
    if (isMissingColumnError(err)) return { available: false, value: null };
    throw err;
  }
}

/**
 * A listing id that CANNOT exist, used to ask the database about the COLUMN without
 * caring about any row. `AppListing.id` is an `apl_<ULID>`, so nothing can collide
 * with this, and the lookup is a primary-key probe that matches nothing — the query
 * still parses the `select`, which is the only part that can raise P2022.
 */
const SOURCE_REPO_COLUMN_PROBE_ID = '__app_listing_source_repo_column_probe__';

/**
 * Is the manual-apply `source_repo_url` column present?
 *
 * For the paths that must WRITE the column with no listing in hand — the on-site
 * listing CREATE at moderator-approve, and the scalar RE-SYNC on a later approved
 * version. Both of those are pre-existing flows wrapped in log-and-continue, so
 * including a missing column would not throw a user-visible error; it would silently
 * stop minting store listings for newly approved apps, which is worse than an error
 * because nothing would look wrong. Probing first keeps the pre-existing write
 * byte-identical while the migration is outstanding.
 *
 * Deliberately NOT memoised: the whole point is that the column APPEARS partway
 * through the deploy's life, and a cached `false` would keep the feature inert until
 * the next restart. Both call sites are moderator approves — single-digit per day —
 * so a primary-key probe that matches no row is not worth caching.
 */
export async function isSourceRepoColumnAvailable(db: SourceRepoReadClient): Promise<boolean> {
  return (await readListingSourceRepoUrl(SOURCE_REPO_COLUMN_PROBE_ID, db)).available;
}

/**
 * Spread-ready write fragment for the column: `{ sourceRepoUrl }` when the column is
 * available, `{}` when it is not.
 *
 * 🔴 THE WHOLE POINT IS THE EMPTY OBJECT. An unavailable column must be OMITTED from
 * the write, not written as `null` — writing it would raise the same P2022 and roll
 * back the surrounding transaction, so a feature that is merely inert would instead
 * break the (pre-existing) submit / revision-apply it rides along with.
 */
export function sourceRepoWriteFragment(read: ListingSourceRepoRead): {
  sourceRepoUrl?: string | null;
} {
  return read.available ? { sourceRepoUrl: read.value } : {};
}

/**
 * The message an AUTHOR sees when they supply a source-repository link before the
 * manual-apply migration has run.
 *
 * Exported so the tests assert the exact string rather than a substring of their own
 * invention, and so a mutant that swaps the guard for a different error is killed by
 * the message, not merely by "something threw".
 */
export const SOURCE_REPO_UNAVAILABLE_MESSAGE =
  'The source repository link is not available on this environment yet. Leave the field empty and try again later.';

/**
 * Gate an AUTHOR-ORIGINATED write of `sourceRepoUrl` on the manual-apply column.
 *
 * 🔴 THIS IS DELIBERATELY NOT {@link sourceRepoWriteFragment}. Omitting the key is the
 * right answer for a write the system originates on the author's behalf; it is the
 * WRONG answer for a value the author just typed, because the request then reports
 * success while the link vanishes, and the author's only recourse is to type it again.
 * A refusal that names the field is recoverable; a silent drop is not.
 *
 * `PRECONDITION_FAILED`, not `BAD_REQUEST`: the value is not malformed and there is
 * nothing the author can do to make it acceptable — the environment is not ready. The
 * distinct code is also what lets a test tell this guard from the validator's rejection
 * of a bad URL, which is the mutation that would otherwise pass unnoticed.
 *
 * Callers must run this BEFORE any side effect. On the approved-listing edit path a
 * throw after `beginListingRevision` would leave an orphan shadow revision draft
 * behind — the same reason the scope validation is hoisted up-front in `updateListing`.
 */
export function assertSourceRepoWritable(available: boolean): void {
  if (available === true) return;
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: SOURCE_REPO_UNAVAILABLE_MESSAGE });
}

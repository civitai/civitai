/**
 * App Store Listings — the guarded reader for `AppListing.visibility`.
 *
 * 🔴 WHY THIS MODULE EXISTS AT ALL, AND WHY IT IS RAW SQL. `app_listings.visibility` is a
 * MANUAL-APPLY column: migrations here are never auto-applied, so between the code deploy
 * and the human who runs the SQL there is a window in which production runs code naming a
 * column the database does not have.
 *
 * 🔴 CONTROLLING EXPLICIT `select`s IS NOT ENOUGH, AND THAT IS MEASURED RATHER THAN
 * ARGUED. Prisma names every scalar the MODEL declares in its default `SELECT` /
 * `RETURNING` list, so any call that returns rows and passes no `select` emits the column
 * whatever this module does. Enumerated on this tree: 18 such sites, **17 of them WRITES**
 * — the off-site submit/approve/reject/delist path among them. The sibling
 * `app-listing-source-repo.service.ts` header records the same thing happening for real on
 * a preview environment: `prisma.appListing.create()` 500ing with
 * `The column app_listings.source_repo_url does not exist`, for authors who supplied no
 * link at all. It happened again here, on PR preview, for `visibility`.
 *
 * 🔴 SO THE COLUMN IS NOT ON THE PRISMA MODEL. It is declared in `schema.full.prisma` —
 * which keeps it visible to the schema-drift detector and to anyone reading the schema —
 * with an inline `// @no-type`, which `scripts/generate-slim-schema.js` strips from the
 * schema the CLIENT is generated from. The field therefore does not exist on the generated
 * delegate, no Prisma query anywhere can emit it, and all 18 of those sites are unaffected
 * by construction rather than by a guard somebody has to remember. That closes the window
 * for reads AND writes instead of mitigating it.
 *
 * The price is that this column has no Prisma type safety: it is read here and written in
 * `app-listing-visibility-write.service.ts`, both through raw SQL, and nowhere else. It is
 * bounded by a DB CHECK and narrowed through `parseStoredVisibility` on the way in, so an
 * unexpected value fails closed rather than propagating.
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

import { Prisma } from '@prisma/client';
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
 * The MINIMAL client surface this module needs: `$queryRaw` and nothing else.
 *
 * 🔴 RAW, NOT THE `appListing` DELEGATE, AND THAT IS THE WHOLE POINT. The column is marked
 * `// @no-type` in `schema.full.prisma`, so `scripts/generate-slim-schema.js` strips it from
 * the schema the client is generated from — it does not exist on the Prisma model at all,
 * and therefore cannot be read or written through the delegate. See the module header.
 *
 * Structurally typed so a replica client, a primary client, an interactive-transaction
 * client and a throwing fake all satisfy it.
 */
export type VisibilityReadClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRaw: (query: any, ...values: any[]) => Promise<any>;
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
    const rows = (await db.$queryRaw(
      Prisma.sql`SELECT "visibility" FROM "app_listings" WHERE "id" = ${listingId} LIMIT 1`
    )) as VisibilityRow[];
    return readFromRow(rows[0] ?? null);
  } catch (err) {
    if (isMissingColumnError(err)) return VISIBILITY_UNAVAILABLE;
    throw err;
  }
}

/**
 * Read the level for a PAGE of listings, as a `Map` keyed by listing id.
 *
 * 🔴 ONE STATEMENT FOR N LISTINGS. The post-app chip surface resolves every candidate
 * listing on a public post view, so a per-row read would be an N+1 on a page-view-rate
 * path. An empty input issues no query at all.
 *
 * 🔴 A LISTING MISSING FROM THE MAP IS NOT "hidden" AND NOT "public" — it is ABSENT, and
 * the caller must substitute the unset level, which resolves to the pre-feature rule. A
 * missing column yields an EMPTY map for the same reason: every caller must read that as
 * "do not consult the level", never as "nobody is visible", or an unapplied migration
 * would blank every chip.
 */
export async function readListingVisibilityMany(
  listingIds: readonly string[],
  db: VisibilityReadClient
): Promise<Map<string, ListingVisibilityRead>> {
  if (listingIds.length === 0) return new Map();
  try {
    const rows = (await db.$queryRaw(
      Prisma.sql`SELECT "id", "visibility" FROM "app_listings" WHERE "id" IN (${Prisma.join([
        ...listingIds,
      ])})`
    )) as Array<VisibilityRow & { id: string }>;
    return new Map(rows.map((r) => [r.id, readFromRow(r)]));
  } catch (err) {
    if (isMissingColumnError(err)) return new Map();
    throw err;
  }
}

/**
 * {@link readListingVisibilityMany} on a RENDERING path — the store badge. Degrades to an
 * EMPTY map (every badge `null`) on ANY error, not just the missing column, because a
 * cosmetic label must not 500 the store grid; the same posture as
 * `readListingBetaManyForRender`.
 *
 * 🔴 NEVER USE THIS FOR AN ADMISSION DECISION. An empty map means "show no badge"; on a gate
 * it would read as "every level unset", which is the pre-feature rule and not fail-closed
 * for a restricted `approved` listing. Admission keeps the propagating readers above.
 *
 * The missing-column case is swallowed silently inside `readListingVisibilityMany`, so what
 * reaches the log here is a real fault (connection, timeout, permission), at fault rate.
 */
export async function readListingVisibilityManyForRender(
  listingIds: readonly string[],
  db: VisibilityReadClient
): Promise<Map<string, ListingVisibilityRead>> {
  try {
    return await readListingVisibilityMany(listingIds, db);
  } catch (err) {
    noteDegradedVisibilityRead(err);
    return new Map();
  }
}

/**
 * Record that a read fell back to the pre-feature predicate, without letting the recording
 * break the page.
 *
 * 🔴 IT WAS DEAD CODE — DEFINED, DOCUMENTED AT LENGTH AS LOAD-BEARING, AND CALLED FROM
 * NOWHERE. The consequence was that the whole manual-apply window was UNOBSERVABLE: the
 * store silently served the pre-feature predicate with no counter, log or metric saying so,
 * which is exactly the silent-gate class `store-scope.metrics` exists for. It is now called
 * from the store list path's catch.
 *
 * ⚠️ FROM THE LIST PATH ONLY, AND THAT IS A RATE DECISION. That catch fires at most once per
 * catalog cache MISS (one per cohort per TTL), which is a usable signal. The DETAIL path's
 * equivalent is deliberately silent: it would emit at page-view rate on a public page, which
 * is a flood rather than observability. So the window is observable, not fully audited —
 * state it that way rather than implying every degraded read is recorded.
 *
 * `type: 'error'` because the missing-column case is swallowed UPSTREAM and never reaches
 * a caller's catch — what arrives here is the complement (connection failure, timeout,
 * `42P01`, `42501`), which is a server fault. The `.catch(() => null)` is load-bearing:
 * nothing awaits this, so an unhandled rejection would take down the render this exists
 * only to observe. Same reasoning as `app-listing-beta.service.ts`.
 */
export function noteDegradedVisibilityRead(err: unknown): void {
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

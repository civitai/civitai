/**
 * App Store Listings — the guarded reader for `AppListing.isBeta` / `betaMessage`.
 *
 * 🔴 WHY THIS MODULE EXISTS AT ALL. `app_listings.is_beta` and `app_listings.beta_message`
 * are MANUAL-APPLY columns. Migrations in this repo are never auto-applied (no
 * `prisma migrate deploy` path; a human runs the SQL per environment), so between the code
 * deploy and that human there is a window in which production runs code naming columns the
 * database does not have. A Prisma `select` naming a missing column does not return
 * `undefined` — it THROWS (P2022 / Postgres 42703), and it throws for the WHOLE query. Put
 * `isBeta: true` into `listingHydrateSelect` and every public `/apps` store read that
 * shares it — the GRID as well as the detail page — 500s until the SQL is applied: an
 * additive, optional, cosmetic feature turned into an outage on a public page.
 *
 * So the columns are read HERE and nowhere else, through functions that swallow exactly
 * the missing-column error and report the absence honestly, and nothing adds them to an
 * existing `select`.
 *
 * 🔴 THAT IS NECESSARY BUT **NOT SUFFICIENT**, and it is worth saying plainly because the
 * sibling module (`app-listing-source-repo.service`) shipped a production 500 having
 * claimed otherwise. Controlling explicit `select`s says nothing about a query that passes
 * NO `select`: Prisma then returns the full model and names every scalar the MODEL declares
 * — including these two — in the `SELECT` / `INSERT … RETURNING` / `UPDATE … RETURNING`
 * list.
 *
 * 🔴 STATED AS A MECHANISM, NOT A COUNT, AND DELIBERATELY SO. An earlier version of this
 * paragraph quoted "roughly half the ~92 `appListing.*` query sites", a figure copied from
 * the sibling module and never re-measured here. Two independent counts of it disagreed
 * (they scope "a query site" differently and both drift with every commit), and no test
 * asserts on it — an unpinned number in a comment is a claim that rots silently, which is
 * how the wrong one got copied forward in the first place.
 *
 * What decides exposure is whether the call RETURNS ROWS. `findUnique` / `findFirst` /
 * `findMany` / `create` / `update` / `upsert` / `delete` do, and so do the `…AndReturn`
 * variants (`createManyAndReturn` / `updateManyAndReturn`, both present in the pinned
 * client) — with no explicit `select`, every one of them names every scalar the model
 * declares. `updateMany` / `deleteMany` / `createMany` return a `BatchPayload` row COUNT, so
 * they name no scalars IN THE RETURNING LIST.
 *
 * 🔴 THAT LAST EXEMPTION IS NARROWER THAN IT LOOKS, and the rewrite that introduced it
 * overstated it as "cannot raise P2022 from a missing column at all". FALSE: a `*Many` call
 * still names whatever columns appear in its own `data` and `where`, so
 * `appListing.updateMany({ data: { isBeta: true } })` emits `SET is_beta = $1` and raises
 * 42703 exactly like the others. The exemption covers the RETURNING list and nothing else.
 * Note too that `createManyAndReturn` / `updateManyAndReturn` CONTAIN the exempt names as
 * substrings, so a grep built from those names alone matches them and gets the wrong answer
 * — match whole method names.
 *
 * 🔴 NO TEST IN THIS REPO CAN SEE THAT. The suites mock Prisma, so none of them ever
 * generates SQL; this module's own tests are green and blind to it. The consequence is
 * operational, not structural: **the migration is a hard PRE-DEPLOY step**, and this module
 * is defence in depth rather than the guarantee. See the header of
 * `20260901120000_app_listing_beta/migration.sql`.
 *
 * 🔴 `available` IS NOT THE SAME QUESTION AS "not in beta", and conflating them is how this
 * would go wrong. A listing that simply has no beta declaration reads
 * `{ available: true, isBeta: false, betaMessage: null }`; an unapplied migration reads
 * `{ available: false, isBeta: false, betaMessage: null }`. Both render nothing, but only
 * the FIRST licenses a write — every write path in this feature is gated on it.
 *
 * 🔴 THERE IS EXACTLY ONE SHAPE OF BETA WRITE, AND THAT IS WHY THERE IS ONE HELPER. Every
 * write of these columns is AUTHOR-originated — a listing patch naming `isBeta` /
 * `betaMessage` — so an absent column must be an ERROR ({@link assertBetaWritable}), never a
 * silent omission: the author typed that value and expects to see it again, and dropping it
 * would show them a saved form with their note missing and no explanation.
 *
 * 🔴 THIS MODULE BRIEFLY HAD A SECOND, SYSTEM-ORIGINATED HELPER — a spread fragment that
 * omitted the keys — for exactly one caller: `beginListingRevision` cloned the columns onto
 * the shadow so the moderator review preview could render them. That clone is gone
 * (`getListingPreviewForReview` reads beta from the PARENT for a shadow), and with it the
 * only system-originated write. Do not reintroduce the fragment without a caller: the
 * sibling `sourceRepoUrl` module legitimately needs both shapes because its column IS staged
 * on a revision, and copying its structure here is what produced the clone in the first
 * place.
 *
 * 🔴 BETA IS NEVER STAGED ON A SHADOW REVISION, and that is the one place this feature
 * deliberately departs from how `sourceRepoUrl` is handled. `sourceRepoUrl` is MATERIAL, so
 * an edit to it rides a shadow revision and `applyApprovedRevision` copies it back onto the
 * parent. Beta is TRIVIAL — it applies in place with no moderator review — so every beta
 * write targets the LIVE listing, and `applyApprovedRevision` copies NEITHER column in
 * EITHER of its kind branches. Three things follow, all of them load-bearing:
 *   1. an approve can never CLEAR a beta flag the author set after the shadow was cloned
 *      (the apply does not name the columns, so there is nothing to revert to);
 *   2. the on-site apply stays ASSETS-ONLY, so `revisionApplyScope('onsite')` keeps
 *      licensing the review panel's "approving changes nothing" claim — copying a scalar
 *      there would have made that claim false for every on-site media revision; and
 *   3. neither column belongs in `OFFSITE_UNCOMPARED_APPLY_FIELDS`, because that list names
 *      what the apply COPIES without comparing, and the apply copies nothing here.
 * There is no clone either: `beginListingRevision` used to copy the columns onto the shadow
 * so the moderator review preview could render them, and that is now unnecessary because
 * `getListingPreviewForReview` reads beta from the PARENT for a shadow. Removing it also
 * removed an ordering constraint that had hoisted a WRITE above the patch validation in
 * `updateListing`.
 */

import { TRPCError } from '@trpc/server';

import { logToAxiom } from '~/server/logging/client';
import { isMissingColumnError } from '~/server/services/blocks/app-listing-source-repo.service';

/** What a guarded read of the beta columns yields. See the module header on `available`. */
export type ListingBetaRead = {
  /**
   * True when the columns were actually readable. `false` ⇒ the manual-apply migration has
   * not been applied yet, the values below are placeholders, and NO write may include the
   * columns.
   */
  available: boolean;
  /** The stored flag, or `false` for "not beta" AND for "could not read". */
  isBeta: boolean;
  /** The stored note, or `null` for "no note" AND for "could not read". */
  betaMessage: string | null;
};

/** The read every degraded path returns. A single frozen value so no caller can mutate it. */
export const BETA_UNAVAILABLE: ListingBetaRead = Object.freeze({
  available: false,
  isBeta: false,
  betaMessage: null,
});

/** The read a caller uses when it has no listing to ask about (a preview fixture, a
 *  projection default). Distinct from {@link BETA_UNAVAILABLE} only in `available`. */
export const BETA_NOT_SET: ListingBetaRead = Object.freeze({
  available: true,
  isBeta: false,
  betaMessage: null,
});

/** One row as the guarded reads select it. */
type BetaRow = { isBeta: boolean; betaMessage: string | null };

/**
 * The MINIMAL Prisma-client surface this module needs, structurally typed.
 *
 * Deliberately not `typeof dbRead`: the callers pass a replica client, a primary client,
 * AND an interactive-transaction client. Structural typing accepts all three, and lets the
 * unit tests hand in a THROWING FAKE — which is the only way to exercise the degraded
 * branch without a database that is actually missing a column.
 */
export type BetaReadClient = {
  appListing: {
    findUnique: (args: {
      where: { id: string } | { slug: string };
      select: { isBeta: true; betaMessage: true };
    }) => Promise<BetaRow | null>;
    findMany: (args: {
      where: { id: { in: string[] } };
      select: { id: true; isBeta: true; betaMessage: true };
    }) => Promise<Array<BetaRow & { id: string }>>;
  };
};

/** Shape one raw row (or a miss) into a successful read. A miss is `available: true` — the
 *  columns WERE readable, there was simply no row. */
function readFromRow(row: BetaRow | null): ListingBetaRead {
  return {
    available: true,
    isBeta: row?.isBeta === true,
    betaMessage: row?.betaMessage ?? null,
  };
}

/**
 * Read one listing's beta declaration BY ID, degrading to {@link BETA_UNAVAILABLE} when the
 * manual-apply columns are not there yet.
 *
 * 🔴 THE `catch` MATCHES ON THE ERROR CODE, never on a message substring, and it delegates
 * to the sibling module's {@link isMissingColumnError} rather than re-deriving the
 * predicate. One rule, one place: a second copy is how the two guards drift into disagreeing
 * about what "the column is missing" looks like after a Prisma upgrade. Everything else —
 * a connection failure, a timeout, a missing TABLE (42P01), a permission error — PROPAGATES,
 * because degrading on those would turn a real outage into a silently missing field, which
 * is the failure mode this module exists to avoid rather than cause.
 */
export async function readListingBeta(
  listingId: string,
  db: BetaReadClient
): Promise<ListingBetaRead> {
  try {
    return readFromRow(
      await db.appListing.findUnique({
        where: { id: listingId },
        select: { isBeta: true, betaMessage: true },
      })
    );
  } catch (err) {
    if (isMissingColumnError(err)) return BETA_UNAVAILABLE;
    throw err;
  }
}

/**
 * Read one listing's beta declaration BY SLUG.
 *
 * For the app RUN page (`/apps/run/<slug>`), whose SSR resolves its app out of `app_blocks`
 * and never touches `app_listings`. `AppListing.slug` is `@unique` and, for an on-site
 * listing, IS the block's `blockId` (`mapAppBlockToListing` sets `slug: ab.blockId`) — so a
 * slug lookup is a single indexed row read that needs nothing from the block resolve, which
 * is what lets the run page issue the two CONCURRENTLY instead of adding a serial hop to the
 * app-launch critical path.
 */
export async function readListingBetaBySlug(
  slug: string,
  db: BetaReadClient
): Promise<ListingBetaRead> {
  try {
    return readFromRow(
      await db.appListing.findUnique({
        where: { slug },
        select: { isBeta: true, betaMessage: true },
      })
    );
  } catch (err) {
    if (isMissingColumnError(err)) return BETA_UNAVAILABLE;
    throw err;
  }
}

/**
 * Read the beta declaration for a PAGE of listings, as a `Map` keyed by listing id.
 *
 * For the two list surfaces — the public `/apps` grid and the moderator all-status table —
 * which hydrate N rows through one `findMany` and would otherwise need N guarded reads. ONE
 * extra batched query per page, so the cost is O(1) reads regardless of page size, and an
 * empty input issues no query at all.
 *
 * 🔴 A LISTING MISSING FROM THE MAP IS "NOT BETA", NOT "UNKNOWN", and the two callers rely
 * on that: they project a row they already hold, so a missing entry can only mean the row
 * was deleted between the two queries. Degrades to an EMPTY map when the columns are absent,
 * which reads identically to "nobody is in beta" — the correct inert behaviour.
 */
export async function readListingBetaMany(
  listingIds: readonly string[],
  db: BetaReadClient
): Promise<Map<string, ListingBetaRead>> {
  if (listingIds.length === 0) return new Map();
  try {
    const rows = await db.appListing.findMany({
      where: { id: { in: [...listingIds] } },
      select: { id: true, isBeta: true, betaMessage: true },
    });
    return new Map(rows.map((r) => [r.id, readFromRow(r)]));
  } catch (err) {
    if (isMissingColumnError(err)) return new Map();
    throw err;
  }
}

/**
 * Record a degraded beta read, without letting the recording break the page.
 *
 * 🔴 `type: 'error'`, AND AN EARLIER VERSION OF THIS COMMENT ARGUED FOR `'warning'` ON A
 * CASE THAT CANNOT REACH HERE. It said "a missing column during the manual-apply window is
 * an expected intermediate state, not an incident" — but the missing-column error is
 * swallowed UPSTREAM: `readListingBeta` and its siblings match `P2022`/`42703` themselves and
 * RETURN `BETA_UNAVAILABLE` without throwing, so it never reaches {@link readForRender}'s
 * catch at all.
 *
 * What actually arrives here is the complement: a connection failure, a statement timeout, a
 * missing TABLE (`42P01`), a permission error (`42501`) — exactly the set this module's
 * `readListingBeta` docstring calls "a real outage". Those are SERVER faults, and
 * `~/server/logging/client` classifies severity on precisely that axis
 * (`fault === 'server' ? 'error' : 'info'`). Filing them as warnings would keep a genuine
 * `app_listings` outage off the error board.
 *
 * 🔴 THE FLOODING OBJECTION DOES NOT APPLY, which is why this differs from
 * `app-listing-assets.service`'s deliberate `'warning'`. That one downgrades because an
 * AUTHOR can trigger it at will (by swapping the object behind a key they own), so at
 * `error` it is an author-controlled tap on the error board. Nothing an author can do
 * produces a `42P01` here.
 *
 * `type` is the load-bearing field — the Alloy→Loki pipeline reads it as the level; `level`
 * is not read.
 *
 * 🔴 THE `.catch(() => null)` IS LOAD-BEARING, not tidiness. Nothing awaits this call, and
 * `logToAxiom` returns a promise that can reject — so without the
 * catch the rejection has nowhere to go but `unhandledRejection`, and the render this exists
 * merely to OBSERVE would be taken down by the observation. That is the precise failure this
 * whole `…ForRender` posture exists to prevent, reintroduced through the logging. Same
 * reasoning as `app-listing-assets.service`, `~/server/redis/fail-open-log` and
 * `~/server/meilisearch/client`.
 */
function noteDegradedBetaRead(err: unknown): void {
  logToAxiom({
    name: 'app-listing-beta-read-degraded',
    type: 'error',
    message: err instanceof Error ? err.message : String(err),
    code: (err as { code?: unknown })?.code ?? null,
  }).catch(() => null);
}

/**
 * A read for a RENDERING path, which degrades on **any** error rather than only on a missing
 * column.
 *
 * 🔴 THIS IS A DELIBERATE SECOND POSTURE, NOT A WIDENING OF THE ONE ABOVE, and the split is
 * the whole point. The narrow guard is right where the answer LICENSES A WRITE: there,
 * swallowing a timeout would tell an author "beta is not available on this environment yet"
 * when the truth is that the database is unwell, and a real outage would be reported as a
 * missing feature. Every write path therefore keeps {@link readListingBeta}.
 *
 * 🔴 BUT ON A PURELY COSMETIC RENDER, PROPAGATING IS THE WORSE ANSWER, and on ONE surface it
 * is much worse. `/apps/run/<slug>` is the APP LAUNCH path, and before this feature existed
 * it never touched `app_listings` at all — its SSR resolves out of `app_blocks`. A statement
 * timeout, a deadlock, a connection reset or a `42P01` on this lookup does not cost a badge
 * there: `createServerSideProps` has no try/catch, so the rejection becomes an SSR **500 on
 * the page that runs the app**. Trading "the app is unusable" for "the Beta badge is missing"
 * is not a close call. The same reasoning, at lower stakes, covers the public `/apps` grid
 * and the moderator table, which are also read-only renders of a cosmetic label.
 *
 * 🔴 THE ERROR IS LOGGED RATHER THAN ASSUMED TO SURFACE ELSEWHERE. An earlier version of
 * this paragraph argued it could not be lost, because "the sibling queries in the same
 * request hit the same client". True on the two LIST surfaces, whose siblings read
 * `app_listings` — and FALSE on the one surface this was built for: the run page's only
 * sibling reads `app_blocks`, so a table-scoped failure on `app_listings` (`42P01`, `42501`
 * — the exact codes this module's tests enumerate) is invisible to it. Without a log, an
 * `app_listings` outage would leave the badge silently absent on that page with no signal
 * anywhere. Hence {@link noteDegradedBetaRead}: the page still renders, and the failure is
 * still findable. What is suppressed is only this label's ability to be the thing that takes
 * a page down.
 *
 * 🔴 NOTE WHICH CASE IS **NOT** IN THAT SET. An earlier version of this paragraph justified
 * the log by "a half-applied schema would leave the badge permanently absent" — but a missing
 * COLUMN never reaches this catch: the narrow readers swallow `P2022`/`42703` themselves and
 * return `BETA_UNAVAILABLE` without throwing. The manual-apply window is silent here by
 * construction, and deliberately so; what this logs is the real-outage complement.
 *
 * `available` is reported honestly as `false` on any failure, so a caller that ever wanted to
 * gate a write on one of these reads would still fail CLOSED — but none does, and none should.
 */
async function readForRender(read: () => Promise<ListingBetaRead>): Promise<ListingBetaRead> {
  try {
    return await read();
  } catch (err) {
    noteDegradedBetaRead(err);
    return BETA_UNAVAILABLE;
  }
}

/** {@link readListingBeta} on a RENDERING path — degrades on any error. See {@link readForRender}. */
export async function readListingBetaForRender(
  listingId: string,
  db: BetaReadClient
): Promise<ListingBetaRead> {
  return readForRender(() => readListingBeta(listingId, db));
}

/**
 * {@link readListingBetaBySlug} on the APP-LAUNCH path — degrades on any error.
 *
 * 🔴 THE ONE CALLER IS THE RUN PAGE, and this function exists so that call site cannot be
 * written any other way. See {@link readForRender} for why launch is different from a store
 * surface.
 */
export async function readListingBetaBySlugForRender(
  slug: string,
  db: BetaReadClient
): Promise<ListingBetaRead> {
  return readForRender(() => readListingBetaBySlug(slug, db));
}

/**
 * {@link readListingBetaMany} on a RENDERING path — degrades to an EMPTY map on any error, so
 * every row in the page renders as not-beta rather than the page 500ing.
 */
export async function readListingBetaManyForRender(
  listingIds: readonly string[],
  db: BetaReadClient
): Promise<Map<string, ListingBetaRead>> {
  try {
    return await readListingBetaMany(listingIds, db);
  } catch (err) {
    noteDegradedBetaRead(err);
    return new Map();
  }
}

/**
 * A listing id that CANNOT exist, used to ask the database about the COLUMNS without caring
 * about any row. `AppListing.id` is an `apl_<ULID>`, so nothing can collide with this, and
 * the lookup is a primary-key probe that matches nothing — the query still parses the
 * `select`, which is the only part that can raise P2022.
 */
const BETA_COLUMN_PROBE_ID = '__app_listing_beta_column_probe__';

/**
 * Are the manual-apply beta columns present?
 *
 * For a path that must decide whether it may name the columns with no listing in hand.
 *
 * Deliberately NOT memoised: the whole point is that the columns APPEAR partway through the
 * deploy's life, and a cached `false` would keep the feature inert until the next restart.
 */
export async function isBetaColumnAvailable(db: BetaReadClient): Promise<boolean> {
  return (await readListingBeta(BETA_COLUMN_PROBE_ID, db)).available;
}

/**
 * The message an AUTHOR sees when they edit their beta declaration before the manual-apply
 * migration has run.
 *
 * Exported so the tests assert the EXACT string rather than a substring of their own
 * invention, and so a mutant that swaps this guard for a different error is killed by the
 * message, not merely by "something threw".
 */
export const BETA_UNAVAILABLE_MESSAGE =
  'Beta status is not available on this environment yet. Leave the beta fields unchanged and try again later.';

/**
 * Gate an AUTHOR-ORIGINATED write of the beta columns on the manual-apply migration.
 *
 * 🔴 IT REFUSES RATHER THAN OMITTING, and the contrast is with the sibling `sourceRepoUrl`
 * module, which has an omit-fragment for its system-originated writes. Omitting the keys is
 * the right answer for a write the system originates on the author's behalf; it is the WRONG
 * answer for a value the author just typed, because the request then reports success while
 * the beta note vanishes, and the author's only recourse is to type it again. A refusal that
 * names the field is recoverable; a silent drop is not. Every beta write is author-
 * originated, so there is no second helper here.
 *
 * `PRECONDITION_FAILED`, not `BAD_REQUEST`: the value is not malformed and there is nothing
 * the author can do to make it acceptable — the environment is not ready. The distinct code
 * is also what lets a test tell this guard from the validator's rejection of an over-long
 * message, which is the mutation that would otherwise pass unnoticed.
 *
 * Callers must run this BEFORE any side effect, for the same reason the source-repo gate is
 * hoisted above the state routing in `updateListing`: a throw after `beginListingRevision`
 * would leave an orphan shadow revision draft behind.
 */
export function assertBetaWritable(available: boolean): void {
  if (available === true) return;
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: BETA_UNAVAILABLE_MESSAGE });
}

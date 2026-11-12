/**
 * App Store Listings — the guarded reader and writer for `app_listings.issue_tracker_url`, the
 * optional "where to report a bug / get support" link shown as a Support row on the store page.
 *
 * 🔴 RAW SQL, AND THE COLUMN IS NOT ON THE PRISMA MODEL. It is a MANUAL-APPLY column, declared
 * in `schema.full.prisma` with an inline `// @no-type`, so the generated client does not know it
 * and no Prisma query can name it. That is the posture `app-listing-visibility.service.ts`
 * documents: as an ordinary field it would be named by every `appListing` call that passes no
 * `select`, and the off-site submit path would 500 until a human applies the SQL (which is what
 * happened to `source_repo_url`; see the `app-listing-source-repo.service.ts` header). The column
 * is read and written here and nowhere else.
 *
 * 🔴 `available` IS NOT THE SAME QUESTION AS `value == null`. A listing with no link reads
 * `{ available: true, value: null }`; an unapplied migration reads
 * `{ available: false, value: null }`. Only the first licenses a write (a revision apply must be
 * able to CLEAR the parent's link, and may do so only when it could see the column).
 *
 * 🔴 NEVER NAME THE COLUMN INSIDE A TRANSACTION WITHOUT PROBING FIRST. PostgreSQL aborts the
 * whole transaction on any statement error, and Prisma's interactive transactions use no
 * savepoints, so a caught 42703 inside a transaction still fails every later statement with
 * 25P02. The transactional callers probe with {@link isIssueTrackerColumnAvailable} on the
 * primary BEFORE the transaction opens and touch the column inside it only when that said yes.
 *
 * TWO SHAPES OF WRITE, as for the source link:
 *   - a write the SYSTEM originates (shadow clone, revision apply, on-site manifest sync) skips
 *     the column when it is absent;
 *   - a write an AUTHOR originates refuses with {@link assertIssueTrackerWritable}, because
 *     dropping a value the author typed would report a save that did not happen.
 */

import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { validateIssueTrackerUrl } from '~/server/schema/blocks/external-app.schema';
import { isMissingColumnError } from '~/server/services/blocks/app-listing-source-repo.service';
import { noteDegradedRead } from '~/server/services/blocks/degraded-read-log';

/** What a guarded read of the column yields. See the header on `available`. */
export type ListingIssueTrackerRead = {
  /** `false` ⇒ the manual-apply migration has not been applied; never write the column. */
  available: boolean;
  /** The stored link, or `null` for "none set" AND for "could not read". */
  value: string | null;
};

/** The read every degraded path returns. */
export const ISSUE_TRACKER_UNAVAILABLE: ListingIssueTrackerRead = Object.freeze({
  available: false,
  value: null,
});

/**
 * Raw read surface: a replica, the primary, a transaction client or a test double. Every read
 * here is a TAGGED-TEMPLATE call (`db.$queryRaw\`…\``), like the other no-type column modules,
 * so a caller or test that inspects raw calls sees one shape.
 */
export type IssueTrackerReadClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRaw: (query: any, ...values: any[]) => Promise<any>;
};

/** Raw write surface. */
export type IssueTrackerWriteClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $executeRaw: (query: any, ...values: any[]) => Promise<any>;
};

type IssueTrackerRow = { id?: string; issueTrackerUrl: string | null };

function asStoredValue(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Read one listing's link, degrading to {@link ISSUE_TRACKER_UNAVAILABLE} when the column is
 * missing. Any other error (connection, timeout, missing table) propagates.
 *
 * A listing id that matches no row reads `{ available: true, value: null }`: the column was
 * readable, there was nothing to read.
 */
export async function readListingIssueTrackerUrl(
  listingId: string,
  db: IssueTrackerReadClient
): Promise<ListingIssueTrackerRead> {
  try {
    const rows = (await db.$queryRaw`SELECT "issue_tracker_url" AS "issueTrackerUrl"
        FROM "app_listings" WHERE "id" = ${listingId} LIMIT 1`) as
      | IssueTrackerRow[]
      | null
      | undefined;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return { available: true, value: asStoredValue(row?.issueTrackerUrl) };
  } catch (err) {
    if (isMissingColumnError(err)) return ISSUE_TRACKER_UNAVAILABLE;
    throw err;
  }
}

/**
 * {@link readListingIssueTrackerUrl} on a RENDERING path (the store page, the moderator
 * preview, the author's edit prefill): ANY error degrades to "unavailable" and is logged. A
 * cosmetic link must not 500 the page it decorates.
 */
export async function readListingIssueTrackerUrlForRender(
  listingId: string,
  db: IssueTrackerReadClient
): Promise<ListingIssueTrackerRead> {
  try {
    return await readListingIssueTrackerUrl(listingId, db);
  } catch (err) {
    noteDegradedRead(ISSUE_TRACKER_READ_DEGRADED_EVENT, err);
    return ISSUE_TRACKER_UNAVAILABLE;
  }
}

/** Log event for an issue-tracker read that fell back to its inert answer. */
export const ISSUE_TRACKER_READ_DEGRADED_EVENT = 'app-listing-issue-tracker-read-degraded';

/**
 * Many listings in ONE statement: listing id → stored link (`null` = none set).
 *
 * 🔴 A LISTING ABSENT FROM THE MAP IS "UNKNOWN", not "no link". A missing column, or any other
 * error, yields an EMPTY map, and every caller must read absence as "do not report on this
 * link" — the listing-problems nudge relies on exactly that so an unapplied migration never
 * tells an author to fill in a field that cannot be saved yet.
 */
export async function readListingIssueTrackerUrlsForRender(
  listingIds: readonly string[],
  db: IssueTrackerReadClient
): Promise<Map<string, string | null>> {
  if (listingIds.length === 0) return new Map();
  try {
    const rows = (await db.$queryRaw`SELECT "id", "issue_tracker_url" AS "issueTrackerUrl"
        FROM "app_listings" WHERE "id" IN (${Prisma.join([...listingIds])})`) as
      | IssueTrackerRow[]
      | null
      | undefined;
    if (!Array.isArray(rows)) return new Map();
    const out = new Map<string, string | null>();
    for (const r of rows) {
      // Only a row that CARRIES the selected column is an answer about it (a real row always
      // does, `null` included); anything else is not evidence and stays unknown.
      if (typeof r?.id === 'string' && r && 'issueTrackerUrl' in r) {
        out.set(r.id, asStoredValue(r.issueTrackerUrl));
      }
    }
    return out;
  } catch (err) {
    if (!isMissingColumnError(err)) noteDegradedRead(ISSUE_TRACKER_READ_DEGRADED_EVENT, err);
    return new Map();
  }
}

/**
 * Both trust links for a PAGE of listings, for the listing-problems nudge: two raw statements
 * (source repo, issue tracker), each degrading to an EMPTY map on any error — a missing column
 * included — so an unreadable link is "unknown" and never reported as missing.
 *
 * The source link is read by raw SQL here too, rather than through the Prisma delegate, so this
 * read names exactly one column per statement and cannot widen a shared `select`.
 */
export async function readListingProblemLinkMaps(
  listingIds: readonly string[],
  db: IssueTrackerReadClient
): Promise<{
  sourceRepoUrls: Map<string, string | null>;
  issueTrackerUrls: Map<string, string | null>;
}> {
  if (listingIds.length === 0) return { sourceRepoUrls: new Map(), issueTrackerUrls: new Map() };
  const readSourceRepos = async (): Promise<Map<string, string | null>> => {
    try {
      const rows = (await db.$queryRaw`SELECT "id", "source_repo_url" AS "sourceRepoUrl"
          FROM "app_listings" WHERE "id" IN (${Prisma.join([...listingIds])})`) as
        | Array<{ id?: unknown; sourceRepoUrl?: unknown }>
        | null
        | undefined;
      if (!Array.isArray(rows)) return new Map();
      const out = new Map<string, string | null>();
      for (const r of rows) {
        if (typeof r?.id === 'string' && r && 'sourceRepoUrl' in r) {
          out.set(r.id, asStoredValue(r.sourceRepoUrl));
        }
      }
      return out;
    } catch (err) {
      if (!isMissingColumnError(err)) noteDegradedRead(ISSUE_TRACKER_READ_DEGRADED_EVENT, err);
      return new Map();
    }
  };
  const [sourceRepoUrls, issueTrackerUrls] = await Promise.all([
    readSourceRepos(),
    readListingIssueTrackerUrlsForRender(listingIds, db),
  ]);
  return { sourceRepoUrls, issueTrackerUrls };
}

/**
 * A listing id that cannot exist (`AppListing.id` is `apl_<ULID>`), so the probe asks about the
 * COLUMN without caring about any row.
 */
const ISSUE_TRACKER_COLUMN_PROBE_ID = '__app_listing_issue_tracker_column_probe__';

/**
 * 🔴 RETIREMENT: this probe and every missing-column fallback in this module exist only for the
 * window before the manual migration `20270103120000_app_listing_issue_tracker` is applied.
 * Remove them once `issue_tracker_url` is applied in every writable environment and the
 * `app_listings.issue_tracker_url` entry in `inFlightColumns`
 * (`packages/civitai-db-schema/src/schema-drift/__tests__/production-snapshot.test.ts`) is
 * dropped. Until then they stay.
 *
 * Is the manual-apply column present? Run it OUTSIDE any transaction, on the client the
 * transaction will use (the primary). Not memoised: the column appears partway through a
 * deploy's life, and a cached `false` would keep the feature inert until a restart.
 *
 * 🔴 ONLY A MISSING-COLUMN ERROR ANSWERS `false`; every other error PROPAGATES, exactly as
 * `isSourceRepoColumnAvailable` does. The transactional callers (`beginListingRevision`, the
 * revision apply) turn this answer into "skip the column", so a transient fault read as
 * "unavailable" would mint a shadow without the live link (cleared at the next approve) or apply
 * a reviewed revision without its link — both silently, with a success response. Failing the
 * operation instead is recoverable: the caller retries. On the on-site approve sync the probe
 * runs inside that path's log-and-continue block, as the source-repo probe does.
 */
export async function isIssueTrackerColumnAvailable(db: IssueTrackerReadClient): Promise<boolean> {
  return (await readListingIssueTrackerUrl(ISSUE_TRACKER_COLUMN_PROBE_ID, db)).available;
}

/**
 * Write one listing's link (`null` clears it). Only call it once the column is known to exist —
 * {@link assertIssueTrackerWritable} for an author write, the probe for a system write.
 */
export async function writeListingIssueTrackerUrl(
  db: IssueTrackerWriteClient,
  listingId: string,
  value: string | null
): Promise<number> {
  return Number(
    await db.$executeRaw`UPDATE "app_listings" SET "issue_tracker_url" = ${value} WHERE "id" = ${listingId}`
  );
}

/**
 * The on-site manifest sync's write: every on-site listing backed by `appBlockId` (there is at
 * most one; a shadow revision has `app_block_id` NULL, so an in-flight revision is never hit).
 */
export async function writeOnsiteListingIssueTrackerUrlByAppBlock(
  db: IssueTrackerWriteClient,
  appBlockId: string,
  value: string | null
): Promise<number> {
  return Number(
    await db.$executeRaw`UPDATE "app_listings" SET "issue_tracker_url" = ${value} WHERE "app_block_id" = ${appBlockId} AND "kind" = 'onsite'`
  );
}

/**
 * Run a SYSTEM-originated write of the column outside any transaction, logging instead of
 * throwing. For the on-site approve / backfill paths, which are log-and-continue: a failure of
 * this cosmetic link must not abort the store-listing write it follows. The next approved
 * version re-syncs it.
 */
export async function writeIssueTrackerBestEffort(
  label: string,
  write: () => Promise<unknown>
): Promise<void> {
  try {
    await write();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[issue-tracker] ${label}: write skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** The refusal an author sees when they set a link before the migration has been applied. */
export const ISSUE_TRACKER_UNAVAILABLE_MESSAGE =
  'The issue tracker link is not available on this environment yet. Leave the field empty and try again later.';

/**
 * Gate an AUTHOR write of the link on the manual-apply column. `PRECONDITION_FAILED`, not
 * `BAD_REQUEST`: the value is fine, the environment is not ready. Run it before any side effect.
 */
export function assertIssueTrackerWritable(available: boolean): void {
  if (available === true) return;
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: ISSUE_TRACKER_UNAVAILABLE_MESSAGE });
}

/**
 * What an author patch asks of the column. `undefined` in → `{ write: false }` (leave it alone);
 * `null` → clear; a string → the validated, normalised value. Refuses an unavailable column
 * FIRST (an explicit clear is as unwritable as a value), then a malformed link. PURE apart from
 * throwing, so callers can resolve it before any write.
 */
export function resolveIssueTrackerPatch(
  patched: string | null | undefined,
  available: boolean
): { write: false } | { write: true; value: string | null } {
  if (patched === undefined) return { write: false };
  assertIssueTrackerWritable(available);
  if (patched === null) return { write: true, value: null };
  const v = validateIssueTrackerUrl(patched);
  if (!v.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: v.error });
  return { write: true, value: v.url };
}

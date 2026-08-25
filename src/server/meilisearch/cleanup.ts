import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';
import { searchClient } from '~/server/meilisearch/client';
import {
  clearScanCursor,
  readScanCursor,
  writeScanCursor,
  type CursorDiscardReason,
} from '~/server/meilisearch/cleanup-cursor';
import { assessPassCoverage } from '~/server/meilisearch/cleanup-coverage';
import { userSearchIndexEligibilitySql } from '~/server/search-index/user-index-eligibility';
import type { JobContext } from '~/server/jobs/job';
import {
  ArticleIngestionStatus,
  ArticleStatus,
  Availability,
  CollectionReadConfiguration,
  ModelStatus,
} from '~/shared/utils/prisma/enums';

/**
 * How long to wait before re-asking the same cursor after an empty page that COVERAGE
 * ALREADY AGREES IS THE END. Also the delay used once the escalation budget below is
 * exhausted, so an exhausted budget degrades to exactly the pre-existing single confirm
 * rather than to a longer or an absent one.
 */
export const EMPTY_PAGE_CONFIRM_DELAY_MS = 500;

/**
 * Escalating re-asks for an empty page arriving while coverage says the scan is nowhere
 * near the end. Measured: the engine's task queue was about an hour behind and applying
 * writes in large batches when it answered empty at 15.5% coverage, and replaying the
 * identical query off-peak walked 400 pages without ever hitting an end. One retry at
 * 500 ms cannot clear a write batch that takes far longer.
 *
 * Five attempts, 30 s of waiting for one empty page.
 */
export const EMPTY_PAGE_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

/**
 * Coverage at or above which an empty page is taken at close to face value and gets only
 * the cheap single confirmation. Deliberately generous and NOT exact: `totalInIndex` is a
 * pre-scan snapshot that drifts while the scan runs, and one index has legitimately
 * reported coverage slightly ABOVE 1 because documents were added mid-scan.
 */
export const EMPTY_PAGE_TRUST_COVERAGE = 0.9;

/**
 * Ceiling on time spent ESCALATING, per index per run: 5 minutes.
 *
 * 🔴 State precisely what this does and does not bound, because an earlier version of
 * this comment claimed a total it did not enforce. EVERY delay is charged against it,
 * including the first — so escalation really is capped at 5 minutes per index, ~35
 * minutes across the seven configured indexes, against the job's 2 h lock.
 *
 * What it does NOT bound: every empty page still gets ONE confirmation even after the
 * budget is gone, because never confirming at all is the original defect. That residual
 * is `EMPTY_PAGE_CONFIRM_DELAY_MS` per empty page, and empty pages are bounded by pages,
 * since a transient empty that then yields documents advances the cursor. So the true
 * worst case is 5 min of escalation plus 0.5 s per empty page.
 */
export const EMPTY_PAGE_BACKOFF_BUDGET_MS = 5 * 60 * 1000;

export type CleanupIndexKey =
  | 'models'
  | 'articles'
  | 'users'
  | 'collections'
  | 'bounties'
  | 'tools'
  | 'comics';

type IndexConfig = {
  key: CleanupIndexKey;
  indexName: string;
  tableName: string;
  alias: string;
  where: (ids: number[]) => Prisma.Sql;
};

export const CLEANUP_INDEXES: IndexConfig[] = [
  {
    key: 'models',
    indexName: MODELS_SEARCH_INDEX,
    tableName: 'Model',
    alias: 'm',
    where: (ids) => Prisma.sql`
      m.id IN (${Prisma.join(ids)})
      AND m.status = ${ModelStatus.Published}::"ModelStatus"
      AND m.availability != ${Availability.Unsearchable}::"Availability"
    `,
  },
  {
    key: 'articles',
    indexName: ARTICLES_SEARCH_INDEX,
    tableName: 'Article',
    alias: 'a',
    where: (ids) => Prisma.sql`
      a.id IN (${Prisma.join(ids)})
      AND a."publishedAt" IS NOT NULL
      AND a.status = ${ArticleStatus.Published}::"ArticleStatus"
      AND a.ingestion = ${ArticleIngestionStatus.Scanned}::"ArticleIngestionStatus"
      AND a."tosViolation" = FALSE
      AND a.availability != ${Availability.Unsearchable}::"Availability"
    `,
  },
  {
    key: 'users',
    indexName: USERS_SEARCH_INDEX,
    tableName: 'User',
    alias: 'u',
    // Shares its predicate with the write side (`users.search-index.ts`) so the reconciler
    // and the indexer cannot disagree about who belongs in the index. This is the half that
    // EVICTS an account that changed state after it was indexed — the incremental sync keys
    // its range scan on `createdAt`, so it never revisits an existing row.
    where: (ids) => Prisma.sql`
      u.id IN (${Prisma.join(ids)})
      AND ${userSearchIndexEligibilitySql()}
    `,
  },
  {
    key: 'collections',
    indexName: COLLECTIONS_SEARCH_INDEX,
    tableName: 'Collection',
    alias: 'c',
    where: (ids) => Prisma.sql`
      c.id IN (${Prisma.join(ids)})
      AND c."userId" != -1
      AND c.read = ${CollectionReadConfiguration.Public}::"CollectionReadConfiguration"
      AND c.availability != 'Unsearchable'::"Availability"
      AND EXISTS (SELECT 1 FROM "CollectionItem" ci WHERE ci."collectionId" = c.id)
    `,
  },
  {
    key: 'bounties',
    indexName: BOUNTIES_SEARCH_INDEX,
    tableName: 'Bounty',
    alias: 'b',
    where: (ids) => Prisma.sql`
      b.id IN (${Prisma.join(ids)})
      AND b."userId" != -1
      AND (b."startsAt" <= NOW() OR b."expiresAt" >= NOW())
      AND b.availability != 'Unsearchable'::"Availability"
    `,
  },
  {
    key: 'tools',
    indexName: TOOLS_SEARCH_INDEX,
    tableName: 'Tool',
    alias: 't',
    where: (ids) => Prisma.sql`
      t.id IN (${Prisma.join(ids)})
      AND t.enabled = TRUE
      AND t.unlisted = FALSE
    `,
  },
  {
    key: 'comics',
    indexName: COMICS_SEARCH_INDEX,
    tableName: 'ComicProject',
    alias: 'cp',
    // MUST mirror `comics.search-index.ts:WHERE`. Cleanup compares
    // index docs against this predicate to decide which still belong
    // — a permissive predicate here means newly TOS-violated, banned-
    // user, or tainted-image projects are kept "valid" and never
    // pruned from Meilisearch.
    where: (ids) => Prisma.sql`
      cp.id IN (${Prisma.join(ids)})
      AND cp.status = 'Active'::"ComicProjectStatus"
      AND cp."tosViolation" = FALSE
      AND cp."userId" != -1
      AND EXISTS (
        SELECT 1 FROM "User" u
        WHERE u.id = cp."userId" AND u."bannedAt" IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM "ComicChapter" cc
        WHERE cc."projectId" = cp.id
        AND cc.status = 'Published'::"ComicChapterStatus"
        AND EXISTS (
          SELECT 1 FROM "ComicPanel" cpn
          JOIN "Image" i ON i.id = cpn."imageId"
          WHERE cpn."projectId" = cc."projectId"
          AND cpn."chapterPosition" = cc."position"
          AND cpn.status = 'Ready'::"ComicPanelStatus"
          AND cpn."imageUrl" IS NOT NULL
          AND i."ingestion" = 'Scanned'::"ImageIngestionStatus"
          AND i."needsReview" IS NULL
          AND i."tosViolation" = FALSE
        )
        AND NOT EXISTS (
          SELECT 1 FROM "ComicPanel" cpn
          LEFT JOIN "Image" i ON i.id = cpn."imageId"
          WHERE cpn."projectId" = cc."projectId"
          AND cpn."chapterPosition" = cc."position"
          AND cpn.status = 'Ready'::"ComicPanelStatus"
          AND (
            i.id IS NULL
            OR i."ingestion" != 'Scanned'::"ImageIngestionStatus"
            OR i."needsReview" IS NOT NULL
            OR i."tosViolation" = TRUE
          )
        )
      )
    `,
  },
];

export type CleanupOptions = {
  apply: boolean;
  /** Retained for backwards compatibility. Ignored under keyset pagination — scans are sequential by id. */
  concurrency?: number;
  batch?: number;
  maxBatches?: number;
  /** Max ids per delete call. Meili accepts large bodies; keep chunks sane. */
  deleteChunkSize?: number;
  /**
   * Read/write the shared cross-run scan cursor. OFF by default so a dry run or an
   * ad-hoc invocation of the one-off script cannot move the position the nightly job
   * resumes from; the cron opts in.
   */
  resumable?: boolean;
  /**
   * How the scan waits. Overridable so a test can assert the empty-page backoff
   * SCHEDULE without spending it — the escalation is the property under test, and a
   * suite that really slept through it could not run. Defaults to real time.
   */
  delay?: (ms: number) => Promise<void>;
  /**
   * Escalation budget for empty-page confirmation. Overridable for the same reason as
   * `delay`: at the shipped 5 minutes no fixture of a runnable size ever reaches it, so
   * the clamp would ship having never once executed. Defaults to
   * `EMPTY_PAGE_BACKOFF_BUDGET_MS`.
   */
  emptyPageBackoffBudgetMs?: number;
  onBatch?: (info: { key: string; offset: number; scanned: number; stale: number }) => void;
  onError?: (info: { key: string; offset: number; error: Error }) => void;
  onDelete?: (info: { key: string; chunk: number; ids: number }) => void;
  jobContext?: JobContext;
};

export type CleanupIndexStats = {
  key: string;
  indexName: string;
  batchesProcessed: number;
  idsScanned: number;
  staleFound: number;
  deleted: number;
  totalInIndex: number | null;
  errors: number;
  /**
   * TRUE when the scan ended for any reason other than reaching a confirmed
   * end of the index. This — not a scanned-vs-total comparison — is the
   * authoritative "the pass did not cover the index" signal: `totalInIndex` is
   * a snapshot taken before a scan that then runs for hours against an index
   * other jobs are concurrently deleting from, so the two numbers legitimately
   * disagree on a perfectly complete run.
   */
  stoppedEarly: boolean;
  /**
   * Ids that were fetched from the index but whose eligibility lookup failed,
   * so they were neither judged nor deleted. The cursor still advanced past
   * them. Distinct from `stoppedEarly`: a scan can reach the very end of the
   * index having skipped batches along the way.
   */
  idsSkipped: number;
  /**
   * Ids the read replica called stale that the PRIMARY then said were still
   * eligible, so they were NOT deleted. A non-zero value is replication lag
   * being caught, which is exactly what the primary re-check exists for.
   */
  rescuedByPrimary: number;
  /** `isIndexing` as reported alongside the document count, or null if unread. */
  indexingAtStart: boolean | null;
  /**
   * Ids walked past by the whole PASS — this run plus every earlier run it resumed
   * from. A resumed run scans only the remainder of the index, so its own `idsScanned`
   * is legitimately a fraction of `totalInIndex`; any coverage verdict has to be
   * computed from this instead, or every resumed run reads as truncated.
   */
  passCovered: number;
  /** The stored cursor this run resumed from, or null if it started from the bottom. */
  resumedFrom: number | null;
  /** The cursor left behind for the next run, or null if none was. */
  cursorPersisted: number | null;
  /**
   * Whether the stored cursor was DISCARDED at the end of this run, so the next run
   * starts from the bottom. Reported rather than inferred from `cursorPersisted: null`,
   * which a healthy completed pass and a failed write emit identically.
   */
  cursorCleared: boolean;
  /**
   * Why a stored cursor was NOT used, or null if one was. `missing` after a completed
   * pass is normal; `unparseable`/`invalid`/`unreadable` mean the run silently restarted
   * from the bottom, which is safe but is not the same event and should not look like one.
   */
  cursorDiscardReason: CursorDiscardReason | null;
  /** How many times an empty page was re-asked before the scan believed it. */
  emptyPageRetries: number;
};

/**
 * Which of `ids` still BELONG in the index, according to `client`.
 *
 * The client is a parameter because the two call sites ask different
 * questions. The scan asks the read replica (cheap, and a wrong answer only
 * costs a document being re-examined tomorrow); the delete path re-asks the
 * PRIMARY, because there a wrong answer destroys a document.
 */
async function fetchValidIds(
  cfg: IndexConfig,
  ids: number[],
  client: typeof dbRead | typeof dbWrite
): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await client.$queryRaw<{ id: number }[]>`
    SELECT ${Prisma.raw(`${cfg.alias}.id`)}::int AS id
    FROM ${Prisma.raw(`"${cfg.tableName}"`)} ${Prisma.raw(cfg.alias)}
    WHERE ${cfg.where(ids)}
  `;
  return new Set(rows.map((r) => r.id));
}

export async function cleanupIndex(
  cfg: IndexConfig,
  opts: CleanupOptions
): Promise<CleanupIndexStats> {
  if (!searchClient) throw new Error('searchClient not configured');
  const index = searchClient.index(cfg.indexName);

  // The requested page size is only a ceiling REQUEST. The engine caps a
  // search `limit` at the index's `pagination.maxTotalHits`, so the effective
  // page size is clamped to that in the preflight below.
  let batch = opts.batch ?? 1000;
  const maxBatches = opts.maxBatches ?? Infinity;
  const deleteChunkSize = opts.deleteChunkSize ?? 10000;

  const stats: CleanupIndexStats = {
    key: cfg.key,
    indexName: cfg.indexName,
    batchesProcessed: 0,
    idsScanned: 0,
    staleFound: 0,
    deleted: 0,
    totalInIndex: null,
    errors: 0,
    stoppedEarly: true,
    idsSkipped: 0,
    rescuedByPrimary: 0,
    indexingAtStart: null,
    passCovered: 0,
    resumedFrom: null,
    cursorPersisted: null,
    cursorCleared: false,
    cursorDiscardReason: null,
    emptyPageRetries: 0,
  };

  try {
    const statsRes = await index.getStats();
    stats.totalInIndex = statsRes.numberOfDocuments;
    // Recorded because it changes how the document count should be read: a
    // count taken while the engine is mid-ingest is a moving number, so a
    // shortfall against it is not evidence of a truncated scan.
    stats.indexingAtStart = statsRes.isIndexing ?? null;
  } catch {
    // non-fatal
  }

  // Preflight: keyset pagination needs `id` declared both filterable AND
  // sortable on the index. If either is missing, the scan would 4xx every
  // batch — bail out early with a logged error so the cron doesn't waste
  // retries and the missing-setting cause is surfaced clearly.
  //
  // The same call is where we learn the index's real page ceiling: a search
  // `limit` above `pagination.maxTotalHits` is silently truncated to it, and
  // that ceiling is PER-INDEX (an index left at the default is far lower than
  // one that has been raised). Clamping here means a large requested batch is
  // safe to ask for everywhere — indexes that can serve it do, and the ones
  // that cannot fall back to their own ceiling instead of being truncated.
  try {
    const indexSettings = await index.getSettings();
    const filt = indexSettings.filterableAttributes ?? [];
    const sort = indexSettings.sortableAttributes ?? [];
    const maxTotalHits = indexSettings.pagination?.maxTotalHits;
    if (typeof maxTotalHits === 'number' && Number.isFinite(maxTotalHits) && maxTotalHits > 0) {
      batch = Math.min(batch, maxTotalHits);
    }
    if (!filt.includes('id') || !sort.includes('id')) {
      stats.errors += 1;
      opts.onError?.({
        key: cfg.key,
        offset: -1,
        error: new Error(
          `index ${cfg.indexName} is missing required settings for keyset scan ` +
            `(filterable has id=${filt.includes('id')}, sortable has id=${sort.includes('id')}). ` +
            `Add 'id' to both lists in ${cfg.key}.search-index.ts and let onIndexSetup run.`
        ),
      });
      return stats;
    }
  } catch (err) {
    stats.errors += 1;
    opts.onError?.({ key: cfg.key, offset: -1, error: err as Error });
    return stats;
  }

  // Keyset (cursor) pagination over `id`. Per-call cost is O(batch) on
  // Meilisearch regardless of depth — replaces offset pagination where
  // deep pages were saturating LMDB read I/O on the search host.
  //
  // 🔴 The starting point is READ FROM DURABLE STATE, not hardcoded to the bottom.
  // A scan that cannot walk a multi-million-document index inside one nightly run
  // and then restarts at the bottom re-examines the same already-clean prefix every
  // night and can NEVER reach the region past where it stopped — measured, the
  // boundary of the unscanned region did not move by a single id across two
  // consecutive nightly runs. No page size fixes that: a from-scratch scan that
  // cannot finish in one run makes zero cumulative progress by construction.
  const resumable = opts.resumable === true;
  let lastId = -1;
  // When the pass that owns this cursor first started, and how much of the index it
  // has walked past in total. Both are carried across runs; both are reset here when
  // the run starts a fresh pass.
  let passStartedAt = Date.now();
  let carriedCovered = 0;

  if (resumable) {
    const { cursor, reason } = await readScanCursor(cfg.key);
    stats.cursorDiscardReason = reason === 'none' ? null : reason;
    if (cursor) {
      // Resume AT the stored id, not one past it: the page filter is `id > lastId`,
      // so the stored value is the last id already walked past and the next page
      // begins with the one after it. Storing-then-incrementing here would skip
      // exactly one document per run, permanently.
      lastId = cursor.lastId;
      passStartedAt = cursor.startedAt;
      carriedCovered = cursor.covered;
      stats.resumedFrom = cursor.lastId;
    }
  }

  // Stale ids awaiting deletion. Deliberately NOT an accumulator for the whole
  // index: deletions are flushed as the scan runs, so a run that is cancelled
  // part-way keeps everything it has already deleted. Batching all deletions
  // until after the scan made the job all-or-nothing — a cancellation (the
  // request socket closing) broke the scan, then broke the delete loop at
  // chunk 0, and the index got ZERO deletions for the run.
  //
  // Nothing is pushed here under `apply: false`, or the sentence above would be
  // false in that mode: `flushDeletions` returns immediately without applying,
  // so the list would never drain and would grow to hold every stale id in the
  // index — exactly the accumulator this replaced. `staleFound` is counted
  // independently, so the dry-run figures are unaffected.
  const pendingStaleIds: number[] = [];

  // Retry helper: run `fn` up to MAX_ATTEMPTS times with linear backoff.
  // Re-throws immediately if the job is canceled mid-retry — otherwise the
  // inner try/catch would treat the cancellation as a transient error and
  // burn through the backoff before bailing.
  const MAX_ATTEMPTS = 3;
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const withRetries = async <T>(fn: () => Promise<T>): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      opts.jobContext?.checkIfCanceled();
      try {
        return await fn();
      } catch (err) {
        // If the job is no longer running, surface the canonical
        // cancellation error (not the underlying fetch/PG error) so log
        // handlers can distinguish "we stopped on purpose" from "we failed".
        // `!== 'running'` mirrors `createJob.checkIfCanceled` exactly —
        // catches both `canceled` and (theoretically) `finished`.
        if (opts.jobContext && opts.jobContext.status !== 'running') {
          opts.jobContext.checkIfCanceled();
          throw err; // unreachable if checkIfCanceled threw, but kept for typing
        }
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          // Linear backoff: 1000ms, 1500ms.
          await delay(attempt * 500 + 500);
        }
      }
    }
    throw lastErr;
  };

  // Defensive cap: if Postgres fails for many batches in a row, abandon
  // this index for the run rather than walking the whole id-space at
  // ~2.5s per batch. The job lock would eventually cancel us anyway,
  // but this short-circuits before we waste an hour.
  const MAX_CONSECUTIVE_PG_FAILURES = 10;
  let consecutivePgFailures = 0;

  /** Set when the monotonicity guard fired; see the guard for why it forbids persisting. */
  let cursorUnadvanceable = false;

  // One keyset page, already reduced to the numeric ids it carried.
  const fetchPage = async (cursor: number): Promise<number[]> => {
    const page = await withRetries(() =>
      index.search<{ id: number }>('', {
        filter: `id > ${cursor}`,
        sort: ['id:asc'],
        limit: batch,
        attributesToRetrieve: ['id'],
      })
    );
    return page.hits.map((r) => r.id).filter((n): n is number => Number.isFinite(n));
  };

  const backoffBudgetMs = opts.emptyPageBackoffBudgetMs ?? EMPTY_PAGE_BACKOFF_BUDGET_MS;
  let emptyPageBackoffSpentMs = 0;

  /**
   * Coverage of the whole PASS so far, or null when the index total is unknown.
   * Includes ids carried from earlier runs of the same pass, and ids the cursor walked
   * past without judging — both were covered by the scan's position even though only
   * one of them was examined.
   */
  const passCoverageSoFar = (): number | null => {
    if (stats.totalInIndex === null || stats.totalInIndex <= 0) return null;
    return (carriedCovered + stats.idsScanned + stats.idsSkipped) / stats.totalInIndex;
  };

  /**
   * Re-ask `cursor` after an empty page and return whatever the last attempt saw.
   *
   * 🔴 An empty page is EVIDENCE, weighed against coverage — not a terminator. When the
   * scan has covered nearly the whole index, an empty page is what the end of the index
   * looks like and one cheap confirm is enough. When it has covered a fraction, an empty
   * page contradicts the index's own document count, and the thing most likely to
   * produce it is the engine being mid-write — so it is re-asked with escalating
   * backoff before being believed.
   */
  const confirmEmptyPage = async (cursor: number): Promise<number[]> => {
    const coverage = passCoverageSoFar();
    const schedule =
      coverage === null || coverage >= EMPTY_PAGE_TRUST_COVERAGE
        ? [EMPTY_PAGE_CONFIRM_DELAY_MS]
        : EMPTY_PAGE_BACKOFF_MS;

    let page: number[] = [];
    let asked = 0;
    for (const ms of schedule) {
      // EVERY delay is charged, the first included. An earlier version exempted it,
      // which meant the budget bounded nothing about how many empty pages could be
      // confirmed — the documented "~5 minutes per index" was not what ran.
      if (emptyPageBackoffSpentMs + ms > backoffBudgetMs) break;
      emptyPageBackoffSpentMs += ms;
      stats.emptyPageRetries += 1;
      asked += 1;
      await delay(ms);
      page = await fetchPage(cursor);
      if (page.length > 0) return page;
    }

    // Budget gone before a single re-ask. Confirm ONCE anyway, at the cheap delay:
    // believing an empty page on sight is the original defect, and this must never
    // degrade below the single confirmation the scan already did before this change.
    // Charged too, so the spend figure stays truthful.
    if (asked === 0) {
      emptyPageBackoffSpentMs += EMPTY_PAGE_CONFIRM_DELAY_MS;
      stats.emptyPageRetries += 1;
      await delay(EMPTY_PAGE_CONFIRM_DELAY_MS);
      page = await fetchPage(cursor);
    }
    return page;
  };

  let chunkIdx = 0;

  /**
   * Delete whole chunks of `pendingStaleIds`; with `final`, delete the
   * remainder too.
   *
   * 🔴 Every id is re-verified against the PRIMARY immediately before it is
   * deleted, and only ids the primary ALSO calls ineligible are sent.
   *
   * The scan judges eligibility from `dbRead`, a read replica. A document
   * indexed moments ago whose row has not replicated yet looks like it belongs
   * to nothing and is classified stale — and the fix that made this scan reach
   * the end of the index is precisely what makes it reach that freshly-written
   * high-id tail for the first time. The replica read stays because it is the
   * cheap filter over millions of ids; this is the expensive check over the
   * few thousand that filter selects, where being wrong destroys a document
   * rather than costing a re-examination tomorrow.
   *
   * If the primary cannot be reached the chunk is NOT deleted. The safe
   * failure direction here is to delete nothing: an undeleted stale document is
   * picked up by a LATER pass, a wrongly deleted live one is not.
   *
   * ⚠️ "Later pass", not "tomorrow". Under `resumable` the next run continues ABOVE
   * these ids, so they are re-examined when the cursor next laps the index — at most
   * one pass away, bounded by the cursor staleness limit. That is a real change in
   * cleanup LATENCY for a truncating index, and the trade the cursor buys: before it,
   * these ids were re-examined the next night, but the ids above the truncation point
   * were never examined at all.
   */
  const flushDeletions = async (final: boolean) => {
    if (!opts.apply) return;
    while (pendingStaleIds.length >= deleteChunkSize || (final && pendingStaleIds.length > 0)) {
      // Bail before submitting more delete tasks if the job is no longer
      // running. (`!== 'running'` mirrors what `createJob.checkIfCanceled`
      // actually throws on: status flipped to either `canceled` or `finished`.)
      //
      // ⚠️ REDUNDANT, and deliberately kept: `withRetries` calls
      // `checkIfCanceled()` before its first attempt, so a cancelled job stops
      // here either way. Mutation-testing confirms it — removing this line
      // kills no test, because the throw from `withRetries` reaches the same
      // early `return`. It is an explicit cheap check in front of an expensive
      // one, not a correctness guard; do not read its presence as evidence
      // that the path below is otherwise unprotected.
      if (opts.jobContext && opts.jobContext.status !== 'running') return;

      const chunk = pendingStaleIds.splice(0, deleteChunkSize);

      let confirmed: number[];
      try {
        const stillValid = await withRetries(() => fetchValidIds(cfg, chunk, dbWrite));
        confirmed = chunk.filter((id) => !stillValid.has(id));
        stats.rescuedByPrimary += chunk.length - confirmed.length;
      } catch (err) {
        if (opts.jobContext && opts.jobContext.status !== 'running') return;
        stats.errors += 1;
        opts.onError?.({
          key: cfg.key,
          offset: -1,
          error: new Error(
            `skipped deleting ${chunk.length} id(s) from ${cfg.indexName}: ` +
              `primary re-check failed (${(err as Error).message})`
          ),
        });
        continue;
      }

      if (confirmed.length === 0) continue;

      try {
        opts.jobContext?.checkIfCanceled();
        await index.deleteDocuments(confirmed);
        stats.deleted += confirmed.length;
        opts.onDelete?.({ key: cfg.key, chunk: chunkIdx, ids: confirmed.length });
      } catch (err) {
        // Treat cancellation thrown mid-deleteDocuments as a clean stop.
        if (opts.jobContext && opts.jobContext.status !== 'running') return;
        stats.errors += 1;
        opts.onError?.({ key: cfg.key, offset: -1, error: err as Error });
      }
      chunkIdx += 1;
    }
  };

  while (stats.batchesProcessed < maxBatches) {
    if (opts.jobContext?.status === 'canceled') break;

    // Retry transient errors on the Meili scan a few times before aborting
    // the whole index. The original concurrent-offset code naturally
    // tolerated a single bad batch (other concurrent batches still made
    // progress); sequential keyset has no such redundancy.
    let docIds: number[];
    try {
      docIds = await fetchPage(lastId);

      // An empty page is the ONLY terminator, and it is not trusted on sight.
      // The engine can be concurrently applying document additions and deletions
      // while we scan, and a transient empty reply at a cursor that still has
      // documents past it would otherwise end the scan early — silently, and
      // reported as success. `confirmEmptyPage` re-asks the SAME cursor, escalating
      // when the index's own document count says we cannot possibly be at the end.
      if (docIds.length === 0) docIds = await confirmEmptyPage(lastId);
    } catch (err) {
      // Cancellation surfaced from withRetries is a clean stop, not a failure.
      if (opts.jobContext && opts.jobContext.status !== 'running') break;
      stats.errors += 1;
      opts.onError?.({ key: cfg.key, offset: lastId, error: err as Error });
      // Out of retries — without advancing the cursor we'd loop on the same page.
      break;
    }

    if (docIds.length === 0) {
      // The one clean terminator: a confirmed-empty page at the cursor.
      stats.stoppedEarly = false;
      break;
    }

    // 🔴 The cursor MUST strictly advance, and that is asserted rather than
    // assumed — BEFORE the page is judged, so a non-advancing page is never
    // examined (or deleted from) twice.
    //
    // Termination now rests entirely on the cursor: `maxBatches` is Infinity
    // from the cron, and dropping the short-page break removed the accidental
    // bound that used to exist. A page whose last id is not greater than the
    // cursor would re-issue the identical query forever, holding a Postgres
    // connection and a Meilisearch reader for the life of the process.
    //
    // ids come back sorted asc, so the last one is the highest.
    const nextId = docIds[docIds.length - 1];
    if (!(nextId > lastId)) {
      stats.errors += 1;
      // 🔴 A cursor the scan could not advance past on the FIRST page of a resumed run
      // must NOT be handed to the next run: persisting it makes every later run trip
      // this same guard immediately and examine ZERO documents, for as long as the
      // staleness bound allows — turning one bad page into a whole index going
      // uncleaned. Before the cursor existed, everything below the bad page was still
      // cleaned nightly, and discarding restores exactly that.
      //
      // Recorded, not acted on here: whether this abort should discard depends on
      // whether the run made progress first, which is decided after the loop by
      // `wedgedOnResume`. Discarding unconditionally would throw away a whole night's
      // work whenever the guard fires deep into a pass.
      cursorUnadvanceable = true;
      opts.onError?.({
        key: cfg.key,
        offset: lastId,
        error: new Error(
          `aborting ${cfg.indexName} scan: cursor did not advance ` +
            `(last id ${nextId} is not greater than cursor ${lastId}); ` +
            `the index is not returning ids in ascending order past the filter`
        ),
      });
      break;
    }

    // Same retry envelope on the Postgres side. A connection blip or short
    // replica-lag spike shouldn't drop ~10M docs of users cleanup.
    try {
      const validIds = await withRetries(() => fetchValidIds(cfg, docIds, dbRead));
      const staleIds = docIds.filter((id) => !validIds.has(id));

      stats.batchesProcessed += 1;
      stats.idsScanned += docIds.length;
      stats.staleFound += staleIds.length;
      consecutivePgFailures = 0;

      if (opts.apply && staleIds.length > 0) pendingStaleIds.push(...staleIds);

      // `offset` in the callback reports the cursor (last id seen before this batch).
      opts.onBatch?.({
        key: cfg.key,
        offset: lastId,
        scanned: docIds.length,
        stale: staleIds.length,
      });

      // Flush whole chunks as they accumulate, so progress survives a
      // cancellation. Only complete chunks here — the remainder goes out in
      // the final flush after the loop.
      await flushDeletions(false);
    } catch (err) {
      // Cancellation surfaced from withRetries is a clean stop, not a
      // Postgres failure — don't pollute the consecutivePgFailures counter
      // or log it as an error.
      if (opts.jobContext && opts.jobContext.status !== 'running') break;
      // Postgres-side error survived retries. Don't abandon the whole
      // index for a single transient batch — advance the cursor and try
      // the next page. We'll miss cleanup for the ids in this batch this
      // run; a LATER PASS will catch them — under `resumable` the next RUN
      // continues above them, so it is when the cursor next laps the index,
      // not tomorrow. But cap consecutive failures so a hard outage doesn't
      // grind through millions of ids.
      stats.errors += 1;
      consecutivePgFailures += 1;
      // These ids were fetched but never judged. The cursor advances past them
      // regardless, so the scan can still reach the end of the index — which
      // is why this is counted separately from `stoppedEarly` rather than
      // folded into one "incomplete" verdict.
      stats.idsSkipped += docIds.length;
      opts.onError?.({ key: cfg.key, offset: lastId, error: err as Error });
      if (consecutivePgFailures >= MAX_CONSECUTIVE_PG_FAILURES) {
        opts.onError?.({
          key: cfg.key,
          offset: lastId,
          error: new Error(
            `aborting ${cfg.indexName} scan: ${consecutivePgFailures} consecutive Postgres errors`
          ),
        });
        // Advance the cursor so a possible retry of the outer cron picks up
        // where we left off. `nextId` is the guarded, strictly-greater value.
        lastId = nextId;
        break;
      }
    }

    // Advance the cursor, already proven to move forward by the guard above.
    //
    // A SHORT page is deliberately NOT a terminator. "Fewer hits than I asked
    // for" and "no more documents" are different statements: the engine caps a
    // page at the index's own ceiling, and can return fewer for reasons of its
    // own. Treating short as done ended a scan at whatever page happened to
    // come back small and reported the run as complete. The cursor advances
    // correctly either way, so the only cost of dropping that shortcut is one
    // additional (empty, then confirmed-empty) query per index.
    lastId = nextId;
  }

  // Whatever is left over after the loop, including the tail of a scan that
  // stopped early. A cancelled run returns from inside the flush instead.
  await flushDeletions(true);

  stats.passCovered = carriedCovered + stats.idsScanned + stats.idsSkipped;

  if (resumable) {
    /**
     * 🔴 "Genuinely reached the end" is NOT "we saw an empty page", and it is NOT a
     * judgement made here. It is `assessPassCoverage` — the SINGLE definition, shared
     * with the job that logs the verdict.
     *
     * Both facts matter. The empty page is the very signal the engine produces
     * transiently under write load, so trusting it alone would carry the original
     * defect into the cursor. And computing a second, private threshold here is how
     * this code shipped with the two disagreeing: the cursor cleared at 50% while the
     * job alarmed below 75%, so a pass in between reported itself truncated and threw
     * its resume point away in the same run.
     */
    const verdict = assessPassCoverage(stats);

    /**
     * 🔴 The wedge is specifically a guard that fires on the FIRST page of a RESUMED
     * run — there, and only there, persisting the unchanged cursor makes every later
     * run reproduce the identical abort and examine zero documents.
     *
     * Firing after real progress is a different event: the run walked from
     * `resumedFrom` up to `lastId` and cleaned everything on the way. Discarding the
     * cursor then throws a whole night's progress away and restarts at the bottom,
     * which is the exact cost this change exists to eliminate — so that case keeps its
     * cursor like any other truncated pass. `lastId === stats.resumedFrom` is the
     * discriminator; a pass that never resumed has `resumedFrom === null`, which no
     * numeric `lastId` can equal, and it has nothing stored to wedge on anyway.
     */
    const wedgedOnResume = cursorUnadvanceable && lastId === stats.resumedFrom;

    if (verdict.reachedEnd || wedgedOnResume) {
      // Start the next run from the bottom. Without this the cursor sits at the top
      // of the index forever and the low-id region — where a document that was
      // eligible when it was indexed and has since gone stale actually lives — is
      // never re-examined.
      const outcome = await clearScanCursor(cfg.key);
      // `absent` is NOT a clear. The overwhelming majority of runs complete with
      // nothing stored, and reporting those as "cursor cleared" put the note on every
      // healthy nightly line for every index and drained the field of meaning.
      stats.cursorCleared = outcome === 'cleared';
      if (outcome === 'failed') {
        // 🔴 Loud, because the silent version is the worst failure this code has.
        // A completed pass that cannot clear its cursor resumes at the TOP of the
        // index next run, scans nothing, carries the old `covered` forward so the
        // count still looks complete, and reports `info … scanned 0, stale 0,
        // deleted 0` — an index getting zero cleanup while looking healthy, nightly,
        // until the staleness bound expires it.
        stats.errors += 1;
        opts.onError?.({
          key: cfg.key,
          offset: -1,
          error: new Error(
            `could not CLEAR the scan cursor for ${cfg.indexName} ` +
              // Not "after a completed pass" unconditionally: on the wedge path the
              // pass explicitly did NOT complete, and a message that says otherwise
              // sends the reader looking for the wrong thing.
              (wedgedOnResume
                ? 'after aborting on a cursor it could not advance past'
                : 'after a completed pass') +
              `; the next run will resume at id ${lastId} and may scan nothing`
          ),
        });
      }
    } else if (lastId >= 0) {
      const persisted = await writeScanCursor(cfg.key, {
        lastId,
        startedAt: passStartedAt,
        covered: stats.passCovered,
      });
      if (persisted) stats.cursorPersisted = lastId;
      else {
        // The pass was truncated and its position could not be saved, so the next run
        // restarts at the bottom — defect B, for this index, this night. Silent, it is
        // indistinguishable from a healthy rollover.
        stats.errors += 1;
        opts.onError?.({
          key: cfg.key,
          offset: -1,
          error: new Error(
            `could not PERSIST the scan cursor for ${cfg.indexName} at id ${lastId}; ` +
              `the next run will restart from the beginning of the index`
          ),
        });
      }
    }
  }

  return stats;
}

export async function cleanupAllIndexes(
  keys: CleanupIndexKey[] | null,
  opts: CleanupOptions
): Promise<CleanupIndexStats[]> {
  const selected = keys ? CLEANUP_INDEXES.filter((i) => keys.includes(i.key)) : CLEANUP_INDEXES;
  const results: CleanupIndexStats[] = [];
  for (const cfg of selected) {
    if (opts.jobContext?.status === 'canceled') break;
    results.push(await cleanupIndex(cfg, opts));
  }
  return results;
}

import type { PrismaClient } from '@prisma/client';
import { chunk } from 'lodash-es';
import type { MeiliSearch } from 'meilisearch';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import { clickhouse } from '~/server/clickhouse/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import type { JobContext } from '~/server/jobs/job';
import { getJobDate } from '~/server/jobs/job';
import {
  countIndexDocuments,
  deleteSwapIndex,
  getOrCreateIndex,
  onSearchIndexDocumentsCleanup,
  swapIndex,
} from '~/server/meilisearch/util';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import type {
  PullTask,
  PushTask,
  SearchIndexIdRange,
  Task,
  TransformTask,
} from '~/server/search-index/utils/taskQueue';
import { getTaskQueueWorker, TaskQueue } from '~/server/search-index/utils/taskQueue';
import { createLogger } from '~/utils/logging';

const DEFAULT_UPDATE_INTERVAL = 30 * 1000;
/** Ids per `updateSync` batch when a processor does not set `updateSyncChunkSize`. */
export const DEFAULT_UPDATE_SYNC_CHUNK_SIZE = 500;
const logger = createLogger(`search-index-processor`);

export type SearchIndexContext = {
  db: PrismaClient;
  pg: AugmentedPool;
  ch?: CustomClickHouseClient;
  indexName: string;
  jobContext?: JobContext;
  logger: ReturnType<typeof createLogger>;
};
export type SearchIndexPullBatch =
  | { type: 'new'; startId: number; endId: number }
  | { type: 'update'; ids: number[] };
type SearchIndexSetup = (context: { indexName: string }) => Promise<void>;

type SearchIndexProcessor = {
  indexName: string;
  setup: SearchIndexSetup;
  prepareBatches: (
    context: SearchIndexContext,
    lastUpdatedAt?: Date
  ) => Promise<{
    batchSize: number;
    startId: number;
    endId: number;
    updateIds?: number[];
  }>;
  pullData: (
    context: SearchIndexContext,
    batch: SearchIndexPullBatch,
    step?: number,
    prevData?: any
  ) => Promise<any>;
  transformData: (data: any) => Promise<any>;
  pushData: (context: SearchIndexContext, data: any) => Promise<void>;
  onComplete?: (context: SearchIndexContext) => Promise<void>;
  maxQueueSize?: number;
  primaryKey?: string;
  updateInterval?: number;
  workerCount?: number;
  /**
   * Ids per batch for `updateSync`. Each batch becomes one targeted pull task, so this is the
   * knob that bounds the id list a `pullData` query is handed, and therefore whether that query
   * fits inside the database statement timeout. Note that it bounds the id list per call, not the
   * number of calls: a processor that also sets `pullSteps` runs the same batch of ids through
   * `pullData` once per step. Defaults to `DEFAULT_UPDATE_SYNC_CHUNK_SIZE`.
   */
  updateSyncChunkSize?: number;
  pullSteps?: number;
  /**
   * Ids a transformed batch ACCOUNTS FOR, when that is not the same as the ids of the documents
   * in it. A processor needs this only when it handles an id by some means other than writing a
   * document — `collections` deletes the ids it disqualifies, which is a handled id with no
   * document. Without the override those ids would be reported as having produced nothing.
   */
  getHandledIds?: (transformedData: any) => (number | string)[];
  client?: MeiliSearch | null;
  jobName?: string;
  partial?: boolean;
  queues?: ('delete' | 'update')[];
  /**
   * Retire the index: every write and sync path becomes a no-op. Queue writes are dropped,
   * `update`/`updateSync`/`reset`/`processQueues` return without touching Meilisearch. Used to
   * stop feeding a Meilisearch index we no longer serve, without editing the many call sites
   * that still call `queueUpdate`. Re-enabling the index requires flipping this back and
   * re-running a `reset` — the index is stale for as long as it is retired.
   */
  retired?: boolean;
};

/**
 * Ids a transformed batch accounts for, read out of the batch itself.
 *
 * Handles the two shapes every processor in this directory returns today: a flat array of
 * documents, and an object whose values are arrays of documents. Returns `undefined` — not an
 * empty list — for any shape it does not recognise, because "I cannot see the documents" and
 * "there are no documents" are the two answers this whole mechanism exists to tell apart.
 */
const readDocumentIds = (
  transformedData: any,
  primaryKey: string
): (number | string)[] | undefined => {
  const fromArray = (value: any): (number | string)[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const ids: (number | string)[] = [];
    let sawDocument = false;
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      sawDocument = true;
      const id = entry[primaryKey];
      if (typeof id === 'number' || typeof id === 'string') ids.push(id);
    }
    // A non-empty array holding no objects is not a batch of documents — it is a shape this
    // cannot read, and saying "0 documents" about it would report every requested id as unwritten.
    // An EMPTY array is the opposite: it is a readable answer, and the answer is none.
    if (value.length > 0 && !sawDocument) return undefined;
    return ids;
  };

  const direct = fromArray(transformedData);
  if (direct) return direct;
  if (!transformedData || typeof transformedData !== 'object') return undefined;

  const ids: (number | string)[] = [];
  let sawArray = false;
  for (const value of Object.values(transformedData)) {
    const fromValue = fromArray(value);
    if (!fromValue) continue;
    sawArray = true;
    ids.push(...fromValue);
  }
  return sawArray ? ids : undefined;
};

/**
 * Which of the ids a targeted pull asked for produced nothing the index will ever see.
 *
 * A row that `pullData` returns and `transformData` then drops is written by nobody and reported
 * by nobody: `pushData` is handed a batch that simply does not contain it, the task completes,
 * and every counter above says success. Two published models with no versions sat stale in
 * `models_v9` for weeks that way, through a bulk repair and a targeted re-enqueue (868m6jk7w).
 */
const accountForBatch = (
  processor: SearchIndexProcessor,
  requestedIds: (number | string)[] | undefined,
  transformedData: any
): {
  idsWithoutDocument?: (number | string)[];
  handledWithoutDocumentIds?: (number | string)[];
} => {
  if (!requestedIds?.length) return {};
  const documentIds = readDocumentIds(transformedData, processor.primaryKey ?? 'id');
  const handled = processor.getHandledIds ? processor.getHandledIds(transformedData) : documentIds;
  if (!handled) return {};
  const handledSet = new Set(handled.map(String));
  const idsWithoutDocument = requestedIds.filter((id) => !handledSet.has(String(id)));

  // What `getHandledIds` subtracts from the count, kept visible instead of silent. A hook is
  // the one way a processor can make an id stop being reported, which is the shape of the defect
  // this accounting exists to catch, moved one layer up: if `collections` ever prunes an id it
  // should not have, only this number shows it happened. A processor with no hook reports none of
  // these, because for it "handled" and "carries a document" are the same set.
  if (!processor.getHandledIds || !documentIds) return { idsWithoutDocument };
  const documentIdSet = new Set(documentIds.map(String));
  const handledWithoutDocumentIds = requestedIds.filter(
    (id) => handledSet.has(String(id)) && !documentIdSet.has(String(id))
  );
  return { idsWithoutDocument, handledWithoutDocumentIds };
};

/**
 * The line that says how many of the ids a run was asked for produced no document.
 *
 * `console.log`, NOT `console.error`, and that is a decision rather than an oversight: on the
 * queue-drain paths this number is nonzero by design. The Update queue legitimately carries ids
 * the index filters out — `model-scan-result` queues an Update for every scanned Draft model,
 * while `pullData` filters to Published — so an error-level line here would fire on every cron
 * run and train its reader to ignore it. This is a measurement; a caller that asked for a repair
 * reads the number out of `updateSync`'s return value instead.
 */
const logIdsWithoutDocument = (indexName: string, caller: string, queue: TaskQueue) => {
  const parts: string[] = [];
  if (queue.idsWithoutDocumentCount > 0)
    parts.push(
      `${
        queue.idsWithoutDocumentCount
      } ids produced no document (sample: ${queue.idsWithoutDocumentSample
        .slice(0, 20)
        .join(', ')})`
    );
  if (queue.handledWithoutDocumentIdCount > 0)
    parts.push(`${queue.handledWithoutDocumentIdCount} handled without a document`);
  if (!parts.length) return;
  console.log(
    `createSearchIndexUpdateProcessor :: ${caller} :: ${indexName} :: ${parts.join('; ')}`
  );
};

/**
 * Put the ids of every batch that exhausted its retries back on the Update queue.
 *
 * The queue checkout that supplied them is destructive, so without this a failed batch's ids are
 * gone once `commit()` runs (#5398). Called AFTER `commit()`: a checkout whose bucket-list write
 * failed leaves the drained bucket as the queue's newest, and an id re-queued before `commit()`
 * would land in that bucket and be deleted with it. `false` means Redis refused and the ids went
 * to the Postgres parking lot; if that also failed or hit its cap, `persistDroppedEnqueue` reports
 * it to Axiom.
 */
const requeueFailedIds = async (indexName: string, caller: string, queue: TaskQueue) => {
  const ids = queue.failedIds;
  if (!ids.length) return;
  const queued = await SearchIndexUpdate.queueUpdate({
    indexName,
    items: ids.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update })),
  });
  const prefix = `createSearchIndexUpdateProcessor :: ${caller} :: ${indexName}`;
  const sample = describeIdSample(ids);
  if (queued)
    console.error(
      `${prefix} :: re-queued ${ids.length} ids from batches that exhausted their retries ${sample}`
    );
  else
    console.error(
      `${prefix} :: could not re-queue ${ids.length} ids from failed batches to Redis ${sample}; attempted the search-index-queue-fallback parking lot (a failure or cap there is logged under that name)`
    );
};

/** Ids named in the re-queue log line: enough to recognise the same set recurring across runs. */
export const REQUEUE_LOG_SAMPLE_SIZE = 10;

/**
 * A bounded, order-independent fingerprint of an id set — the lowest ids plus the range — so
 * consecutive runs re-queueing the SAME ids read identically in the log while a fresh backlog
 * does not. Sorted because `failedIds` is in task-completion order, which varies run to run.
 */
const describeIdSample = (ids: number[]) => {
  const ascending = [...ids].sort((a, b) => a - b);
  const lowest = ascending.slice(0, REQUEUE_LOG_SAMPLE_SIZE).join(', ');
  return `(lowest: ${lowest}; min ${ascending[0]}, max ${ascending[ascending.length - 1]})`;
};

/**
 * One statement, INSIDE `updateSync`, of "an item with no action is an Update" — read by the
 * dedupe key and both of its filters so they cannot disagree about an item that carries no action.
 * Not repo-wide: `SearchIndexUpdate.queueUpdate` states the rule the other way (strict equality,
 * no defaulting), so an item queued with no action there reaches neither bucket.
 *
 * It does NOT make the taxonomy exhaustive: a third enum member returns itself here, matches
 * neither filter, and still vanishes from the run. Closing that is an else-branch or an
 * exhaustive check, not this helper.
 */
const actionOf = (item: { action?: SearchIndexUpdateQueueAction }) =>
  item.action ?? SearchIndexUpdateQueueAction.Update;

const processSearchIndexTask = async (
  processor: SearchIndexProcessor,
  context: SearchIndexContext,
  task: Task
) => {
  const { type } = task;
  let logDetails: any = '';
  if (task.index !== undefined && task.total) logDetails = `${task.index + 1} of ${task.total}`;
  if (task.currentStep !== undefined) logDetails += ` - ${task.currentStep + 1} of ${task.steps}`;
  context.logger(
    `processSearchIndexTask :: ${type} :: ${processor.indexName} :: Processing task`,
    logDetails
  );

  try {
    if (type === 'pull') {
      context.logger(`processSearchIndexTask :: pull :: ${processor.indexName} :: Processing task`);
      const start = (task.start ??= Date.now());
      const t = task as PullTask;
      const activeStep = t.currentStep ?? 0;
      const batch: SearchIndexPullBatch =
        t.mode === 'targeted'
          ? {
              type: 'update',
              ids: t.ids,
            }
          : {
              type: 'new',
              startId: t.startId,
              endId: t.endId,
            };
      const pulledData = await processor.pullData(context, batch, activeStep, t.currentData);

      if (!pulledData) {
        // Nothing to transform or push — but for a TARGETED batch that is not "nothing to do", it
        // is every requested id producing no document, by a different route than the transform
        // route below. `users`, `comics`, `tools` and `metrics-images` all return null here for an
        // empty pull, so without this the WORST case — every requested id producing nothing — was
        // the one case reporting zero.
        // STEP 0 ONLY, deliberately. A falsy pull at step 0 proves nothing was ever pulled, and no
        // `pullData` in this directory writes to an index, so nothing can have been written. A
        // falsy pull at a LATER step is overloaded: some processors use it to mean "the step
        // sequence ran out" rather than "no rows". Both such returns are unreachable under today's
        // `pullSteps` counts, so this excludes nothing that happens — it is written this way so
        // that lowering a processor's branch coverage below its step count cannot silently turn
        // every batch into a batch reported as writing nothing.
        if (t.mode === 'targeted' && t.ids.length && activeStep === 0)
          task.idsWithoutDocument = t.ids;
        context.logger(
          `processSearchIndexTask :: pull :: ${processor.indexName} :: No data pulled. Marking as done.`,
          start ? (Date.now() - start) / 1000 : 'unknown duration'
        );
        return 'done';
      }

      if (t?.steps && activeStep + 1 < t.steps) {
        return {
          ...t,
          currentData: pulledData,
          currentStep: activeStep + 1,
          start,
        } as PullTask;
      } else {
        return {
          start,
          type: 'transform',
          index: task.index,
          total: task.total,
          idCount: task.idCount,
          sourceRange: task.sourceRange,
          requestedIds: t.mode === 'targeted' ? t.ids : undefined,
          data: pulledData,
        } as TransformTask;
      }
    } else if (type === 'transform') {
      context.logger(
        `processSearchIndexTask :: transform :: ${processor.indexName} :: Processing task`
      );
      const { data, start, requestedIds } = task as TransformTask;
      const transformedData = processor.transformData ? await processor.transformData(data) : data;
      // Observation must not be able to lose a batch. A throw here would return 'error', and the
      // task would retry three times and then be reported as failed — an accounting helper
      // destroying the very write it exists to watch. `getHandledIds` is processor-supplied, so
      // it is the one call in this chain that is not ours.
      let idsWithoutDocument: (number | string)[] | undefined;
      let handledWithoutDocumentIds: (number | string)[] | undefined;
      try {
        ({ idsWithoutDocument, handledWithoutDocumentIds } = accountForBatch(
          processor,
          requestedIds,
          transformedData
        ));
      } catch (e) {
        console.error(
          `processSearchIndexTask :: transform :: ${processor.indexName} :: without-document accounting threw; the batch is unaffected`,
          e
        );
      }
      if (idsWithoutDocument?.length) {
        context.logger(
          `processSearchIndexTask :: transform :: ${processor.indexName} :: ${idsWithoutDocument.length} of ${requestedIds?.length} requested ids produced no document`,
          idsWithoutDocument.slice(0, 10)
        );
      }
      return {
        start,
        type: 'push',
        requestedIds,
        index: task.index,
        total: task.total,
        idCount: task.idCount,
        sourceRange: task.sourceRange,
        idsWithoutDocument,
        handledWithoutDocumentIds,
        data: transformedData,
      } as PushTask;
    } else if (type === 'push') {
      context.logger(`processSearchIndexTask :: Push :: ${processor.indexName} :: Processing task`);
      const { data, start } = task as PushTask;
      await processor.pushData(context, data);
      context.logger(
        `processSearchIndexTask :: Push :: ${processor.indexName} :: Done`,
        start ? (Date.now() - start) / 1000 : 'unknown duration'
      );

      return 'done';
    } else if (type === 'onComplete') {
      await processor.onComplete?.(context);
      return 'done';
    }
    return 'error';
  } catch (e) {
    console.error(`processSearchIndexTask :: ${type} :: ${processor.indexName} :: Error`, e);
    return 'error';
  } finally {
    context.logger(
      `processSearchIndexTask :: ${type} :: ${processor.indexName} :: Done`,
      logDetails
    );
  }
};

export type SearchIndexTaskResult = Awaited<ReturnType<typeof processSearchIndexTask>>;

/**
 * Outcome of an `updateSync` run. `failedTasks > 0` means those batches were dropped after
 * exhausting their retries and `failedIds` documents were never written to the index.
 */
export type SearchIndexUpdateSyncResult = {
  indexName: string;
  totalTasks: number;
  failedTasks: number;
  failedIds: number;
  /**
   * Ids that were pulled but produced no document — nothing was written for them and nothing
   * failed. A repair that reports `failedIds: 0` alongside a nonzero `idsWithoutDocument` did not repair
   * those ids, and before this existed there was no number that said so.
   */
  idsWithoutDocument: number;
  /**
   * Up to `WITHOUT_DOCUMENT_SAMPLE_LIMIT` of those ids. A SAMPLE, deliberately: `idsWithoutDocument` is the
   * count to act on, and a caller that needs all of them should read the log line per batch.
   */
  idsWithoutDocumentSample: (number | string)[];
  /**
   * Ids a processor's `getHandledIds` accounted for although no document carries them — a
   * `collections` prune, today, where the processor calls the same set `disqualifiedIds`. Reported rather than subtracted into silence: the hook is the one
   * way an id can stop being counted here, so this is the only number that would show a
   * processor pruning ids it should not have.
   */
  handledWithoutDocument: number;
};

/**
 * Outcome of a `reset` run — a FULL-CORPUS rebuild into `<indexName>_NEW`, promoted by a swap.
 *
 * `swapped` is the fact that matters: `false` means the rebuild was abandoned and the index that
 * was already serving still is. A full reset is the one path that can replace the entire corpus
 * at once, so it is also the one path where dropping batches is unbounded in blast radius.
 */
export type SearchIndexResetResult = {
  indexName: string;
  totalTasks: number;
  failedTasks: number;
  /**
   * Id ranges whose batches were dropped after exhausting their retries. The slice to re-pull.
   *
   * Populated on the `partial` path too: the range-task loop runs before the `partial` branch, so
   * those tasks carry a `sourceRange` like any other. (An earlier version of this comment claimed
   * the opposite. It happened to look true only because the one `partial` processor's
   * `prepareBatches` returns an empty span — an accident of that caller, not a property of the
   * branch.)
   */
  failedRanges: SearchIndexIdRange[];
  /**
   * Whether the rebuilt index was promoted. `false` for every `partial` reset — it writes in
   * place and has no swap counterpart — and `false` for a non-partial reset that refused, which
   * throws rather than returning.
   */
  swapped: boolean;
};

/** How many failed ranges the error MESSAGE names before summarising the rest. */
export const FAILED_RANGE_MESSAGE_LIMIT = 20;

/**
 * Why a `reset` refused to promote its rebuild.
 *
 * - `dropped-batches` — batches exhausted their retries, so the rebuild is missing their documents.
 * - `no-batches` — the run enqueued NO batches, so the rebuild is empty, and the live index has
 *   documents to lose. Distinct because the counts that describe the first case are all zero in the
 *   second, and "0 of 0 batches failed" reads as success.
 * - `stale-swap-index` — the swap index already held documents before the rebuild started, so
 *   whatever the rebuild did not rewrite would have been promoted alongside it.
 */
export type SearchIndexResetRefusalReason = 'dropped-batches' | 'no-batches' | 'stale-swap-index';

/**
 * Thrown by `reset` when a full-corpus rebuild is not a complete corpus, INSTEAD of promoting it.
 *
 * Why refuse the swap rather than swap and report: the two outcomes are wildly asymmetric.
 *
 * - Refusing leaves the previously-serving index in place. It is complete, merely as stale as it
 *   was a moment ago, and the incremental update queue is untouched so it keeps closing that
 *   drift. The repair is to run the reset again — and note that every `*-reset` job is registered
 *   at `UNRUNNABLE_JOB_CRON`, so nothing re-runs it on a schedule: a human triggered this one and
 *   a human has to trigger the retry. That is precisely why the failure has to be loud.
 * - Swapping publishes a corpus that is missing every document in the dropped batches, and the
 *   `SearchIndexUpdate.clearQueue` that follows a swap then destroys the only channel that would
 *   have re-added them. Nothing in the system reports the gap, and the natural edit churn that
 *   would eventually refill it is orders of magnitude smaller than the hole: measured against a
 *   ~13,000-document loss, roughly 1.7 documents a minute. In practice it does not self-heal.
 *
 * So the worst case of refusing is a stale-but-whole index; the worst case of swapping is a
 * silently truncated one with its repair path wiped. It throws rather than returning a result
 * because the job runner's only report was a duration on a success line — see the job wiring in
 * `src/server/jobs/search-index-sync.ts`. A throw there increments the job-error counter, logs
 * the stack, and fails the request, which is what makes this impossible to miss.
 *
 * 🔴 WHAT THIS DOES NOT COVER, because the name reads wider than the mechanism. It fires on
 * CLIENT-side task outcomes only — a batch whose pull, transform or push threw in this process.
 * `pushData` reaches Meilisearch through `updateDocuments`, which resolves when the write is
 * ENQUEUED, and nothing here waits on the resulting task uid. So a batch Meilisearch accepts and
 * then fails asynchronously completes normally, is never counted, and still promotes. Closing
 * that needs the enqueued task uids collected and awaited before the swap; it is not done here.
 */
export class SearchIndexResetIncompleteError extends Error {
  readonly indexName: string;
  readonly reason: SearchIndexResetRefusalReason;
  readonly totalTasks: number;
  readonly failedTasks: number;
  readonly failedRanges: SearchIndexIdRange[];

  constructor(args: {
    indexName: string;
    reason: SearchIndexResetRefusalReason;
    totalTasks: number;
    failedTasks: number;
    failedRanges: SearchIndexIdRange[];
  }) {
    super(
      `createSearchIndexUpdateProcessor :: reset :: ${args.indexName} :: ${refusalDetail(args)}`
    );
    this.name = 'SearchIndexResetIncompleteError';
    this.indexName = args.indexName;
    this.reason = args.reason;
    this.totalTasks = args.totalTasks;
    this.failedTasks = args.failedTasks;
    this.failedRanges = args.failedRanges;
  }
}

/** What the refusal says, per reason — each names the state and what to do about it. */
const refusalDetail = (args: {
  reason: SearchIndexResetRefusalReason;
  totalTasks: number;
  failedTasks: number;
  failedRanges: SearchIndexIdRange[];
}) => {
  if (args.reason === 'no-batches')
    return `the run enqueued 0 batches, so the rebuild is empty, and the live index holds documents; refusing to replace them with nothing`;
  if (args.reason === 'stale-swap-index')
    return `the swap index already held documents before the rebuild started, so promoting it would carry over whatever this run did not rewrite; refusing. Discard it and re-run`;
  return `${args.failedTasks} of ${
    args.totalTasks
  } batches failed; refusing to swap in a truncated index. Ranges to re-pull: ${
    describeFailedRanges(args.failedRanges) || 'unknown'
  }`;
};

/**
 * The ranges, capped. A run where EVERY batch fails (the backend was down throughout) produces one
 * range per batch — ~1,493 for the models index — and the full join is ~25 KB. V8 prefixes
 * `Error.stack` with the message and the job logger ships the stack verbatim, so the whole thing
 * would ride into the log sink. The complete list stays on the error's `failedRanges` field.
 */
const describeFailedRanges = (ranges: SearchIndexIdRange[]) => {
  const shown = ranges.slice(0, FAILED_RANGE_MESSAGE_LIMIT).map((r) => `${r.startId}-${r.endId}`);
  const remaining = ranges.length - shown.length;
  return remaining > 0 ? `${shown.join(', ')} …and ${remaining} more` : shown.join(', ');
};

export function createSearchIndexUpdateProcessor(processor: SearchIndexProcessor) {
  const {
    indexName,
    setup,
    prepareBatches,
    updateInterval = DEFAULT_UPDATE_INTERVAL,
    primaryKey = 'id',
    maxQueueSize,
    workerCount = 10,
    jobName,
    partial,
    queues,
    updateSyncChunkSize: configuredUpdateSyncChunkSize = DEFAULT_UPDATE_SYNC_CHUNK_SIZE,
    retired = false,
  } = processor;

  // `chunk(xs, 0)`, `chunk(xs, -1)`, `chunk(xs, NaN)` and `chunk(xs, -Infinity)` all return `[]`
  // (lodash-es 4.17.21; `Infinity` is the one non-finite size that does not — it returns a single
  // batch of everything). A processor configured with any of the empty-returning values would
  // queue zero tasks, write nothing to the index, and still report `totalTasks: 0,
  // failedTasks: 0` — the silent success this reporting exists to remove. Clamp a finite value to
  // at least one id per batch; fall back to the default for a NON-FINITE one. `NaN`, `Infinity`
  // and `-Infinity` are all of type `number`, so the declared type does not exclude them.
  // Defensive only: no caller passes one today — `collections.search-index.ts` is the sole
  // processor that configures this field at all, at 25.
  const updateSyncChunkSize = Number.isFinite(configuredUpdateSyncChunkSize)
    ? Math.max(1, Math.floor(configuredUpdateSyncChunkSize))
    : DEFAULT_UPDATE_SYNC_CHUNK_SIZE;

  return {
    indexName,
    /** Exposed so callers/tests can see the batch size `updateSync` will actually use. */
    updateSyncChunkSize,
    /**
     * Exposed so the hook can be tested as the processor's own, rather than as a copy of it in a
     * fixture. A test that re-implements the lambda it is checking passes whether or not the
     * processor still carries one.
     */
    getHandledIds: processor.getHandledIds,
    /**
     * Exposed for the same reason: a test that imports an index's batch function directly proves
     * nothing about the function this processor runs. Re-inlining a different body here is
     * invisible to such a test unless it can compare the two.
     */
    prepareBatches,
    async getData(ids: number[]) {
      const ctx = {
        db: dbWrite,
        pg: pgDbWrite,
        ch: clickhouse,
        indexName,
        logger,
      };

      const baseData = await processor.pullData(ctx, {
        type: 'update',
        ids,
      });

      return processor.transformData ? await processor.transformData(baseData) : baseData;
    },
    async update(jobContext: JobContext) {
      if (retired) return;
      const [lastUpdatedAt, setLastUpdate] = await getJobDate(
        `searchIndex:${(jobName ?? indexName).toLowerCase()}`
      );
      const ctx = {
        db: dbWrite,
        pg: pgDbWrite,
        ch: clickhouse,
        lastUpdatedAt,
        indexName,
        jobContext,
        logger,
      };
      // Check if update is needed
      const shouldUpdate = lastUpdatedAt.getTime() + updateInterval < Date.now();

      if (!shouldUpdate) {
        console.log(
          `createSearchIndexUpdateProcessor :: update :: ${indexName} :: Job does not require updating yet.`
        );
        return;
      }

      // Run update
      const now = new Date();
      const queue = new TaskQueue('pull', maxQueueSize);
      logger(
        `createSearchIndexUpdateProcessor :: update :: ${indexName} :: About to prepare batches...`
      );
      const { batchSize, startId = 0, endId, updateIds } = await prepareBatches(ctx, lastUpdatedAt);
      logger(
        `createSearchIndexUpdateProcessor :: update :: ${indexName} :: Index last update at ${lastUpdatedAt}`,
        { batchSize, startId, endId, updateIds }
      );

      const queuedUpdates =
        !queues || queues.includes('update')
          ? await SearchIndexUpdate.getQueue(
              indexName,
              SearchIndexUpdateQueueAction.Update,
              partial ? true : false // readOnly
            )
          : {
              content: [],
              commit: async () => undefined, // noop
            };
      const queuedDeletes =
        !queues || queues.includes('delete')
          ? await SearchIndexUpdate.getQueue(
              indexName,
              SearchIndexUpdateQueueAction.Delete,
              partial ? true : false // readOnly
            )
          : {
              content: [],
              commit: async () => undefined, // noop
            };

      const newItemsTasks = Math.ceil((endId - startId) / batchSize);

      // if (true) {
      //   console.log({
      //     startid: startId,
      //     endid: endId,
      //     update: queuedUpdates.content.length,
      //     delete: queuedDeletes.content.length,
      //     total: endId - startId,
      //   });

      //   return;
      // }

      for (let i = 0; i < newItemsTasks; i++) {
        const start = startId + i * batchSize;
        const batch = {
          startId: start,
          endId: Math.min(start + batchSize - 1, endId),
        };

        queue.addTask({
          type: 'pull',
          mode: 'range',
          steps: processor.pullSteps,
          currentStep: 0,
          index: i,
          total: newItemsTasks,
          ...batch,
        });
      }

      const updatedItems = [...new Set<number>([...(updateIds ?? []), ...queuedUpdates.content])];

      const maxUpdateBatchSize = Math.min(batchSize, 10000); // To avoid too large batches for postgres
      const updateItemsTasks = Math.ceil(updatedItems.length / maxUpdateBatchSize);

      for (let i = 0; i < updateItemsTasks; i++) {
        const batch = {
          ids: updatedItems.slice(i * maxUpdateBatchSize, (i + 1) * maxUpdateBatchSize),
        };

        queue.addTask({
          type: 'pull',
          mode: 'targeted',
          steps: processor.pullSteps,
          currentStep: 0,
          index: i,
          total: updateItemsTasks,
          ...batch,
        });
      }

      // Deletes FIRST, as `updateSync` already does. The two queues are disjoint sets with no
      // timestamps, so an id queued in both carries no record of which action came last, and the
      // drain order alone decides the outcome. Pulling second lets `pullData`'s own WHERE
      // arbitrate; pulling first rebuilt the document and then deleted it.
      if (queuedDeletes.content.length > 0 && !partial) {
        await onSearchIndexDocumentsCleanup({
          indexName,
          ids: queuedDeletes.content,
          client: processor.client,
        });
      }

      const workers = Array.from({ length: workerCount }).map(() => {
        return getTaskQueueWorker(
          queue,
          async (task) => processSearchIndexTask(processor, ctx, task),
          logger
        );
      });

      await Promise.all(workers);

      logIdsWithoutDocument(indexName, 'update', queue);

      // Commit queues:
      await queuedUpdates.commit();
      await queuedDeletes.commit();
      // Also re-queues failed ids that came from `updateIds` rather than the queue: `setLastUpdate`
      // below moves the window past them, so the queue is the only place they can be retried.
      if (!partial && (!queues || queues.includes('update')))
        await requeueFailedIds(indexName, 'update', queue);

      // Use the start time as the time of update
      // Should  help avoid missed items during the run
      // of the index.
      if (!partial || jobName) {
        // Partial indexes should not update the last update time
        await setLastUpdate(now);
      }
    },
    /**
     * Resets an entire index by using its swap counterpart.
     * The goal here is to ensure we keep the  existing search index during the
     * reset process.
     */
    async reset(jobContext: JobContext): Promise<SearchIndexResetResult> {
      if (retired)
        return { indexName, totalTasks: 0, failedTasks: 0, failedRanges: [], swapped: false };

      const swapIndexName = `${indexName}_NEW`;

      /**
       * Abandon the rebuild and say why. Only ever called on the non-partial path.
       *
       * It discards the swap index for every reason EXCEPT `stale-swap-index`, and that exception
       * is the important one. For the other reasons the swap index holds this run's own work, so
       * throwing it away costs only the storage it occupies. For `stale-swap-index` it holds state
       * this run did not create and cannot account for — and deleting it would be strictly more
       * destructive than the clearing the comment at the check itself calls "a destructive act
       * taken on a guess".
       *
       * 🔴 It is also unsafe, because two resets of one index can genuinely overlap. The reset jobs
       * now set `keepLockOnDisconnect`, but a pod that dies still drops its lock within seconds, so
       * the window is narrowed rather than closed. Were this to delete, the sequence would be: run
       * A is mid-rebuild; run B starts, sees A's partial documents, refuses and deletes the index A
       * is writing into; A's remaining `updateDocuments` calls then auto-create a bare index and A
       * swaps it in. That is both of the failures this whole change exists to prevent — a truncated
       * index, and one with no settings — caused by the guard meant to stop them.
       */
      const refuse = async (
        reason: SearchIndexResetRefusalReason,
        counts: { totalTasks: number; failedTasks: number; failedRanges: SearchIndexIdRange[] }
      ) => {
        if (reason !== 'stale-swap-index') {
          try {
            // Best-effort storage cleanup so a near-complete copy of the corpus is not left
            // resident. NOT a correctness mechanism and deliberately not treated as one — the
            // deletion is a task that completes later. Non-fatal: the error we are about to throw
            // is the diagnosis and must not be replaced by a cleanup failure.
            await deleteSwapIndex({ swapIndexName, client: processor.client });
          } catch (e) {
            console.error(
              `createSearchIndexUpdateProcessor :: reset :: ${indexName} :: could not discard ${swapIndexName} after refusing to promote it`,
              e
            );
          }
        }
        throw new SearchIndexResetIncompleteError({ indexName, reason, ...counts });
      };

      const noCounts = { totalTasks: 0, failedTasks: 0, failedRanges: [] };

      // First, setup and init both indexes - Swap requires both indexes to be created:
      // In order to swap, the base index must exist. because of this, we need to create or get it.
      await getOrCreateIndex(indexName, { primaryKey }, processor.client);
      if (!partial) {
        await setup({ indexName: swapIndexName });

        // The rebuild must start from an EMPTY swap index. `setup` does not clear one — it is
        // `getOrCreateIndex` plus settings, and `getOrCreateIndex` only creates on
        // `index_not_found` — while `pushData` UPSERTS by primary key. So documents left by an
        // earlier run survive a rebuild that simply does not rewrite those ids, and the swap then
        // promotes documents for rows that are no longer eligible: a deleted or unsearchable model
        // searchable again, a banned user back in people search.
        //
        // 🔴 This is a READ and not a delete, and that is the fix for a trap worth stating. Every
        // Meilisearch mutation is a TASK: `deleteIndex` resolves when the deletion is ENQUEUED.
        // Deleting here would therefore land AFTER `setup` had already read the OLD settings and
        // found nothing to change — so no settings task is enqueued, the deletion then removes the
        // index, `updateDocuments` silently auto-creates a bare one, and the swap promotes an index
        // with NO filterable/sortable/searchable attributes at all. Every filtered query against it
        // then errors. A read cannot reorder itself against `setup` that way.
        //
        // 🔴 WHAT IT STILL DOES NOT COVER, because "a read answers about now" is a weaker statement
        // than it sounds: it answers about the documents Meilisearch has already PROCESSED. Tasks
        // that are merely enqueued are invisible to it, and nothing in this file awaits an index
        // deletion — `swapIndex` ends by enqueuing one, and so does `refuse`. So a swap index with
        // a pending deletion reads as populated (a spurious refusal, which is safe), and one whose
        // deletion has just landed while a dead run's writes are still queued reads as empty (not
        // safe, and not detectable here). Closing that needs the deletion and the document writes
        // awaited by task uid; it is not done here.
        //
        // Refusing rather than repairing, because a populated swap index means a previous run
        // ended in a way nobody looked at, and clearing it is a destructive act taken on a guess.
        // `refuse` does not discard it for this reason, for the same reason — see its doc comment.
        const swapDocumentCount = await countIndexDocuments({
          indexName: swapIndexName,
          client: processor.client,
        });
        if (swapDocumentCount) await refuse('stale-swap-index', noCounts);
      }

      const ctx = {
        db: dbRead,
        pg: pgDbRead,
        indexName: partial ? indexName : swapIndexName,
        jobContext,
        logger,
      };
      // Run update
      const queue = new TaskQueue('pull', maxQueueSize);
      const { batchSize, startId = 0, endId } = await prepareBatches(ctx);

      const tasks = Math.ceil((endId - startId) / batchSize);
      // The number of batches actually enqueued below, which is what `totalTasks` should report and
      // what the loop must bound itself by. A non-finite `tasks` is clamped to 0 rather than being
      // allowed to reach the loop: `NaN` already iterates zero times, but `Infinity` would spin
      // forever, and the refusal below cannot be relied on to stop it — it is conditional on
      // something being at stake, so an `Infinity` over an empty live index falls straight through.
      // Clamping is what makes "this guard sits before the loop" actually true.
      const taskCount = Number.isFinite(tasks) ? tasks : 0;

      // A run that enqueues NO batches rebuilds NOTHING, and would otherwise sail through the
      // dropped-batch gate below with `failedTasks === 0` and promote a freshly-created, EMPTY swap
      // index over a populated one — then clear the update queue. That is this guard's own harm at
      // its maximum, reached by a different route, so it belongs to the same guarantee rather than
      // being a separate feature.
      //
      // Reachable, not defensive. `tasks < 1`: `prepareBatches` derives its bounds from
      // `MIN(id)/MAX(id)` (six processors) or from `ORDER BY "createdAt" LIMIT 1` subqueries
      // (`users`, `metrics-images`), all of which yield `null` on an empty eligible set, and the
      // `startId = 0` default above does NOT fire for `null`, so `Math.ceil(0 / batchSize)` is 0. A
      // single eligible row (`startId === endId`) gives 0 the same way — via the batch-count
      // off-by-one, not because one row is nothing.
      //
      // `!Number.isFinite(tasks)` is reachable too: `metrics-images--update-metrics` returns
      // `{ batchSize: 0, startId: 0, endId: 0 }` when it has no ClickHouse client, and
      // `Math.ceil(0 / 0)` is `NaN`. That processor is `partial`, and the `partial` early return is
      // BELOW this point, not above it — the `partial ? 0` arm here is what waves it through.
      // `Infinity` has no producer in this directory today.
      //
      // Refuse only when something is actually AT STAKE. An index whose live corpus is empty has
      // nothing to lose from promoting an empty rebuild — and that case must keep working, because
      // `setup` runs only against the swap index, so being swapped in is the ONLY way a brand-new
      // index ever receives its settings. Refusing there would strand it unconfigured forever, and
      // every filtered query against it would error. That is the shape of a new index before launch,
      // and of every index on a dev or test database.
      if (taskCount < 1) {
        const liveDocumentCount = partial
          ? 0
          : await countIndexDocuments({ indexName, client: processor.client });
        // `null` means there is no search client, so nothing can be destroyed either way.
        if ((liveDocumentCount ?? 0) > 0) await refuse('no-batches', noCounts);
      }

      for (let i = 0; i < taskCount; i++) {
        const start = startId + i * batchSize;
        const batch = {
          startId: start,
          endId: Math.min(start + batchSize - 1, endId),
        };

        queue.addTask({
          type: 'pull',
          mode: 'range',
          steps: processor.pullSteps,
          currentStep: 0,
          // The attribution key for this batch, carried through to `failTask` so a dropped batch
          // names the slice of the corpus it cost. Duplicated from the query parameters in
          // `batch` on purpose — see `BaseTask.sourceRange`.
          sourceRange: { startId: batch.startId, endId: batch.endId },
          ...batch,
        });
      }

      const workers = Array.from({ length: workerCount }).map(() => {
        return getTaskQueueWorker(
          queue,
          async (task) => processSearchIndexTask(processor, ctx, task),
          logger
        );
      });

      await Promise.all(workers);

      // No `logIdsWithoutDocument` here, deliberately. That accounting is driven by
      // `requestedIds`, which only a `mode: 'targeted'` pull sets; a reset enqueues range tasks
      // exclusively, so both of its counters are structurally always 0 on this path. Calling it
      // would read as instrumentation while being incapable of ever printing.

      // Read the queue's failure state BEFORE deciding to swap. `failTask` reports a task that
      // exhausted its retries by pushing a summary and returning normally — it does not throw —
      // so every worker resolves and `Promise.all` above resolves on a run that dropped batches
      // exactly as it does on a clean one. Those two outcomes are indistinguishable from here
      // unless this number is read.
      const failedTasks = queue.failedTasks.length;
      const failedRanges = queue.failedRanges;

      if (partial) {
        // Control flow unchanged, deliberately. A partial reset writes in place into the live
        // index: it has no swap counterpart to refuse and never clears the update queue, so the
        // outcome the refusals below exist to prevent cannot occur on this path. There is nothing
        // to withhold, so there is nothing to throw about.
        //
        // Nor is there anything to log, today, and it is worth saying why rather than leaving a
        // reader to assume this path is instrumented. The one `partial` processor's
        // `prepareBatches` returns `startId: 0, endId: 0` on both of its branches, so `taskCount`
        // is 0 — directly, or via the clamp when its no-ClickHouse branch makes `tasks` `NaN` — no
        // range task is ever enqueued, and `failedTasks` here is structurally always 0. A diagnostic would read as
        // reporting while being incapable of firing. The counts are returned instead, for tests and
        // for a future partial processor that does enqueue batches — at which point this path needs
        // a real report, because `update()` and `processQueues()` never read `queue.failedTasks`
        // (only `updateSync` does) and `reset`'s sole caller discards the return value.
        return { indexName, totalTasks: taskCount, failedTasks, failedRanges, swapped: false };
      }

      // Refuse the swap AND the `clearQueue` below. Leaving the queue alone is half the point: it
      // is the channel that would repair the gap, and clearing it is what turned a recoverable
      // truncation into a permanent one.
      if (failedTasks > 0)
        await refuse('dropped-batches', { totalTasks: taskCount, failedTasks, failedRanges });

      // Finally, perform the swap:
      await swapIndex({ indexName, swapIndexName, client: processor.client });
      // Clear update queue since our index should be brand new:
      await SearchIndexUpdate.clearQueue(indexName);

      return { indexName, totalTasks: taskCount, failedTasks: 0, failedRanges: [], swapped: true };
    },
    async updateSync(
      items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>,
      jobContext?: JobContext
    ): Promise<SearchIndexUpdateSyncResult> {
      if (retired || !items.length) {
        return {
          indexName,
          totalTasks: 0,
          failedTasks: 0,
          failedIds: 0,
          idsWithoutDocument: 0,
          idsWithoutDocumentSample: [],
          handledWithoutDocument: 0,
        };
      }

      // TODO index.update shouldnt run
      // await setup({ indexName });

      console.log(
        `createSearchIndexUpdateProcessor :: updateSync :: ${indexName} :: Called with ${items.length} items`
      );
      const queue = new TaskQueue('pull', maxQueueSize);
      // Deduped BEFORE chunking, which is what `update()` and `processQueues()` already do. Doing
      // it per chunk instead leaves a repeated id counted once per chunk it lands in, so the
      // guarantee would hold only for callers whose duplicates happened to be adjacent.
      // Per ACTION, not globally: the same id may legitimately arrive once as an Update and once
      // as a Delete, and collapsing that pair would change which one runs.
      const seen = new Set<string>();
      const dedupedItems = items.filter((item) => {
        const key = `${actionOf(item)}:${item.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const batches = chunk(dedupedItems, updateSyncChunkSize);
      let totalTasks = 0;

      for (const batch of batches) {
        const updateIds = batch
          .filter((i) => actionOf(i) === SearchIndexUpdateQueueAction.Update)
          .map(({ id }) => id);
        const deleteIds = batch
          .filter((i) => actionOf(i) === SearchIndexUpdateQueueAction.Delete)
          .map(({ id }) => id);

        if (deleteIds.length > 0 && !partial) {
          await onSearchIndexDocumentsCleanup({
            indexName,
            ids: deleteIds,
            client: processor.client,
          });
        }

        if (updateIds.length > 0) {
          queue.addTask({
            type: 'pull',
            mode: 'targeted',
            ids: updateIds,
            idCount: updateIds.length,
            steps: processor.pullSteps,
            currentStep: 0,
          });
          totalTasks++;
        }
      }

      const workers = Array.from({ length: 5 }).map(() => {
        return getTaskQueueWorker(
          queue,
          async (task) =>
            processSearchIndexTask(
              processor,
              { db: dbWrite, pg: pgDbWrite, indexName, jobContext, logger },
              task
            ),
          logger
        );
      });

      await Promise.all(workers);

      // A task that exhausted its retries wrote nothing to the index. Report that instead of
      // resolving as though everything landed — the caller cannot otherwise tell a total failure
      // from a total success.
      const result: SearchIndexUpdateSyncResult = {
        indexName,
        totalTasks,
        failedTasks: queue.failedTasks.length,
        failedIds: queue.failedIdCount,
        idsWithoutDocument: queue.idsWithoutDocumentCount,
        idsWithoutDocumentSample: queue.idsWithoutDocumentSample,
        handledWithoutDocument: queue.handledWithoutDocumentIdCount,
      };

      logIdsWithoutDocument(indexName, 'updateSync', queue);

      if (result.failedTasks > 0) {
        console.error(
          `createSearchIndexUpdateProcessor :: updateSync :: ${indexName} :: ${result.failedTasks} of ${result.totalTasks} batches failed (${result.failedIds} ids not indexed)`
        );
      }

      return result;
    },
    async queueUpdate(items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>) {
      if (retired) return;
      await SearchIndexUpdate.queueUpdate({ indexName, items });
    },
    async processQueues(
      opts: { processUpdates?: boolean; processDeletes?: boolean } = {},
      jobContext: JobContext
    ) {
      if (retired) return;
      const ctx = {
        db: dbRead,
        pg: pgDbRead,
        indexName,
        jobContext,
        logger,
      };

      // Deletes before updates, for the reason spelled out in `update()` above: when both
      // flags are set an id can sit in both queues, and pulling first would rebuild the
      // document only for the cleanup to remove it.
      if (opts.processDeletes) {
        const queuedDeletes = await SearchIndexUpdate.getQueue(
          indexName,
          SearchIndexUpdateQueueAction.Delete,
          partial ? true : false // readOnly
        );

        if (queuedDeletes.content.length > 0 && !partial) {
          await onSearchIndexDocumentsCleanup({
            indexName,
            ids: queuedDeletes.content,
            client: processor.client,
          });
        }

        await queuedDeletes.commit();
      }

      if (opts.processUpdates) {
        const queuedUpdates = await SearchIndexUpdate.getQueue(
          indexName,
          SearchIndexUpdateQueueAction.Update,
          partial ? true : false // readOnly
        );

        const updatedItems = [...new Set<number>([...queuedUpdates.content])];

        const queue = new TaskQueue('pull', maxQueueSize);
        const maxUpdateBatchSize = 10000; // To avoid too large batches for postgres
        const updateItemsTasks = Math.ceil(updatedItems.length / maxUpdateBatchSize);

        for (let i = 0; i < updateItemsTasks; i++) {
          const batch = {
            ids: updatedItems.slice(i * maxUpdateBatchSize, (i + 1) * maxUpdateBatchSize),
          };

          queue.addTask({
            type: 'pull',
            mode: 'targeted',
            steps: processor.pullSteps,
            currentStep: 0,
            index: i,
            total: updateItemsTasks,
            ...batch,
          });
        }

        const workers = Array.from({ length: workerCount }).map(() => {
          return getTaskQueueWorker(
            queue,
            async (task) => processSearchIndexTask(processor, ctx, task),
            logger
          );
        });

        await Promise.all(workers);

        logIdsWithoutDocument(indexName, 'processQueues', queue);

        await queuedUpdates.commit();
        if (!partial) await requeueFailedIds(indexName, 'processQueues', queue);
      }
    },
  };
}

export type SearchIndexSetupContext = {
  indexName: string;
};

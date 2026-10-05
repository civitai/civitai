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
 * - `no-batches` — the run enqueued NO batches, so the rebuild is empty. Distinct because the
 *   counts that describe the first case are all zero in the second, and "0 of 0 batches failed"
 *   reads as success.
 */
export type SearchIndexResetRefusalReason = 'dropped-batches' | 'no-batches';

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
      `createSearchIndexUpdateProcessor :: reset :: ${args.indexName} :: ${
        args.reason === 'no-batches'
          ? `the run enqueued 0 batches, so the rebuild is empty; refusing to swap in an empty index`
          : `${args.failedTasks} of ${
              args.totalTasks
            } batches failed; refusing to swap in a truncated index. Ranges to re-pull: ${
              describeFailedRanges(args.failedRanges) || 'unknown'
            }`
      }`
    );
    this.name = 'SearchIndexResetIncompleteError';
    this.indexName = args.indexName;
    this.reason = args.reason;
    this.totalTasks = args.totalTasks;
    this.failedTasks = args.failedTasks;
    this.failedRanges = args.failedRanges;
  }
}

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

      /**
       * Drop the swap index, tolerating its absence and never masking the caller's own outcome.
       * Used both before a rebuild (so it starts empty) and when abandoning one (so a near-full
       * copy of the corpus does not sit resident until the next run).
       */
      const discardSwapIndex = async (name: string, when: string) => {
        try {
          await deleteSwapIndex({ swapIndexName: name, client: processor.client });
        } catch (e) {
          // Non-fatal on purpose. On the refusal path the thrown error below is the diagnosis and
          // must not be replaced by a cleanup failure; on the pre-rebuild path a missing index is
          // the normal first-run case. Either way the risk this leaves is stale documents in the
          // swap index, which is reported here rather than swallowed.
          console.error(
            `createSearchIndexUpdateProcessor :: reset :: ${indexName} :: could not discard ${name} ${when}; a later rebuild may push onto its documents`,
            e
          );
        }
      };
      // First, setup and init both indexes - Swap requires both indexes to be created:
      // In order to swap, the base index must exist. because of this, we need to create or get it.
      await getOrCreateIndex(indexName, { primaryKey }, processor.client);
      const swapIndexName = `${indexName}_NEW`;
      if (!partial) {
        // Start from nothing. `setup` does not clear the swap index — it is `getOrCreateIndex`
        // plus settings, and `getOrCreateIndex` only creates on `index_not_found` — while
        // `pushData` UPSERTS by primary key. So if a previous rebuild left documents behind, a
        // rebuild that simply does not write some of those ids keeps the stale ones, and the swap
        // promotes documents for rows that are no longer eligible: a deleted or unsearchable model
        // becomes searchable again, a banned user reappears in people search.
        //
        // Previously every non-partial reset ended in `swapIndex`, whose last act is to delete the
        // swap index, so this could only happen if a run died mid-flight. The refusal below makes
        // a surviving swap index an ORDINARY outcome, so the guarantee has to be established here
        // rather than relied on as a side effect of finishing.
        await discardSwapIndex(swapIndexName, 'before rebuilding');
        await setup({ indexName: swapIndexName });
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
      for (let i = 0; i < tasks; i++) {
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
        // It does NOT follow that its failures are reported elsewhere. The only `partial`
        // processor is indexed in production by `update()`, and `update()` — like
        // `processQueues()` — never reads `queue.failedTasks`; only `updateSync` does. The sole
        // caller of `reset` also discards the return value. So log it: the return value is for
        // tests and future callers, and this line is the part a human can see.
        if (failedTasks > 0) {
          console.error(
            `createSearchIndexUpdateProcessor :: reset :: ${indexName} :: ${failedTasks} of ${tasks} batches failed on a partial reset (written in place; no swap to refuse)`
          );
        }
        return { indexName, totalTasks: tasks, failedTasks, failedRanges, swapped: false };
      }

      // Both refusals discard the rebuild rather than leave a near-complete copy of the corpus
      // resident until the next run — for `models` that is multiple GB. The pre-rebuild discard
      // above is what guarantees correctness if this one does not run (a killed process); this one
      // is what stops the storage sitting there in the meantime.
      const refuse = async (reason: SearchIndexResetRefusalReason) => {
        await discardSwapIndex(swapIndexName, 'after refusing to promote it');
        throw new SearchIndexResetIncompleteError({
          indexName,
          reason,
          totalTasks: tasks,
          failedTasks,
          failedRanges,
        });
      };

      // A run that enqueued NO batches would otherwise sail through the dropped-batch gate below
      // with `failedTasks === 0` and promote a freshly-created, EMPTY swap index over a populated
      // one — then clear the update queue. That is this guard's own harm at its maximum, reached
      // by a different route, so refusing on batch count is part of the same guarantee rather than
      // a separate feature.
      //
      // Reachable, not defensive: every `prepareBatches` in this directory is
      // `SELECT MIN(id), MAX(id) …` with no null guard, and the `startId = 0` default above does
      // not fire for `null`, so an empty eligible corpus yields `Math.ceil(0 / batchSize)` = 0. A
      // single eligible row (`startId === endId`) gives 0 the same way.
      //
      // The cost of being wrong here is one failed job on a genuinely empty index, whose live
      // index is equally empty — so the swap it refuses would have changed nothing.
      if (!Number.isFinite(tasks) || tasks < 1) await refuse('no-batches');

      // Refuse the swap AND the `clearQueue` below. Leaving the queue alone is half the point: it
      // is the channel that would repair the gap, and clearing it is what turned a recoverable
      // truncation into a permanent one.
      if (failedTasks > 0) await refuse('dropped-batches');

      // Finally, perform the swap:
      await swapIndex({ indexName, swapIndexName, client: processor.client });
      // Clear update queue since our index should be brand new:
      await SearchIndexUpdate.clearQueue(indexName);

      return { indexName, totalTasks: tasks, failedTasks: 0, failedRanges: [], swapped: true };
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
      }
    },
  };
}

export type SearchIndexSetupContext = {
  indexName: string;
};

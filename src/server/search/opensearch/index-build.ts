import type { BulkOperation, OpenSearchClient } from '~/server/search/opensearch/opensearch-client';

// Rebuilds a search index from the database into a NEW concrete index behind an alias:
//
//   alias "models"  ──►  models_20261103153000   (serving)
//                        models_20261104090000   (being built; becomes the target on success)
//
// The serving index is never touched, so a failed or abandoned build costs nothing, and the
// previous index is kept after a swap so a bad build can be rolled back in one alias call. Progress
// is checkpointed, so a build that dies resumes where it stopped instead of starting over.

/** Where the documents come from. Ids are positive integers, scanned in ascending order. */
export type IndexSource = {
  /** Up to `limit` ids above `afterId`, ascending, of rows that belong in the index. */
  nextIds(afterId: number, limit: number): Promise<number[]>;
  /** The document for each id that belongs in the index. An id it leaves out is removed. */
  buildDocuments(ids: number[]): Promise<Map<number, unknown>>;
  /** Ids whose document may have changed since `since`, whether or not they still belong. */
  changedSince(since: Date): Promise<number[]>;
};

export type BuildCheckpoint = {
  index: string;
  startedAt: string;
  /** Every id at or below this is written to `index`. */
  watermark: number;
};

export type CheckpointStore = {
  get(alias: string): Promise<BuildCheckpoint | null>;
  set(alias: string, checkpoint: BuildCheckpoint): Promise<void>;
  clear(alias: string): Promise<void>;
};

export type IndexDefinition = {
  settings?: Record<string, unknown>;
  mappings: Record<string, unknown>;
  /** Applied once the build is complete. Defaults: 1 replica, 1s refresh. */
  servingSettings?: { number_of_replicas?: number; refresh_interval?: string };
};

export type BuildReport = {
  index: string;
  resumed: boolean;
  batches: number;
  written: number;
  removed: number;
  caughtUp: number;
  documents: number;
  previous: string[];
  deleted: string[];
};

export class IndexBuildError extends Error {
  constructor(
    message: string,
    readonly index: string,
    readonly rejected: { id: string; status: number; reason: string }[] = []
  ) {
    super(message);
    this.name = 'IndexBuildError';
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
/** `<alias>_YYYYMMDDHHmmss` (UTC). Names sort in build order. */
export const buildIndexName = (alias: string, at: Date) =>
  `${alias}_${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(
    at.getUTCHours()
  )}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;

const BUILD_SETTINGS = { refresh_interval: '-1', number_of_replicas: 0 };

export async function buildIndex({
  alias,
  client,
  source,
  definition,
  checkpoints,
  batchSize = 1000,
  concurrency = 8,
  retainPrevious = 1,
  maxAttempts = 5,
  now = () => new Date(),
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  signal,
  logger = () => undefined,
}: {
  alias: string;
  client: OpenSearchClient;
  source: IndexSource;
  definition: IndexDefinition;
  checkpoints: CheckpointStore;
  batchSize?: number;
  concurrency?: number;
  /** Older indexes kept after the swap, for rollback. */
  retainPrevious?: number;
  maxAttempts?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  logger?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<BuildReport> {
  let checkpoint = await checkpoints.get(alias);
  const resumed = !!checkpoint && (await client.indexExists(checkpoint.index));
  if (!checkpoint || !resumed) {
    const startedAt = now();
    checkpoint = {
      index: buildIndexName(alias, startedAt),
      startedAt: startedAt.toISOString(),
      watermark: 0,
    };
    await client.createIndex(checkpoint.index, {
      settings: { ...definition.settings, ...BUILD_SETTINGS },
      mappings: definition.mappings,
    });
    await checkpoints.set(alias, checkpoint);
  }
  const { index } = checkpoint;
  logger(resumed ? 'resuming build' : 'starting build', {
    alias,
    index,
    watermark: checkpoint.watermark,
  });

  const report: BuildReport = {
    index,
    resumed,
    batches: 0,
    written: 0,
    removed: 0,
    caughtUp: 0,
    documents: 0,
    previous: [],
    deleted: [],
  };

  /** Writes the current documents for `ids`: indexes the ones that exist, removes the rest. */
  const writeIds = async (ids: number[]) => {
    const documents = await source.buildDocuments(ids);
    let operations: BulkOperation[] = ids.map((id) =>
      documents.has(id)
        ? { action: 'index', id, document: documents.get(id) }
        : { action: 'delete', id }
    );
    for (let attempt = 1; operations.length; attempt++) {
      const result = await client.bulk(index, operations);
      if (result.rejected.length)
        throw new IndexBuildError(
          `${result.rejected.length} documents rejected by ${index}`,
          index,
          result.rejected
        );
      if (!result.retryable.length) break;
      if (attempt >= maxAttempts)
        throw new IndexBuildError(
          `${result.retryable.length} documents still refused after ${maxAttempts} attempts`,
          index
        );
      const retry = new Set(result.retryable);
      operations = operations.filter((op) => retry.has(String(op.id)));
      await sleep(Math.min(30_000, 500 * 2 ** (attempt - 1)));
    }
    const written = ids.filter((id) => documents.has(id)).length;
    report.written += written;
    report.removed += ids.length - written;
  };

  // Ids are handed out in order by one scanner; batches complete in any order. The watermark only
  // moves past a batch once every batch before it is written, so a resume never skips one.
  let afterId = checkpoint.watermark;
  let scanDone = false;
  let nextSeq = 0;
  let nextToCommit = 0;
  let failure: unknown;
  const completed = new Map<number, number>();
  let scanTail: Promise<unknown> = Promise.resolve();
  let saveTail: Promise<unknown> = Promise.resolve();

  const nextBatch = () => {
    const batch = scanTail.then(async () => {
      if (scanDone || failure !== undefined || signal?.aborted) return null;
      const ids = await source.nextIds(afterId, batchSize);
      if (!ids.length) {
        scanDone = true;
        return null;
      }
      afterId = ids[ids.length - 1];
      return { seq: nextSeq++, ids };
    });
    scanTail = batch.catch(() => undefined);
    return batch;
  };

  const commit = (seq: number, lastId: number) => {
    completed.set(seq, lastId);
    let watermark: number | undefined;
    while (completed.has(nextToCommit)) {
      watermark = completed.get(nextToCommit);
      completed.delete(nextToCommit++);
    }
    if (watermark === undefined) return;
    const next = { ...checkpoint!, watermark };
    checkpoint = next;
    saveTail = saveTail.then(() => checkpoints.set(alias, next));
  };

  const worker = async () => {
    while (failure === undefined) {
      const batch = await nextBatch();
      if (!batch) return;
      await writeIds(batch.ids);
      report.batches++;
      commit(batch.seq, batch.ids[batch.ids.length - 1]);
    }
  };

  await Promise.all(
    Array.from({ length: concurrency }, () =>
      worker().catch((error) => {
        failure ??= error;
      })
    )
  );
  await saveTail;
  if (failure !== undefined) throw failure;
  if (signal?.aborted)
    throw new IndexBuildError(`build of ${index} cancelled at id ${checkpoint.watermark}`, index);

  // Rows that changed while the scan ran may have been read before the change.
  const changed = await source.changedSince(new Date(checkpoint.startedAt));
  for (let i = 0; i < changed.length; i += batchSize)
    await writeIds(changed.slice(i, i + batchSize));
  report.caughtUp = changed.length;

  await client.updateSettings(index, {
    number_of_replicas: definition.servingSettings?.number_of_replicas ?? 1,
    refresh_interval: definition.servingSettings?.refresh_interval ?? '1s',
  });
  await client.refresh(index);
  report.documents = await client.count(index);

  report.previous = (await client.aliasTargets(alias)).filter((i) => i !== index);
  await client.swapAlias(alias, index);
  await checkpoints.clear(alias);
  logger('alias swapped', { alias, index, documents: report.documents });

  // Keep the newest `retainPrevious` older builds for rollback; drop the rest.
  const builds = (await client.listIndexes(`${alias}_`)).filter((i) => i !== index && i < index);
  const stale = builds.slice(0, Math.max(0, builds.length - retainPrevious));
  for (const old of stale) await client.deleteIndex(old);
  report.deleted = stale;

  return report;
}

/** The index a build in progress is writing, so live updates can write to it as well. */
export async function activeBuildIndex(alias: string, checkpoints: CheckpointStore) {
  return (await checkpoints.get(alias))?.index ?? null;
}

/** Points `alias` back at the newest build older than the one it serves now. */
export async function rollbackAlias(client: OpenSearchClient, alias: string) {
  const [current] = await client.aliasTargets(alias);
  const older = (await client.listIndexes(`${alias}_`)).filter((i) => !current || i < current);
  const previous = older[older.length - 1];
  if (!previous) throw new Error(`no earlier build of ${alias} to roll back to`);
  await client.swapAlias(alias, previous);
  return { from: current ?? null, to: previous };
}

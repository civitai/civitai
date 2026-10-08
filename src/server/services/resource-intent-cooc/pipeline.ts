import { dbRead, dbWrite } from '~/server/db/client';
import {
  CoocCountAccumulator,
  COOC_STATEMENT_TIMEOUT_MS,
  drawTrainingRows,
  fetchVersionText,
  serializeCoocCounts,
  serializeTrainImageIds,
  timedCoocQuery,
  type CoocRawQuery,
} from './build';
import { RESOURCE_INTENT_COOC_SPEC, RESOURCE_INTENT_COOC_SPEC_HASH } from './spec';
import {
  assertCoocPin,
  beginCoocBuild,
  completeCoocBuild,
  coocContentHash,
  coocSqlOf,
  DAY_MS,
  failCoocBuild,
  type CoocSnapshotKind,
  type CoocSql,
} from './store';
import { coocTrainingTokens, type CoocModelText } from './tokenize';

/** Rows tokenised between yields to the event loop. */
const ROWS_PER_YIELD = 1000;

export type CoocBuildOptions = {
  kind: CoocSnapshotKind;
  /** Study builds only; production always trains up to `defaultCoocTrainEnd(now)`. */
  trainEnd?: Date;
  seed: number;
  pinnedUntil: Date | null;
  dryRun: boolean;
  now?: Date;
  query?: CoocRawQuery;
  sql?: CoocSql;
};

/** Aggregates only: never a token, a prompt or a model name. */
export type CoocBuildSummary = {
  rowId: string | null;
  contentHash: string;
  kind: CoocSnapshotKind;
  specHash: string;
  trainStart: string;
  trainEnd: string;
  seed: number;
  idsTried: number;
  batches: number;
  trainRows: number;
  vocab: number;
  rawVocab: number;
  models: number;
  rawPairs: number;
  keptPairs: number;
  /** Rows attaching a model under another type than its first one (it keeps the first). */
  typeConflicts: number;
  payloadBytes: number;
  dryRun: boolean;
  created: boolean;
};

/**
 * The draw's replica reads, each capped at `COOC_STATEMENT_TIMEOUT_MS`. The interactive transaction
 * gets headroom over the statement cap, so the database's cancellation, not Prisma's, ends a slow
 * statement.
 */
export function coocReplicaQuery(): CoocRawQuery {
  return timedCoocQuery(
    (fn) =>
      dbRead.$transaction(fn, { maxWait: 30_000, timeout: COOC_STATEMENT_TIMEOUT_MS + 30_000 }),
    COOC_STATEMENT_TIMEOUT_MS
  );
}

/**
 * The latest allowed `trainEnd`: UTC midnight today minus the spec's gap. Day-aligned so a re-run
 * on the same day draws the same window, and never later than `now` minus the gap.
 */
export function defaultCoocTrainEnd(now: Date) {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnight - RESOURCE_INTENT_COOC_SPEC.gapDays * DAY_MS);
}

/**
 * Validate → (unless dry run) record the build → draw → tokenise → count → serialise →
 * complete it (ready, or 'duplicate' of an existing snapshot), or mark it failed on any error.
 * Each drawn batch is tokenised as it arrives, so prompts are not all held at once. Retention is
 * a separate job.
 */
export async function buildCoocSnapshot(opts: CoocBuildOptions): Promise<CoocBuildSummary> {
  const spec = RESOURCE_INTENT_COOC_SPEC;
  const now = opts.now ?? new Date();
  assertCoocPin(opts.kind, opts.pinnedUntil, now);
  if (!Number.isInteger(opts.seed) || opts.seed < 0 || opts.seed > 2 ** 31 - 1)
    throw new Error('seed must be an integer in [0, 2^31 - 1]');
  if (opts.kind === 'production' && opts.trainEnd)
    throw new Error(
      'a production build cannot be backdated: it always trains up to defaultCoocTrainEnd'
    );
  const trainEnd = opts.trainEnd ?? defaultCoocTrainEnd(now);
  if (trainEnd.getTime() > now.getTime() - spec.gapDays * DAY_MS)
    throw new Error(`trainEnd must be at least ${spec.gapDays} day(s) before now`);
  const trainStart = new Date(trainEnd.getTime() - spec.trainDays * DAY_MS);
  const query: CoocRawQuery = opts.query ?? coocReplicaQuery();
  const sql: CoocSql = opts.sql ?? coocSqlOf(dbWrite);

  const rowId = opts.dryRun
    ? null
    : (
        await beginCoocBuild(sql, {
          kind: opts.kind,
          specHash: RESOURCE_INTENT_COOC_SPEC_HASH,
          trainStart,
          trainEnd,
          seed: opts.seed,
          pinnedUntil: opts.pinnedUntil,
          now,
        })
      ).id;
  try {
    const acc = new CoocCountAccumulator(spec.addonTypes);
    const versionText = new Map<number, CoocModelText>();
    const imageIds: number[] = [];
    let createdMin = Infinity;
    let createdMax = -Infinity;
    const draw = await drawTrainingRows({
      query,
      trainStart,
      trainEnd,
      seed: opts.seed,
      target: spec.targetRows,
      idBatch: spec.idBatch,
      maxBatches: spec.maxBatches,
      onBatch: async (rows) => {
        const missing = [...new Set(rows.flatMap((r) => r.att.map((a) => a.versionId)))].filter(
          (v) => !versionText.has(v)
        );
        for (const [id, text] of await fetchVersionText(query, missing)) versionText.set(id, text);
        for (const [i, r] of rows.entries()) {
          if (i > 0 && i % ROWS_PER_YIELD === 0) await new Promise((res) => setImmediate(res));
          const own = r.att.map(
            (a) => versionText.get(a.versionId) ?? { modelName: '', trainedWords: null }
          );
          const models = new Map<number, string>();
          for (const a of r.att) models.set(a.modelId, a.modelType);
          acc.add(coocTrainingTokens(r.prompt, own), [...models]);
          imageIds.push(r.imageId);
          const ts = new Date(r.createdAt).getTime();
          createdMin = Math.min(createdMin, ts);
          createdMax = Math.max(createdMax, ts);
        }
      },
    });
    if (!imageIds.length) throw new Error('the draw matched no training rows; refusing to build');
    if (new Set(imageIds).size !== imageIds.length) throw new Error('training image ids repeat');
    if (createdMin < trainStart.getTime() || createdMax >= trainEnd.getTime())
      throw new Error('a training row lies outside the training window');

    const { rawPairs, rawVocab, typeConflicts, ...counts } = acc.finalize(spec);
    const payload = await serializeCoocCounts(counts);
    const summary: CoocBuildSummary = {
      rowId,
      contentHash: coocContentHash(opts.kind, payload),
      kind: opts.kind,
      specHash: RESOURCE_INTENT_COOC_SPEC_HASH,
      trainStart: trainStart.toISOString(),
      trainEnd: trainEnd.toISOString(),
      seed: opts.seed,
      idsTried: draw.idsTried,
      batches: draw.batches,
      trainRows: counts.N,
      vocab: counts.vocab.length,
      rawVocab,
      models: counts.modelIds.length,
      rawPairs,
      keptPairs: counts.modelIdx.length,
      typeConflicts,
      payloadBytes: payload.length,
      dryRun: opts.dryRun,
      created: false,
    };
    if (rowId === null) return summary;
    const { created } = await completeCoocBuild(sql, rowId, {
      payload,
      trainImageIds: await serializeTrainImageIds(imageIds),
      trainCreatedAtMin: new Date(createdMin),
      trainCreatedAtMax: new Date(createdMax),
      idsTried: draw.idsTried,
      trainRows: counts.N,
      vocab: counts.vocab.length,
      models: counts.modelIds.length,
      keptPairs: counts.modelIdx.length,
    });
    return { ...summary, created };
  } catch (e) {
    if (rowId !== null) await failCoocBuild(sql, rowId).catch(() => undefined);
    throw e;
  }
}

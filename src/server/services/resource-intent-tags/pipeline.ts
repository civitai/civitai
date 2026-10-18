import { Prisma } from '@prisma/client';

import { dbWrite } from '~/server/db/client';
import { COOC_STATEMENT_TIMEOUT_MS } from '~/server/services/resource-intent-cooc/build';
import { coocReplicaRunner } from '~/server/services/resource-intent-cooc/pipeline';
import { coocSqlOf, type CoocSql } from '~/server/services/resource-intent-cooc/store';
import {
  indexedModelTypes,
  parseTagVocabulary,
  TagIndexAccumulator,
  type TagBuildStats,
} from './build';
import { s3TagIndexObjects, TAG_INDEX_STORE_ENV } from './objects';
import { encodeTagIndexCooperative, TAG_INDEX_MAX_PAYLOAD_BYTES } from './payload';
import { promptExcludedByAuditor } from './prompt-exclusion';
import {
  assertObservationKey,
  fetchVersionInfo,
  genSliceCondition,
  genObservationOf,
  genObservationsSql,
  genTrainingRow,
  observationUserHash,
  readEligibleModelIds,
  readModelContent,
  readPostedSample,
  retryingQuery,
  standbyQuery,
  TAG_SOURCE_PARAMS,
  tagTrainingWindow,
  unionAscending,
  type GenObservation,
  type TagRawQuery,
  type VersionInfo,
} from './sources';
import { RESOURCE_INTENT_TAGS_SPEC, RESOURCE_INTENT_TAGS_SPEC_HASH } from './spec';
import { assertSnapshotTableAdmits, putSnapshot, type TagIndexObjectStore } from './store';

/**
 * Refuse to build when more than this share of the training window's hours hold no generator
 * observation. Generator traffic fills every hour, so an empty hour is a slice the external
 * extractor never wrote; the share allows about two days of 90 for a stalled extractor's backlog.
 */
export const TAG_BUILD_MAX_MISSING_HOUR_SHARE = 0.02;

/**
 * The observation table's first hour whose sample slice holds rows. The extractor went live with a
 * 31-day backfill, the most its source keeps; its first row is at 2026-09-12 23:20 UTC, past that
 * hour's slice, so the first hour the build can read is the next one (verified read-only, October
 * 2026). Coverage is counted from here when the training window starts earlier; a window wholly
 * after it ignores it, from about 2026-12-14 on. Pinned rather than read as `min(time)`: a later
 * truncation or re-backfill would move `min(time)` and silently shrink the span the coverage check
 * guards.
 */
export const TAG_OBSERVATION_FLOOR = new Date('2026-09-13T00:00:00Z');

/**
 * The longest the build holds the event loop between yields while tagging. It shares the process
 * with every other job; a time slice, not a row count, because the audit's cost varies per prompt.
 */
export const TAG_BUILD_YIELD_MS = 50;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/**
 * Image ids per posted-sample statement: sized for the deployed replica route, which can cancel a
 * statement well before the build's own timeout (the dry run prints each kind's slowest attempt).
 */
export const TAG_POSTED_ID_BATCH = 125_000;

/** Call once per unit of work: yields to the event loop once `sliceMs` have passed since the last yield. */
export function loopYielder(sliceMs: number, now: () => number = () => performance.now()) {
  let last = now();
  return async () => {
    if (now() - last < sliceMs) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    last = now();
  };
}

export type TagBuildEnv = Partial<
  Record<
    | 'RESOURCE_INTENT_TAG_INDEX_BUCKET'
    | (typeof TAG_INDEX_STORE_ENV)[number]
    | 'P2M_CLICKHOUSE_URL'
    | 'P2M_CLICKHOUSE_USER'
    | 'P2M_CLICKHOUSE_PASSWORD'
    | 'P2M_HASH_KEY'
    | 'P2M_HASH_KEY_FINGERPRINT',
    string | undefined
  >
>;

export type TagBuildConfig = {
  clickhouse: { url: string; user: string; password: string };
  hashKey: Buffer;
};

/**
 * The build's configuration, or one error naming every missing variable. A production build needs
 * the snapshot bucket and its credentials (`TAG_INDEX_STORE_ENV`); a dry run stores nothing and
 * does not. The hash key must be hex and carry the fingerprint the observations were written under.
 */
export function tagBuildConfig(e: TagBuildEnv, opts: { requireBucket: boolean }): TagBuildConfig {
  const required = [
    ...(opts.requireBucket
      ? (['RESOURCE_INTENT_TAG_INDEX_BUCKET', ...TAG_INDEX_STORE_ENV] as const)
      : []),
    'P2M_CLICKHOUSE_URL',
    'P2M_CLICKHOUSE_USER',
    'P2M_CLICKHOUSE_PASSWORD',
    'P2M_HASH_KEY',
    'P2M_HASH_KEY_FINGERPRINT',
  ] as const;
  const missing = required.filter((k) => !e[k]);
  if (missing.length)
    throw new Error(
      `tag index build: ${missing.join(', ')} not set; refusing before reading anything`
    );
  const keyHex = e.P2M_HASH_KEY as string;
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(keyHex))
    throw new Error('tag index build: P2M_HASH_KEY is not hex; refusing before reading anything');
  const hashKey = Buffer.from(keyHex, 'hex');
  assertObservationKey(hashKey, e.P2M_HASH_KEY_FINGERPRINT as string);
  return {
    clickhouse: {
      url: e.P2M_CLICKHOUSE_URL as string,
      user: e.P2M_CLICKHOUSE_USER as string,
      password: e.P2M_CLICKHOUSE_PASSWORD as string,
    },
    hashKey,
  };
}

/** The build's view of ClickHouse: rows of a query, streamed. */
export type TagClickHouse = {
  rows: <T>(query: string) => AsyncIterable<T>;
  close: () => Promise<void>;
};

/**
 * The build's ClickHouse client. It sends no `readonly`, so the session runs at the level the
 * account's own profile sets, which `assertClickHouseReadonly` then checks: the account must be
 * read-only by configuration, not by the client's request. The settings it sends need that level to
 * be 2 (an account at 1 cannot change any setting).
 */
export async function readonlyClickHouse(c: TagBuildConfig['clickhouse']): Promise<TagClickHouse> {
  const { createClient } = await import('@clickhouse/client');
  const ch = createClient({
    url: c.url,
    username: c.user,
    password: c.password,
    request_timeout: 1_900_000,
    clickhouse_settings: { max_execution_time: 1800 },
  });
  return {
    async *rows<T>(query: string) {
      const rs = await ch.query({ query, format: 'JSONEachRow' });
      let done = false;
      try {
        for await (const batch of rs.stream())
          for (const row of batch as { json: <R>() => R }[]) yield row.json<T>();
        done = true;
      } finally {
        // Not read to the end: close the result set rather than leave a half-read response on the
        // socket.
        if (!done) rs.close();
      }
    },
    close: () => ch.close(),
  };
}

/**
 * The first row of a one-row query. Reads the stream to its end: a stream left half-read aborts the
 * response mid-socket.
 */
async function firstRow<T>(ch: TagClickHouse, query: string): Promise<T | undefined> {
  let first: T | undefined;
  for await (const r of ch.rows<T>(query)) first ??= r;
  return first;
}

/**
 * Refuse unless the account's own profile makes the session `readonly = 2`: at 0 the account can
 * write (the build must not be able to). An account at 1 never reaches this comparison: it refuses
 * the settings the build sends, so this very query fails first with ClickHouse Code 164.
 */
export async function assertClickHouseReadonly(ch: TagClickHouse): Promise<void> {
  const r = await firstRow<{ ro: number | string }>(ch, `SELECT getSetting('readonly') AS ro`);
  if (Number(r?.ro) !== 2)
    throw new Error(
      `tag index build: the ClickHouse account runs at readonly=${String(
        r?.ro
      )}; it needs a profile with readonly=2, refusing`
    );
}

const chTime = (d: Date) =>
  `toDateTime('${d.toISOString().slice(0, 19).replace('T', ' ')}', 'UTC')`;

export type ObservationCoverage = {
  /** Seconds since the newest generator observation, by ClickHouse's clock. */
  newestAgeSec: number;
  /** Where coverage was counted from: the later of the window's start and the table's floor. */
  start: Date;
  /** Hours in [start, window end), and those with no generator observation. */
  hours: number;
  missingHours: number;
};

/**
 * The training window's generator coverage. Refuses unless some observation lies at or after the
 * window's end: a progress check that the extractor has written past it, so any row counts there.
 * An hour counts as covered only when its sample slice (`genSliceCondition`, the predicate the build
 * reads with) holds an observation, bucketed by UTC hour; hours that do not are counted from the
 * later of the window's start and `floor` to the window's end, and more than
 * `TAG_BUILD_MAX_MISSING_HOUR_SHARE` of that span is refused unless `refuseGaps` is false (a dry run
 * reports them instead).
 */
export async function observationCoverage(
  ch: TagClickHouse,
  window: { start: Date; end: Date },
  refuseGaps: boolean,
  floor: Date = TAG_OBSERVATION_FLOOR
): Promise<ObservationCoverage> {
  const start = new Date(Math.max(window.start.getTime(), floor.getTime()));
  const slice = genSliceCondition(TAG_SOURCE_PARAMS.genSliceMinutes);
  const r = await firstRow<Record<'after' | 'hours' | 'newest' | 'now', number | string>>(
    ch,
    `SELECT countIf(time >= ${chTime(window.end)}) AS after,
       uniqExactIf(toStartOfHour(time, 'UTC'), time < ${chTime(window.end)} AND ${slice}) AS hours,
       toUnixTimestamp(max(time)) AS newest, toUnixTimestamp(now()) AS now
     FROM default.resourceIntentGenObservation WHERE time >= ${chTime(start)}`
  );
  if (!(Number(r?.after) > 0))
    throw new Error(
      `tag index build: no generator observation at or after the window end ${window.end.toISOString()}; the extractor has not covered the window, refusing`
    );
  const hours = Math.max(0, Math.round((window.end.getTime() - start.getTime()) / HOUR_MS));
  const missingHours = hours - Number(r?.hours);
  const allowed = Math.floor(hours * TAG_BUILD_MAX_MISSING_HOUR_SHARE);
  if (refuseGaps && missingHours > allowed)
    throw new Error(
      `tag index build: ${missingHours} of the ${hours} hours from ${start.toISOString()} have no generator observation (allowed ${allowed}); refusing`
    );
  return { newestAgeSec: Number(r?.now) - Number(r?.newest), start, hours, missingHours };
}

/**
 * The window's generator observations, one UTC day per query, each read to its end before it is
 * handed on. ClickHouse aborts a response its client stops reading for longer than its send timeout
 * (30 s by default; neither a per-query nor a per-profile `http_send_timeout` changed that against
 * ClickHouse 26.7), and tagging a day's rows takes longer, so no response stays open while rows are
 * tagged. `limit` caps the rows over all pages.
 */
export async function* genObservationPages(
  ch: TagClickHouse,
  window: { start: Date; end: Date },
  limit?: number
): AsyncGenerator<GenObservation[]> {
  let left = limit ?? Infinity;
  for (let t = window.start.getTime(); t < window.end.getTime() && left > 0; t += DAY_MS) {
    const page: GenObservation[] = [];
    for await (const r of ch.rows<Parameters<typeof genObservationOf>[0]>(
      genObservationsSql(
        new Date(t),
        new Date(Math.min(t + DAY_MS, window.end.getTime())),
        TAG_SOURCE_PARAMS.genSliceMinutes,
        Number.isFinite(left) ? left : undefined
      )
    ))
      page.push(genObservationOf(r));
    left -= page.length;
    yield page;
  }
}

/** The newest frozen vocabulary, verified against its version; refuses when there is none. */
export async function newestFrozenVocabulary(query: TagRawQuery) {
  const [v] = (await query(Prisma.sql`
    SELECT "vocabVersion", payload FROM "ResourceIntentVocabulary"
    WHERE status = 'frozen' ORDER BY "frozenAt" DESC, "vocabVersion" DESC LIMIT 1`)) as {
    vocabVersion: string;
    payload: Buffer;
  }[];
  if (!v) throw new Error('tag index build: no frozen vocabulary; refusing');
  const vocab = parseTagVocabulary(v.payload);
  if (vocab.vocabVersion !== v.vocabVersion)
    throw new Error('tag index build: the vocabulary payload does not hash to its version');
  return vocab;
}

/**
 * The standby reads, each statement READ ONLY under the co-occurrence build's timeout, retried.
 * `eachAttempt` wraps every attempt inside the retry (the dry run times them).
 */
export function tagStandbyQuery(
  eachAttempt: (attempt: TagRawQuery) => TagRawQuery = (attempt) => attempt
): TagRawQuery {
  return retryingQuery(eachAttempt(standbyQuery(coocReplicaRunner, COOC_STATEMENT_TIMEOUT_MS)));
}

/** Milliseconds since the previous call (or since it was made). */
function phaseClock() {
  let last = performance.now();
  return () => {
    const now = performance.now();
    const ms = Math.round(now - last);
    last = now;
    return ms;
  };
}

/**
 * Finalizes and encodes, yielding throughout. The encode consumes `data` (`consume: true` empties its
 * postings as it streams them into brotli), so nothing may read it afterwards.
 */
export async function finalizeAndEncodeTagIndex(
  acc: TagIndexAccumulator,
  tick: () => Promise<void>
) {
  const { data, stats } = await acc.finalizeCooperative(tick, undefined, { float32Postings: true });
  const payload = await encodeTagIndexCooperative(data, RESOURCE_INTENT_TAGS_SPEC_HASH, tick, {
    consume: true,
  });
  return { payload, stats };
}

/** Aggregates only: never a prompt, a tag or a model name. */
export type TagBuildSummary = {
  vocabVersion: string;
  specHash: string;
  window: { start: string; end: string };
  observationAgeSec: number;
  /**
   * Generator coverage: counted from `start` (the later of the window's start and the observation
   * table's floor, so a snapshot trained on a shorter span says so) over `hours` hours to the window's
   * end, `missing` of them with no observation.
   */
  observationHours: ObservationHours;
  observations: number;
  genUsers: number;
  postUsers: number;
  genAndPostUsers: number;
  postedRows: number;
  /** Models eligible for the index (`readEligibleModelIds`), whether or not a training row used them. */
  eligibleModels: number;
  /**
   * Models whose content was requested: the eligible ones and those seen in training rows (after any
   * `limits.models` cut).
   */
  contentModelsRequested: number;
  contentModels: number;
  stats: TagBuildStatsWithCoverage;
  /** Wall time per phase. */
  ms: {
    gen: number;
    posted: number;
    eligible: number;
    content: number;
    finalizeEncode: number;
    put: number | null;
  };
  payloadBytes: number;
  dryRun: boolean;
  /** Set when stored: the manifest row and whether this build created it. */
  snapshotId: string | null;
  created: boolean | null;
};

/** The build's stats as stored on the manifest row: the index's, and the window's coverage. */
export type ObservationHours = { start: string; hours: number; missing: number };

export type TagBuildStatsWithCoverage = TagBuildStats & { observationHours: ObservationHours };

export type TagBuildDeps = {
  env: TagBuildEnv;
  now?: Date;
  query?: TagRawQuery;
  clickhouse?: (c: TagBuildConfig['clickhouse']) => Promise<TagClickHouse>;
  objects?: () => TagIndexObjectStore;
  sql?: CoocSql;
  excludeGenPrompt?: (prompt: string) => boolean;
};

/**
 * Read the training data and build the encoded index. The accumulator and every training-side
 * structure (versions, user sets) live only in this call, so none of it is reachable while the
 * caller's put decodes the payload.
 */
async function readAndBuild(a: {
  opts: { dryRun: boolean; limits?: { gen?: number; postBatches?: number; models?: number } };
  deps: TagBuildDeps;
  config: TagBuildConfig;
  ch: TagClickHouse;
  query: TagRawQuery;
  vocab: Awaited<ReturnType<typeof newestFrozenVocabulary>>;
  window: { start: Date; end: Date };
  clock: () => number;
}) {
  const { opts, deps, config, ch, query, window, clock } = a;
  const tick = loopYielder(TAG_BUILD_YIELD_MS);
  const acc = new TagIndexAccumulator(a.vocab, {
    addonTypes: RESOURCE_INTENT_TAGS_SPEC.build.addonTypes,
    excludeGenPrompt: deps.excludeGenPrompt ?? promptExcludedByAuditor,
  });

  // Generator rows a UTC day at a time, so their prompts are never all held at once.
  const versions = new Map<number, VersionInfo>();
  const genUsers = new Set<string>();
  let observations = 0;
  for await (const page of genObservationPages(ch, window, opts.limits?.gen)) {
    observations += page.length;
    const missing = [...new Set(page.flatMap((o) => o.versionIds))].filter(
      (id) => !versions.has(id)
    );
    for (const [id, v] of await fetchVersionInfo(query, missing)) versions.set(id, v);
    for (const o of page) {
      await tick();
      genUsers.add(o.user);
      const row = genTrainingRow(o, versions);
      if (row) acc.addRow(row);
    }
  }
  if (observations === 0 && !opts.dryRun)
    throw new Error('tag index build: the generator read returned no observations; refusing');
  const genMs = clock();

  const postUsers = new Set<string>();
  const posted = await readPostedSample(query, {
    start: window.start,
    end: window.end,
    mod: TAG_SOURCE_PARAMS.postedMod,
    idBatch: TAG_POSTED_ID_BATCH,
    maxBatches: opts.limits?.postBatches,
    userKey: (id) => observationUserHash(config.hashKey, id),
    onBatch: async (rows) => {
      for (const r of rows) {
        await tick();
        postUsers.add(r.user);
        acc.addRow(r);
      }
    },
  });
  let genAndPostUsers = 0;
  for (const u of postUsers) if (genUsers.has(u)) genAndPostUsers++;
  const postedMs = clock();

  // Used models need not still be eligible, so content is read for both; a never-used model ranks on
  // its content alone, its fit the shrinkage prior's 0.
  const eligible = await readEligibleModelIds(
    query,
    indexedModelTypes(RESOURCE_INTENT_TAGS_SPEC.build.addonTypes)
  );
  const eligibleMs = clock();

  let contentModels = 0;
  const modelIds = unionAscending(acc.usedModelIds(), eligible).slice(0, opts.limits?.models);
  await readModelContent(query, modelIds, window.end, async (models) => {
    for (const m of models) {
      await tick();
      acc.addModel(m);
      contentModels++;
    }
  });
  const contentMs = clock();

  const { payload, stats } = await finalizeAndEncodeTagIndex(acc, tick);
  return {
    payload,
    stats,
    counts: {
      observations,
      genUsers: genUsers.size,
      postUsers: postUsers.size,
      genAndPostUsers,
      postedRows: posted.rows,
      eligibleModels: eligible.length,
      contentModelsRequested: modelIds.length,
      contentModels,
    },
    ms: {
      gen: genMs,
      posted: postedMs,
      eligible: eligibleMs,
      content: contentMs,
      finalizeEncode: clock(),
    },
  };
}

/**
 * Gate, read, build and encode; then, unless `dryRun`, store it as a production snapshot. Every gate
 * runs before the first training read, so a misconfigured or stale environment fails loudly.
 */
export async function runTagIndexBuild(
  opts: {
    dryRun: boolean;
    /** A dry run's trial cuts: a LIMIT on the observations, posted batches, models read. */
    limits?: { gen?: number; postBatches?: number; models?: number };
  },
  deps: TagBuildDeps
): Promise<{ summary: TagBuildSummary; payload: Buffer }> {
  if (opts.limits && !opts.dryRun) throw new Error('tag index build: limits are for dry runs only');
  const config = tagBuildConfig(deps.env, { requireBucket: !opts.dryRun });
  const objects = opts.dryRun ? null : (deps.objects ?? (() => s3TagIndexObjects()))();
  const sql = deps.sql ?? coocSqlOf(dbWrite);
  // Before a 40-minute build: a production build whose payload the table could refuse stops here.
  if (!opts.dryRun) await assertSnapshotTableAdmits(sql, TAG_INDEX_MAX_PAYLOAD_BYTES);
  const ch = await (deps.clickhouse ?? readonlyClickHouse)(config.clickhouse);
  try {
    await assertClickHouseReadonly(ch);
    const window = tagTrainingWindow(deps.now ?? new Date());
    const coverage = await observationCoverage(ch, window, !opts.dryRun);
    const query = deps.query ?? tagStandbyQuery();
    const vocab = await newestFrozenVocabulary(query);
    const clock = phaseClock();
    const built = await readAndBuild({ opts, deps, config, ch, query, vocab, window, clock });
    const stats: TagBuildStatsWithCoverage = {
      ...built.stats,
      observationHours: {
        start: coverage.start.toISOString(),
        hours: coverage.hours,
        missing: coverage.missingHours,
      },
    };
    const summary: TagBuildSummary = {
      vocabVersion: vocab.vocabVersion,
      specHash: RESOURCE_INTENT_TAGS_SPEC_HASH,
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
      observationAgeSec: coverage.newestAgeSec,
      observationHours: stats.observationHours,
      ...built.counts,
      stats,
      ms: { ...built.ms, put: null },
      payloadBytes: built.payload.length,
      dryRun: opts.dryRun,
      snapshotId: null,
      created: null,
    };
    if (!objects) return { summary, payload: built.payload };

    const { manifest, created } = await putSnapshot({ sql, objects }, built.payload, {
      vocabVersion: vocab.vocabVersion,
      specHash: RESOURCE_INTENT_TAGS_SPEC_HASH,
      buildStats: stats,
    });
    return {
      summary: {
        ...summary,
        ms: { ...summary.ms, put: clock() },
        snapshotId: manifest.id,
        created,
      },
      payload: built.payload,
    };
  } finally {
    await ch.close();
  }
}

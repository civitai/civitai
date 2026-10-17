import { Prisma } from '@prisma/client';

import { dbRead, dbWrite } from '~/server/db/client';
import {
  COOC_STATEMENT_TIMEOUT_MS,
  type CoocTxRunner,
} from '~/server/services/resource-intent-cooc/build';
import { coocSqlOf, type CoocSql } from '~/server/services/resource-intent-cooc/store';
import { parseTagVocabulary, TagIndexAccumulator, type TagBuildStats } from './build';
import { s3TagIndexObjects } from './objects';
import { encodeTagIndex } from './payload';
import { promptExcludedByAuditor } from './prompt-exclusion';
import {
  assertObservationKey,
  fetchVersionInfo,
  genObservationOf,
  genObservationsSql,
  genTrainingRow,
  observationUserHash,
  readModelContent,
  readPostedSample,
  retryingQuery,
  standbyQuery,
  TAG_SOURCE_PARAMS,
  tagTrainingWindow,
  type GenObservation,
  type TagRawQuery,
  type VersionInfo,
} from './sources';
import { RESOURCE_INTENT_TAGS_SPEC, RESOURCE_INTENT_TAGS_SPEC_HASH } from './spec';
import { putSnapshot, type TagIndexObjectStore } from './store';

/**
 * The weekly tag-index build: gates, then the reads, the build, the encode and (unless a dry run) the
 * put. Every gate runs before the first read of training data, so a misconfigured or stale
 * environment fails loudly instead of building something wrong.
 */

/**
 * Refuse to build when the newest generator observation is older than this. The observations are
 * written only by an external hourly extractor, which reads each 2-minute slice about 2 h after it
 * ends, so a healthy table's newest row is about 2–3.5 h old; its own lag alert fires at 4 h (one
 * missed run plus slack). 6 h is that alert plus two more missed runs: the extractor has then been
 * down for at least three runs, and a build now would train on a window it may have stopped
 * filling.
 */
export const TAG_BUILD_MAX_OBSERVATION_AGE_HOURS = 6;

/**
 * The longest the build keeps the event loop between yields while tagging. The job shares its
 * process with every other job on the pod; a fixed row count is not a bound, because the prompt
 * audit's cost varies per prompt (the dry run measured 1,000 generator rows taking up to 0.92 s).
 */
export const TAG_BUILD_YIELD_MS = 50;
/** Generator observations whose versions are resolved together. */
const GEN_BATCH = 20_000;

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
 * the snapshot bucket; a dry run stores nothing and does not. The hash key must be hex and carry the
 * fingerprint the observations were written under.
 */
export function tagBuildConfig(e: TagBuildEnv, opts: { requireBucket: boolean }): TagBuildConfig {
  const required = [
    ...(opts.requireBucket ? (['RESOURCE_INTENT_TAG_INDEX_BUCKET'] as const) : []),
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

/** A ClickHouse client whose every query runs read-only (`readonly = 2`). */
export async function readonlyClickHouse(c: TagBuildConfig['clickhouse']): Promise<TagClickHouse> {
  const { createClient } = await import('@clickhouse/client');
  const ch = createClient({
    url: c.url,
    username: c.user,
    password: c.password,
    request_timeout: 1_900_000,
    clickhouse_settings: { readonly: '2', max_execution_time: 1800 },
  });
  return {
    async *rows<T>(query: string) {
      const rs = await ch.query({ query, format: 'JSONEachRow' });
      for await (const batch of rs.stream())
        for (const row of batch as { json: <R>() => R }[]) yield row.json<T>();
    },
    close: () => ch.close(),
  };
}

async function firstRow<T>(ch: TagClickHouse, query: string): Promise<T | undefined> {
  for await (const r of ch.rows<T>(query)) return r;
  return undefined;
}

/** Refuse a ClickHouse session that is not read-only: the build must not be able to write there. */
export async function assertClickHouseReadonly(ch: TagClickHouse): Promise<void> {
  const r = await firstRow<{ ro: number | string }>(ch, `SELECT getSetting('readonly') AS ro`);
  if (!(Number(r?.ro) >= 1))
    throw new Error('tag index build: the ClickHouse session is not read-only; refusing');
}

/**
 * Seconds since the newest generator observation, by ClickHouse's clock; refuses above
 * `TAG_BUILD_MAX_OBSERVATION_AGE_HOURS`, and when there is none in the last 3 days.
 */
export async function assertObservationsFresh(ch: TagClickHouse): Promise<number> {
  const r = await firstRow<{ newest: number | string; now: number | string; n: number | string }>(
    ch,
    `SELECT toUnixTimestamp(max(time)) AS newest, toUnixTimestamp(now()) AS now, count() AS n
     FROM default.resourceIntentGenObservation WHERE time > now() - INTERVAL 3 DAY`
  );
  const age = Number(r?.now) - Number(r?.newest);
  if (!r || !(Number(r.n) > 0) || !Number.isFinite(age))
    throw new Error(
      'tag index build: no generator observation in the last 3 days; the extractor is stalled, refusing'
    );
  const maxSec = TAG_BUILD_MAX_OBSERVATION_AGE_HOURS * 3600;
  if (age > maxSec)
    throw new Error(
      `tag index build: the newest generator observation is ${Math.round(
        age / 60
      )} min old (limit ${TAG_BUILD_MAX_OBSERVATION_AGE_HOURS} h); the extractor is stalled, refusing`
    );
  return age;
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

/** The standby reads, each statement READ ONLY under the co-occurrence build's timeout, retried. */
export function tagStandbyQuery(): TagRawQuery {
  const run: CoocTxRunner = (fn) =>
    dbRead.$transaction(fn, { maxWait: 30_000, timeout: COOC_STATEMENT_TIMEOUT_MS + 30_000 });
  return retryingQuery(standbyQuery(run, COOC_STATEMENT_TIMEOUT_MS));
}

async function finalizeAndEncode(acc: TagIndexAccumulator) {
  const { data, stats } = acc.finalize();
  return { payload: await encodeTagIndex(data, RESOURCE_INTENT_TAGS_SPEC_HASH), stats };
}

/** Aggregates only: never a prompt, a tag or a model name. */
export type TagBuildSummary = {
  vocabVersion: string;
  specHash: string;
  window: { start: string; end: string };
  observationAgeSec: number;
  observations: number;
  genUsers: number;
  postUsers: number;
  genAndPostUsers: number;
  postedRows: number;
  contentModels: number;
  stats: TagBuildStats;
  payloadBytes: number;
  dryRun: boolean;
  /** Set when stored: the manifest row and whether this build created it. */
  snapshotId: string | null;
  created: boolean | null;
};

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
 * Gate, read, build and encode; then, unless `dryRun`, store it as a production snapshot. The gates,
 * in order: the environment (and the snapshot bucket's object store, unless a dry run); a read-only
 * ClickHouse session; generator observations no older than the limit; a frozen vocabulary.
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
  const ch = await (deps.clickhouse ?? readonlyClickHouse)(config.clickhouse);
  try {
    await assertClickHouseReadonly(ch);
    const observationAgeSec = await assertObservationsFresh(ch);
    const query = deps.query ?? tagStandbyQuery();
    const vocab = await newestFrozenVocabulary(query);
    const window = tagTrainingWindow(deps.now ?? new Date());
    const tick = loopYielder(TAG_BUILD_YIELD_MS);
    const acc = new TagIndexAccumulator(vocab, {
      addonTypes: RESOURCE_INTENT_TAGS_SPEC.build.addonTypes,
      excludeGenPrompt: deps.excludeGenPrompt ?? promptExcludedByAuditor,
    });

    // Generator rows, a batch at a time so their prompts are never all held at once.
    const versions = new Map<number, VersionInfo>();
    const genUsers = new Set<string>();
    let observations = 0;
    let pending: GenObservation[] = [];
    const flush = async () => {
      const missing = [...new Set(pending.flatMap((o) => o.versionIds))].filter(
        (id) => !versions.has(id)
      );
      for (const [id, v] of await fetchVersionInfo(query, missing)) versions.set(id, v);
      for (const o of pending) {
        await tick();
        const row = genTrainingRow(o, versions);
        if (row) acc.addRow(row);
      }
      pending = [];
    };
    for await (const r of ch.rows<Parameters<typeof genObservationOf>[0]>(
      genObservationsSql(
        window.start,
        window.end,
        TAG_SOURCE_PARAMS.genSliceMinutes,
        opts.limits?.gen
      )
    )) {
      const o = genObservationOf(r);
      observations++;
      genUsers.add(o.user);
      pending.push(o);
      if (pending.length >= GEN_BATCH) await flush();
    }
    await flush();

    const postUsers = new Set<string>();
    const posted = await readPostedSample(query, {
      start: window.start,
      end: window.end,
      mod: TAG_SOURCE_PARAMS.postedMod,
      idBatch: 250_000,
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

    let contentModels = 0;
    const modelIds = acc.usedModelIds().slice(0, opts.limits?.models);
    await readModelContent(query, modelIds, window.end, async (models) => {
      for (const m of models) {
        await tick();
        acc.addModel(m);
        contentModels++;
      }
    });

    // The built arrays live only inside this call, so they can be collected before the put decodes.
    const { payload, stats } = await finalizeAndEncode(acc);
    const summary: TagBuildSummary = {
      vocabVersion: vocab.vocabVersion,
      specHash: RESOURCE_INTENT_TAGS_SPEC_HASH,
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
      observationAgeSec,
      observations,
      genUsers: genUsers.size,
      postUsers: postUsers.size,
      genAndPostUsers,
      postedRows: posted.rows,
      contentModels,
      stats,
      payloadBytes: payload.length,
      dryRun: opts.dryRun,
      snapshotId: null,
      created: null,
    };
    if (!objects) return { summary, payload };

    const { manifest, created } = await putSnapshot(
      { sql: deps.sql ?? coocSqlOf(dbWrite), objects },
      payload,
      {
        vocabVersion: vocab.vocabVersion,
        specHash: RESOURCE_INTENT_TAGS_SPEC_HASH,
        buildStats: stats,
      }
    );
    return { summary: { ...summary, snapshotId: manifest.id, created }, payload };
  } finally {
    await ch.close();
  }
}

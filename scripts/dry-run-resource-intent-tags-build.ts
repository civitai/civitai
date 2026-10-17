import { parseArgs } from 'util';

import type { GenObservation } from '~/server/services/resource-intent-tags/sources';
import { runScriptAndExit } from './lib/run-as-script';

/**
 * Build the v1 content-tag index from real data WITHOUT storing it, and print what it costs.
 *
 *   pnpm run tsscript scripts/dry-run-resource-intent-tags-build.ts [--limit-gen N]
 *     [--limit-post-batches N] [--limit-models N]
 *
 * Reads only: Postgres through `dbRead` with every statement in a READ ONLY transaction that refuses
 * any server that is not a standby, and ClickHouse with `readonly` set. Writes nothing anywhere.
 * Prints aggregates only — counts, bytes, milliseconds, tag ids — never a prompt, tag or model name.
 *
 * Environment:
 *   P2M_CLICKHOUSE_URL, P2M_CLICKHOUSE_USER, P2M_CLICKHOUSE_PASSWORD
 *       a ClickHouse user that can read the generator observations and their prompt text
 *   P2M_HASH_KEY
 *       hex key the observations' user ids were hashed with; posted users are hashed with it so
 *       both sources share one user namespace
 * The `--limit-*` flags cut the inputs for a quick trial; the printed counts say what was read.
 */

const ms = (t0: number) => Math.round(performance.now() - t0);
const mib = (b: number) => Math.round((b / 2 ** 20) * 10) / 10;

function quantiles(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: s[s.length - 1] ?? 0 };
}

/** A full collection, so the heap figures around the decode measure what it retains. */
async function gc() {
  const v8 = await import('v8');
  const vm = await import('vm');
  v8.setFlagsFromString('--expose_gc');
  const collect = vm.runInNewContext('gc') as () => void;
  collect();
  collect();
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'limit-gen': { type: 'string' },
      'limit-post-batches': { type: 'string' },
      'limit-models': { type: 'string' },
    },
    strict: true,
  });
  const limit = (v?: string) => (v === undefined ? Infinity : Number(v));
  const env = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  const chUrl = env('P2M_CLICKHOUSE_URL');
  const hashKey = Buffer.from(env('P2M_HASH_KEY'), 'hex');
  if (!hashKey.length) throw new Error('P2M_HASH_KEY is not hex');

  const { Prisma } = await import('@prisma/client');
  const { createClient } = await import('@clickhouse/client');
  const { dbRead } = await import('~/server/db/client');
  const B = await import('~/server/services/resource-intent-tags/build');
  const S = await import('~/server/services/resource-intent-tags/sources');
  const {
    compressTagIndex,
    decompressTagIndex,
    packTagIndex,
    TAG_INDEX_MAX_PAYLOAD_BYTES,
    unpackTagIndex,
  } = await import('~/server/services/resource-intent-tags/payload');
  const { promptExcludedByAuditor } = await import(
    '~/server/services/resource-intent-tags/prompt-exclusion'
  );
  const { RESOURCE_INTENT_TAGS_SPEC, RESOURCE_INTENT_TAGS_SPEC_HASH } = await import(
    '~/server/services/resource-intent-tags/spec'
  );
  const { scoreTagRequest } = await import('~/server/services/resource-intent-tags/score');
  const log = (k: string, v: unknown) =>
    console.log(`[dry-run-resource-intent-tags] ${k} ${JSON.stringify(v)}`);

  const query = S.retryingQuery(
    S.standbyQuery((fn) => dbRead.$transaction(fn, { maxWait: 30_000, timeout: 310_000 }), 280_000)
  );
  const ch = createClient({
    url: chUrl,
    username: env('P2M_CLICKHOUSE_USER'),
    password: env('P2M_CLICKHOUSE_PASSWORD'),
    request_timeout: 1_900_000,
    clickhouse_settings: { readonly: '2', max_execution_time: 1800 },
  });
  const ro = await (
    await ch.query({ query: `SELECT getSetting('readonly') AS ro`, format: 'JSONEachRow' })
  ).json<{ ro: number | string }>();
  if (!(Number(ro[0]?.ro) >= 1)) throw new Error('ClickHouse session is not readonly; refusing');

  try {
    const [v] = (await query(Prisma.sql`
      SELECT "vocabVersion", payload FROM "ResourceIntentVocabulary"
      WHERE status = 'frozen' ORDER BY "frozenAt" DESC NULLS LAST LIMIT 1`)) as {
      vocabVersion: string;
      payload: Buffer;
    }[];
    if (!v) throw new Error('no frozen vocabulary');
    const vocab = B.parseTagVocabulary(v.payload);
    if (vocab.vocabVersion !== v.vocabVersion) throw new Error('vocabulary payload hash mismatch');
    const window = S.tagTrainingWindow(new Date());
    log('input', {
      vocabVersion: vocab.vocabVersion,
      vocabularyTags: vocab.tags.length,
      vocabularyBytes: v.payload.length,
      specHash: RESOURCE_INTENT_TAGS_SPEC_HASH,
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
    });

    let t0 = performance.now();
    const gen: GenObservation[] = [];
    const rs = await ch.query({
      query: S.genObservationsSql(window.start, window.end, S.TAG_SOURCE_PARAMS.genSliceMinutes),
      format: 'JSONEachRow',
    });
    const maxGen = limit(values['limit-gen']);
    for await (const batch of rs.stream()) {
      for (const row of batch as { json: <T>() => T }[]) {
        if (gen.length < maxGen) gen.push(S.genObservationOf(row.json()));
      }
    }
    const genReadMs = ms(t0);
    t0 = performance.now();
    const versionIds = [...new Set(gen.flatMap((o) => o.versionIds))];
    const versions = await S.fetchVersionInfo(query, versionIds);
    log('gen', {
      observations: gen.length,
      users: new Set(gen.map((o) => o.user)).size,
      versions: versionIds.length,
      versionsResolved: versions.size,
      readMs: genReadMs,
      versionMs: ms(t0),
    });

    const acc = new B.TagIndexAccumulator(vocab, {
      addonTypes: RESOURCE_INTENT_TAGS_SPEC.build.addonTypes,
      excludeGenPrompt: promptExcludedByAuditor,
    });
    t0 = performance.now();
    let flaggedModelRows = 0;
    for (const o of gen.splice(0)) {
      const row = S.genTrainingRow(o, versions);
      if (row) acc.addRow(row);
      else flaggedModelRows++;
    }
    log('genRows', { flaggedModelRows, tagMs: ms(t0) });

    t0 = performance.now();
    const posted = await S.readPostedSample(query, {
      start: window.start,
      end: window.end,
      mod: S.TAG_SOURCE_PARAMS.postedMod,
      idBatch: 250_000,
      maxBatches: limit(values['limit-post-batches']),
      userKey: (id) => S.observationUserHash(hashKey, id),
      onBatch: (rows) => {
        for (const r of rows) acc.addRow(r);
      },
    });
    log('post', { ...posted, ms: ms(t0) });

    t0 = performance.now();
    const modelIds = acc.usedModelIds().slice(0, limit(values['limit-models']));
    let contentModels = 0;
    await S.readModelContent(query, modelIds, window.end, (models) => {
      contentModels += models.length;
      for (const m of models) acc.addModel(m);
    });
    log('content', { modelsRequested: modelIds.length, modelsRead: contentModels, ms: ms(t0) });

    t0 = performance.now();
    const { data, stats } = acc.finalize();
    log('build', { ...stats, ms: ms(t0) });
    t0 = performance.now();
    const raw = packTagIndex(data, RESOURCE_INTENT_TAGS_SPEC_HASH);
    const packMs = ms(t0);
    t0 = performance.now();
    const payload = await compressTagIndex(raw);
    log('payload', {
      rawBytes: raw.length,
      rawMiB: mib(raw.length),
      compressedBytes: payload.length,
      compressedMiB: mib(payload.length),
      underCap: payload.length <= TAG_INDEX_MAX_PAYLOAD_BYTES,
      packMs,
      compressMs: ms(t0),
    });

    await gc();
    const before = process.memoryUsage();
    t0 = performance.now();
    const inflated = await decompressTagIndex(payload);
    const decompressMs = ms(t0);
    t0 = performance.now();
    const decoded = unpackTagIndex(inflated);
    const unpackMs = ms(t0);
    await gc();
    const after = process.memoryUsage();
    log('decode', {
      decompressMs,
      unpackMs,
      heapUsedMiB: mib(after.heapUsed - before.heapUsed),
      arrayBuffersMiB: mib(after.arrayBuffers - before.arrayBuffers),
      externalMiB: mib(after.external - before.external),
      rssMiB: mib(after.rss - before.rss),
    });

    for (const kind of ['addon', 'checkpoint'] as const) {
      const k = decoded.index.kinds[kind];
      const lens = Array.from(
        { length: vocab.tags.length },
        (_, t) => k.postings.ptr[t + 1] - k.postings.ptr[t]
      );
      const top = lens
        .map((n, t) => ({ tagId: t, n }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 10);
      log(`postings.${kind}`, {
        resources: k.modelIds.length,
        entries: k.postings.resource.length,
        tagsWithPostings: lens.filter((n) => n > 0).length,
        lengths: quantiles(lens.filter((n) => n > 0)),
        top,
        userByTagEntries: [...k.userByTag.values()].reduce((n, v) => n + v.resource.length, 0),
      });
    }
    const synthetic = [
      'clean product photo of a sneaker on a white background for an ad',
      'watercolor painting of a lighthouse at dusk, soft light',
      'cyberpunk city street at night, neon rain, cinematic',
      'cute chibi cat mascot logo, flat vector',
      'portrait of an elderly fisherman, dramatic lighting, film photo',
      'isometric fantasy castle game asset, pixel art',
    ];
    const lat: number[] = [];
    const statuses: string[] = [];
    for (let rep = 0; rep < 5; rep++)
      for (const prompt of synthetic) {
        const t = performance.now();
        const r = scoreTagRequest(decoded.index, { prompt, kind: 'addon', browsingLevel: 3 });
        lat.push(performance.now() - t);
        if (!rep) statuses.push(`${r.status}:${r.candidates.length}`);
      }
    log('score', {
      requests: lat.length,
      ms: quantiles(lat.map((x) => Math.round(x * 100) / 100)),
      statusCandidates: statuses,
    });
  } finally {
    await ch.close();
    await dbRead.$disconnect();
  }
}

if (process.argv[1]?.endsWith('dry-run-resource-intent-tags-build.ts')) {
  void runScriptAndExit(() => main());
}

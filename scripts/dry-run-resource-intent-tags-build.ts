import { parseArgs } from 'util';

import type { TagBuildEnv } from '~/server/services/resource-intent-tags/pipeline';
import { runScriptAndExit } from './lib/run-as-script';

/**
 * Build the v1 content-tag index from real data WITHOUT storing it, and print what it costs. It runs
 * the weekly job's own pipeline (`runTagIndexBuild`, gates included) as a dry run.
 *
 *   pnpm run tsscript scripts/dry-run-resource-intent-tags-build.ts [--limit-gen N]
 *     [--limit-post-batches N] [--limit-models N]
 *
 * Reads only: Postgres through `dbRead` with every statement in a READ ONLY transaction that refuses
 * any server that is not a standby, and ClickHouse with `readonly` set. Writes nothing anywhere.
 * Prints aggregates only — counts, bytes, milliseconds, tag ids — never a prompt, tag or model name.
 *
 * Environment: the job's (`tagBuildConfig`), without the snapshot bucket or its credentials:
 *   P2M_CLICKHOUSE_URL, P2M_CLICKHOUSE_USER, P2M_CLICKHOUSE_PASSWORD
 *       a ClickHouse user that can read the generator observations and their prompt text
 *   P2M_HASH_KEY, P2M_HASH_KEY_FINGERPRINT
 *       hex key the observations' user ids were hashed with, and the fingerprint they were written
 *       under; a key with another fingerprint is refused. Posted users are hashed with it so both
 *       sources share one user namespace
 * The `--limit-*` flags (positive integers) cut the inputs for a quick trial; `--limit-gen` is a
 * LIMIT on the ClickHouse read (`--limit-models` cuts the union of used and eligible models by
 * ascending id). The printed counts say what was read. It prints each standby statement kind's
 * attempt times (retries counted separately); the RSS before the build reads anything, the build's
 * peak RSS and its longest event-loop stall counted from there; the same for the put's decode
 * (`decodeTagIndexData`, as `putSnapshot` runs it), whose peak is the job's; the decoded index's
 * resident cost, with decompress, unpack and validate-and-assemble timed apart; and the wall time.
 * Unlike the job, it reports missing window hours over the limit instead of refusing.
 */

const ms = (t0: number) => Math.round(performance.now() - t0);
const mib = (b: number) => Math.round((b / 2 ** 20) * 10) / 10;

function quantiles(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: s[s.length - 1] ?? 0 };
}

/**
 * Full collections with event-loop turns between them, so the heap and array-buffer figures around
 * the decode measure what it retains: freed array buffers are released after a collection, not by it.
 */
async function gc() {
  const v8 = await import('v8');
  const vm = await import('vm');
  v8.setFlagsFromString('--expose_gc');
  const collect = vm.runInNewContext('gc') as () => void;
  for (let i = 0; i < 3; i++) {
    collect();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const tStart = performance.now();
  // The longest the event loop went without running a 10 ms timer during the build: what every
  // other job in a shared process would wait.
  let lastTick = performance.now();
  let maxLoopGap = 0;
  const loopTimer = setInterval(() => {
    const t = performance.now();
    maxLoopGap = Math.max(maxLoopGap, t - lastTick);
    lastTick = t;
  }, 10);
  loopTimer.unref();
  const { values } = parseArgs({
    args: argv,
    options: {
      'limit-gen': { type: 'string' },
      'limit-post-batches': { type: 'string' },
      'limit-models': { type: 'string' },
    },
    strict: true,
  });
  /** A `--limit-*` value: absent, or a positive integer; anything else is refused. */
  const limit = (flag: string, v?: string): number | undefined => {
    if (v === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v)))
      throw new Error(`--${flag}: not a positive integer: ${v}`);
    return Number(v);
  };
  const limits = {
    gen: limit('limit-gen', values['limit-gen']),
    postBatches: limit('limit-post-batches', values['limit-post-batches']),
    models: limit('limit-models', values['limit-models']),
  };

  const { dbRead } = await import('~/server/db/client');
  const {
    decodeTagIndexData,
    decompressTagIndex,
    TAG_INDEX_MAX_PAYLOAD_BYTES,
    tagIndexFromData,
    unpackTagIndexData,
  } = await import('~/server/services/resource-intent-tags/payload');
  const { runTagIndexBuild, tagStandbyQuery } = await import(
    '~/server/services/resource-intent-tags/pipeline'
  );
  const { scoreTagRequest } = await import('~/server/services/resource-intent-tags/score');
  const log = (k: string, v: unknown) =>
    console.log(`[dry-run-resource-intent-tags] ${k} ${JSON.stringify(v)}`);

  // The job's standby reads (`tagStandbyQuery`), each ATTEMPT timed by kind inside the retry: the
  // replica route a deployed job reads through may cap statements tighter than the build's own
  // timeout, so the slowest attempt, and any that failed, matter.
  const failedAttempts: Record<string, number> = {};
  const statementMs: Record<string, number[]> = {};
  const kindOf = (text: string) =>
    text.includes('ORDER BY m.id LIMIT')
      ? 'eligibleIds'
      : text.includes('jsonb_agg(DISTINCT')
      ? 'postedBatch'
      : text.includes('WITH ms AS')
      ? 'contentImages'
      : text.includes('FROM "Model" m WHERE')
      ? 'contentModels'
      : text.includes('"ModelVersion" mv JOIN')
      ? 'versions'
      : text.includes('"Image"')
      ? 'imageIdSearch'
      : 'other';
  const query = tagStandbyQuery((attempt) => async (sql) => {
    const t = performance.now();
    try {
      return await attempt(sql);
    } catch (e) {
      failedAttempts[kindOf(sql.text)] = (failedAttempts[kindOf(sql.text)] ?? 0) + 1;
      throw e;
    } finally {
      (statementMs[kindOf(sql.text)] ??= []).push(performance.now() - t);
    }
  });

  // The process with the app loaded, before the build reads anything. The event-loop gap is counted
  // from here too: loading the app's modules above blocks for seconds and is not the build's.
  const startRss = process.memoryUsage().rss;
  lastTick = performance.now();
  maxLoopGap = 0;
  try {
    const { summary, payload } = await runTagIndexBuild(
      { dryRun: true, limits },
      // The job reads the parsed app env; here the raw environment carries the same names.
      { env: process.env as TagBuildEnv, query }
    );
    for (const [kind, xs] of Object.entries(statementMs))
      log(`statements.${kind}`, {
        attempts: xs.length,
        failed: failedAttempts[kind] ?? 0,
        ms: quantiles(xs.map((x) => Math.round(x))),
      });
    const { stats, ...rest } = summary;
    log('input', rest);
    log('build', stats);
    log('payload', {
      compressedBytes: payload.length,
      compressedMiB: mib(payload.length),
      underCap: payload.length <= TAG_INDEX_MAX_PAYLOAD_BYTES,
    });
    clearInterval(loopTimer);
    log('memory', {
      // The peak less this is what the build adds to a process.
      startRssMiB: mib(startRss),
      peakRssMiB: mib(process.resourceUsage().maxRSS * 1024),
      buildMs: ms(tStart),
      maxEventLoopGapMs: Math.round(maxLoopGap),
    });

    // What the job's put does next, as it does it: decode the payload it is about to store, with the
    // build's garbage not yet collected. The process's peak RSS after it is the job's peak.
    {
      let gap = 0;
      let last = performance.now();
      const timer = setInterval(() => {
        const t = performance.now();
        gap = Math.max(gap, t - last);
        last = t;
      }, 10);
      const t = performance.now();
      await decodeTagIndexData(payload);
      clearInterval(timer);
      log('putDecode', {
        ms: ms(t),
        maxEventLoopGapMs: Math.round(gap),
        peakRssMiB: mib(process.resourceUsage().maxRSS * 1024),
      });
    }

    await gc();
    const before = process.memoryUsage();
    let t0 = performance.now();
    let inflated: Buffer | null = await decompressTagIndex(payload);
    const decompressMs = ms(t0);
    const rawBytes = inflated.length;
    // Unpack, then validate and assemble together (`decodeTagIndex` turns the event loop between
    // each of the three).
    t0 = performance.now();
    const unpacked = unpackTagIndexData(inflated);
    const unpackDataMs = ms(t0);
    t0 = performance.now();
    const decoded = { index: tagIndexFromData(unpacked.data) };
    const fromDataMs = ms(t0);
    // What a holder keeps: the decoded index alone, the inflated bytes released.
    inflated = null;
    await gc();
    const after = process.memoryUsage();
    const delta = (m: NodeJS.MemoryUsage) => ({
      heapUsedMiB: mib(m.heapUsed - before.heapUsed),
      arrayBuffersMiB: mib(m.arrayBuffers - before.arrayBuffers),
      externalMiB: mib(m.external - before.external),
      rssMiB: mib(m.rss - before.rss),
    });
    log('decode', {
      rawBytes,
      rawMiB: mib(rawBytes),
      decompressMs,
      unpackDataMs,
      fromDataMs,
      ...delta(after),
    });

    for (const kind of ['addon', 'checkpoint'] as const) {
      const k = decoded.index.kinds[kind];
      const lens = Array.from(
        { length: decoded.index.vocabulary.length },
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
    // Heavy prompts too: tags with the longest posting lists, every browsing level allowed (31).
    // Built in memory, never printed.
    const vocabKeys = decoded.index.vocabulary.map((t) => t.key);
    const heavy: string[] = [];
    for (const kind of ['addon', 'checkpoint'] as const) {
      const ptr = decoded.index.kinds[kind].postings.ptr;
      const longest = vocabKeys
        .map((_, t) => t)
        .sort((x, y) => ptr[y + 1] - ptr[y] - (ptr[x + 1] - ptr[x]))
        .slice(0, 20);
      for (let i = 0; i < 20; i += 5)
        heavy.push(
          longest
            .slice(i, i + 5)
            .map((t) => vocabKeys[t])
            .join(', ')
        );
    }
    const probes = [
      ...synthetic.map((prompt) => ({ prompt, browsingLevel: 3, set: 'synthetic' })),
      ...heavy.map((prompt) => ({ prompt, browsingLevel: 31, set: 'heavy' })),
    ];
    for (const set of ['synthetic', 'heavy'])
      for (const kind of ['addon', 'checkpoint'] as const) {
        const lat: number[] = [];
        const statuses: Record<string, number> = {};
        for (let rep = 0; rep < 5; rep++)
          for (const p of probes.filter((x) => x.set === set)) {
            const t = performance.now();
            const r = scoreTagRequest(decoded.index, {
              prompt: p.prompt,
              kind,
              browsingLevel: p.browsingLevel,
            });
            lat.push(performance.now() - t);
            if (!rep) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
          }
        log(`score.${set}.${kind}`, {
          requests: lat.length,
          ms: quantiles(lat.map((x) => Math.round(x * 100) / 100)),
          statuses,
        });
      }
    log('wall', { totalMs: ms(tStart), peakRssMiB: mib(process.resourceUsage().maxRSS * 1024) });
  } finally {
    await dbRead.$disconnect();
  }
}

if (process.argv[1]?.endsWith('dry-run-resource-intent-tags-build.ts')) {
  void runScriptAndExit(() => main());
}

import type { Gauge, Histogram } from 'prom-client';

/**
 * Cheaper per-command handles for the two Redis command metrics `@civitai/redis` updates on EVERY
 * command (`redis_commands_inflight`, `redis_command_duration_seconds`), with the exported series
 * unchanged: same names, same labels, and at every scrape the same values the per-command prom-client
 * calls would have produced.
 *
 * Why: a prom-client `inc`/`dec`/`observe` with labels validates the labels and hashes them into a
 * string key on every call. On the busiest paths that is three label hashes per Redis command, which
 * is enough to appear in a CPU profile. These handles keep plain numbers per `client` label value
 * on the hot path and hand them to prom-client once per scrape, from the metric's `collect()`.
 *
 *  - The in-flight gauge is counted locally only if the gauge MODE latched `local`. A gauge's
 *    exported value is the running sum of its incs and decs, which is exactly what the local integer
 *    holds, and the `collect()` sets it at scrape. The mode is decided ONCE per process, on the
 *    first inc or dec, from the resolver the app installs (`setRedisInflightGaugeModeResolver`), and
 *    never changes after: a command inc'd on one path and dec'd on the other would leave the gauge
 *    off by one for good, so a flag flip must not be able to move it. No resolver installed at that
 *    first call, or one that throws or answers anything but `true`, latches `direct` (per-command
 *    prom-client inc/dec, as before). Changing the mode therefore needs a process restart.
 *  - The duration histogram is accumulated locally only while the batch gate (a Flipt switch the
 *    app installs at boot) is on, and flushed into the histogram's own bucket/sum/count on the next
 *    scrape. Off, or with no gate installed, every observe goes straight to prom-client as before.
 *    Values accumulated under the gate are flushed whatever the gate says later, so a flip loses
 *    nothing.
 *
 * Multiple bundled copies: this module can be emitted into more than one server chunk, and each copy
 * may wrap the same metric instance. So the accumulators live in a WeakMap keyed by the METRIC
 * INSTANCE, held on `globalThis` together with the gate: every copy that wraps one metric shares one
 * accumulator, and whichever copy's `collect()` runs flushes it. (Enrolled as SHARED_STATE in
 * scripts/server-graph-watchlist.mjs.)
 *
 * The flush writes into prom-client's internal per-label entry (`hashMap`: `bucketValues`, `sum`,
 * `count`), because prom-client has no weighted observe. `redis-command-metrics.test.ts` compares
 * the scraped text of a batched histogram with one fed through `observe()` for the same values, so a
 * prom-client change to that layout fails there. At runtime, a flush that meets an unexpected layout
 * stops batching for good (every later observe goes straight to prom-client) instead of throwing out
 * of `collect()`, which would fail the whole scrape.
 */

type Labels = { client: string };

type HistogramAcc = {
  /** Per finite bucket (`bounds[i]`): samples whose value is <= bounds[i] and > bounds[i-1]. */
  counts: number[];
  sum: number;
  count: number;
};

type HistogramState = {
  bounds: readonly number[];
  accs: Map<string, HistogramAcc>;
  broken: boolean;
};

type InflightGaugeMode = 'local' | 'direct';

type SharedState = {
  gate: (() => boolean) | undefined;
  /** Decides the in-flight gauge mode; read once, at the first inc/dec of the process. */
  gaugeModeResolver: (() => boolean) | undefined;
  /** The latched in-flight gauge mode; `undefined` only until the first inc/dec. */
  gaugeMode: InflightGaugeMode | undefined;
  gauges: WeakMap<object, Map<string, number>>;
  histograms: WeakMap<object, HistogramState>;
};

declare global {
  // eslint-disable-next-line no-var
  var __civitaiRedisCommandMetricsState: SharedState | undefined;
}

const state: SharedState = (globalThis.__civitaiRedisCommandMetricsState ??= {
  gate: undefined,
  gaugeModeResolver: undefined,
  gaugeMode: undefined,
  gauges: new WeakMap(),
  histograms: new WeakMap(),
});

/**
 * Install (or, with `undefined`, remove) the switch that batches `redis_command_duration_seconds`.
 * Called once per command, so it must be cheap: the app passes a cached flag read.
 */
export function setRedisCommandHistogramBatchGate(gate: (() => boolean) | undefined): void {
  state.gate = gate;
}

function batchOn(): boolean {
  const gate = state.gate;
  if (gate === undefined) return false;
  try {
    return gate() === true;
  } catch {
    return false;
  }
}

/**
 * Install the resolver that decides the in-flight gauge mode (`true` = count locally). It is read
 * exactly once per process, at the first inc or dec through any `batchedInflightGauge` handle, and
 * the answer is latched for the life of the process; installing a resolver after that changes
 * nothing. The app installs it once Flipt is initialized, before it serves traffic.
 */
export function setRedisInflightGaugeModeResolver(resolver: (() => boolean) | undefined): void {
  state.gaugeModeResolver = resolver;
}

/** The latched in-flight gauge mode, or `undefined` before the first inc/dec. */
export function getRedisInflightGaugeMode(): InflightGaugeMode | undefined {
  return state.gaugeMode;
}

/** Test-only: forget the latched gauge mode and the resolver. Never called by app code. */
export function resetRedisInflightGaugeModeForTests(): void {
  state.gaugeMode = undefined;
  state.gaugeModeResolver = undefined;
}

function latchGaugeMode(): InflightGaugeMode {
  let local = false;
  const resolver = state.gaugeModeResolver;
  if (resolver !== undefined) {
    try {
      local = resolver() === true;
    } catch {
      local = false;
    }
  }
  const mode: InflightGaugeMode = local ? 'local' : 'direct';
  state.gaugeMode = mode;
  console.log(`[redis-command-metrics] redis_commands_inflight mode latched: ${mode}`);
  return mode;
}

/**
 * In-flight gauge handle. Mode `local`: integers per `client`, set on the gauge at scrape. Mode
 * `direct`: per-command prom-client inc/dec, as before. The mode is latched at the first call.
 */
export function batchedInflightGauge<L extends string>(gauge: Gauge<L>) {
  let counts = state.gauges.get(gauge);
  if (!counts) {
    const created = new Map<string, number>();
    counts = created;
    state.gauges.set(gauge, created);
    (gauge as unknown as { collect: () => void }).collect = () => {
      // Direct mode: prom-client already holds the value. (Local integers are only ever written in
      // local mode, and the mode never changes, so there is nothing to merge.)
      if (state.gaugeMode !== 'local') return;
      for (const [client, n] of created) gauge.set({ client } as never, n);
    };
  }
  const local = counts;
  return {
    inc(labels: Labels) {
      if ((state.gaugeMode ?? latchGaugeMode()) === 'local') {
        local.set(labels.client, (local.get(labels.client) ?? 0) + 1);
      } else {
        gauge.inc(labels as never);
      }
    },
    dec(labels: Labels) {
      if ((state.gaugeMode ?? latchGaugeMode()) === 'local') {
        local.set(labels.client, (local.get(labels.client) ?? 0) - 1);
      } else {
        gauge.dec(labels as never);
      }
    },
  };
}

type PromHistogramEntry = {
  labels: Record<string, string>;
  bucketValues: Record<number, number>;
  sum: number;
  count: number;
};

function histogramEntry<L extends string>(
  histogram: Histogram<L>,
  client: string
): PromHistogramEntry | undefined {
  const find = () => {
    const map = (histogram as unknown as { hashMap?: Record<string, PromHistogramEntry> }).hashMap;
    if (!map) return undefined;
    for (const key in map) {
      const entry = map[key];
      const names = Object.keys(entry.labels);
      if (names.length === 1 && entry.labels.client === client) return entry;
    }
    return undefined;
  };
  const existing = find();
  if (existing) return existing;
  histogram.zero({ client } as never);
  return find();
}

function flush<L extends string>(histogram: Histogram<L>, hs: HistogramState) {
  if (hs.broken) return;
  try {
    for (const [client, acc] of hs.accs) {
      if (acc.count === 0) continue;
      const entry = histogramEntry(histogram, client);
      if (
        !entry ||
        typeof entry.sum !== 'number' ||
        typeof entry.count !== 'number' ||
        !entry.bucketValues ||
        Object.keys(entry.bucketValues).length !== hs.bounds.length ||
        !hs.bounds.every((b) => typeof entry.bucketValues?.[b] === 'number')
      ) {
        throw new Error('unexpected prom-client histogram layout');
      }
      for (let i = 0; i < hs.bounds.length; i++) {
        if (acc.counts[i]) entry.bucketValues[hs.bounds[i]] += acc.counts[i];
      }
      entry.sum += acc.sum;
      entry.count += acc.count;
      acc.counts.fill(0);
      acc.sum = 0;
      acc.count = 0;
    }
  } catch (err) {
    hs.broken = true;
    console.error('[redis-command-metrics] histogram flush failed; batching disabled:', err);
  }
}

/**
 * Duration histogram handle. `bounds` must be the histogram's own buckets (the caller passes the
 * same constant it registered the histogram with).
 */
export function batchedDurationHistogram<L extends string>(
  histogram: Histogram<L>,
  bounds: readonly number[]
) {
  let hs = state.histograms.get(histogram);
  if (!hs) {
    const created: HistogramState = { bounds: [...bounds], accs: new Map(), broken: false };
    hs = created;
    state.histograms.set(histogram, created);
    (histogram as unknown as { collect: () => void }).collect = () => flush(histogram, created);
  }
  const local = hs;
  return {
    observe(labels: Labels, value: number) {
      if (local.broken || !batchOn() || !Number.isFinite(value)) {
        histogram.observe(labels as never, value);
        return;
      }
      let acc = local.accs.get(labels.client);
      if (!acc) {
        acc = { counts: new Array(local.bounds.length).fill(0), sum: 0, count: 0 };
        local.accs.set(labels.client, acc);
      }
      // prom-client's findBound: the first bound >= value; above the last, no finite bucket (+Inf
      // is derived from count).
      const bounds = local.bounds;
      for (let i = 0; i < bounds.length; i++) {
        if (value <= bounds[i]) {
          acc.counts[i]++;
          break;
        }
      }
      acc.sum += value;
      acc.count++;
    },
  };
}

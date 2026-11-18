'use strict';
/**
 * The pure parts of the image feed benchmark's replay harness (`bench.cjs` here; README.md): what a
 * capture keeps, the open-loop pacing, the latency statistics, the response parity check and the
 * CPU-per-request arithmetic. No I/O: `bench.cjs` supplies the clock, the HTTP client and the files.
 * Unit-tested in `__tests__/lib.test.ts`.
 */

const PROCEDURE = 'image.getImagesAsPostsInfinite';
const PROCEDURE_PATH = `/api/trpc/${PROCEDURE}`;

// --- capture ---------------------------------------------------------------------------------------

/**
 * The capture rows in one Tempo search response (`GET /api/search`): one per matched span whose
 * `http.url` is a single unbatched GET of the procedure. A row keeps ONLY what the replay needs:
 * the span's start (epoch ms), the request host (the domain decides the browsing-level cap), the
 * raw `input` value and the span's duration (the in-situ reference latency). Never the client
 * address, user agent, cookie or user id. A URL carrying an API credential (`token`) or a batch is
 * dropped whole. Duplicate spans (one span can be in several span sets) count once.
 */
function captureRowsFromTempoSearch(json) {
  const rows = [];
  const seen = new Set();
  for (const trace of (json && json.traces) || []) {
    const sets = trace.spanSets || (trace.spanSet ? [trace.spanSet] : []);
    for (const set of sets) {
      for (const span of set.spans || []) {
        if (span.spanID && seen.has(span.spanID)) continue;
        const attr = (span.attributes || []).find((a) => a.key === 'http.url');
        const raw = attr && attr.value && attr.value.stringValue;
        if (!raw) continue;
        let url;
        try {
          url = new URL(raw);
        } catch {
          continue;
        }
        if (url.pathname !== PROCEDURE_PATH) continue;
        if (url.searchParams.has('token') || url.searchParams.has('batch')) continue;
        if (span.spanID) seen.add(span.spanID);
        rows.push({
          t: Number(BigInt(span.startTimeUnixNano) / 1000000n),
          host: url.host,
          input: url.searchParams.get('input') ?? '',
          durMs: Number(span.durationNanos) / 1e6,
        });
      }
    }
  }
  return rows;
}

/** The request path for a capture row: the procedure's URL with its `input`, if it had one. */
function requestPath(row) {
  return row.input ? `${PROCEDURE_PATH}?input=${encodeURIComponent(row.input)}` : PROCEDURE_PATH;
}

// --- pacing ----------------------------------------------------------------------------------------

/**
 * Fire `send(item, index)` for every item at a FIXED rate, open loop: item i is sent at
 * `start + i * 1000 / rps` whether or not earlier requests have answered, so a slow arm cannot slow
 * its own arrival rate down (no coordinated omission). At most `maxInFlight` requests are open at
 * once; an item due while the cap is full is not sent and is recorded as
 * `{ status: 'skipped_overload' }`. Each result carries `lagMs`, how late it was sent against its
 * planned time (a busy harness shows up there, not as arm latency).
 *
 * `now()` returns milliseconds; `sleepUntil(ms)` resolves at (or after) that time.
 */
async function runOpenLoop({ items, rps, send, now, sleepUntil, maxInFlight = Infinity }) {
  if (!(rps > 0)) throw new Error('rps must be > 0');
  const results = new Array(items.length);
  const pending = [];
  let open = 0;
  const start = now();
  for (let i = 0; i < items.length; i++) {
    const planned = start + (i * 1000) / rps;
    await sleepUntil(planned);
    const lagMs = now() - planned;
    if (open >= maxInFlight) {
      results[i] = { status: 'skipped_overload', lagMs };
      continue;
    }
    open++;
    // Called NOW, not on a later microtask, so the request is written at its planned time.
    let sent;
    try {
      sent = Promise.resolve(send(items[i], i));
    } catch (err) {
      sent = Promise.reject(err);
    }
    pending.push(
      sent
        .then(
          (r) => (results[i] = { ...r, lagMs }),
          (err) => (results[i] = { status: 'error', error: String(err && err.message), lagMs })
        )
        .finally(() => open--)
    );
  }
  await Promise.all(pending);
  return results;
}

/** Every arm's order for each round: round r starts at arm r (mod n), so each arm leads once. */
function armOrders(arms, rounds) {
  return Array.from({ length: rounds }, (_, r) => arms.map((_, i) => arms[(r + i) % arms.length]));
}

// --- statistics ------------------------------------------------------------------------------------

/** Nearest-rank percentile of an ASCENDING array (p in 0..100). NaN for an empty array. */
function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** n, min, mean, p50, p95, p99 and max of a list of numbers (any order). */
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = n ? sorted.reduce((s, v) => s + v, 0) / n : NaN;
  return {
    n,
    min: n ? sorted[0] : NaN,
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: n ? sorted[n - 1] : NaN,
  };
}

/**
 * The indexes every arm answered 200: the only requests the latency comparison may use, so an arm
 * that fails (or, for feed-go, falls back) on a hard shape is not credited with skipping it.
 * `byArm` maps arm -> results array (same item order in every arm).
 */
function commonOkIndexes(byArm) {
  const arms = Object.values(byArm);
  if (!arms.length) return [];
  const n = Math.min(...arms.map((r) => r.length));
  const out = [];
  for (let i = 0; i < n; i++) if (arms.every((r) => r[i] && r[i].status === 200)) out.push(i);
  return out;
}

// --- parity ----------------------------------------------------------------------------------------

function typeOf(v) {
  if (v === null) return 'null';
  return Array.isArray(v) ? 'array' : typeof v;
}

function diffJson(a, b, path, out, max) {
  if (out.length >= max) return;
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) {
    out.push({ path, a, b });
    return;
  }
  if (ta === 'array') {
    if (a.length !== b.length) out.push({ path: `${path}.length`, a: a.length, b: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      diffJson(a[i], b[i], `${path}[${i}]`, out, max);
    return;
  }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      if (out.length >= max) return;
      diffJson(a[k], b[k], `${path}.${k}`, out, max);
    }
    return;
  }
  if (!Object.is(a, b)) out.push({ path, a, b });
}

/**
 * Compare two response bodies: byte-identical, JSON-identical (object key order ignored, array
 * order not), and the first `maxDiffs` differing JSON paths (`$.result.data.json.items[0].postId`).
 * A body that is not JSON compares unequal at `$`.
 */
function compareBodies(a, b, { maxDiffs = 10 } = {}) {
  const bytesEqual = a === b;
  let ja;
  let jb;
  try {
    ja = JSON.parse(a);
    jb = JSON.parse(b);
  } catch {
    return { bytesEqual, jsonEqual: bytesEqual, diffs: bytesEqual ? [] : [{ path: '$' }] };
  }
  const diffs = [];
  diffJson(ja, jb, '$', diffs, maxDiffs);
  return { bytesEqual, jsonEqual: diffs.length === 0, diffs };
}

// --- CPU -------------------------------------------------------------------------------------------

/**
 * Container CPU milliseconds per request: the run's CPU seconds less what the container burns idle
 * over the same time (its idle rate, measured over its own window with no requests), divided by the
 * requests sent.
 */
function cpuPerRequestMs({ busyCpuSeconds, busySeconds, idleCpuSeconds, idleSeconds, requests }) {
  if (!(requests > 0) || !(busySeconds > 0) || !(idleSeconds > 0)) return NaN;
  const idleRate = idleCpuSeconds / idleSeconds;
  return ((busyCpuSeconds - idleRate * busySeconds) / requests) * 1000;
}

module.exports = {
  PROCEDURE,
  PROCEDURE_PATH,
  captureRowsFromTempoSearch,
  requestPath,
  runOpenLoop,
  armOrders,
  percentile,
  summarize,
  commonOkIndexes,
  compareBodies,
  cpuPerRequestMs,
};

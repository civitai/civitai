// App Blocks SHARED storage metrics: the op and outcome domains, the one wrapper every shared
// storage operation records through, and the zero-seeding of both series.
//
// Imports the handles from `@civitai/telemetry/client` rather than the `~/server/prom/client`
// shim, for the reason `app-block-storage.metrics.ts` gives: `src/__tests__/setup.ts` replaces
// the shim wholesale, which would leave these untestable against the real registry.
import { TRPCError } from '@trpc/server';
import {
  appSharedStorageLatencyHistogram,
  appSharedStorageOpsCounter,
} from '@civitai/telemetry/client';

/**
 * Every shared storage operation. `apps-shared.router.ts`'s `SharedOp` derives from this, so an
 * op cannot be added there without being seeded here.
 *
 * `getCount` covers both the single-key and the batch read: `apps.shared.getCount`,
 * `apps.shared.getCounts` and `/shared-storage/counts` all run `getSharedCounts`. `list` with
 * `mine` set is still `list`.
 */
export const SHARED_STORAGE_OPS = [
  'list',
  'get',
  'getCount',
  'getTop',
  'append',
  'update',
  'vote',
  'unvote',
  'withdraw',
  'report',
  'increment',
] as const;
export type SharedStorageOp = (typeof SHARED_STORAGE_OPS)[number];

/**
 * What one operation ended in. A refusal that has no outcome of its own lands on the one its
 * tRPC code maps to (see `sharedStorageOutcomeOf`).
 *
 * - `unauthorized` — the block token, its scopes or its subject were refused, or an anonymous
 *   caller tried to write.
 * - `disabled` — the shared storage flag is off for this caller.
 * - `trust_refused` — the account failed the minimum-trust gate for writes.
 * - `forbidden` — an edit of a row the caller did not author.
 * - `rate_limited` — a per-user, per-app rate limit or write budget refused the call.
 * - `moderation_blocked` — content moderation refused the title, body, `data` or counter key.
 * - `moderation_unavailable` — moderation could not run, so the write was refused unchecked.
 * - `payload_too_large` — one value over the per-value byte cap.
 * - `user_row_cap_exceeded` — the caller already has the most rows one user may hold in an app.
 * - `quota_exceeded` — the app's byte or row budget is spent. Shared by every user of the app.
 * - `bad_request` — a counter key or value the server will not accept.
 * - `not_found` — the row does not exist or is hidden.
 * - `error` — anything else, including a database failure.
 */
export type SharedStorageOutcome =
  | 'ok'
  | 'unauthorized'
  | 'disabled'
  | 'trust_refused'
  | 'forbidden'
  | 'rate_limited'
  | 'moderation_blocked'
  | 'moderation_unavailable'
  | 'payload_too_large'
  | 'user_row_cap_exceeded'
  | 'quota_exceeded'
  | 'bad_request'
  | 'not_found'
  | 'error';

/** Reachable under every op: every op resolves the token and can fail. */
const ANY_OP = ['ok', 'unauthorized', 'disabled', 'error'] as const;
/** Reachable under every write: the trust gate and a rate limit run on each of them. */
const ANY_WRITE = [...ANY_OP, 'trust_refused', 'rate_limited'] as const;
const MODERATED_WRITE = ['bad_request', 'moderation_blocked', 'moderation_unavailable'] as const;

/**
 * The outcomes each op can actually produce. Only these pairs are seeded: a seeded pair no code
 * path can move reads as "this never happens" rather than "this cannot happen". The router
 * metrics suite drives every pair here and fails if a call produces one that is not listed.
 */
export const SHARED_STORAGE_REACHABLE_OUTCOMES: {
  readonly [op in SharedStorageOp]: readonly SharedStorageOutcome[];
} = {
  list: ANY_OP,
  get: ANY_OP,
  getCount: ANY_OP,
  getTop: ANY_OP,
  append: [
    ...ANY_WRITE,
    ...MODERATED_WRITE,
    'payload_too_large',
    'user_row_cap_exceeded',
    'quota_exceeded',
  ],
  update: [
    ...ANY_WRITE,
    ...MODERATED_WRITE,
    'payload_too_large',
    'quota_exceeded',
    'not_found',
    'forbidden',
  ],
  vote: [...ANY_WRITE, 'not_found'],
  unvote: ANY_WRITE,
  withdraw: ANY_WRITE,
  report: [...ANY_WRITE, 'not_found'],
  increment: [...ANY_WRITE, ...MODERATED_WRITE],
};

export const SHARED_STORAGE_REACHABLE_SERIES: ReadonlyArray<{
  op: SharedStorageOp;
  outcome: SharedStorageOutcome;
}> = SHARED_STORAGE_OPS.flatMap((op) =>
  SHARED_STORAGE_REACHABLE_OUTCOMES[op].map((outcome) => ({ op, outcome }))
);

/**
 * Outcomes set by the code that refuses, for refusals whose tRPC code alone would be read as a
 * different outcome. Keyed on the error object and never written onto it, so a tag cannot reach
 * a response.
 */
const taggedOutcomes = new WeakMap<object, SharedStorageOutcome>();

/** Records which outcome `err` stands for, and returns it so it can be thrown inline. */
export function tagSharedStorageOutcome<T>(err: T, outcome: SharedStorageOutcome): T {
  if (err !== null && typeof err === 'object') taggedOutcomes.set(err as object, outcome);
  return err;
}

/** The outcome a thrown value stands for: its tag, else its tRPC code, else `error`. */
export function sharedStorageOutcomeOf(err: unknown): SharedStorageOutcome {
  if (err !== null && typeof err === 'object') {
    const tagged = taggedOutcomes.get(err as object);
    if (tagged) return tagged;
  }
  if (!(err instanceof TRPCError)) return 'error';
  switch (err.code) {
    case 'UNAUTHORIZED':
      return 'unauthorized';
    case 'FORBIDDEN':
      return 'forbidden';
    case 'TOO_MANY_REQUESTS':
      return 'rate_limited';
    case 'PAYLOAD_TOO_LARGE':
      return 'payload_too_large';
    case 'BAD_REQUEST':
      return 'bad_request';
    case 'NOT_FOUND':
      return 'not_found';
    default:
      return 'error';
  }
}

/**
 * Runs one shared storage operation and records it: one `ops_total` increment and one latency
 * observation per call, whether it returns or throws. The thrown value is rethrown unchanged.
 *
 * Wraps the exported function of each op in `apps-shared.router.ts`, which both the tRPC
 * procedures and the REST routes call, so each call is recorded once whichever way it arrived.
 * A call refused by its transport before reaching that function (input validation, a missing
 * token on a REST route) is not recorded.
 */
export async function withSharedStorageMetrics<T>(
  op: SharedStorageOp,
  run: () => Promise<T>
): Promise<T> {
  const start = process.hrtime.bigint();
  let outcome: SharedStorageOutcome = 'ok';
  try {
    return await run();
  } catch (err) {
    outcome = sharedStorageOutcomeOf(err);
    throw err;
  } finally {
    // A throw from here would replace the operation's own result or error.
    try {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      appSharedStorageOpsCounter.inc({ op, outcome });
      appSharedStorageLatencyHistogram.observe({ op }, seconds);
    } catch {
      // Losing one sample is acceptable; changing the response is not.
    }
  }
}

/**
 * Zeroes the latency child of each op that has none yet. Never zeroes one that exists:
 * `Histogram.zero` replaces that child's values, and this runs on a scrape, after the pod may
 * already have served calls. See `zeroMissingLatencyChildren` in `app-block-storage.metrics.ts`
 * for the remaining window this leaves.
 */
async function zeroMissingLatencyChildren(): Promise<void> {
  const { values } = await appSharedStorageLatencyHistogram.get();
  const present = new Set(
    values.filter((v) => v.metricName?.endsWith('_count')).map((v) => v.labels.op)
  );
  for (const op of SHARED_STORAGE_OPS) {
    if (!present.has(op)) appSharedStorageLatencyHistogram.zero({ op });
  }
}

/**
 * Publishes every reachable (op, outcome) pair and one latency child per op at 0, so an op no
 * one has called reads as 0 rather than absent. Idempotent; called on every scrape.
 */
export async function seedAppBlockSharedStorageMetrics(): Promise<void> {
  try {
    for (const { op, outcome } of SHARED_STORAGE_REACHABLE_SERIES) {
      appSharedStorageOpsCounter.inc({ op, outcome }, 0);
    }
    // Last, because it is the only step that awaits and so the only one that can reject; the
    // counter series are already published if it does.
    await zeroMissingLatencyChildren();
  } catch {
    // Losing the seed must not cost the scrape.
  }
}

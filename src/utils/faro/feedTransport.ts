import { faro } from '@grafana/faro-web-sdk';
import type { Operation, TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { AppRouter } from '~/server/routers';

/**
 * One Faro `feed_transport` measurement per SAMPLED request of a measured ported feed procedure
 * (`FEED_TRANSPORT_SAMPLE_RATES`): `feed_transport_ms`, context `procedure`, `transport`, `outcome`,
 * `status` on an `http_error` whose status is known, and `sample_rate` when the procedure's rate is
 * below 1 (absent means every request was recorded, i.e. a rate of 1).
 *
 * `transport` is STRUCTURAL: `~/utils/trpc` puts this link inside each branch of its
 * `shouldUseGoTransport` split, so the tag is the link the request left on, never a re-derived
 * predicate. Like-for-like: both arms are GET-sized, unbatched requests. The procedures are in
 * `NEVER_BATCH_PROCEDURES` (`~/utils/trpc`), and the node arm skips a request that would be sent as
 * POST (`skip`), which the go arm can never carry. Not recorded: a signed-out request (it can never take the Go path, so it is in
 * neither arm), an aborted one (a cancel is neither arm's latency), and a request sampled out.
 *
 * Sampling is per request and blind to the transport: each arm's link draws once per request from
 * the same random source against the same per-procedure rate, so both arms are thinned alike and
 * the go/node comparison stays unbiased. Re-weight a count by `1 / sample_rate`.
 */

/**
 * The Go-transport procedures (`GO_TRANSPORT_PROCEDURES` in `~/utils/trpc-go-transport`) this link
 * measures, each with the fraction of its signed-in requests recorded (`(0, 1]`); a subset of that
 * set (trpc-feed-transport-timing.test.ts pins it). The only list of measured procedures. Kept
 * literal because adding a procedure, or raising a rate, is itself a production change: the node
 * arm records `rate` of every signed-in request of it, its Go-transport flag on or off.
 */
export const FEED_TRANSPORT_SAMPLE_RATES: ReadonlyMap<string, number> = new Map([
  ['image.getImagesAsPostsInfinite', 1],
  ['model.getAll', 1],
  ['image.getInfinite', 0.1],
]);

/**
 * Strict `<` with `random` in `[0, 1)`, so the chance is exactly `rate`. Rate 1 skips the draw; a
 * throwing `random` records nothing.
 */
export function feedTransportSampledIn(rate: number, random: () => number): boolean {
  if (rate >= 1) return true;
  try {
    return random() < rate;
  } catch {
    return false;
  }
}

/** Faro measurement type (→ Loki `type=feed_transport`). */
export const FEED_TRANSPORT_MEASUREMENT = 'feed_transport';

export type FeedTransport = 'go' | 'node';
export type FeedTransportOutcome = 'ok' | 'http_error' | 'network_error';

type PushMeasurement = (
  payload: { type: string; values: Record<string, number> },
  options: { skipDedupe: boolean; context: Record<string, string> }
) => void;

/**
 * The outcome of a failed request, from the `TRPCClientError` the http link raised, or `aborted`
 * (not recorded). A response that reached the client is an `http_error` — with its `status` when
 * the client read one: tRPC keeps `meta.response` only when the body parsed, so a non-JSON error
 * page (a proxy's 502) has no status but is still a response (its cause is the parse error).
 * Anything else — no response at all — is a `network_error`.
 */
export function classifyFeedTransportError(
  error: unknown,
  signal?: AbortSignal | null
): { outcome: FeedTransportOutcome | 'aborted'; status?: number } {
  const err = error as
    | {
        meta?: { response?: { status?: unknown } };
        data?: { httpStatus?: unknown } | null;
        cause?: { name?: unknown } | null;
      }
    | null
    | undefined;
  const causeName = typeof err?.cause?.name === 'string' ? err.cause.name : undefined;
  if (signal?.aborted || causeName === 'AbortError') return { outcome: 'aborted' };
  const status = err?.meta?.response?.status ?? err?.data?.httpStatus;
  if (typeof status === 'number' && status > 0) return { outcome: 'http_error', status };
  if (causeName === 'SyntaxError') return { outcome: 'http_error' };
  return { outcome: 'network_error' };
}

export interface FeedTransportTimingOptions {
  transport: FeedTransport;
  /** Whether the browser session is signed in (`isAuthedBrowser` in `~/utils/trpc`). */
  isAuthed: () => boolean;
  /** An operation this arm does not measure (node: `shouldSendQueryAsPost` from `~/utils/trpc`). */
  skip?: (op: Operation) => boolean;
  /** Sampling draw in `[0, 1)`. Default `Math.random`, read per call. */
  random?: () => number;
  /** Milliseconds clock. Default `performance.now`, read per call. */
  now?: () => number;
  /** Faro's `pushMeasurement`. Default: the global Faro's, a no-op until Faro is initialised. */
  pushMeasurement?: PushMeasurement;
}

function defaultPushMeasurement(): PushMeasurement | undefined {
  return faro?.api?.pushMeasurement?.bind(faro.api) as PushMeasurement | undefined;
}

function skipped(skip: FeedTransportTimingOptions['skip'], op: Operation): boolean {
  try {
    return skip?.(op) === true;
  } catch {
    return true;
  }
}

function signedIn(isAuthed: () => boolean): boolean {
  try {
    return isAuthed() === true;
  } catch {
    return false;
  }
}

/**
 * The timing link for ONE transport branch. Passes every other operation straight through; never
 * throws into the request (a telemetry fault is swallowed) and never changes what the next link
 * receives or returns.
 */
export function feedTransportTimingLink(options: FeedTransportTimingOptions): TRPCLink<AppRouter> {
  const { transport, isAuthed } = options;
  const now = options.now ?? (() => performance.now());
  const random = options.random ?? (() => Math.random());
  return () =>
    ({ op, next }) => {
      const rate = FEED_TRANSPORT_SAMPLE_RATES.get(op.path);
      if (
        typeof window === 'undefined' ||
        op.type !== 'query' ||
        rate === undefined ||
        !signedIn(isAuthed) ||
        skipped(options.skip, op) ||
        !feedTransportSampledIn(rate, random)
      ) {
        return next(op);
      }
      return observable((observer) => {
        let start = 0;
        try {
          start = now();
        } catch {
          // Telemetry only.
        }
        let recorded = false;
        const record = (outcome: FeedTransportOutcome, status?: number) => {
          if (recorded) return;
          recorded = true;
          try {
            const push = options.pushMeasurement ?? defaultPushMeasurement();
            if (!push) return;
            const context: Record<string, string> = {
              procedure: op.path,
              transport,
              outcome,
            };
            if (status !== undefined) context.status = String(status);
            if (rate < 1) context.sample_rate = String(rate);
            push(
              { type: FEED_TRANSPORT_MEASUREMENT, values: { feed_transport_ms: now() - start } },
              // skipDedupe: two equal timings are two requests, not one repeated beacon.
              { skipDedupe: true, context }
            );
          } catch {
            // Never let RUM telemetry break a feed request.
          }
        };
        const subscription = next(op).subscribe({
          next(value) {
            record('ok');
            observer.next(value);
          },
          error(err) {
            let classified: ReturnType<typeof classifyFeedTransportError> = {
              outcome: 'network_error',
            };
            try {
              classified = classifyFeedTransportError(err, op.signal);
            } catch {
              // Keep the default.
            }
            if (classified.outcome !== 'aborted') record(classified.outcome, classified.status);
            observer.error(err);
          },
          complete() {
            observer.complete();
          },
        });
        return () => subscription.unsubscribe();
      });
    };
}

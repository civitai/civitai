import { faro } from '@grafana/faro-web-sdk';
import type { TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { AppRouter } from '~/server/routers';
import { GO_TRANSPORT_PROCEDURES } from '~/utils/trpc-go-transport';

/**
 * Real-user latency of the ported feed procedures (`GO_TRANSPORT_PROCEDURES`), per transport, so
 * the Go service and Node can be compared on what users actually wait for across the ramp cohort.
 *
 * WHAT: one Faro measurement per request of a ported procedure —
 *   `type=feed_transport`, value `feed_transport_ms` (link start → result or error), context
 *   `procedure`, `transport` (`go` | `node`), `outcome` (`ok` | `http_error` | `network_error`),
 *   `authed` (`true` | `false`), and `status` on an `http_error` whose status is known.
 *
 * `transport` is STRUCTURAL, not re-derived: `~/utils/trpc` puts this link inside each branch of
 * its `shouldUseGoTransport` split, `go` in the `/api/trpc-go` branch and `node` in the other, so
 * the tag is the link the request left on. `go` means "sent to the Go path"; which service the
 * edge hands it to is the edge's cohort. Requests of the same procedures that stay on `/api/trpc`
 * (flag off, signed out, an input sent as POST) are the `node` arm. `authed` separates the
 * signed-out node traffic, which can never be on the Go path, from the comparable arm.
 *
 * NOT recorded: an aborted request (the query was cancelled; neither arm's latency), any other
 * procedure, anything outside the browser. No input, URL or user value is in the beacon. Volume:
 * the measurement rides Faro's own session sampling and `beforeSend` scrub; `skipDedupe` keeps two
 * identical timings from being collapsed into one by Faro's consecutive-payload dedupe.
 *
 * WHERE IT LANDS — a Faro measurement is a `kind=measurement` logfmt line on the faro-rum stream:
 * `type=feed_transport value_feed_transport_ms=<ms> context_procedure=<p> context_transport=<t>
 * context_outcome=<o> context_authed=<a>`, plus the session's `session_attr_exp_feed_go_*` cohort
 * (`~/utils/faro/experimentFlags`).
 */

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
  /** Milliseconds clock. Default `performance.now`, read per call. */
  now?: () => number;
  /** Faro's `pushMeasurement`. Default: the global Faro's, a no-op until Faro is initialised. */
  pushMeasurement?: PushMeasurement;
}

function defaultPushMeasurement(): PushMeasurement | undefined {
  return faro?.api?.pushMeasurement?.bind(faro.api) as PushMeasurement | undefined;
}

/**
 * The timing link for ONE transport branch. Passes every other operation straight through; never
 * throws into the request (a telemetry fault is swallowed) and never changes what the next link
 * receives or returns.
 */
export function feedTransportTimingLink(options: FeedTransportTimingOptions): TRPCLink<AppRouter> {
  const { transport, isAuthed } = options;
  const now = options.now ?? (() => performance.now());
  return () =>
    ({ op, next }) => {
      if (
        typeof window === 'undefined' ||
        op.type !== 'query' ||
        !GO_TRANSPORT_PROCEDURES.has(op.path)
      ) {
        return next(op);
      }
      return observable((observer) => {
        let start = 0;
        let authed = 'false';
        try {
          start = now();
          authed = String(isAuthed() === true);
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
              authed,
            };
            if (status !== undefined) context.status = String(status);
            push(
              { type: FEED_TRANSPORT_MEASUREMENT, values: { feed_transport_ms: now() - start } },
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

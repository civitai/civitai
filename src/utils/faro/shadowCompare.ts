import { faro } from '@grafana/faro-web-sdk';
import {
  devalueAnswerDiff,
  firstDiffPath,
  withoutReferentialEqualities,
  type ShadowDiff,
} from '~/utils/faro/shadowCompareDiff';
import { GO_TRANSPORT_PROCEDURES, GO_TRANSPORT_URL } from '~/utils/trpc-go-transport';
import { claimShadowCompareSlot } from '~/utils/trpc-shadow-compare';

/**
 * Client shadow compare: for a query the `clientShadowCompare` cohort sends, the CONTROL leg is the
 * request the app would have sent anyway, and a CANDIDATE leg asks another route the same question
 * at the same moment. The app gets the control leg's response, untouched. Once both settle, one Faro
 * `shadow_compare` measurement says whether the two raw response texts were byte-identical, apart
 * from superjson's `meta.referentialEqualities`, which the Go service never writes
 * (`withoutReferentialEqualities`). Two devalue answers (`result.data` a devalue string: an answer
 * that is not edge-cacheable) are compared by their decoded values instead (`devalueAnswerDiff`).
 *
 * Raw text, before any parsing: a transformer round trip can hide a difference a client would see
 * (key order, number formatting, an extra field the parser drops). Both legs start together, so
 * data that changes between two sequential calls does not read as a mismatch.
 *
 * The beacon carries the verdict, the procedure, the candidate's id, both byte lengths, both
 * latencies, both HTTP statuses, who answered the candidate request (`candidate_served_by`), and
 * on a mismatch where the texts first differ as a path of keys and indices. Never a response body, a value from one, the request URL (it carries the input) or
 * an error message.
 */

export type ShadowVerdict =
  | 'match'
  | 'mismatch'
  | 'candidate_error'
  | 'candidate_timeout'
  | 'candidate_fallback'
  | 'control_error';

/** One leg's answer: its HTTP status and the response body exactly as received. */
export type ShadowLegResponse = {
  status: number;
  text: string;
  /**
   * The candidate did not produce this answer itself (it handed the request back to the old route's
   * backend). Compared bytes would then be the old route's own, so the compare is
   * `candidate_fallback`, never `match` or `mismatch`.
   */
  fallback?: boolean;
  /** Who answered, as the candidate reports it. Beaconed; keep it to a few fixed values. */
  servedBy?: string;
  /** The edge cache's verdict on this leg (`edgeCacheStatus`); absent when the edge sent none. */
  cacheStatus?: string;
};

/**
 * The edge cache's verdict header. A signed-out answer is edge-cacheable on both legs' paths, each
 * its own cache entry, so either leg can be an older stored copy of a feed that has moved since: a
 * signed-out compare is evidence about the Go service only when neither leg was served from the
 * cache. Both legs' verdicts are beaconed (`control_cache`, `candidate_cache`) for that filter.
 */
export const EDGE_CACHE_STATUS_HEADER = 'cf-cache-status';

const EDGE_CACHE_STATUSES = new Set([
  'hit',
  'miss',
  'expired',
  'stale',
  'updating',
  'revalidated',
  'dynamic',
  'bypass',
]);

/** A cache verdict as a fixed low-cardinality value: lowercased, `other` when unknown, `undefined` when absent. */
export function edgeCacheStatus(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const v = value.trim().toLowerCase();
  return EDGE_CACHE_STATUSES.has(v) ? v : 'other';
}

/** The control leg's request as it was sent, for a candidate to ask the same question. */
export type ShadowCandidateRequest = {
  procedure: string;
  /** The control leg's URL; for a GET query it carries the encoded input. */
  controlUrl: string;
  /** The control leg's init: method and headers (credentials ride the same-origin cookie). */
  controlInit: RequestInit;
  /** Aborts on the candidate timeout and when the control leg is cancelled. */
  signal: AbortSignal;
};

/**
 * The pluggable leg: `createShadowCompareFetch` takes any implementation. Today the only one is
 * `goTransportCandidate`.
 */
export interface ShadowCandidate {
  /** Beaconed as `candidate`. Low-cardinality and stable: it is how compares are grouped. */
  readonly id: string;
  /** Whether this candidate can answer `procedure` at all. */
  supports(procedure: string): boolean;
  /** One request, no retries. Rejecting (or a non-2xx status) is a `candidate_error`. */
  send(request: ShadowCandidateRequest): Promise<ShadowLegResponse>;
}

const CONTROL_PATH_PREFIX = /^((?:https?:\/\/[^/?#]+)?)\/api\/trpc\//;

/** The Go service names who answered each request; only `go` is its own answer. */
export const GO_SERVED_HEADER = 'x-feed-go-served';

function goServedBy(value: string | null): string {
  if (value === null) return 'absent';
  return value === 'go' || value === 'node' ? value : 'other';
}

/**
 * The same query over the Go transport path (`GO_TRANSPORT_URL`): the control URL with its
 * `/api/trpc/` prefix swapped, so input encoding and headers are the control leg's own. Anything but
 * `go` in `GO_SERVED_HEADER` is a fallback: `node` when the Go service proxied it, absent when no
 * route sent it to the Go service at all (the app's own rewrite answered).
 */
export const goTransportCandidate: ShadowCandidate = {
  id: 'go-transport',
  supports: (procedure) => GO_TRANSPORT_PROCEDURES.has(procedure),
  async send({ controlUrl, controlInit, signal }) {
    if (!CONTROL_PATH_PREFIX.test(controlUrl)) throw new Error('not a tRPC query URL');
    const url = controlUrl.replace(CONTROL_PATH_PREFIX, `$1${GO_TRANSPORT_URL}/`);
    const response = await globalThis.fetch(url, { ...controlInit, signal });
    const servedBy = goServedBy(response.headers.get(GO_SERVED_HEADER));
    const cacheStatus = edgeCacheStatus(response.headers.get(EDGE_CACHE_STATUS_HEADER));
    return {
      status: response.status,
      text: await response.text(),
      fallback: servedBy !== 'go',
      servedBy,
      ...(cacheStatus === undefined ? {} : { cacheStatus }),
    };
  },
};

/** Faro measurement type (→ Loki `type=shadow_compare`). */
export const SHADOW_COMPARE_MEASUREMENT = 'shadow_compare';

/** A candidate that has not answered by then is a `candidate_timeout` and is aborted. */
export const SHADOW_CANDIDATE_TIMEOUT_MS = 10_000;

type PushMeasurement = (
  payload: { type: string; values: Record<string, number> },
  options: { skipDedupe: boolean; context: Record<string, string> }
) => void;

export type ShadowCompareFetchOptions = {
  procedure: string;
  candidate: ShadowCandidate;
  /** Default `SHADOW_CANDIDATE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Milliseconds clock. Default `performance.now`, read per call. */
  now?: () => number;
  /** Faro's `pushMeasurement`. Default: the global Faro's, a no-op until Faro is initialised. */
  pushMeasurement?: PushMeasurement;
  /**
   * `signed_out` for a signed-out browser's compare, beaconed as `viewer`; absent (a signed-in
   * compare, as every compare was before the signed-out cohort existed) beacons none.
   */
  viewer?: 'signed_out';
};

type ShadowFetch = (input: RequestInfo | URL | string, init?: RequestInit) => Promise<Response>;

type Leg =
  | { ok: true; response: ShadowLegResponse; ms: number }
  | { ok: false; status?: number; ms: number };

/** A response outside 2xx is that leg's error, compared by status only. */
function legOf(response: ShadowLegResponse, ms: number): Leg {
  return response.status >= 200 && response.status < 300
    ? { ok: true, response, ms }
    : { ok: false, status: response.status, ms };
}

function defaultPushMeasurement(): PushMeasurement | undefined {
  return faro?.api?.pushMeasurement?.bind(faro.api) as PushMeasurement | undefined;
}

async function sameBytes(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): Promise<boolean> {
  if (a.byteLength !== b.byteLength) return false;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const [hashA, hashB] = await Promise.all([
    subtle.digest('SHA-256', a),
    subtle.digest('SHA-256', b),
  ]);
  const viewA = new Uint8Array(hashA);
  const viewB = new Uint8Array(hashB);
  for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
  return true;
}

/**
 * The `fetch` for the control leg's `httpLink`. When the page load's compare cap allows, it sends
 * the control request and the candidate's together and returns the control response itself;
 * otherwise it is plain `fetch`. Nothing the candidate does reaches the returned promise.
 */
export function createShadowCompareFetch(options: ShadowCompareFetchOptions): ShadowFetch {
  const { procedure, candidate } = options;
  const timeoutMs = options.timeoutMs ?? SHADOW_CANDIDATE_TIMEOUT_MS;
  const now = options.now ?? (() => performance.now());

  return (input, init) => {
    let supported = false;
    try {
      supported = candidate.supports(procedure) === true;
    } catch {
      // An unsupported candidate.
    }
    if (!supported || !claimShadowCompareSlot()) {
      return globalThis.fetch(input, init);
    }

    const start = now();
    const controlSignal = init?.signal ?? undefined;
    const controlPromise = globalThis.fetch(input, init);

    const controlLeg: Promise<Leg> = controlPromise.then(
      async (response): Promise<Leg> => {
        try {
          // A clone, so the app's response body is never touched.
          const text = await response.clone().text();
          const cacheStatus = edgeCacheStatus(response.headers?.get(EDGE_CACHE_STATUS_HEADER));
          return legOf(
            cacheStatus === undefined
              ? { status: response.status, text }
              : { status: response.status, text, cacheStatus },
            now() - start
          );
        } catch {
          return { ok: false, status: response.status, ms: now() - start };
        }
      },
      (): Leg => ({ ok: false, ms: now() - start })
    );

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onControlAbort = () => controller.abort();
    controlSignal?.addEventListener('abort', onControlAbort, { once: true });

    const candidateLeg: Promise<Leg> = (async (): Promise<Leg> => {
      try {
        const response = await candidate.send({
          procedure,
          controlUrl:
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          controlInit: init ?? {},
          signal: controller.signal,
        });
        return legOf(response, now() - start);
      } catch {
        return { ok: false, ms: now() - start };
      } finally {
        clearTimeout(timer);
        controlSignal?.removeEventListener('abort', onControlAbort);
      }
    })();

    void settle(controlLeg, candidateLeg, () => timedOut, controlSignal, options).catch(() => {
      // Telemetry only.
    });

    return controlPromise;
  };
}

async function settle(
  controlLeg: Promise<Leg>,
  candidateLeg: Promise<Leg>,
  timedOut: () => boolean,
  controlSignal: AbortSignal | undefined,
  options: ShadowCompareFetchOptions
) {
  const [control, candidate] = await Promise.all([controlLeg, candidateLeg]);
  // A cancelled query is neither leg's answer.
  if (controlSignal?.aborted) return;

  const encoder = new TextEncoder();
  const controlBytes = control.ok ? encoder.encode(control.response.text) : undefined;
  const candidateBytes = candidate.ok ? encoder.encode(candidate.response.text) : undefined;

  let verdict: ShadowVerdict;
  let diff: ShadowDiff | undefined;
  if (!control.ok || !controlBytes) verdict = 'control_error';
  else if (timedOut()) verdict = 'candidate_timeout';
  else if (!candidate.ok || !candidateBytes) verdict = 'candidate_error';
  else if (candidate.response.fallback === true) verdict = 'candidate_fallback';
  else if (await sameBytes(controlBytes, candidateBytes)) verdict = 'match';
  else {
    // Two devalue answers (not edge-cacheable: both writers send devalue) are compared by value.
    const devalueDiff = devalueAnswerDiff(control.response.text, candidate.response.text);
    if (devalueDiff === null) verdict = 'match';
    else if (devalueDiff) {
      verdict = 'mismatch';
      diff = devalueDiff;
    } else {
      const controlText =
        withoutReferentialEqualities(control.response.text) ?? control.response.text;
      const candidateText =
        withoutReferentialEqualities(candidate.response.text) ?? candidate.response.text;
      if (controlText === candidateText) verdict = 'match';
      else {
        verdict = 'mismatch';
        diff = firstDiffPath(controlText, candidateText);
      }
    }
  }

  const push = options.pushMeasurement ?? defaultPushMeasurement();
  if (!push) return;

  const values: Record<string, number> = {
    control_ms: control.ms,
    candidate_ms: candidate.ms,
  };
  if (controlBytes) values.control_bytes = controlBytes.byteLength;
  if (candidateBytes) values.candidate_bytes = candidateBytes.byteLength;

  const context: Record<string, string> = {
    procedure: options.procedure,
    candidate: options.candidate.id,
    verdict,
  };
  const controlStatus = control.ok ? control.response.status : control.status;
  const candidateStatus = candidate.ok ? candidate.response.status : candidate.status;
  if (controlStatus !== undefined) context.control_status = String(controlStatus);
  if (candidateStatus !== undefined) context.candidate_status = String(candidateStatus);
  if (candidate.ok && candidate.response.servedBy !== undefined) {
    context.candidate_served_by = candidate.response.servedBy;
  }
  if (options.viewer) context.viewer = options.viewer;
  if (control.ok && control.response.cacheStatus)
    context.control_cache = control.response.cacheStatus;
  if (candidate.ok && candidate.response.cacheStatus) {
    context.candidate_cache = candidate.response.cacheStatus;
  }
  if (diff) {
    context.diff_path = diff.path;
    context.diff_kind = diff.kind;
  }

  // skipDedupe: two equal compares are two requests, not one repeated beacon.
  push({ type: SHADOW_COMPARE_MEASUREMENT, values }, { skipDedupe: true, context });
}

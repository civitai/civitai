import { faro } from '@grafana/faro-web-sdk';

export const BOUNDARY_ERROR_TYPE = 'react-error-boundary';

/**
 * Where the error was caught. Rides along as a Faro context field so the stream is segmentable
 * by boundary. Deliberately a CLOSED set — add a member when another boundary adopts this
 * reporter, so the context values stay a known vocabulary rather than free text.
 */
export type BoundaryName = 'root' | 'user';

type ReportOptions = {
  boundary: BoundaryName;
  componentStack?: string | null;
};

export type ReportDeps = {
  pushError?: (error: Error, opts: { type: string; context: Record<string, string> }) => void;
  post?: typeof fetch;
};

/**
 * Report an error caught by a React error boundary to BOTH sinks, independently.
 *
 * 🔴 The two sinks are not redundant — they cover DIFFERENT failure shapes, which is why
 * each gets its own try/catch and neither can suppress the other:
 *
 *  - **Faro** (`pushError`) reaches the RUM stream our frontend error alerting watches, but
 *    only once `FaroProvider` has mounted. It is the sink for a crash on a client-side
 *    navigation, where the SDK is already live.
 *  - **`POST /api/application-error`** (→ Axiom) is a plain server endpoint and needs no client
 *    state at all. It is the only sink that survives a crash on the FIRST render, where
 *    `FaroProvider` — which lives inside `_app`'s returned JSX — never mounted.
 *
 * Measured on the regression fixed in #4867: a throw in `_app`'s own render body produced no
 * report on EITHER sink, and none server-side either — the server branch still rendered fine, so
 * nothing anywhere recorded it. Keep both sinks, and keep them independent.
 */
export function reportBoundaryError(
  error: Error,
  { boundary, componentStack }: ReportOptions,
  deps: ReportDeps = {}
) {
  // `stack` is REQUIRED as a string by the endpoint's zod schema. `componentStack` is
  // `string | null` on React's ErrorInfo, and an absent key makes `schema.parse` throw →
  // the endpoint answers 400 and the report is silently lost. Coerce, never pass through.
  const stack = componentStack ?? error.stack ?? '';

  try {
    const pushError = deps.pushError ?? faro?.api?.pushError?.bind(faro.api);
    pushError?.(error, {
      type: BOUNDARY_ERROR_TYPE,
      context: { boundary: String(boundary) },
    });
  } catch {
    // Reporting must never break the fallback render, and must never stop the POST below.
  }

  try {
    const post = deps.post ?? (typeof fetch === 'function' ? fetch : undefined);
    // NOTE: deliberately NO `Content-Type: application/json`. The handler does
    // `JSON.parse(req.body)`, so it needs the RAW string — Next's body parser would hand it a
    // already-parsed object for an application/json request and `JSON.parse` would then throw.
    void post?.('/api/application-error', {
      method: 'POST',
      body: JSON.stringify({ message: error.message, stack, name: error.name }),
    })?.catch(() => {
      // Offline / blocked / aborted. Nothing to do; Faro above may still have carried it.
    });
  } catch {
    // `fetch` missing entirely (SSR, very old browser).
  }
}

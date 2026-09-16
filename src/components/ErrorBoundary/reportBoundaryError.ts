import { faro } from '@grafana/faro-web-sdk';
import { reportApplicationError } from '~/utils/application-error';

/** Where the error was caught. Rides along as a Faro context field so the stream is segmentable. */
export type BoundaryName = 'root' | 'user' | 'game';

type ReportOptions = {
  boundary: BoundaryName;
  componentStack?: string | null;
};

export type ReportDeps = {
  pushError?: (error: Error, opts: { context: Record<string, string> }) => void;
  report?: typeof reportApplicationError;
};

/**
 * Report an error caught by a React error boundary to BOTH sinks, independently.
 *
 * The two sinks are not redundant — they reach different consumers:
 *  - **Faro** (`pushError`) puts it in the RUM stream our frontend error alerting watches. No
 *    boundary reached that stream before this helper existed; the only `pushError` call site was
 *    the Meili search client.
 *  - **`reportApplicationError`** (→ `/api/application-error` → Axiom, and the server-side log
 *    line our log alerting watches) is the pre-existing path, kept because it is what those
 *    alerts read.
 *
 * Each gets its own `try`/`catch` so neither can suppress the other.
 *
 * 🔴 **Do NOT pass a `name` to `reportApplicationError` here.** The endpoint defaults an absent
 * `name` to the literal `application-error`, and log-based alerting keys off that value — so
 * setting any `name` silently moves these reports into a different population. Every other caller
 * does pass one and is therefore already in that other population by design, which is exactly why
 * following the convention here looks harmless and is not. The boundary identity travels in
 * `message` instead, and in the Faro `context` below. Changing this requires changing the alert
 * queries in the infrastructure repo in the same breath — details deliberately live there, not in
 * this public repo.
 */
export function reportBoundaryError(
  error: unknown,
  { boundary, componentStack }: ReportOptions,
  deps: ReportDeps = {}
) {
  try {
    const pushError = deps.pushError ?? faro?.api?.pushError?.bind(faro.api);
    // 🔴 No `type:` — Faro core resolves `type: type || error.name || <default>`, so passing one
    // REPLACES the error class, and `~/utils/faro/classifyException` keys its `chunkload` and
    // `meili` rules off that field. Tagging these would make a boundary-caught ChunkLoadError
    // classify as a real app error: it would inflate the general JS-error-rate alert and drop out
    // of the chunk-load one. The boundary identity goes in `context`, which is the field the
    // classifier and the dashboards actually query.
    pushError?.(error instanceof Error ? error : new Error(String(error)), {
      context: { boundary },
    });
  } catch {
    // Reporting must never break the fallback render, and must never stop the report below.
  }

  try {
    const report = deps.report ?? reportApplicationError;
    // `reportApplicationError` normalizes a non-Error throw, prefixes `message`, coerces the
    // stack to a string and swallows its own rejection — so none of that is repeated here.
    // Passing `componentStack` as `stack` is what it documents the field for.
    report(error, {
      message: `error boundary: ${boundary}`,
      ...(componentStack ? { stack: componentStack } : {}),
    });
  } catch {
    // `fetch` missing entirely (SSR, very old browser).
  }
}

import {
  FEEDBACK_CONSOLE_ERROR_MAX_COUNT,
  FEEDBACK_CONSOLE_ERROR_MAX_LENGTH,
  FEEDBACK_NETWORK_ERROR_MAX_COUNT,
  FEEDBACK_NETWORK_INITIATOR_MAX_LENGTH,
  FEEDBACK_NETWORK_URL_MAX_LENGTH,
} from '~/shared/constants/feedback.constants';
import { redactText, redactValue } from '~/utils/faro/redact';

/**
 * A bounded, redacted, in-memory snapshot of what the reporter's browser complained about, read at
 * submit time by `useFeedbackSubmission` and stored on `Feedback.context`.
 *
 * ─── WHY A SNAPSHOT RATHER THAN A QUERY ───────────────────────────────────────────────────────
 * The moderator queue already shows a Faro `sessionId` and a Grafana deep link, and both are
 * useless for triage on anything but a fresh report: `faroSessionLink()` returns null past
 * `FARO_LOKI_RETENTION_HOURS` (72 h), so every row in the queue today has a suppressed link. An
 * in-page panel that queried Loki for console/network detail would inherit the same wall. Writing
 * the data into the report makes it permanent and independent of retention. Accepted, stated
 * consequence: rows written before this shipped gain nothing — this helps NEW reports only.
 *
 * 🔴 AND THE SNAPSHOT IS NOT MERELY A RETENTION-PROOF COPY OF WHAT LOKI HOLDS — FOR CONSOLE TEXT
 * IT IS THE ONLY COPY THERE HAS EVER BEEN. `FaroProvider` runs an explicit instrumentation
 * allow-list and DELIBERATELY EXCLUDES the Console instrumentation ("serialises arbitrary logged
 * objects") and the stock Performance instrumentation ("emits full resource URLs"). So a
 * `console.error` — which is how React reports a render error, a hydration mismatch or a failed
 * boundary — has never reached Loki at any age, and failed-request URLs reach it only as coarse
 * route-normalised timings behind two flags, or as ~10 %-sampled OTel fetch spans. Only uncaught
 * exceptions ride `ErrorsInstrumentation`. Two consequences worth holding on to:
 *   1. this module is ADDITIVE, not redundant — do not "simplify" it away by pointing at Faro; and
 *   2. it is a genuinely NEW collection surface, so it is held to the privacy bar that kept those
 *      instrumentations switched off, not to the lower bar of an existing debug field.
 *
 * ─── WHAT IS DELIBERATELY NOT CAPTURED ────────────────────────────────────────────────────────
 * · Request and response BODIES, and headers. On this platform a body can hold a payment payload,
 *   a prompt, or another user's content. Nothing here reads one.
 * · STACK TRACES. Only an error's `message`. A stack is mostly bundle paths, it blows the length
 *   bound on its own, and its frames add no triage signal a moderator can act on that the message
 *   and the URL do not already carry.
 * · `console.warn` / `console.log` / `console.info`. Errors only — the rest is an order of
 *   magnitude more volume and is where incidental user data actually lives.
 * · STATUS-0 REQUESTS, i.e. genuine network-layer failures (offline, DNS, CORS). See the mechanism
 *   note below: they are indistinguishable from an ordinary opaque cross-origin success, so
 *   recording them would show a moderator "failures" that never happened.
 *
 * ─── MECHANISM, AND THE ONE THING IT REFUSES TO DO ────────────────────────────────────────────
 * 🔴 `fetch` IS NOT PATCHED, AND THAT IS A DECISION, NOT AN OVERSIGHT. Wrapping global `fetch`
 * would give complete coverage — every 4xx/5xx plus the network-layer throws named above, in every
 * browser. It would also put code written for a triage convenience directly in the request path of
 * every page view on the site, where a defect is a site outage rather than a missing log line.
 * Network capture is therefore PASSIVE ONLY: a `PerformanceObserver` over `resource` entries,
 * reading `responseStatus`. An observer cannot alter, delay or fail a request.
 *
 * What that costs, named rather than hidden:
 *   · `PerformanceResourceTiming.responseStatus` is not universally implemented. Where it is
 *     absent, NOTHING is captured and the field is simply omitted — the same "absence is ordinary"
 *     shape `getFaroSessionId` uses, never an error.
 *   · A cross-origin response without `Timing-Allow-Origin` reports `responseStatus: 0`, which is
 *     the SAME observable as a real network failure. Only `>= 400` is recorded, so both are
 *     dropped. Under-reporting is the safe direction; a fabricated failure is not.
 *
 * Console capture DOES wrap `console.error`, which is the only way to see it at all. The wrapper
 * delegates to the captured original FIRST and does its own work inside a `try`, so the worst
 * available failure is a lost buffer entry, never a lost log line or a thrown error.
 *
 * ─── EVERY STRING IS REDACTED AND CLIPPED ON THE WAY IN, NOT ON THE WAY OUT ───────────────────
 * The buffers hold only sanitized values. That bounds memory, and it means a `read*` call cannot
 * be the thing that forgets to redact. `feedbackContextSchema` REJECTS an over-long value rather
 * than clipping it, so clipping here is not belt-and-braces — it is what keeps an over-long
 * console line from failing the whole submission on the surface that exists to collect reports.
 */

export type FeedbackNetworkError = {
  url: string;
  status: number;
  initiatorType: string;
};

/**
 * Keeps the LAST `capacity` items. The last few errors before someone gives up and files a report
 * are the ones describing what they gave up on; the first few are usually page-load noise.
 */
class RingBuffer<T> {
  private items: T[] = [];
  constructor(private readonly capacity: number) {}
  push(item: T) {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }
  read(): T[] {
    return [...this.items];
  }
  clear() {
    this.items = [];
  }
}

const consoleBuffer = new RingBuffer<string>(FEEDBACK_CONSOLE_ERROR_MAX_COUNT);
const networkBuffer = new RingBuffer<FeedbackNetworkError>(FEEDBACK_NETWORK_ERROR_MAX_COUNT);

/**
 * How many `console.error` arguments are formatted. A cap rather than the whole list because the
 * result is clipped to one bounded string anyway, so arguments past the first few cannot reach the
 * stored value — and formatting them is work done inside somebody's error path for nothing.
 */
const MAX_CONSOLE_ARGS = 4;

/**
 * One `console.error` argument as text.
 *
 * An `Error` contributes `name: message` and NOT `.stack` — see the "deliberately not captured"
 * list. Anything else is JSON where that works and `String()` where it does not (a circular
 * structure, a throwing getter, a BigInt): this runs inside an error path, so it must not be able
 * to add a second error to the first.
 */
function formatConsoleArg(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value === null || value === undefined || typeof value !== 'object') return String(value);
    const json = JSON.stringify(value);
    // `JSON.stringify` returns undefined for a function or a lone symbol.
    return typeof json === 'string' ? json : String(value);
  } catch {
    try {
      return String(value);
    } catch {
      // A `Symbol` throws on String(), and an object with a throwing `toString` reaches here too.
      return '[unserializable]';
    }
  }
}

/** The formatted arguments of one `console.error` call, space-joined as the console shows them. */
export function formatConsoleArgs(args: readonly unknown[]): string {
  return args.slice(0, MAX_CONSOLE_ARGS).map(formatConsoleArg).join(' ');
}

/**
 * Redact, then clip. `''` when there is nothing worth keeping, which the callers treat as "do not
 * record" rather than as an empty entry.
 *
 * 🔴 THE ORDER IS LOAD-BEARING AND IS PINNED BY A TEST. Clipping first can cut a JWT or a signed
 * URL in half, leaving a fragment that no longer matches the pattern that would have removed it —
 * so the stored value would carry the front half of the secret. Redacting first cannot do that.
 *
 * `redactText` (not `redactValue`) because a console message is genuine free text, which is the
 * one context where the long-opaque-token heuristic is safe to apply — the same routing
 * `deepRedact` uses for `message` / `stack` keys.
 */
export function sanitizeConsoleMessage(raw: string): string {
  if (typeof raw !== 'string') return '';
  const redacted = redactText(raw).trim();
  return redacted.slice(0, FEEDBACK_CONSOLE_ERROR_MAX_LENGTH);
}

/**
 * A captured request URL with its query string and fragment removed, or `null` if it must not be
 * stored at all.
 *
 * 🔴 STRIPPING THE QUERY IS THE POINT OF THIS FUNCTION, and it is the same rule `FeedbackDrawer`
 * already applies to `context.path`: this platform routes secrets through query strings
 * (`/redeem-code?code=…`, `/payment/coinbase?key=…`, signed S3 URLs, OAuth callbacks), and
 * `context` is a JSONB column with no retention policy. A failed request to one of those would
 * otherwise write a live credential into a moderator-readable column, permanently, without ever
 * telling the reporter.
 *
 * 🔴 NON-http(s) SCHEMES ARE REFUSED ENTIRELY rather than stripped. A `data:` resource entry IS
 * its own payload — there is no query string to remove, the whole URL is the content, and it can
 * be megabytes. `blob:` is refused alongside it: same shape, and it is already the spelling the
 * moderator's `IMAGE_KEY` guard treats as hostile.
 *
 * The surviving `origin + pathname` still goes through `redactValue` (the structural-leaf scrub:
 * emails, JWTs, embedded URLs) because a path can carry an email — `/user/someone@example.com`.
 * `redactValue` rather than `redactText` so the long-token heuristic does not corrupt a legitimate
 * long id or content hash in a path segment, which is exactly the routing `deepRedact` documents.
 */
export function sanitizeNetworkUrl(raw: string, base?: string): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.search = '';
    url.hash = '';
    const scrubbed = redactValue(url.toString()).trim();
    if (!scrubbed) return null;
    return scrubbed.slice(0, FEEDBACK_NETWORK_URL_MAX_LENGTH);
  } catch {
    // A relative URL with no base, or anything else `new URL` refuses. Storing a value we could
    // not parse means storing a value we could not strip a query off, so store nothing.
    return null;
  }
}

/** Record one already-raw console message. Exported for the recorder and for tests. */
export function recordConsoleError(raw: string) {
  const message = sanitizeConsoleMessage(raw);
  if (!message) return;
  consoleBuffer.push(message);
}

/**
 * Record one failed request.
 *
 * Returns nothing and swallows everything: `status` outside 4xx/5xx, an unusable URL, a missing
 * `initiatorType`. The schema's `status` bound is `400..599`, so a value this function let through
 * unfiltered would fail the reporter's whole submission rather than log a wrong number.
 *
 * 🔴 `status` IS TYPED `number` AND IS ROUTINELY `undefined` AT RUNTIME, which is why the check is
 * `Number.isInteger` rather than a range comparison. `PerformanceResourceTiming.responseStatus` is
 * declared `number` by the DOM lib but is unimplemented in some browsers, and this is the ONE
 * place that fact is handled — the observer deliberately carries no second guard of its own.
 * A bare `status < 400 || status > 599` would let `undefined` through both comparisons as `false`.
 */
export function recordNetworkError(input: {
  url: string;
  status: number;
  initiatorType?: string;
  base?: string;
}) {
  if (!Number.isInteger(input.status) || input.status < 400 || input.status > 599) return;
  const url = sanitizeNetworkUrl(input.url, input.base);
  if (!url) return;
  networkBuffer.push({
    url,
    status: input.status,
    initiatorType: String(input.initiatorType ?? 'other').slice(
      0,
      FEEDBACK_NETWORK_INITIATOR_MAX_LENGTH
    ),
  });
}

/** The console errors to attach to a submission, oldest first. Already redacted and clipped. */
export const readConsoleErrors = (): string[] => consoleBuffer.read();

/** The failed requests to attach to a submission, oldest first. Already redacted and clipped. */
export const readNetworkErrors = (): FeedbackNetworkError[] => networkBuffer.read();

/** Drop everything. For tests, and for a caller that wants a clean slate. */
export function resetBrowserErrorLog() {
  consoleBuffer.clear();
  networkBuffer.clear();
}

// Module + window guards make install idempotent across React StrictMode's double-mount and
// Next.js Fast Refresh, where module state resets but the patched `console` persists — the same
// shape `FaroProvider` uses for `initializeFaro`.
let installed = false;
const WINDOW_GUARD_KEY = '__civitaiBrowserErrorLogInstalled__';

/**
 * Start recording. Idempotent, never throws, and a no-op outside a browser.
 *
 * Returns an uninstall function that restores `console.error` and detaches every listener — used
 * by tests, and the honest thing to hand back for a patch of a global.
 */
export function installBrowserErrorLog(): () => void {
  const noop = () => undefined;
  if (typeof window === 'undefined') return noop;
  const guarded = window as unknown as Record<string, unknown>;
  if (installed || guarded[WINDOW_GUARD_KEY]) return noop;
  installed = true;
  guarded[WINDOW_GUARD_KEY] = true;

  const teardown: Array<() => void> = [];

  // ── console.error ────────────────────────────────────────────────────────────────────────────
  // 🔴 THE ORIGINAL IS CALLED FIRST AND UNCONDITIONALLY. Everything this wrapper adds happens
  // after the delegation, inside a `try`, so a defect here can lose a buffer entry and nothing
  // else. It must never swallow a log line or throw into somebody's error path.
  try {
    const original = window.console?.error;
    if (typeof original === 'function') {
      const patched = function (this: unknown, ...args: unknown[]) {
        const result = original.apply(this, args);
        try {
          recordConsoleError(formatConsoleArgs(args));
        } catch {
          // A console call must not be able to fail because of the recorder.
        }
        return result;
      };
      window.console.error = patched as typeof window.console.error;
      teardown.push(() => {
        // Only restore if nothing else has patched over us since; clobbering a later wrapper
        // (React DevTools, Next's overlay) is worse than leaving ours in place.
        if (window.console.error === patched) window.console.error = original;
      });
    }
  } catch {
    // A locked-down `console` (some embedded webviews) — carry on without console capture.
  }

  // ── uncaught errors and rejections ───────────────────────────────────────────────────────────
  // Passive listeners. These are the ones `ErrorsInstrumentation` also sees; they are recorded
  // anyway because the snapshot has to stand on its own when Faro is not running — which is every
  // dev, preview and ad-blocked session, and is precisely when someone is filing a bug report.
  try {
    const onError = (event: ErrorEvent) => {
      try {
        // A resource load failure (`<img>`, `<script>`) also raises `error` on window, with an
        // empty message and the element as the target. The PerformanceObserver below is the
        // instrument for those; an empty string here would be a blank buffer entry.
        if (event?.message) recordConsoleError(event.message);
      } catch {
        // Never let a listener throw.
      }
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      try {
        const reason = event?.reason;
        recordConsoleError(
          `Unhandled rejection: ${
            reason instanceof Error ? `${reason.name}: ${reason.message}` : formatConsoleArg(reason)
          }`
        );
      } catch {
        // Never let a listener throw.
      }
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    teardown.push(() => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    });
  } catch {
    // No `addEventListener` — nothing to do.
  }

  // ── failed requests, passively ───────────────────────────────────────────────────────────────
  // `buffered: true` replays the entries already in the resource-timing buffer, so installing this
  // after the first paint still sees the page-load failures that a reporter is most likely to be
  // filing about.
  try {
    if (typeof PerformanceObserver === 'function') {
      const observer = new PerformanceObserver((list) => {
        try {
          for (const entry of list.getEntries()) {
            const resource = entry as PerformanceResourceTiming;
            // 🔴 NO FEATURE DETECT HERE, DELIBERATELY. `responseStatus` is `undefined` at runtime
            // in a browser that does not implement it — the DOM lib types it as `number`
            // regardless, so TypeScript is no help — and `recordNetworkError` already refuses a
            // non-integer status. A `typeof … !== 'number'` guard on this line was written first
            // and then REMOVED: mutation-testing it showed it could not be killed, because every
            // input that reaches it is rejected one call later by the other guard anyway. One
            // rule, one place; `recordNetworkError`'s own test covers the `undefined` case.
            recordNetworkError({
              url: resource.name,
              status: resource.responseStatus,
              initiatorType: resource.initiatorType,
              base: window.location?.href,
            });
          }
        } catch {
          // Never let the observer callback throw.
        }
      });
      observer.observe({ type: 'resource', buffered: true });
      teardown.push(() => observer.disconnect());
    }
  } catch {
    // `type`-style observe is unsupported, or resource timing is unavailable.
  }

  return () => {
    for (const undo of teardown) {
      try {
        undo();
      } catch {
        // Best effort — carry on tearing the rest down.
      }
    }
    installed = false;
    delete guarded[WINDOW_GUARD_KEY];
  };
}

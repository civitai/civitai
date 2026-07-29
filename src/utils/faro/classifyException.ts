/**
 * Deterministic client-exception CLASSIFICATION for Faro RUM beacons.
 *
 * WHY THIS EXISTS: Faro captures ~26k JS exceptions/3h on civitai-dp-prod, but a live triage
 * showed ~75% is non-actionable noise (request aborts, ad-blocker/3p script blocks, opaque
 * cross-origin `Script error.`, browser-extension-injected errors, transient network blips) plus
 * expected business-logic (insufficient Buzz, blocked prompt, generation temporarily
 * unavailable). That noise inflates the RUM "JS error rate", buries real app bugs, and makes
 * exception-rate alerting flap. This module classifies each exception at INGEST (`beforeSend`) so:
 *   - KNOWN-benign noise is DROPPED (never sent), and
 *   - the rest is TAGGED (`error_category`) so the dashboard/alerts can split
 *     bizlogic / chunkload / meili from the real-app-bug stream (`real`).
 *
 * This is PURE and unit-tested (`__tests__/classifyException.test.ts`) and is composed INTO the
 * Faro `beforeSend` pipeline AFTER `deepRedact` (redaction still runs on every beacon).
 *
 * 🔴 SAFETY — CONSERVATIVE ALLOWLIST. The DROP set is an explicit allowlist of KNOWN-benign
 * patterns. A pattern must match one of the enumerated shapes to be dropped; ANYTHING unmatched
 * falls through to `real` and is KEPT. A false drop hides a real bug, so every ambiguous case
 * errs toward keeping. Never widen a DROP rule to a broad substring that could match a genuine
 * error (e.g. do not drop on the bare word "aborted" or "failed").
 *
 * TAGGING SURFACE (VERIFIED against the Alloy faro.receiver source): the returned category is
 * written by the caller onto the exception payload's `context` map (`ExceptionContext`,
 * `Record<string,string>`). Alloy's `Exception.KeyVal()` does
 * `MergeKeyValWithPrefix(kv, KeyValFromMap(e.Context), "context_")`, so
 * `context.error_category = "real"` lands in Loki as the logfmt field **`context_error_category`**
 * — the exact same mechanism that puts a measurement's `context_route` / a web-vital's
 * `context_largest_shift_target` into Loki. So a per-EXCEPTION category is reliably queryable.
 */

/** Faro exception-payload shape this classifier reads (subset of ExceptionEventDefault). */
export interface ClassifiableStackFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
}
export interface ClassifiableException {
  /** Exception type, e.g. `TypeError`, `AbortError`, `UnhandledRejection`, `TRPCClientError`. */
  type?: string;
  /** Exception message / value. */
  value?: string;
  /** Parsed stack frames (Faro `stacktrace.frames`). */
  stacktrace?: { frames?: ClassifiableStackFrame[] };
}

/**
 * Result of classifying one exception.
 *   - `drop: true`  → caller returns `null` from `beforeSend` (beacon not sent). KNOWN-benign only.
 *   - `drop: false` → keep the beacon and tag `context.error_category = category`.
 *
 * `category` values:
 *   - noise subtypes (only present WITH `drop:true`): `abort`, `adblock`, `autoplay`,
 *     `script_error`, `injected`, `network` — the reason it was dropped (useful if you ever want
 *     to TAG-instead-of-DROP by flipping the caller; not sent to Loki while dropped).
 *   - keep-and-tag: `bizlogic`, `chunkload`, `meili`.
 *   - default keep: `real`.
 */
export type ErrorCategory =
  | 'abort'
  | 'adblock'
  | 'autoplay'
  | 'script_error'
  | 'injected'
  | 'network'
  | 'bizlogic'
  | 'chunkload'
  | 'meili'
  | 'real';

export interface Classification {
  drop: boolean;
  category: ErrorCategory;
}

const KEEP = (category: ErrorCategory): Classification => ({ drop: false, category });
const DROP = (category: ErrorCategory): Classification => ({ drop: true, category });

// ── DROP allowlist patterns (each an EXPLICIT, narrow match) ──────────────────────────────────

// Request aborts — user/navigation/media aborts, never a bug.
const ABORT_VALUE_RES = [
  /\bThe user aborted a request\b/i,
  /\bThe play\(\) request was interrupted by a call to pause\(\)/i,
  /\bThe fetching process for the media resource was aborted\b/i,
  /\bThe operation was aborted\b/i,
  /\bsignal is aborted without reason\b/i,
];
// UnhandledRejection variants for Next.js route-change aborts.
const ROUTECHANGE_ABORT_RES = [
  /\bnextjs route change aborted\b/i,
  /\brouteChange aborted\b/i,
];

// Ad-blocker / third-party script load failures. Matched ONLY inside the explicit
// "Failed to load script" shape OR against known ad-network hosts/globals — never a bare host
// substring on an arbitrary message.
const SCRIPT_LOAD_FAIL_RE = /Failed to load script/i;
const ADBLOCK_HOST_RES = [
  /securepubads/i,
  /cdn\.snigelweb\.co/i,
  /adengine\.snigelw/i,
  /\bgoogletag\b/i,
  /doubleclick/i,
  /adsbygoogle/i,
];

// Autoplay policy — the browser blocked programmatic play(). Not a bug.
const AUTOPLAY_RE = /\bThe play method is not allowed by the user agent\b/i;

// Opaque cross-origin script error (no usable message/stack). Exact-ish match only.
const SCRIPT_ERROR_RE = /^Error:\s*Script error\.?$/i;

// Transient network failures with NO app frame. Matched as the WHOLE message only (anchored),
// so a real error that merely CONTAINS "Failed to fetch" in a larger sentence is NOT dropped.
const BARE_NETWORK_VALUE_RES = [
  /^(?:TypeError:\s*)?Failed to fetch$/i,
  /^(?:TypeError:\s*)?NetworkError when attempting to fetch resource\.?$/i,
  /^(?:TypeError:\s*)?Load failed$/i,
];

// ── KEEP-and-TAG patterns ─────────────────────────────────────────────────────────────────────

// Expected business-logic user states surfaced as TRPCClientError. NOT bugs, but money-path
// signal — keep and tag `bizlogic`.
const BIZLOGIC_VALUE_RES = [
  /\binsufficientBuzz\b/i,
  /\bGeneration services are temporarily unavailable\b/i,
  /\bPrompt blocked as it may violate TOS\b/i,
  /\bPrompt requires mature content but workflow does not allow it\b/i,
];

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

function anyMatch(res: RegExp[], text: string): boolean {
  return res.some((re) => re.test(text));
}

/**
 * True iff the stack has frames AND every frame is an "injected" frame — i.e. `filename` is
 * empty / `undefined` (the literal string the parser emits for extension/inline-eval frames,
 * e.g. `undefined:1705:541`) and references no project source. If ANY frame references a real
 * source (a `turbopack://`/`webpack://` scheme, an `http(s)://…/_next/…` bundle, a `.ts`/`.tsx`/
 * `.js`/`.mjs` filename, or anything that isn't the empty/`undefined` sentinel), it is NOT
 * treated as injected → the exception is KEPT. Conservative: an empty/absent frame list is NOT
 * injected (we can't prove it, so we keep).
 */
function isInjectedOnlyStack(exc: ClassifiableException): boolean {
  const frames = exc.stacktrace?.frames;
  // Guard against a malformed (non-array) `frames` — treat as "not injected-only" so an odd
  // payload shape can never force a DROP. Classification must FAIL OPEN (keep), never closed.
  if (!Array.isArray(frames) || frames.length === 0) return false;
  return frames.every((f) => isInjectedFrame(f));
}

function isInjectedFrame(frame: ClassifiableStackFrame): boolean {
  const filename = (frame.filename ?? '').trim();
  // The Faro/error-stack parser renders a frame with no resolvable script URL as the literal
  // string "undefined" (seen in prod as `undefined:1705:541`) — or leaves it empty. Either is an
  // injected/extension/eval frame with no project source.
  if (filename === '' || filename.toLowerCase() === 'undefined') return true;
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────────────────────

/**
 * Classify one Faro exception. PURE — no I/O, never throws (callers run it in a try/catch anyway,
 * but this is defensive). Returns `{ drop, category }`:
 *   - `drop:true`  → the exception matched a KNOWN-benign allowlist pattern → not actionable.
 *   - `drop:false` → keep; `category` is the tag to write to `context.error_category`.
 *
 * Order matters: DROP allowlist is checked FIRST (so an aborted media fetch that would also look
 * like a network error is dropped as `abort`), then the keep-and-tag rules, then default `real`.
 */
export function classifyException(exc: ClassifiableException | null | undefined): Classification {
  if (!exc) return KEEP('real');

  const type = (exc.type ?? '').trim();
  const value = (exc.value ?? '').trim();
  // Some Faro exceptions carry the type only in the message (e.g. `AbortError: ...`). Match
  // against both the type and a `type + ": " + value` composite so a pattern anchored on the
  // message form still fires. We keep matching CONSERVATIVE (explicit patterns only).
  const typed = type ? `${type}: ${value}` : value;

  // 1) DROP — request aborts (AbortError family + route-change aborts). Gated on the ABSENCE of a
  //    project-source stack frame (same guard the network DROP uses): the abort phrases are the
  //    only unanchored substring matches, so a genuine app error whose message merely CONTAINS
  //    "The operation was aborted" but carries a `turbopack://` app frame must be KEPT, not dropped.
  const abortMatch =
    anyMatch(ABORT_VALUE_RES, value) ||
    anyMatch(ABORT_VALUE_RES, typed) ||
    anyMatch(ROUTECHANGE_ABORT_RES, value) ||
    anyMatch(ROUTECHANGE_ABORT_RES, typed);
  if (abortMatch && !hasProjectSourceFrame(exc)) return DROP('abort');

  // 2) DROP — ad-blocker / third-party script-load failures. Require BOTH the "Failed to load
  //    script" shape AND a known ad-network host/global, so a real "Failed to load script" for a
  //    FIRST-party bundle is NOT dropped (it would be a genuine deploy/asset bug).
  if (
    (SCRIPT_LOAD_FAIL_RE.test(value) || SCRIPT_LOAD_FAIL_RE.test(typed)) &&
    anyMatch(ADBLOCK_HOST_RES, `${value} ${typed}`)
  ) {
    return DROP('adblock');
  }

  // 3) DROP — autoplay policy block.
  if (AUTOPLAY_RE.test(value) || AUTOPLAY_RE.test(typed)) return DROP('autoplay');

  // 4) DROP — opaque cross-origin `Error: Script error.` (no usable message/stack).
  if (SCRIPT_ERROR_RE.test(value) || SCRIPT_ERROR_RE.test(typed)) return DROP('script_error');

  // 5) DROP — browser-extension / injected error whose stack has ONLY `undefined:`/empty frames
  //    (no project source frame). If ANY frame references project source, this does NOT match.
  if (isInjectedOnlyStack(exc)) return DROP('injected');

  // 6) DROP — bare transient network failure with no useful app stack. The value must be the
  //    WHOLE anchored network message AND the stack must carry no project-source frame (else it's
  //    a real fetch bug in our code we want to see).
  if (
    (anyMatch(BARE_NETWORK_VALUE_RES, value) || anyMatch(BARE_NETWORK_VALUE_RES, typed)) &&
    !hasProjectSourceFrame(exc)
  ) {
    return DROP('network');
  }

  // 7) KEEP+TAG — expected business-logic (TRPCClientError user states).
  if (anyMatch(BIZLOGIC_VALUE_RES, value) || anyMatch(BIZLOGIC_VALUE_RES, typed)) {
    return KEEP('bizlogic');
  }

  // 8) KEEP+TAG — stale-bundle chunk load (deploy-health signal).
  if (/ChunkLoadError/i.test(type) || /ChunkLoadError/i.test(typed)) return KEEP('chunkload');

  // 9) KEEP+TAG — MeiliSearch backend blips (search correlation signal).
  if (/MeiliSearchCommunicationError/i.test(type) || /MeiliSearchCommunicationError/i.test(typed)) {
    return KEEP('meili');
  }

  // 10) Default — a real app-bug candidate. KEEP and tag `real`.
  return KEEP('real');
}

/**
 * True iff the stack has at least one frame that references PROJECT SOURCE (a `turbopack://` /
 * `webpack://` scheme, a `_next/` bundle URL, or a JS/TS source filename). Used to guard the
 * "bare network" DROP: a `Failed to fetch` with a real app frame is a bug in OUR fetch code and
 * must be KEPT. Conservative — anything that looks like real source counts.
 */
function hasProjectSourceFrame(exc: ClassifiableException): boolean {
  const frames = exc.stacktrace?.frames;
  // Guard against a malformed (non-array) `frames`. This is used to PROTECT real errors from a
  // DROP, so on an unknown shape we return `false` (no known project frame) — but because the
  // DROP rules that consult it also require an anchored/known message match, an odd shape can
  // still never manufacture a drop on its own. Fails open at the classifyException level too.
  if (!Array.isArray(frames) || frames.length === 0) return false;
  return frames.some((f) => {
    if (isInjectedFrame(f)) return false;
    const filename = (f.filename ?? '').trim();
    if (!filename) return false;
    return (
      /^(?:turbopack|webpack):\/\//i.test(filename) ||
      /\/_next\//i.test(filename) ||
      /\.(?:tsx?|jsx?|mjs|cjs)(?:[?#:]|$)/i.test(filename)
    );
  });
}

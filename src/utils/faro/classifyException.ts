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
 *     bizlogic / chunkload / meili / extension / ad_initiated from the real-app-bug stream
 *     (`real`).
 *
 * 🔴 PREFER TAGGING TO DROPPING for anything still under investigation. A dropped beacon is never
 * sent, so no later question can be asked of it — the saving is ingest volume, and the cost is
 * permanent. Every consumer selects `context_error_category="real"`, so a non-`real` tag already
 * cleans the real-app-bug stream without giving up the data. `ad_initiated` (rule 6b) is the
 * worked example: it was built as a DROP and deliberately changed to a tag.
 *
 * This is PURE and unit-tested (`__tests__/classifyException.test.ts`) and is composed INTO the
 * Faro `beforeSend` pipeline BEFORE `deepRedact` — it sees the RAW payload, and the tag it returns
 * is written onto the scrubbed clone afterwards. (`processBeacon` in
 * `src/components/Faro/FaroProvider.tsx` calls `classifyException(item.payload)` and only then
 * `scrubBeacon`, which is what runs `deepRedact`.) Redaction still runs on every beacon that
 * ships. 🔴 This line said AFTER until 2026-10-05 and that was wrong in the direction that
 * matters, because it is the claim deciding whether redaction can rewrite a literal a pattern
 * matches: the answer is no, classification runs first. The note above
 * `EXTENSION_OBJECT_PATH_RES` already said "pre-redact" and the two contradicted each other.
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
 *   - keep-and-tag: `bizlogic`, `chunkload`, `meili`, `extension`, `ad_initiated`.
 *   - default keep: `real`.
 *
 * 🔴 `adblock` and `ad_initiated` are BOTH about ad/analytics traffic and are NOT the same thing.
 * `adblock` is a DROP category (rule 2: an ad script failed to LOAD). `ad_initiated` is a KEEP
 * category (rule 6b: an ad script's own fetch failed). Deliberately two names, because one name
 * meaning both "never sent" and "sent and queryable" would wreck a reader's model of this module.
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
  | 'extension'
  | 'ad_initiated'
  | 'real';

export interface Classification {
  drop: boolean;
  category: ErrorCategory;
}

const KEEP = (category: ErrorCategory): Classification => ({ drop: false, category });
const DROP = (category: ErrorCategory): Classification => ({ drop: true, category });

// ── DROP allowlist patterns (each an EXPLICIT, narrow match) ──────────────────────────────────

// Request aborts — user/navigation/media aborts, never a bug.
//
// 🔴 PHRASING FAMILIES, not one message per cause. Chromium emits a DIFFERENT sentence for each
// reason a `play()` promise was superseded, and each is enumerated here rather than collapsed to
// a `The play() request was interrupted` prefix: the module header forbids widening a DROP to a
// broad substring, and the reason clause is what distinguishes a benign supersede from anything
// else that might one day share the prefix. Measured live over 6h (bot-filtered, category
// `real`): `…by a call to pause()` was already listed, while `…because the media was removed
// from the document` (251, with and without the trailing `https://goo.gl/LdLk22` help URL) and
// `…because video-only background media was paused to save power` (85) fell through to `real`.
// Chromium has at least one further reason clause (`…by a new load request`) that did not appear
// in the window; add phrasings as they are MEASURED rather than pre-emptively.
const ABORT_VALUE_RES = [
  /\bThe user aborted a request\b/i,
  /\bThe play\(\) request was interrupted by a call to pause\(\)/i,
  /\bThe play\(\) request was interrupted because the media was removed from the document\b/i,
  /\bThe play\(\) request was interrupted because video-only background media was paused to save power\b/i,
  /\bThe fetching process for the media resource was aborted\b/i,
  /\bThe operation was aborted\b/i,
  /\bsignal is aborted without reason\b/i,
];

// Abort phrasings that are too SHORT to be safe as unanchored substrings. `Fetch is aborted`
// (Firefox, 111 measured) and `BodyStreamBuffer was aborted` (Chromium, 32) are a few words each,
// so as substrings they could sit inside a genuine app sentence ("Model fetch is aborted by the
// retry budget"). The abort rule's `!hasProjectSourceFrame` conjunct would not save such an error
// when its stack carries no project frame at all — a thrown string, or a stack of only dependency
// frames — so these are matched as the WHOLE message instead. The optional `SomeError: ` prefix
// covers the message-only form (no separate `type` field), exactly as the network patterns do.
const ABORT_ANCHORED_VALUE_RES = [
  /^(?:[A-Za-z]+Error:\s*)?Fetch is aborted\.?$/i,
  /^(?:[A-Za-z]+Error:\s*)?BodyStreamBuffer was aborted\.?$/i,
];
// UnhandledRejection variants for Next.js route-change aborts.
const ROUTECHANGE_ABORT_RES = [/\bnextjs route change aborted\b/i, /\brouteChange aborted\b/i];

// Ad-blocker / third-party script load failures. Matched ONLY inside the explicit
// "Failed to load script" shape OR against known ad-network hosts/globals — never a bare host
// substring on an arbitrary message.
//
// 🔴 THESE ARE MESSAGE FINGERPRINTS, NOT HOSTS, and are NOT interchangeable with rule 6b's
// `AD_NETWORK_FRAME_HOST_RES`. They are matched as unanchored substrings against a MESSAGE, and
// two of them (`googletag`, `adsbygoogle`) are JS globals rather than hosts at all. As a host
// matcher this list would be actively wrong in both directions: `/\bgoogletag\b/` does not match
// `googletagmanager.com` (no word boundary before the `m`), while `/doubleclick/` matches both
// `notdoubleclick.net` and `doubleclick.net.example.com`. A newly measured ad DOMAIN belongs in
// rule 6b's list; a new message fingerprint belongs here.
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
//
// 🔴 THIS RULE HAS NO SECOND CONJUNCT. Unlike the abort (rule 1) and network (rule 6) DROPs it
// does not consult the stack at all — a message match alone discards the beacon, app frames and
// all. So the second phrasing added here is matched as the WHOLE anchored message rather than as
// a substring: Chromium's `play() can only be initiated by a user gesture.` (222 measured) is a
// complete sentence, and anchoring means an app error that merely quotes it is still KEPT.
const AUTOPLAY_RE = /\bThe play method is not allowed by the user agent\b/i;
const AUTOPLAY_GESTURE_RE =
  /^(?:[A-Za-z]+Error:\s*)?play\(\) can only be initiated by a user gesture\.?$/i;
// 🔴 DELIBERATELY NOT MATCHED, and the reason is the whole point of the anchoring above:
// `NotAllowedError: The request is not allowed by the user agent or the platform in the current
// context, possibly because the user denied permission.` (30 measured) is the SAME error type and
// nearly the same sentence, but it is a user PERMISSION denial (camera/microphone/clipboard), not
// an autoplay block — and a permission prompt our code should not have been showing IS a real
// bug. `The play method is not allowed…` vs `The request is not allowed…` is the only difference
// between a drop and a kept bug, so neither pattern may be relaxed toward the other. A test pins
// that this variant stays `real`.

// Opaque cross-origin script error (no usable message/stack). Exact-ish match only.
const SCRIPT_ERROR_RE = /^Error:\s*Script error\.?$/i;

// Transient network failures with NO app frame. Matched as the WHOLE message only (anchored),
// so a real error that merely CONTAINS "Failed to fetch" in a larger sentence is NOT dropped.
//
// 🔴 DO NOT READ THE `TypeError:` PREFIX AS A TYPE FILTER — it does not exclude other error
// classes, and getting this backwards is easy. Rules 6 and 6b test BOTH `value` and the
// `type + ': ' + value` composite, so for a `TRPCClientError` whose message is `Failed to fetch`
// the composite does NOT match (the prefix permits only `TypeError:`) but the bare `value` DOES.
// Those beacons are therefore fully eligible for both DROP rules and survive on the FRAME
// conjunct alone. That matters because they are a distinct measured population: over three
// adjacent 6h windows on 2026-09-30 (`client_class!="bot"`, `context_error_category="real"`)
// `TRPCClientError: Failed to fetch` ran 448–460 per window, and every one sampled was a
// two-frame stack of our own minified chunks with NO foreign frame at any position — so nothing
// in the beacon attributes it to a third party and it is deliberately left as `real`.
const BARE_NETWORK_VALUE_RES = [
  /^(?:TypeError:\s*)?Failed to fetch$/i,
  /^(?:TypeError:\s*)?NetworkError when attempting to fetch resource\.?$/i,
  /^(?:TypeError:\s*)?Load failed$/i,
];

// ── KEEP-and-TAG patterns ─────────────────────────────────────────────────────────────────────

// Expected business-logic user states surfaced as TRPCClientError. NOT bugs, but money-path
// signal — keep and tag `bizlogic`.
// 🔴 `Your prompt was flagged` is a PREFIX, not a whole message: the server builds it as
// `Your prompt was flagged: ${error.blockedFor.join(', ')}` (and a `green`-currency variant
// appends a two-newline redirect hint after that), so the suffix is an open set of moderation
// reasons — `breasts` (45) and `Inappropriate minor content` (44) were the top two in the
// measured window. It is therefore anchored at the START and left open at the end. Anchoring is
// what makes the prefix safe rather than the wording: an app error that merely CONTAINS the
// sentence mid-message is kept. The colon is deliberately NOT part of the pattern, because two
// live components already treat the colon-less sentence as the marker
// (`message?.startsWith('Your prompt was flagged')`) — matching them keeps one definition of what
// a flagged-prompt message is, rather than a second, stricter one only this module knows about.
//
// `The prompt has been blocked due to mature content…` (21) is the `green`/SFW-model rewrite of
// the `Prompt requires mature content but workflow does not allow it` message already listed
// above — same user state, different sentence, and the tail (`…which is not supported by the
// current model`) is left unmatched so a reworded tail cannot make this pattern go inert.
const BIZLOGIC_VALUE_RES = [
  /\binsufficientBuzz\b/i,
  /\bGeneration services are temporarily unavailable\b/i,
  /\bPrompt blocked as it may violate TOS\b/i,
  /\bPrompt requires mature content but workflow does not allow it\b/i,
  /^(?:[A-Za-z]+Error:\s*)?Your prompt was flagged\b/i,
  /\bThe prompt has been blocked due to mature content\b/i,
];

// Browser-extension / page-injected-global errors. Extensions reference globals that only exist
// when the injection ran, so touching them throws in every OTHER browser — measured live on
// civitai-dp-prod (24h): `Can't find variable: __firefox__` 1,380×, `undefined is not an object
// (evaluating 'window.__firefox__.<prop>')` ~2,100×, `window.ethereum.selectedAddress = …`
// ~2,300/day, `Can't find variable: DarkReader` 132×. Not app bugs — but TAGGED (`extension`)
// and KEPT rather than dropped: the alerts/dashboards count `context_error_category=real`, so
// re-tagging cleans the real-bug signal while the raw stream stays queryable. Unlike the
// `injected` DROP above, this is message-evidence based: these land in `real` precisely because
// their stacks carry app frames or no stack at all.
//
// 🔴 Two engine phrasing families name these errors and BOTH must be matched — a one-phrasing
// matcher returned a confident zero for a whole error class. Bare globals: `Can't find variable:
// X` vs `X is not defined`. Property access: the `undefined is not an object (evaluating '…')`
// clause carries the object PATH, while V8's `Cannot read properties of … (reading '…')` omits
// the base object entirely — so the only V8 property-access case attributable from the message
// is a READ of a denylisted NAME.
//
// 🔴 DELIBERATELY NOT matched: any name outside the denylist (`downProgCallback`,
// `syncDownloadState`, `jQuery`, `JSZip`, `goog`, `MOBILE`, `require`, `selector` are live
// examples that may be app code), and the generic `Cannot read properties of undefined
// (reading 'M_ID')` shape — the dominant real-bug message shape in this stream. A bare global
// tags only when its name is EXACTLY one of these (case-sensitive, like the identifiers).
const EXTENSION_INJECTED_GLOBALS: readonly string[] = ['__firefox__', 'DarkReader', '__alhWeb'];

// Bare-global ReferenceError, both engine phrasings. The optional `SomeError: ` prefix covers
// the message-only form (no separate `type` field). Anchored, so an app error that merely
// CONTAINS an injected global's name mid-message does not tag.
const EXTENSION_BARE_GLOBAL_RES = [
  /^(?:[A-Za-z]+Error:\s*)?Can't find variable: (\w+)\.?$/i,
  /^(?:[A-Za-z]+Error:\s*)?(\w+) is not defined\.?$/i,
];

// Property-access on an injected object. The evaluating clause carries the object path as a
// substring, so match the stable path prefix — never the segment after it: an injected property
// name can be an opaque ≥32-char token that `redact.ts` rewrites to `[redacted-token]` in the
// shipped beacon (`window.__firefox__.[redacted-token]` is a real Loki value). Classification
// runs pre-redact and sees the raw segment; keying on the path prefix matches both spellings.
//
// 🔴 `window.ethereum` REQUIRES `.selectedAddress`, and the narrowing is not cosmetic. This was
// the only DROP-or-TAG predicate in the module that was an unanchored substring with NO second
// conjunct, and it fires BY DESIGN on beacons that carry app frames (rule 7 runs after every DROP
// and is reached precisely because the stack looks like ours). `viem` and `@coinbase/cdp-sdk` are
// live dependencies, so the day a wallet connector ships, `window.ethereum.*` becomes APP code
// and every genuine failure in it would be re-tagged away from `real` — a silently narrowed
// real-bug stream, which is the direction the header forbids. `.selectedAddress` is the injected
// read that actually occurs (the extension defines the property, our code would not read it), and
// requiring it loses NOTHING: measured over the same window, 0 of 364 `window.ethereum` hits
// referenced any other property.
const EXTENSION_OBJECT_PATH_RES = [
  /\(evaluating ['"]window\.__firefox__/i,
  /\(evaluating ['"]window\.ethereum\.selectedAddress\b/i,
  // V8's property-access phrasing omits the base object, so a denylisted READ name is the only
  // message evidence V8 property access can carry.
  /\(reading ['"](?:__firefox__|DarkReader|__alhWeb)['"]\)/i,
];

// Extensions that name THEMSELVES in the message rather than throwing on an injected global.
// `Failed to connect to MetaMask` (206 measured) arrives with a MINIFIED `type` (`i`), so the type
// field carries no information and the match must be on the VALUE. Anchored at the start and left
// open at the end: MetaMask appends varying detail, but a mid-message occurrence is not evidence.
//
// `Window message "chrome: call method" timed out.` is the same shape, named by its API rather
// than its brand — Chrome's extension-messaging wording. Verified on `origin/main` across BOTH
// the tracked tree and the installed dependency tree: three spellings of the phrase, 0 matches
// each, against a positive control that does match — so nothing we ship emits it. Measured over
// 96.3h (2026-10-01T18:20Z → 2026-10-05T18:40Z, non-bot): 1,727 of 76,470 `real` exceptions —
// 2.26%, hourly share p50 1.33% and max 21.11% — uniformly `browser_name=Chrome`, and no sampled
// beacon carried a stack frame. ⚠️ Read that last one carefully: it is partly a property of the
// FILTER, not only of the population, because the sample was drawn from `error_category="real"`
// and rule 5 has already removed every injected-only stack from that stream.
//
// WHY IT IS WORTH MATCHING: it was the dominant single contributor to the worst client
// error-breadth reading in the window, and excluding it moves that metric's MAX by 36.9% while
// moving its p99 by only 3.5%. So this buys alert stability, not ingest volume. (Breadth
// thresholds and the alerting identity are deliberately not recorded here — public repo.)
//
// 🔴 ONE CHARACTER DIFFERS FROM THE SIBLING'S PREFIX — `*` here, `+` above — and the reason is
// NARROWER than it looks, so do not restate it from memory. The measured shape (`type: 'Error'`,
// value = the bare phrase) tags under EITHER spelling via the `value` arm, because the prefix
// group is optional; `+` would NOT have lost the production population. What `*` additionally
// covers is the message-only form `Error: <phrase>` carrying no separate `type`, which `+` cannot
// match since it requires a letter before `Error`. And note what is NOT the reason: the `typed`
// composite arm cannot decide the outcome for ANY pattern on this array, since an optional prefix
// group already subsumes it — contrast `SCRIPT_ERROR_RE`, whose MANDATORY `Error:` prefix is
// exactly why the `value`/`typed` pair exists at all. The MetaMask sibling stays at `+`: no such
// form has been measured for it, and this file adds patterns from measurement, not symmetry.
//
// The straight double quotes are the measured spelling and are load-bearing — a smart-quote or
// single-quote variant makes this pattern inert (failing SAFE, the beacon stays `real`, but
// silently). `EXTENSION_OBJECT_PATH_RES` above writes `['"]` because two ENGINES quote that
// clause differently; here only Chrome emits the sentence, so one spelling is matched until
// another is measured.
//
// This is a KEEP+TAG, never a DROP — deliberately, and the asymmetry matters if a first-party
// wallet connector ever ships. A mis-tag is recoverable (the beacon is still in Loki, queryable
// by `context_error_category="extension"`); a mis-drop is not, because the beacon was never sent.
const EXTENSION_MESSAGE_RES = [
  /^(?:[A-Za-z]+Error:\s*)?Failed to connect to MetaMask\b/i,
  /^(?:[A-Za-z]*Error:\s*)?Window message "chrome: call method" timed out\b/i,
];

function isExtensionInjectedError(value: string, typed: string): boolean {
  for (const re of EXTENSION_BARE_GLOBAL_RES) {
    for (const text of [value, typed]) {
      const m = re.exec(text);
      if (m && EXTENSION_INJECTED_GLOBALS.includes(m[1])) return true;
    }
  }
  if (anyMatch(EXTENSION_MESSAGE_RES, value) || anyMatch(EXTENSION_MESSAGE_RES, typed)) return true;
  return anyMatch(EXTENSION_OBJECT_PATH_RES, value) || anyMatch(EXTENSION_OBJECT_PATH_RES, typed);
}

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

// ── What counts as PROJECT SOURCE ────────────────────────────────────────────────────────────
//
// 🔴 These three exclusions exist because a `Failed to fetch` stack is NOT built from the
// awaiting code — the browser captures the SYNCHRONOUS CALL STACK at the moment `fetch()` is
// invoked. So every layer that sits between the caller and the network appears on EVERY fetch
// rejection, whoever initiated it. A frame that is present unconditionally carries no
// attribution signal and must not be read as "our fetch code failed".
//
// 🔴 BEFORE SPENDING TIME HERE: changing these patterns moves nothing on a real browser stack.
// The browser spells every one of our chunks `https://<our-host>/_next/static/chunks/<hash>.js`,
// and the `turbopack:///[project]/…` paths below are a source-map `sources` spelling the
// collector produces AFTER this code has run. So exclusions 1 and 2 cannot fire on a
// browser-produced frame at all, and exclusion 3 fires but cannot help — see the note above
// `AD_NETWORK_FRAME_HOST_RES` for the mechanism and the measurement. Rule 6b is the lever.
// These are retained because they are correct for any frame that arrives source-resolved, not
// because a build is known to produce one.

// 1) Dependencies. A bundler rewrites a `node_modules` file to a `turbopack://`/`webpack://`
//    URL just like our own source, so the scheme test alone cannot tell them apart. The fetch
//    instrumentation that wraps every request (`@opentelemetry/instrumentation-fetch`, pulled in
//    by the browser tracing package) lands here.
const DEPENDENCY_PATH_RE = /(?:^|[/\\])node_modules[/\\]/i;

// 2) Our own GLOBAL `window.fetch` wrappers. `UpdateRequiredWatcher` patches `window.fetch` for
//    the whole document to read update-prompt response headers, so its frame is on the stack of
//    every fetch — including third-party ad/analytics requests that never touch any other app
//    code. It is genuine project source, which is exactly why it has to be named here: the
//    `node_modules` rule above cannot exclude it.
//    🔴 Keep this in sync with the wrapper itself; the two files reference each other in
//    comments.
//    Scope note: this only suppresses the frame's ability to PROVE project involvement — an
//    actual bug inside the watcher still surfaces under its own message. But be precise about
//    how much that protects, because the two DROP rules consulting this guard differ:
//      - rule 6 (network) matches the WHOLE message, anchored, so any watcher error with a
//        message of its own is kept;
//      - rule 1 (abort) matches an enumerated set of abort phrases as UNANCHORED substrings, so
//        a watcher message that happens to contain one ("…the operation was aborted while
//        reading update headers") IS droppable.
//    So message anchoring is not a blanket protection. Weigh that before adding a file here.
const GLOBAL_FETCH_WRAPPER_PATH_RES = [
  /[/\\]UpdateRequiredWatcher[/\\]UpdateRequiredWatcher\.tsx?(?:[?#:]|$)/i,
];

// 3) Third-party scripts. A bare `.js` extension test matches every script on the web, so an ad
//    or analytics bundle (`…/pubads_impl.js`) used to read as project source. An ABSOLUTE
//    http(s) frame is judged purely on its PATH: Next's `/_next/` bundles, or the hand-built
//    workers generated into `public/workers/`. Non-absolute filenames (bundler schemes, bare
//    source paths) are unaffected and still match on extension below.
// Protocol-relative (`//host/path`) counts as absolute too: a frame spelled that way is still a
// fetch from some host, and without it a `//securepubads…/pubads_impl.js` frame falls through to
// the bare extension test and reads as project source — exactly the traffic this guard excludes.
// A bundler scheme (`turbopack:///…`) does NOT match: the optional `https?:` cannot consume
// `turbopack:`, so the `//` is not at position 0.
//
// 🔴 THE HOST IS DELIBERATELY NOT CHECKED, and that is a real hole, not an oversight: the app is
// served from several first-party domains, plus per-PR preview hosts, so a static host list is
// exactly the thing that would start producing FALSE DROPS the first time a new domain appears.
// A pure classifier has no trustworthy way to enumerate them. The cost is that ANY site's `/_next/`
// or `/workers/` path reads as ours — and every Next.js site on the web serves `/_next/`, so a
// third-party embed frame can block a drop. That fails SAFE (noise kept, never a real bug
// dropped), which is why it is accepted here; a test records the decision so it is not
// rediscovered as a bug. Adding a host check means feeding this module a first-party host set.
const ABSOLUTE_URL_RE = /^(?:https?:)?\/\//i;
// Both slashes are load-bearing: without the leading one `…/js/webworkers/loader.js` matches,
// and without the trailing one `…/workersfoo/x.js` does. Both would silently re-admit the noise.
const FIRST_PARTY_ASSET_PATH_RE = /\/(?:_next|workers)\//i;

// 🔴 EXCEPTION TO (1) — our API client stack. `node_modules` normally proves nothing, but these
// libraries only ever appear on a stack because OUR code asked them for something, so they DO
// attribute the request to us. They need naming because our own frames are frequently absent
// from a tRPC failure: `@trpc/client` batches and dispatches from a `setTimeout`, so by the time
// `fetch()` runs the synchronous stack is library frames only and every frame above it is gone.
// Without this, a genuine first-party API failure — an unreachable origin, a CORS or certificate
// regression, a bad deploy — would be dropped as a transient network blip.
// Third-party ad/analytics requests never touch these, so this does not reopen the gate.
//
// ⚠️ NOT listed, deliberately: the RUM SDK's own beacon transport. A failed telemetry POST is a
// first-party request, and it is now dropped as `network` noise rather than surfacing as an app
// error. That is the right call — an undeliverable beacon is not an app bug — but it means
// "our telemetry ingest is being blocked for real users" has to be read off the ingest RATE, not
// off this exception stream. Do not read its absence here as health.
const FIRST_PARTY_CLIENT_LIB_RES = [
  /[/\\]node_modules[/\\]@trpc[/\\]/i,
  /[/\\]node_modules[/\\]@tanstack[/\\]react-query/i,
];

function isProjectSourceFrame(frame: ClassifiableStackFrame): boolean {
  // Covers the empty / `undefined` filename cases, so no further blank check is needed below.
  if (isInjectedFrame(frame)) return false;
  const filename = (frame.filename ?? '').trim();
  if (anyMatch(GLOBAL_FETCH_WRAPPER_PATH_RES, filename)) return false;
  // 🔴 The absolute-URL test runs BEFORE the dependency allowlist, and the order is load-bearing:
  // a remote URL is decided purely by whether its PATH is one of ours. Otherwise a third-party
  // script served from a path that merely contains `/node_modules/@trpc/` would be allowlisted
  // into counting as our code. A real dependency frame carries a bundler scheme, not `http(s)`,
  // so it reaches the check below.
  if (ABSOLUTE_URL_RE.test(filename)) return FIRST_PARTY_ASSET_PATH_RE.test(filename);
  // Every `FIRST_PARTY_CLIENT_LIB_RES` pattern requires `node_modules/`, a strict subset of what
  // `DEPENDENCY_PATH_RE` matches — so nesting the allowlist inside the dependency check is
  // equivalent to testing it separately, and skips two scans on every non-dependency frame.
  if (DEPENDENCY_PATH_RE.test(filename)) return anyMatch(FIRST_PARTY_CLIENT_LIB_RES, filename);
  return (
    /^(?:turbopack|webpack):\/\//i.test(filename) ||
    FIRST_PARTY_ASSET_PATH_RE.test(filename) ||
    /\.(?:tsx?|jsx?|mjs|cjs)(?:[?#:]|$)/i.test(filename)
  );
}

// ── Third-party ad/analytics REQUEST INITIATORS (rule 6b) ─────────────────────────────────────
//
// 🔴 WHY THIS RULE EXISTS, AND WHY THE GUARD ABOVE CANNOT DO ITS JOB ON A REAL BROWSER STACK.
// This module runs in `beforeSend`, on the frames the BROWSER produced. In a production build
// every one of our chunks is spelled `https://<our-host>/_next/static/chunks/<hash>.js`; the
// `turbopack:///[project]/…` paths that `DEPENDENCY_PATH_RE`, `GLOBAL_FETCH_WRAPPER_PATH_RES`
// and `FIRST_PARTY_CLIENT_LIB_RES` match are a source-map `sources` spelling, produced by the
// COLLECTOR after this function has returned (`normalizeSourcePath` in
// `src/server/utils/errorHandling.ts` is the repo's other consumer of that spelling, and it
// reads `.js.map` files to get it). Precisely:
//   - exclusions 1 and 2 (the `node_modules` path test, the wrapper named by file path) cannot
//     fire at all on a browser-produced frame; and
//   - exclusion 3 (the `ABSOLUTE_URL_RE` → `FIRST_PARTY_ASSET_PATH_RE` branch) DOES fire, and
//     correctly rejects a third-party script — it just cannot help, because our own frames
//     genuinely are `<our-host>/_next/…` and one sibling first-party frame satisfies
//     `hasProjectSourceFrame` for the whole stack.
// Net effect: the rule 6 DROP cannot fire on any bare-network beacon that CARRIES A STACK.
//
// 🔴 THAT CLAIM RESTS ON FIRST PRINCIPLES AND ON #4994's OWN TEST, NOT ON A MEASUREMENT, and the
// distinction matters because the obvious measurement CANNOT DISCRIMINATE. A browser does not
// consult source maps to build `error.stack`, so a browser-produced frame cannot carry a
// post-resolution path — and #4994 already pinned exactly this, with a test asserting that an
// all-minified-bundle stack satisfies the guard. Counting stored beacons looks like confirmation
// and is not: storage holds the POST-resolution spelling, so "almost every stored line carries
// `turbopack:`/`node_modules`" is what you would observe whether this thesis or its negation were
// true. Do not add such a count here as support.
//
// What IS visible on a browser stack is the HOST of a foreign frame. A browser builds a
// fetch-rejection stack from the synchronous call stack at `fetch()`, innermost frame first, so
// the outermost frame is the code that ASKED for the request. When that frame is served by an
// ad/analytics network, the failing request was theirs.
//
// 🔴 LIMIT ON THAT CLAIM, because it is the rule's own premise: the SDK's stack parser
// (`@grafana/faro-web-sdk`, `getStackFramesFromError`) DISCARDS any stack line longer than its
// `MAX_STACK_LINE_LENGTH` (1024) rather than truncating it, so `frames[frames.length - 1]` is
// the outermost SURVIVING frame, not necessarily the outermost frame the browser produced. Both
// directions of that loss are safe for THIS rule — a discarded ad frame means no re-tag, and a
// discarded frame further out than an ad frame is the shape rule 6b is deliberately willing to
// re-tag (see the ad-callback note below) — but the rule reads one slot and that slot can move.
//
// 🔴 THE `OUTERMOST` CONJUNCT IS LOAD-BEARING, NOT DECORATION. The simpler rule — "an ad-host
// frame appears ANYWHERE on the stack" — selects the same beacons today (MEASURED: over the same
// 4,000-beacon sample, both forms selected the same 2,555 beacons, with zero disagreements in
// either direction) but has a catastrophic tail. Browser extensions demonstrably patch
// `window.fetch` — over one of those two windows, 1,175 of that window's 1,727 sampled
// `TypeError: Failed to fetch` beacons carried a `chrome-extension://…` frame, our own requests
// included — so the day an ad script does the same, its frame joins every fetch rejection as one
// more unconditional layer and an anywhere-rule would re-tag the ENTIRE bare-network stream out
// of `real`, genuine first-party bugs with it. Requiring the ad frame to be OUTERMOST turns "ad scripts do
// not wrap fetch" from an assumption into a precondition checked per beacon: a wrapper's frame
// is never outermost for a request it did not initiate. If the frame order this rests on ever
// changed, the rule goes inert rather than wrong.
//
// 🔴 ACCEPTED LOSS, with an enforced ledger. Three call sites run OUR callback synchronously
// beneath an ad-SDK frame (`src/components/Ads/AdsProvider.tsx`,
// `src/components/Ads/AdUnitFactory.tsx`). If such a callback ever issues a first-party `fetch`,
// its outermost frame is the ad SDK's and this rule tags a first-party failure out of `real` —
// and the stack
// is genuinely indistinguishable from an ad-initiated one, because every frame of ours on it is
// the same minified chunk path. No callback at those sites fetches today. That is a precondition
// nothing in the type system enforces, so `__tests__/adCallbackLedger.test.ts` asserts the set of
// such call sites and fails when it GROWS or SHRINKS. The fix, if one ever needs a fetch, is to
// defer it (`setTimeout`) so the stack starts fresh — the pattern
// `src/components/Ads/useAdUnitImpressionTracked.ts` already uses.
//
// 🔴 HOSTS ARE ENUMERATED FROM MEASUREMENT, DOMAIN-ANCHORED, AND MATCHED AGAINST THE PARSED HOST
// — never as a substring of the filename, or a first-party bundle URL carrying an ad domain in
// its query (`…/chunks/a.js?ref=.doubleclick.net`) would match. The `$` anchor is what stops
// `doubleclick.net.example.com`; the `(?:^|\.)` alternation is what stops `notdoubleclick.net`
// while still matching an apex host. Domain rather than exact hostname because these serve from
// rotating subdomains (`securepubads.g.`, `www.`, `cdn.`, and a `staging-cdn.` the ad provider
// config already names) and pinning a hostname is how the rule would silently go inert.
//
// MEASURED, and this is the whole basis for the list: over three ADJACENT 6h windows on
// 2026-09-30 (04:38–10:38Z, 10:38–16:38Z, 16:38–22:38Z; `client_class!="bot"`,
// `context_error_category="real"`), the complete set of third-party `http(s)` hosts appearing on
// a `Failed to fetch` stack was FOUR: `doubleclick.net` (subdomain `securepubads.g.`),
// `googletagmanager.com` (`www.`) and `snigelweb.com` (`cdn.`) — all three listed — plus
// `static-lib.com`, which appeared on 2 beacons of the 4,000 sampled and is DELIBERATELY NOT
// listed: an unrecognised injector, below any threshold worth widening a denylist for. Extension
// origins are not in that count: they are excluded by the authority parse below, which accepts
// only `http(s)` and protocol-relative frames, and that exclusion is deliberate (see the
// `window.fetch` measurement above).
//
// SIZE OF THE POPULATION THIS RETAGS, carried with its population because the figure is not a
// constant: roughly 8–25% of the NON-BOT `context_error_category="real"` exception stream, on the
// four 6h windows measured on 2026-09-30 (24.5% / 14.8% / 8.3% / 21.9%). It swings about 3×
// diurnally with ad composition, so treat any single number as a window reading rather than an
// effect size, and re-measure before quoting one.
//
// 🔴 THIS IS A MAINTAINED DENYLIST WITH NO STALENESS DETECTOR. Nothing tells you when an ad
// vendor changes domain or a new one appears; the rule simply stops re-tagging. Add a host only
// after MEASURING it on this stream, exactly as the abort phrasings earlier in this file are
// added, and state the window you measured over.
//
// ASSUMPTION, stated because it is the one case where "the outermost frame is third-party" and
// "the request was ours" can both be true without an ad callback: `googletagmanager.com` serves a
// container whose CONTENTS we configure, so a first-party tag fetching our own endpoint would
// be re-tagged here. There is no first-party GTM loader in this repo today, so it is theoretical.
//
// 🔴 NOT the same list as `ADBLOCK_HOST_RES` (rule 2), and the two are not interchangeable: that
// one is matched as an unanchored substring against a MESSAGE and contains JS globals
// (`googletag`, `adsbygoogle`) alongside host fragments, so it is not a host matcher at all —
// `/\bgoogletag\b/` does not even match `googletagmanager.com` (no word boundary before the `m`).
const AD_NETWORK_FRAME_HOST_RES = [
  /(?:^|\.)doubleclick\.net$/i,
  /(?:^|\.)googletagmanager\.com$/i,
  /(?:^|\.)snigelweb\.com$/i,
];

// Host of an absolute (or protocol-relative) URL frame, with any userinfo, port and root-label
// dot stripped. Returns `null` for anything that is not an absolute URL — a bundler scheme, a
// bare source path, `<anonymous>`, an extension scheme — so none of those can reach a host
// pattern. DERIVED from `ABSOLUTE_URL_RE` rather than re-spelled, so the two cannot drift apart
// about what an absolute frame is: this is that test plus an authority capture. Deliberately not
// `new URL()`: this runs on every exception beacon, `URL` throws on the malformed filenames stack
// parsers emit, and a protocol-relative frame has no base to resolve against. Case is left alone
// because every host pattern is `/i`; normalising it here would change no outcome.
const FRAME_AUTHORITY_RE = new RegExp(`${ABSOLUTE_URL_RE.source}([^/?#]+)`, 'i');

function frameHost(filename: string): string | null {
  const m = FRAME_AUTHORITY_RE.exec(filename);
  if (!m) return null;
  const authority = m[1];
  return (
    authority
      // `user:pass@host` — take everything after the LAST `@`.
      .slice(authority.lastIndexOf('@') + 1)
      .replace(/:\d+$/, '')
      // A fully-qualified name may carry the root label (`doubleclick.net.`), which the `$`
      // anchor would otherwise reject. `normalizeHost` in `src/utils/external-link.ts` strips it
      // for the same reason.
      .replace(/\.$/, '') || null
  );
}

/**
 * True iff the OUTERMOST surviving stack frame — the request's initiator, subject to the parser
 * limit noted above — is a script served by one of the enumerated ad/analytics domains.
 *
 * Conservative on every unknown: an absent, empty or malformed `frames` value returns `false`, so
 * an odd payload shape can never manufacture a DROP. That guard is UNOBSERVABLE at rule 6b's
 * position — rule 6 consults `hasProjectSourceFrame`, which returns `false` from its own
 * malformed guard, so every bare-network beacon with an absent, empty or non-array `frames` is
 * already dropped as `network` before this function is called, and no test can distinguish the
 * guard's presence. It is kept because without it an array-LIKE payload off the wire
 * (`{length: 1, 0: {…}}`) is indexable and could MANUFACTURE a drop if this rule were ever
 * reordered ahead of rule 6. Nothing observes that today; a reorder leaves every current test
 * green on this function, and reddens four of rule 6's instead (see the rule 6b ordering note).
 */
function isAdNetworkInitiatedRequest(exc: ClassifiableException): boolean {
  const frames = exc.stacktrace?.frames;
  if (!Array.isArray(frames) || frames.length === 0) return false;
  const outermost = frames[frames.length - 1];
  const host = frameHost((outermost?.filename ?? '').trim());
  return host !== null && anyMatch(AD_NETWORK_FRAME_HOST_RES, host);
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
    anyMatch(ABORT_ANCHORED_VALUE_RES, value) ||
    anyMatch(ABORT_ANCHORED_VALUE_RES, typed) ||
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

  // 3) DROP — autoplay policy block. Both engine phrasings; the second is anchored because this
  //    rule consults no stack (see the pattern comments).
  if (AUTOPLAY_RE.test(value) || AUTOPLAY_RE.test(typed)) return DROP('autoplay');
  if (AUTOPLAY_GESTURE_RE.test(value) || AUTOPLAY_GESTURE_RE.test(typed)) return DROP('autoplay');

  // 4) DROP — opaque cross-origin `Error: Script error.` (no usable message/stack).
  if (SCRIPT_ERROR_RE.test(value) || SCRIPT_ERROR_RE.test(typed)) return DROP('script_error');

  // 5) DROP — browser-extension / injected error whose stack has ONLY `undefined:`/empty frames
  //    (no project source frame). If ANY frame references project source, this does NOT match.
  if (isInjectedOnlyStack(exc)) return DROP('injected');

  // Rules 6 and 6b share this conjunct exactly, so it is computed once. One definition also
  // makes the two rules' relationship visible: they differ ONLY in what they then ask of the
  // stack.
  const isBareNetworkMessage =
    anyMatch(BARE_NETWORK_VALUE_RES, value) || anyMatch(BARE_NETWORK_VALUE_RES, typed);

  // 6) DROP — bare transient network failure with no useful app stack. The value must be the
  //    WHOLE anchored network message AND the stack must carry no project-source frame (else it's
  //    a real fetch bug in our code we want to see).
  if (isBareNetworkMessage && !hasProjectSourceFrame(exc)) {
    return DROP('network');
  }

  // 6b) KEEP+TAG `ad_initiated` — a bare network failure whose OUTERMOST stack frame (the
  //     request's initiator) is a script on an enumerated ad/analytics domain. This is the rule
  //     that actually fires on a real browser stack, where rule 6's `!hasProjectSourceFrame`
  //     guard structurally cannot — see the note above `AD_NETWORK_FRAME_HOST_RES` for the
  //     mechanism, the parser limit on "outermost", and why the OUTERMOST conjunct is
  //     load-bearing.
  //
  //     🔴 TAG, NOT DROP, AND THE TRADE IS THE WHOLE POINT. Dropping this population would buy
  //     roughly 0.01% of ingest volume and cost PERMANENT UNQUERYABILITY of the one bucket still
  //     under active investigation — a dropped beacon is never sent, so no later question can be
  //     asked of it. That is the same trade rejected on #5233. Tagging gets both properties: the
  //     real-app-bug stream is cleaned (every consumer selects `context_error_category="real"`,
  //     so a non-`real` tag is excluded by construction) and the beacons stay auditable.
  //
  //     🔴 AND IT KEEPS THIS MODULE THE SINGLE SOURCE OF TRUTH. The alternative considered was
  //     moving the host denylist downstream into the observability repo. Rejected: that
  //     re-introduces a hand-maintained predicate at five consumer sites, and deleting exactly
  //     that duplication from four dashboard targets is what made those consumers key on this
  //     tag in the first place. One definition here, no duplication there.
  //
  //     🔴 IT SITS AFTER RULE 6 DELIBERATELY, and the reason is about TESTS, not behaviour. Four
  //     existing tests cover stacks that BOTH rules accept (an ad-initiated fetch with no
  //     project-source frame) and each asserts `category === 'network'`. With this rule earlier
  //     they would be tagged instead of dropped, so they would go RED — and the only way to green
  //     them again stops them distinguishing WHICH rule decided, so they stop observing the rule 6
  //     exclusions they were written to pin. Ordering is also what makes the two rules disjoint:
  //     rule 6 takes every stack where no frame looks like ours, leaving this one the stacks where
  //     some frame does but the initiator is a third party. Note the consequence of that order —
  //     an ad-initiated fetch whose stack carries NO project-source frame is still DROPPED as
  //     `network` by rule 6 and never reaches this tag. This rule's population is specifically
  //     the one rule 6 cannot see.
  //
  //     Both conjuncts are required. The message must be the WHOLE anchored network message, so
  //     an app error that merely names an ad host stays `real`; and the ad frame must be the
  //     OUTERMOST one, so a third party that wraps `window.fetch` cannot drag our own failures
  //     out of the real stream with it.
  if (isBareNetworkMessage && isAdNetworkInitiatedRequest(exc)) {
    return KEEP('ad_initiated');
  }

  // 7) KEEP+TAG — browser-extension / injected-global errors (patterns above). AFTER every DROP
  //    rule on purpose: a denylisted global behind an all-`undefined:` stack still drops as
  //    `injected` (tag-only must not un-drop anything), and everything that used to reach `real`
  //    is re-tagged here. Disjoint from bizlogic/chunkload/meili by pattern.
  if (isExtensionInjectedError(value, typed)) return KEEP('extension');

  // 8) KEEP+TAG — expected business-logic (TRPCClientError user states).
  if (anyMatch(BIZLOGIC_VALUE_RES, value) || anyMatch(BIZLOGIC_VALUE_RES, typed)) {
    return KEEP('bizlogic');
  }

  // 9) KEEP+TAG — stale-bundle chunk load (deploy-health signal).
  if (/ChunkLoadError/i.test(type) || /ChunkLoadError/i.test(typed)) return KEEP('chunkload');

  // 10) KEEP+TAG — MeiliSearch backend blips (search correlation signal).
  if (/MeiliSearchCommunicationError/i.test(type) || /MeiliSearchCommunicationError/i.test(typed)) {
    return KEEP('meili');
  }

  // 11) Default — a real app-bug candidate. KEEP and tag `real`.
  return KEEP('real');
}

/**
 * True iff the stack has at least one frame that references PROJECT SOURCE — OUR code, as
 * opposed to a dependency, a third-party script, or the global fetch plumbing every request
 * passes through (see `isProjectSourceFrame` for why those three are excluded).
 *
 * Used to guard the "bare network" DROP: a `Failed to fetch` raised from a call site in our own
 * code is a bug in OUR fetch code and must be KEPT, while one whose only app-adjacent frames are
 * instrumentation is a third-party network blip and is dropped.
 */
function hasProjectSourceFrame(exc: ClassifiableException): boolean {
  const frames = exc.stacktrace?.frames;
  // Guard against a malformed (non-array) `frames`. This is used to PROTECT real errors from a
  // DROP, so on an unknown shape we return `false` (no known project frame) — but because the
  // DROP rules that consult it also require an anchored/known message match, an odd shape can
  // still never manufacture a drop on its own. Fails open at the classifyException level too.
  if (!Array.isArray(frames) || frames.length === 0) return false;
  return frames.some((f) => isProjectSourceFrame(f));
}

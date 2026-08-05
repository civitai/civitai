// App Blocks — the iframe URL FRAGMENT fast path.
//
// WHAT THIS IS
// ------------
// `theme`, `renderMode` and `blockInstanceId` ship in the `BLOCK_INIT`
// postMessage payload. That payload cannot be posted until the host has a
// block token AND the effective-checkpoint query has resolved, so a block
// cannot paint its own loading state in the right theme, nor key any
// per-instance bootstrap, until the handshake completes. Repeating the same
// three values in the iframe URL's FRAGMENT makes them readable by the block
// synchronously at document-parse time, before a single message is exchanged.
//
// 🔴 THE PAYLOAD REMAINS AUTHORITATIVE. This is an additive FAST PATH:
//   - `BLOCK_INIT` still carries all three fields, and the SDK's
//     `snapshotFromInit` replaces the whole snapshot when it lands, so the
//     payload always wins over the fragment.
//   - A block is only `ready` after `BLOCK_INIT`. The fragment never makes a
//     block ready.
//   - A NEW block against an OLD host sees no fragment and falls back to
//     waiting for the payload — i.e. today's behaviour.
//
// 🔴 THE TOKEN IS NEVER PUT IN THE URL. Only these three non-secret fields
// are. URLs leak into `document.referrer`, browser history, proxy logs and
// screenshots; a bearer token must not. `token`, `viewer`, `settings` and
// `context` stay in the postMessage payload.
//
// WHY A FRAGMENT AND NOT A QUERY ARG
// ----------------------------------
// A fragment is never transmitted to the block's origin server, so it cannot
// perturb caching, server-side routing, or a strict query-param validator on
// the publisher's side. It is also the only part of a URL that can be changed
// WITHOUT re-navigating the document, which is what makes a future
// no-reload update of `renderMode`/`theme` possible at all. See
// "PROPAGATING A CHANGE" below for what is and is not implemented today.
//
// WIRE FORMAT (v1) — mirrored by `@civitai/app-sdk`'s `parseBlockInitFragment`:
//
//   #civitai-block=v1&theme=dark&renderMode=iframe&blockInstanceId=bi_abc
//
// The body is a standard `URLSearchParams` string; `civitai-block=v1` is both
// the namespace marker and the format version, so a reader can tell OUR
// fragment from a block app's own hash state without guessing.
//
// 🔴 THIS IS A MIRRORED CONTRACT, NOT A SHARED IMPORT. civitai consumes the
// PUBLISHED `@civitai/app-sdk` dist, and the decoder lands in a version that
// is not published yet, so the encoder cannot import it. `__tests__/blockIframeUrl.test.ts`
// pins the exact literal output string — change the format on one side and that
// literal must be changed here AND in the SDK's `initFragment.test.ts`, which
// pins the same literal from the decoder's side.
//
// NO-STOMP RULE — 🔴 A CORRECTNESS PROPERTY, *NOT* A MITIGATION
// -------------------------------------------------------------
// If the publisher's `iframe.src` ALREADY carries a fragment, we append
// nothing and return the src untouched.
//
// 🔴 THIS BRANCH CANNOT FIRE FOR A PRODUCTION BLOCK, AND AN EARLIER VERSION OF
// THIS COMMENT WAS WRONG TO CALL IT "the compatibility guard for hash-routing
// block apps". `stampCanonicalIframeSrc`
// (`src/server/services/blocks/manifest-normalize.ts`) UNCONDITIONALLY
// overwrites `manifest.iframe.src` with `https://<slug>.<appsDomain>/` — its
// own doc comment says "Any developer-supplied `iframe.src` is overwritten" —
// and the manifest schema independently rejects a dev-set `iframe.src`. The
// dev-tunnel URL is server-derived too. So no src reaching this function can
// carry a publisher fragment, and a hash-routing block is NOT protected here.
//
// The real protection is the GATE (`blockInitFragmentGate.ts`): off by default
// for every block, and unconditionally off for the dev tunnel. This branch is
// kept because it is cheap and correct if a fragment-bearing src ever does
// arrive — but it must not be counted as a mitigation, and the hazard it was
// once claimed to cover is the entire deployed population, not a tail case.
//
// PROPAGATING A CHANGE
// --------------------
// Today nothing changes these three values for a MOUNTED block:
//   - `renderMode` is a per-install constant (`'iframe'` at every iframe call
//     site) and cannot change without a remount;
//   - `theme` CAN change (the viewer toggles dark mode) but the host has never
//     propagated that to a live block — `BLOCK_INIT` is deduped by the SDK, so
//     a later theme value never reaches it;
//   - `blockInstanceId` is immutable per mount.
// So the hosts FREEZE the fragment at mount (see `useBlockIframeSrc.ts`) and
// the observable behaviour of a running block is unchanged by this module. The
// alternative — recomputing the fragment from live values — would make the
// iframe's `src` attribute change on a theme toggle, which is a navigation
// where today there is none. That is a behaviour change nobody asked for and
// is deliberately not made here.
//
// When a live update IS wanted, the mechanism the fragment buys is: the host
// rewrites ONLY the fragment of the existing `src` (a same-document fragment
// navigation, no reload) and the block observes it via a `hashchange`
// listener. That needs an SDK-side listener that does not exist yet, so it is
// explicitly out of scope here — and note the freeze above means shipping it
// later is purely additive.

/** Fragment key that both namespaces and versions the payload. */
export const BLOCK_INIT_FRAGMENT_MARKER_KEY = 'civitai-block';

/** Current fragment format version. */
export const BLOCK_INIT_FRAGMENT_VERSION = 'v1';

export interface BlockInitFragmentFields {
  theme: 'light' | 'dark';
  renderMode: 'iframe' | 'inline';
  blockInstanceId: string;
}

/**
 * Encode the fast-path fields into a fragment BODY (no leading `#`).
 *
 * Key order is fixed (marker first) so the output is deterministic and can be
 * pinned by a literal-valued test on both sides of the wire.
 */
export function encodeBlockInitFragment(fields: BlockInitFragmentFields): string {
  const params = new URLSearchParams();
  params.set(BLOCK_INIT_FRAGMENT_MARKER_KEY, BLOCK_INIT_FRAGMENT_VERSION);
  params.set('theme', fields.theme);
  params.set('renderMode', fields.renderMode);
  params.set('blockInstanceId', fields.blockInstanceId);
  return params.toString();
}

/**
 * Append the init fragment to a publisher-supplied iframe `src`.
 *
 * Returns `baseSrc` UNCHANGED when:
 *   - `blockInstanceId` is empty (nothing useful to say), or
 *   - it does not parse as an absolute URL — which covers BOTH the empty-string
 *     src of a malformed manifest and a relative one. There is deliberately no
 *     separate `if (!baseSrc)` early return: `new URL('')` throws, so the catch
 *     below already returns the input, and a second guard for the same case
 *     would be one no mutation can kill.
 *   - it already carries a fragment (the no-stomp rule above).
 *
 * Never throws: a bad `src` returns the input, and the caller's existing
 * `new URL(src).origin` guard is what rejects it.
 */
export function buildBlockIframeSrc(baseSrc: string, fields: BlockInitFragmentFields): string {
  if (!fields.blockInstanceId) return baseSrc;

  let url: URL;
  try {
    url = new URL(baseSrc);
  } catch {
    return baseSrc;
  }

  // NO-STOMP: the publisher is already using the fragment. `URL#hash` is the
  // empty string when there is no fragment, and `'#'` for a bare trailing
  // hash — treat the bare hash as "unused" and claim it.
  if (url.hash && url.hash !== '#') return baseSrc;

  url.hash = encodeBlockInitFragment(fields);
  return url.toString();
}

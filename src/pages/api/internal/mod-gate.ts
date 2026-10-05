import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import { verifyReviewAccessToken } from '~/server/services/blocks/review-session';

/**
 * GET/ANY /api/internal/mod-gate  (MOD REVIEW SANDBOX, #2831 / #2847 / #2855)
 *
 * A Traefik `forwardAuth` target guarding the temporary review-preview hosts
 * (`review-<sha16>.<APPS_DOMAIN>`). The review preview is a CROSS-ORIGIN iframe
 * embedded inside the authenticated civitai.com `/apps/review` page.
 *
 * ── WHY A TOKEN, NOT THE SESSION COOKIE ──
 * The civitai session cookie is scoped to civitai.com and is NOT sent to a
 * `*.civit.ai` host, so resolving the civitai session from the forwarded Cookie
 * 401'd EVERYONE. Instead the already-authenticated civitai.com parent page
 * mints a signed, short-TTL (120s), mod-bound ENTRY token (see
 * `review-session.ts`) and injects it into the iframe `src` as `?mr=<token>`.
 *
 * ── ENTRY-GATE: TWO ARMS, DEST **AND** PATH ──
 * A request is an ENTRY request — and therefore needs a valid `mr` token — when
 * EITHER arm says so. Only a request that fails BOTH arms is allowed through
 * unauthenticated:
 *
 *   (a) DEST arm — `Sec-Fetch-Dest` is an entry dest (document / iframe / frame /
 *       nested-document), or the header is ABSENT, EMPTY or whitespace (all
 *       treated as entry, fail-safe). Compared case-folded.
 *   (b) PATH arm — the forwarded original path is NOT a recognised STATIC
 *       SUBRESOURCE path. Note the one-way implication: every path the server can
 *       answer with the SHELL is unrecognised, but not every unrecognised path is
 *       a shell path — `/docs/manual.pdf` with a context-capable dest is a real
 *       file and is still gated. That asymmetry is the "stated trade" below, not a
 *       defect.
 *
 * 🔴 ARM (b) IS NOT DEST-INDEPENDENT. The two path PREDICATES below
 * (`isStructuralAssetPath`, `hasNonDocumentExtension`) are dest-free, but what
 * counts as "recognised" is not: the dest decides WHICH HALF of the allowlist is
 * available, so `/nope.js` is a recognised subresource path for dest `empty` and
 * is not one for dest `object`.
 *
 * So:
 *   - ENTRY (either arm): require a valid `mr` token whose bound host ===
 *     X-Forwarded-Host → 200 + `X-Mod-Id`, else 401.
 *   - SUBRESOURCE (NEITHER arm): 200 (allow), no token.
 *   - Missing X-Forwarded-Host → 401 (fail-closed; can't bind/verify anything).
 *   - Missing / unclassifiable X-Forwarded-Uri → ENTRY (fail-closed).
 *
 * The PATH arm's allowlist has TWO halves — mirroring the static server's own
 * split, one location serving a fixed file set under `/assets/` and the other
 * serving everything else over the fallback. They are NOT interchangeable, so the
 * DEST arm decides which half applies:
 *
 *   - `/assets/…` is STRUCTURAL: that prefix has its own location in the static
 *     server whose fallback is a hard 404, so a path under it is answered from a
 *     fixed file set or not at all — it can never be the shell. Any non-entry dest
 *     may use this half.
 *   - the static-EXTENSION half is PRAGMATIC: it exists because blocks fetch files
 *     from their `public/` dir outside `/assets/`, and it cannot be structural,
 *     because an allowlisted extension that names no file in the bundle is
 *     answered by the SPA fallback. So it is restricted to dests that CANNOT
 *     create a browsing context (`NON_DOCUMENT_DESTS`) — a dest which can, and any
 *     dest we do not recognise, is confined to the structural half.
 *
 * That split is what keeps the ✅ claim below true rather than nearly true. Without
 * it, a dest that creates a nested browsing context but is not an entry dest could
 * pair with an extension-allowlisted path that is absent from the bundle and LOAD
 * the shell as a document with no token — the same shape as the dest-only
 * classification this replaces, one level down.
 *
 * ── WHY THE PATH ARM EXISTS ──
 * The DEST arm on its own does not gate the entry document, and cannot be made
 * to. The sandbox serves a single-page app: its static server answers `/` and
 * `/index.html` with the shell, and its SPA fallback answers EVERY path that does
 * not name a file in the bundle with that same shell. "The entry document" is
 * therefore not one path — it is an unbounded set of paths.
 *
 * A classification that reads only `Sec-Fetch-Dest` hands that shell to any
 * client that merely DECLARES a non-entry dest, because the dest is supplied by
 * the caller: a cross-origin `fetch()` sends `Sec-Fetch-Dest: empty`, which is
 * not an entry dest, so the shell came back with no `mr` token involved.
 *
 * A path check shaped as a DENYLIST does not fix that either: gating `/` (or `/`
 * plus `/index.html`) is answered by asking for `/anything-else`, which the SPA
 * fallback serves with the very same bytes. Hence the ALLOWLIST above — only
 * positively-recognised static-file shapes pass, so the unbounded fallback set is
 * rejected BY DEFAULT rather than enumerated.
 *
 * ── WHY THE CHIPS SUBRESOURCE-COOKIE GATE WAS REVERTED ──
 * The earlier #2847 hardening tried to gate EVERY subresource with a CHIPS
 * `Partitioned` session cookie: on a valid `mr` entry, the gate returned 200
 * WITH a `Set-Cookie: __Host-review-sess=...; Partitioned; SameSite=None` so the
 * browser would replay that cookie on subsequent subresource requests, and each
 * subresource would then be verified against it.
 *
 * That does NOT work: **Traefik `forwardAuth` does not forward a 2xx auth
 * response's `Set-Cookie` header back to the client** (confirmed live — an entry
 * request with a valid token returns 200 with NO Set-Cookie reaching the
 * browser). So the CHIPS session cookie is never set, and every subsequent
 * subresource arrives with no cookie → 401 → the review preview never renders.
 * The subresource-cookie gate was therefore REVERTED to this entry-gate-only
 * design.
 *
 * ── ACCEPTED TRADEOFF, AND ITS EXACT RESIDUAL ──
 * Subresources are still served WITHOUT per-request auth, and that is required,
 * not merely tolerated: the preview iframe is sandboxed with NO
 * allow-same-origin, so its own scripts / styles / fonts / `fetch()`es arrive
 * carrying no token at all. 401'ing them is what broke the preview before (see
 * the CHIPS section above), so a request whose dest is a subresource dest AND
 * whose path is an allowlisted static shape gets 200 with no token.
 *
 * 🔴 STATE WHAT IS PROVIDED, AND STATE THE RESIDUAL. Do not write a sentence here
 * that rounds the second into the first: a comment that asserts a guarantee the
 * code does not implement is worse than no comment, because it tells a maintainer
 * the question is already settled.
 *
 * 🔴 THE PREMISE THAT MAKES THE DEST SETS LOAD-BEARING, stated because this file
 * also says the dest is caller-supplied and the two read as a contradiction
 * otherwise. `Sec-Fetch-Dest` is a FORBIDDEN HEADER NAME: page script cannot set
 * it, so for a BROWSER it is browser-set and an `<iframe>`/`<object>` load cannot
 * be labelled `image`. A non-browser client can of course send anything — but a
 * non-browser client cannot create a browsing context at all, so for it the dest
 * is irrelevant. That is exactly why the dest sets are trustworthy for the
 * document-load claim below and worthless for the byte residual.
 *
 * What the arms above provide, exactly:
 *
 *   ✅ The SHELL cannot be LOADED AS A DOCUMENT without a valid `mr` token. The
 *      only dests that can create a browsing context are either in `ENTRY_DESTS`
 *      (so the DEST arm requires the token) or absent from `NON_DOCUMENT_DESTS`
 *      (so the PATH arm confines them to `/assets/`, which the static server
 *      answers from a fixed file set or 404s — never with the shell). An
 *      unrecognised dest falls in the second group, so this holds for dests that
 *      do not exist yet. ⚠️ Read "the SHELL" literally: `/assets/` guarantees "not
 *      the shell", NOT "not a document". A scriptable file the bundle itself ships
 *      under `/assets/` (Vite emits `.svg` there, and in a review sandbox that
 *      tree is authored by the submission under review) is a document of its own
 *      and may be loaded via `object`/`embed` — it is a subresource of the
 *      submission, on the accepted tradeoff, not the entry document.
 *   ⚠️ RESIDUAL — the shell BYTES, not a document. A request whose dest cannot
 *      create a browsing context (a cross-origin `fetch()`, dest `empty`) and
 *      whose path carries a non-document file extension absent from the bundle
 *      (`/nope.js`) is answered by the SPA fallback with the shell body, with no
 *      token. That is irreducible AT THIS LAYER — but see the SECOND lever under
 *      FUTURE HARDENING below, which prices the change that would close it: the
 *      shapes a block legitimately
 *      fetches from its `public/` dir are the same shapes, so the gate cannot
 *      separate them without knowing which files the bundle contains, which it
 *      does not read today. 🔴 Note the
 *      honest consequence: this arm does NOT materially reduce byte disclosure,
 *      because a caller who wanted `/` can ask for `/nope.js` instead. It closes
 *      document LOADS completely and byte disclosure not at all. Do not read it
 *      as doing the second.
 *
 * That residual is accepted on the same footing as the subresources themselves:
 * the `review-<sha16>` host is a ~64-bit secret (the sha16 hostname) surfaced
 * ONLY to mods. It is mod-only, ephemeral, and exists purely for the
 * pre-approval preview — an attacker who does not already know the exact host
 * can't request anything from it, and the host is torn down after review.
 *
 * Two things that premise quietly needs, checked rather than assumed, because every
 * accepted residual above rests on it. (1) The sha16 is NOT the submitter's own
 * pushed commit: `resolveReviewSourceSha` returns a SERVER-created commit in the
 * in-review repo on both the ZIP and git-push paths. ⚠️ Note precisely what that
 * does and does not buy, because the obvious phrasing over-claims: a commit sha is
 * determined by tree + parent + author + committer + timestamp + message, and a
 * submitter influences the tree. What they do not have is the PARENT — the
 * in-review repo's prior HEAD — so that, not the fact of server authorship, is the
 * clause holding the host unguessable. Anything that made the parent predictable
 * (a first commit into a freshly created review repo, say) would weaken it, and
 * this was not traced. (2) The host gets a public DNS record, so the remaining
 * way it could leak is a per-host TLS certificate landing in a Certificate
 * Transparency log — and none is issued, because the review host is a single-level
 * subdomain covered by an existing wildcard certificate. 🔴 Give a review host its
 * own certificate and the hostname becomes public within minutes; this paragraph
 * stops being true and so does every residual that cites it.
 *
 * ── A PRECONDITION THIS FILE DEPENDS ON, NAMED SO IT IS NOT REMOVED BY ACCIDENT ──
 * The PATH arm classifies `X-Forwarded-Uri`, so it is only as trustworthy as that
 * header. Traefik's forwardAuth sets it from the real request target by default,
 * but it has an opt-in "trust forward header" mode in which a CLIENT-supplied
 * `X-Forwarded-Uri` is passed through instead. Enabling that on the review
 * Middleware would let a caller hand this gate one path while the proxy forwards
 * a different one upstream, which collapses the PATH arm entirely. The same
 * applies to `X-Forwarded-Host`, which is what the `mr` token is bound to. Both
 * must stay proxy-set — SET, not appended: a proxy that added its value beside a
 * client's would hand this gate two paths in one header. That Middleware is not in
 * this repo — it ships as
 * `review.yaml.tmpl` in the app-templates ConfigMap, which `apps-pipeline.service.ts`
 * already names — so nothing here can assert it mechanically. Contrast the sibling
 * dev-tunnel gate, whose Middleware IS built in this repo and whose shape its own
 * test pins.
 *
 * SECOND PRECONDITION, and the ✅ depends on it just as hard: a document load must
 * actually PRODUCE a forwardAuth subrequest. A response this gate allowed as bytes
 * is convertible into a document load without the gate being consulted at all if
 * the browser can serve a later navigation to the same URL from its HTTP cache. Two
 * things stop that today and both are outside this file: the SPA-fallback response
 * is served `Cache-Control: no-store` (measured — every fallback path, unlike
 * `/assets/*`, which is `immutable`), and current browsers partition the HTTP cache
 * by top-level site, so a cross-site fetch's entry is not reachable from a top-level
 * navigation. ⚠️ Stated at the width the ✅ actually needs: no CLIENT-SIDE STORE may
 * serve a navigation for one of these URLs. The HTTP cache is the instance that was
 * measured; the nearest others are the prefetch/prerender speculation store (a
 * `<link rel=prefetch>` sends a NON-document dest, and a later navigation can be
 * served from it) and the back/forward cache — `no-store` is what holds both; the Cache API ignores `no-store`, but writing to it requires script
 * execution on the review origin, which requires the token-gated document. If the
 * fallback ever becomes storable, the ✅ weakens to "closes document loads that
 * reach the gate".
 *
 * ── SCOPE: THE SIBLING GATE IS NOT UPDATED ──
 * `src/pages/api/internal/dev-tunnel-gate.ts` carries the same dest-only
 * classification this file used to have, and several comments in and around it
 * describe the two gates as identical. As of this change they are NOT, in three
 * ways: that gate has no PATH arm, it does not case-fold the dest, and it treats an
 * EMPTY-string dest as a subresource dest rather than as absent (`'' != null` and
 * `ENTRY_DESTS.has('')` is false there, where this gate folds `''` to `undefined`).
 *
 * It is deliberately unchanged, and the real reason is stronger than "its tradeoff
 * is its own" (which is also true — the exposure there is the author's own dev
 * machine, and its comment already states host-secrecy rather than a token
 * guarantee): THE PATH ARM IS NOT PORTABLE TO IT AS WRITTEN. That gate fronts a
 * Vite dev server, which serves extensionless, non-`/assets/` endpoints such as
 * `/@vite/client` with a subresource dest. Both halves of this allowlist would
 * reject those, so porting it needs a different allowlist, not a copy.
 *
 * ⚠️ That reason covers the PATH ARM only. The dest case-folding IS trivially
 * portable and was left out purely to keep this change to one gate — so if you
 * are the next person in that file, that one is a one-line lift and this
 * paragraph is not an argument against it. Its practical effect there is nil in
 * both directions (a browser cannot send a differently-cased dest, and that gate
 * passes every subresource on host secrecy anyway), which is why it was not worth
 * widening the diff for. The asymmetry is recorded here, on the side that moved,
 * because a reader of that file will not see this one.
 *
 * ── FUTURE HARDENING (if per-subresource gating is ever wanted) ──
 * A **302-strip handshake** would restore subresource gating without depending on
 * 2xx Set-Cookie forwarding: on a valid `mr` token, mod-gate returns a `302` to
 * the SAME URL minus the `mr` param, WITH the `Set-Cookie` on the redirect —
 * Traefik DOES forward headers (incl. Set-Cookie) on a NON-2xx auth response, so
 * the CHIPS cookie is set via the redirect; the browser then re-requests the
 * document (now cookie-carrying) and subsequent subresources carry the cookie
 * too. This is still CHIPS-only (Chromium/Firefox; Safari hard-blocks the
 * `Partitioned` cookie so it would be excluded). NOT implemented — documented as
 * a known lever.
 *
 * A SECOND lever, specific to the byte residual above, recorded because it is a
 * PRICED OPTION and not the dead end "the gate cannot know the file list" would
 * suggest: the bundle's file list IS persisted — `FileSummary.files` on the
 * publish request (`publish-request.service.ts`) carries a `path` per file. The
 * review host embeds the first 16 hex of the review commit sha, so the gate could
 * resolve host → publish request → a file list and answer "does this path name a
 * real file" exactly. The host→request lookup already exists
 * (`findActiveReviewPreviewRows` in that same service reads the host out of the
 * deploy detail, over a population capped by `MAX_CONCURRENT_REVIEW_PREVIEWS`), and
 * any such list is immutable per review sha, so the steady-state cost would be a
 * cache lookup rather than a per-subrequest database round trip.
 *
 * 🔴 BUT NOT FROM `FileSummary.files` — get this right before acting on the lever,
 * because an earlier draft of this paragraph pointed at it. That list is the
 * SUBMITTED SOURCE tree (`Dockerfile`, `block.manifest.json`, `vite.config.ts`,
 * `public/…`), not the served build output: the hashed `/assets/*` names appear in
 * it nowhere, `public/*` is flattened to the root by the build, and source-root
 * files in it are never served at all. A gate consulting it would 401 real assets
 * AND admit paths the server still answers with the shell. The lever needs the
 * BUILD manifest, which is not persisted today — that, not the lookup cost, is
 * what makes it unimplemented.
 *
 * No body is read and no method is enforced: Traefik forwardAuth issues a GET by
 * default but may mirror the original method, so we accept any method.
 */

/** Sec-Fetch-Dest values that mean "this is the top-level document / iframe being
 *  LOADED" (an entry request that may carry the mod `mr` token). An ABSENT header
 *  is treated as entry (fail-safe).
 *
 *  🔴 THIS SET NO LONGER HAS TO BE COMPLETE, and that is deliberate — a dest
 *  allowlist that must be complete is what this change exists to get away from.
 *  `object` and `embed` are NOT here (adding them would 401 a block's own
 *  legitimate `<object data="/assets/doc.pdf">`, a real static subresource), and
 *  neither is any dest the spec adds later. They are covered instead by being
 *  absent from `NON_DOCUMENT_DESTS` below, which confines them to the STRUCTURAL
 *  half of the path allowlist. */
const ENTRY_DESTS = new Set(['document', 'iframe', 'frame', 'nested-document']);

/** `Sec-Fetch-Dest` values that CANNOT create a browsing context — so a shell body
 *  returned to one of these is bytes, never a loaded document.
 *
 *  🔴 FAIL-CLOSED BY CONSTRUCTION: this set does not have to be complete either.
 *  Membership is what EARNS the pragmatic (extension) half of the path allowlist;
 *  a dest that is neither here nor in `ENTRY_DESTS` — `object`, `embed`,
 *  `fencedframe`, a typo, a dest invented after this file was written — is
 *  confined to the structural `/assets/` half, which the static server can never
 *  answer with the shell. So an omission here costs a request a 401 (visible,
 *  fixable) rather than silently admitting a document load.
 *
 *  🔴 THIS IS A CURATED SUBSET, NOT A DERIVATION — do not write "the Fetch list
 *  minus the browsing-context values" here, because that is a completeness claim
 *  and nothing keeps it true. The only
 *  invariant that matters is the one above: nothing in this set may be able to
 *  create a browsing context. Adding a value that can is the one edit that breaks
 *  the ✅ claim; omitting one that cannot costs a 401, and a destination the spec
 *  adds after this was written is omitted by definition — which is why the
 *  omission direction has to be the cheap one. The browsing-context dests to keep
 *  OUT are `document`, `embed`, `frame`, `iframe`, `object`, the legacy
 *  `nested-document`, and `fencedframe`. */
const NON_DOCUMENT_DESTS = new Set([
  'empty', // fetch() / XHR — the dest a cross-origin fetch sends
  'audio',
  'audioworklet',
  'font',
  'image',
  'json',
  'manifest',
  'paintworklet',
  'report',
  'script',
  'serviceworker',
  'sharedworker',
  'style',
  'track',
  'video',
  'webidentity',
  'worker',
  'xslt',
]);

/** The ONE path prefix the sandbox's static server answers from a FIXED file set
 *  and never with the SPA shell: it has its own location whose fallback is a hard
 *  404, so a miss under it is a 404 rather than the shell. Vite emits hashed,
 *  content-addressed build output here. This is the STRUCTURAL half of the
 *  allowlist — membership here cannot be the shell no matter what the bundle
 *  contains. */
const ASSET_PATH_PREFIX = '/assets/';

/** File extensions that name a DOCUMENT rather than a subresource. The pragmatic
 *  half of the path allowlist admits any other extension; these are excluded
 *  because they are shell-shaped — `/index.html` is literally the entry document,
 *  and admitting it would leave the headline path of this whole change open.
 *
 *  🔴 WHY THIS IS A SHORT EXCLUSION AND NOT A LONG ALLOWLIST. An earlier revision
 *  of this file carried a closed ~40-entry allowlist of "static" extensions. It
 *  was removed because it bought nothing and cost real requests:
 *    - It bought nothing. Once a document-capable dest is confined to `/assets/`
 *      (see `NON_DOCUMENT_DESTS`), the extension half only ever decides BYTE
 *      disclosure — and a caller after bytes can always pick a spelling that any
 *      plausible allowlist contains (`/nope.js`). Rejecting `/nope.gibberish`
 *      while admitting `/nope.js` reduces nothing.
 *    - It cost real requests. Measured against that list, a block fetching
 *      `/data.yaml`, `/captions.vtt`, `/clip.mov`, `/scene.obj`, `/tex.ktx2` or
 *      `/model.safetensors` got a 401 in review while working in production —
 *      i.e. the gate would have presented as the reviewed app being broken. The
 *      list's membership was authored, not derived from any enumeration of what
 *      blocks actually ship.
 *  The boundary that matters is still an allowlist and is unchanged: a path must
 *  POSITIVELY look like a file — under `/assets/`, or carrying a file extension —
 *  so the unbounded SPA-fallback set (extensionless paths, directory paths, the
 *  bare root) is rejected by default rather than enumerated. */
const DOCUMENT_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'xht', 'shtml']);

/** Longest `X-Forwarded-Uri` — PATH **AND** QUERY — this gate will look at. Over
 *  that, the request is refused without being parsed at all.
 *
 *  🔴 IT HAS TO COVER THE QUERY. Two different parsers read this header: the path half feeds the normalisation
 *  below (whose cost is linear in SEGMENT COUNT — measured ~17 µs at 2048 B of
 *  single-character segments, against ~0.4 µs for a real asset request), and the
 *  query half feeds `URLSearchParams` in `extractMrToken` — measured at up to
 *  ~362 µs for a maximal query (an earlier draft said ~95 µs, which was the same
 *  shape measured less adversarially; the error was in the safe direction). The
 *  ~16 KB that size derives from is Node's cap on the WHOLE header block, so the
 *  real single-header ceiling is lower. Neither figure moves the bound, which sits
 *  three orders of magnitude below both — measured 11.1x headroom against the
 *  longest legitimate entry URI, 184 B with a real minted token. Both parsers
 *  are reachable unauthenticated, and the PATH arm is what makes the second one
 *  so: before it, only an entry dest got as far as token extraction.
 *
 *  Generous against real traffic — the review entry URL with its token is ~150 B
 *  and a hashed asset filename is well under 512 B — because the failure mode of
 *  a too-tight bound is a 401 that presents as the reviewed app being broken. */
const MAX_FORWARDED_URI_LENGTH = 2048;

/** Node's parser hands these headers over as a STRING even when the request
 *  carried the same name twice — duplicates are comma-joined, and only
 *  `set-cookie` ever becomes an array. So the array branch here is unreachable for
 *  `x-forwarded-*` and `sec-fetch-dest`: it satisfies the declared type, it is not
 *  a defence, and the comma-joined shape it looks like it handles is refused by the
 *  raw-character check in the handler instead. */
function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Extract the `mr` query param from the forwarded original URI (X-Forwarded-Uri
 *  is path?query). Returns undefined if absent / unparseable.
 *
 *  🔴 `indexOf`, not `lastIndexOf`, for the same reason as the path split: the
 *  query starts at the FIRST `?`, and a later one is a legal query character.
 *  Splitting at the last would drop every parameter before it — including `mr`
 *  itself — and 401 a moderator holding a valid token. */
function extractMrToken(forwardedUri: string | undefined): string | undefined {
  if (!forwardedUri) return undefined;
  const q = forwardedUri.indexOf('?');
  if (q < 0) return undefined;
  try {
    const params = new URLSearchParams(forwardedUri.slice(q + 1));
    return params.get('mr') ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalise the forwarded ORIGINAL request path the same way the sandbox's static
 * server does before it picks a location: drop the QUERY (there is no fragment to
 * drop — a fragment is never sent to a server, and a percent-encoded `?`/`#` IS
 * decoded and then refused, rather than becoming a path segment), percent-decode,
 * collapse repeated slashes, and resolve `.` / `..` segments.
 *
 * 🔴 NORMALISING IS WHAT MAKES THE PATH ARM STRUCTURAL RATHER THAN A SPELLING.
 * The gate sees the ORIGINAL URI (X-Forwarded-Uri), never the server's rewritten
 * internal path, so without this a raw `startsWith('/assets/')` test reads
 * `/assets/../index.html` as "under /assets/" while the server resolves it to
 * `/index.html` and answers with the shell. Same for `/%2e%2e/index.html`,
 * `//index.html` and `/./index.html`.
 *
 * Returns `undefined` when there is nothing trustworthy to classify — header
 * absent/empty, not origin-form (so the path cannot be located), an undecodable
 * escape, an embedded NUL, or a `..` that escapes the root. The caller treats
 * every such case as an ENTRY request (fail-closed).
 */
function normalizeForwardedPath(forwardedUri: string | undefined): string | undefined {
  if (!forwardedUri) return undefined;
  // Only `?` splits the query, and only its LITERAL spelling — a `#` is not a
  // delimiter here at all. Both of its spellings are instead refused outright by
  // the decoded-delimiter check below: a literal `#` survives decoding unchanged,
  // `%23` decodes into one, and `includes('#')` catches either.
  //
  // ⚠️ Before that check existed, this comment claimed a stray `#` "would simply
  // land in the path and be rejected, which is fail-safe". That was FALSE in the
  // direction that matters — it landed in the path and was ALLOWED, so
  // `/index.html#.js` read as a `.js` file and `/#/x.js` as a typed path. Two
  // independent reviews found it. The cases pinning both shapes are in the suite;
  // if this check is ever narrowed to `%`-escapes only, they go red.
  //
  // 🔴 `indexOf`, not `lastIndexOf`: the FIRST `?` begins the query, so a second one
  // is query content. Splitting at the last would move query text into the path
  // (`/assets/x.js?a=1?b=2` → a path of `/assets/x.js?a=1`) and, now that a decoded
  // `?` is refused, turn an ordinary parameterised asset fetch into a 401.
  const cut = forwardedUri.indexOf('?');
  const raw = cut >= 0 ? forwardedUri.slice(0, cut) : forwardedUri;
  // Traefik forwards the origin-form request target (path[?query]). Anything else
  // (absolute-form, authority-form, empty) is not a path we can reason about.
  if (!raw.startsWith('/')) return undefined;
  // No length bound here: the caller refuses an over-long X-Forwarded-Uri before
  // this function is reached, and the path is a prefix of it. A second bound here
  // would be dead — nothing could reach it — and a dead guard reads as a live one.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed %-escape — the server rejects these outright, so fail closed.
    // 🔴 DO NOT replace this with `safeDecodeURIComponent` from
    // `src/utils/string-helpers.ts`. It returns the RAW string on a malformed
    // escape, which would turn this fail-closed `undefined` into classifying an
    // UNDECODED path — i.e. it reopens exactly the `%2e%2e` / `%2f` cases the
    // normalisation exists to resolve. The giveaway if someone does it anyway is
    // that the malformed-escape test goes red while the percent-encoded-traversal
    // test stays green, which reads as an over-strict test rather than a reopened
    // hole.
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  // 🔴 A DECODED `?` OR `#` IS REFUSED, and this is INSURANCE, not a fix for a
  // measured hole — read that before "simplifying" it away. `%3F`/`%23` decode into
  // characters that are DELIMITERS in a request target, so whether
  // `/%3F/../assets/x.js` names an asset or the shell depends on whether the server
  // re-dispatches the decoded byte through its path parser. Measured on the serving
  // line: it does NOT. All of `/%3F/../assets/x.js`,
  // `/index.html%3F/../assets/x.js` and `/%23/../assets/x.js` resolve to
  // `/assets/x.js` and are served the asset — exactly what this function
  // classifies them as — while the `%2F` control DOES become a separator. The two
  // agree today; there is no bypass here.
  //
  // It is refused anyway, because the alternative is for the structural half's
  // guarantee to rest on that agreement CONTINUING, in a config that lives in
  // another repo and is edited independently. Nothing legitimate carries a decoded
  // delimiter in a path — no positive control in the suite does — so the cost is a
  // 401 for a filename nobody ships, and the gate stops having to be right about a
  // parser it does not own.
  if (decoded.includes('?') || decoded.includes('#')) return undefined;
  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue; // collapses `//` and `/./`
    if (segment === '..') {
      if (segments.length === 0) return undefined; // escapes the root
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  // Everything collapsed away: the root. Returned explicitly rather than falling
  // out of the join, so the trailing-separator logic below has no dead sub-clause
  // guarding against it (a `segments.length > 0` test there could not change any
  // decision — `//` and `/` classify identically — which makes it unkillable by
  // any test and therefore noise).
  if (segments.length === 0) return '/';
  // A trailing separator means "directory", which the server resolves via its
  // index/fallback to the shell. Preserve it so the classifier sees an EMPTY
  // final segment and rejects, rather than reading the parent dir's name.
  const endsAsDirectory =
    decoded.endsWith('/') || decoded.endsWith('/.') || decoded.endsWith('/..');
  return `/${segments.join('/')}${endsAsDirectory ? '/' : ''}`;
}

/**
 * STRUCTURAL half of the PATH arm: a path the static server answers from a fixed
 * file set or 404s, never with the shell, whatever the bundle contains.
 *
 * 🔴 The prefix is ANCHORED AT THE ROOT on purpose. The server's asset location is
 * a root-anchored prefix, so `/<base>/assets/x` is NOT in it — that path is served
 * by the catch-all location and CAN be answered with the shell. Matching any
 * `…/assets/` segment would therefore admit shell-reachable paths to the dests
 * that are confined to this half, which is exactly the hole this split closes.
 * The asset location is a single root-anchored prefix in the shared served config,
 * not generated per block, so this half is available to every block regardless of
 * how it was built. Consequence worth knowing: a block built with a NON-ROOT base
 * path emits its assets outside that prefix, so it gets only the extension half —
 * which costs it an `<object data="/<base>/assets/x.pdf">` (401'd rather than
 * served) and nothing else. ⚠️ It does NOT weaken the ✅ claim: a document-capable
 * dest never reaches the extension half under any base path, so the claim still
 * rests on structural confinement. What rests on `DOCUMENT_EXTENSIONS` is the byte
 * residual.
 */
function isStructuralAssetPath(path: string): boolean {
  return path.startsWith(ASSET_PATH_PREFIX);
}

/**
 * PRAGMATIC half of the PATH arm: does this NORMALISED path positively look like a
 * file of a non-document type?
 *
 * Rejects `/` and every directory path (empty final segment), every extensionless
 * path (`/slug` — note the review ENTRY url is exactly this shape), dotfiles, and
 * the document extensions. Those are the shapes the SPA fallback turns into the
 * shell, and they are rejected by DEFAULT: the test is "does it name a typed
 * file", not "is it one of the known shell paths".
 */
function hasNonDocumentExtension(path: string): boolean {
  const segment = path.slice(path.lastIndexOf('/') + 1);
  const dot = segment.lastIndexOf('.');
  // dot < 0 → extensionless (`/slug`); dot === 0 → dotfile (`/.env`); segment
  // empty → directory path. None of those can be positively identified as a file.
  if (dot <= 0) return false;
  // `getFileExtension` in `src/utils/string-helpers.ts` computes the same
  // extension FROM THE FINAL PATH SEGMENT (verified equivalent on every shape that
  // matters here, including `foo.`, `.env` and `index.html;a=b`) — note it takes a
  // whole value, so handed a PATH it answers `getFileExtension('/foo/.env') ===
  // 'env'`, which would flip a nested dotfile from 401 to 200. It is deliberately
  // NOT used: its reject
  // cases return `''`, so the `dot <= 0` branch above would become IMPLICIT —
  // satisfied only by the regex on the next line rejecting an empty string — and
  // this is the site where the dotfile / directory / extensionless reasoning has
  // to be readable. The shared thing would be a string utility, not this gate's
  // rule, so reusing it consolidates nothing while coupling a 401 decision to a
  // helper owned by the upload paths.
  const extension = segment.slice(dot + 1).toLowerCase();
  // 🔴 The extension must be a PLAUSIBLE extension token, or excluding the
  // document extensions is walkable by spelling: `/index.html;a=b` names no file
  // (the server answers it from the fallback, i.e. with the shell) while its
  // trailing component is not `html`, so a bare set-membership test would admit
  // it. Requiring an alphanumeric token also rejects `/foo.` and any decoded
  // junk tail.
  if (!/^[a-z0-9]{1,16}$/.test(extension)) return false;
  return !DOCUMENT_EXTENSIONS.has(extension);
}

export default withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Traefik forwardAuth mirrors the original request headers (lowercased by Node).
  const forwardedHost = firstHeader(req.headers['x-forwarded-host']);
  const forwardedUri = firstHeader(req.headers['x-forwarded-uri']);
  const secFetchDest = firstHeader(req.headers['sec-fetch-dest']);

  // Fail-closed: without the review host we can't bind/verify anything.
  if (!forwardedHost) {
    res.setHeader('X-Mod-Gate-Reason', 'missing-host');
    res.status(401).json({ error: 'Missing review host' });
    return;
  }

  // Every 401 below also carries `X-Mod-Gate-Reason` — one of `missing-host`,
  // `unclassifiable-uri`, `shell-path` or `entry-dest`. 🔴 WHY: a refusal here is
  // INVISIBLE exactly where it costs most. A subresource this gate declines does
  // not surface an error to the moderator — the element simply does not render, or
  // the block silently misses a file — and that reads as the submission being
  // broken rather than as the gate declining. The header names which check refused,
  // so the answer is one network-panel row away instead of a bisect. It is
  // diagnostic only: computed after the decision from booleans the decision already
  // used, and it can never change one. Traefik forwards headers on a non-2xx auth
  // response, which is what makes it reach the browser at all — the same mechanism
  // the 302-strip lever above would have relied on.

  // 🔴 TWO CHECKS ON THE RAW HEADER, AHEAD OF BOTH PARSERS. These are the only
  // checks that may precede the classification, because a header this shape must
  // not be parsed at all — neither by the path normalisation nor by
  // `extractMrToken`'s `URLSearchParams`. Refusing here rather than inside either
  // parser is what makes them cover the QUERY as well as the path.
  //
  // (1) LENGTH — see the constant for the measurements.
  // (2) 🔴 CHARACTERS A REQUEST TARGET CANNOT CONTAIN: space, tab, DEL and the C0
  //     controls. A real request target never carries them (the static server
  //     answers 400 — measured — and so does Go's HTTP parser, while `%20` is
  //     unaffected), so nothing legitimate is refused. What it closes is the shape
  //     a DUPLICATED forwarded header takes: Node joins duplicates of these headers
  //     into ONE comma-SPACE-separated string rather than an array, and the
  //     classifier reads such a concatenation fail-OPEN in both halves — the
  //     structural half satisfied by a leading `/assets/…` value, the extension
  //     half by a trailing `….js` one. Refusing the whole string removes the
  //     question of which value wins, rather than answering it.
  //
  //     ⚠️ TWO HONEST LIMITS, so this is not read as wider than it is. Most of the
  //     class is unreachable: Node's own header parser refuses 0x00–0x08, 0x0a–0x1f
  //     and 0x7f before `req.headers` exists, so only SPACE and TAB can actually
  //     arrive here. The rest is kept as cheap redundancy, not as live defence —
  //     which is why the test for this uses a raw tab rather than a byte that
  //     cannot reach the handler. And it closes ONE joiner's shape, not
  //     concatenation in general: every byte ≥ 0x80 passes, so a joiner that used
  //     a bare comma would not be caught — Node's does not.
  if (
    forwardedUri != null &&
    (forwardedUri.length > MAX_FORWARDED_URI_LENGTH || /[\x00-\x20\x7f]/.test(forwardedUri))
  ) {
    res.setHeader('X-Mod-Gate-Reason', 'unclassifiable-uri');
    res.status(401).json({ error: 'Moderator review session required' });
    return;
  }

  // ── Classify: ENTRY if EITHER arm says so (see the header comment). ─────────
  // (a) DEST arm. An entry dest, or no usable header at all, is an entry request.
  //     An EMPTY header value is semantically the same as an absent one, so it
  //     takes the same fail-safe branch; and the comparison is case-folded so a
  //     dest cannot dodge this arm by capitalisation.
  const dest = secFetchDest?.trim().toLowerCase() || undefined;
  const destIsEntry = dest == null || ENTRY_DESTS.has(dest);
  // (b) PATH arm — anything the static server could answer with the SPA shell.
  //     Evaluated on the normalised ORIGINAL path, and fail-closed when the path
  //     cannot be determined. This arm is what actually gates the entry document:
  //     the dest is caller-supplied, so a cross-origin `fetch()` (dest `empty`)
  //     passes arm (a) trivially.
  //
  //     Which HALF of the allowlist applies depends on the dest, and that is the
  //     load-bearing part: only a dest that cannot create a browsing context earns
  //     the extension half, because an extension-allowlisted path absent from the
  //     bundle IS answered with the shell. Everything else — `object`, `embed`, a
  //     dest we do not recognise — is confined to the structural half.
  //
  // 🔴 The PATH arm is evaluated INSIDE this branch, not alongside arm (a). An
  // entry dest already demands the token, so its verdict would be computed and
  // never read — and normalisation is the only non-trivial work this handler does
  // (measured ~56× the whole-handler cost on a long path). Keep the call here; do
  // not hoist it next to `destIsEntry` for symmetry. An `&&` does not help: it
  // short-circuits reading the boolean, not computing it.
  // Which check refuses, carried to the 401 below. 🔴 ASSIGNED ON EVERY PATH
  // THROUGH THIS BLOCK rather than re-derived from `destIsEntry` afterwards: the
  // earlier version inferred it from that one boolean, which cannot tell a shell
  // path from a path it could not classify AT ALL, so a URI literally under
  // `/assets/` (`/assets/a%23b.png`) was reported as `shell-path` — a label
  // contradicting the structural rule stated in this file. `unclassifiable-uri`
  // is deliberately the SAME label the raw-header checks use: it is the same
  // answer, and spelling it two ways depending on which check caught it is the
  // thing that made the header misleading.
  let reason: 'entry-dest' | 'shell-path' | 'unclassifiable-uri' = 'entry-dest';

  if (!destIsEntry) {
    const normalizedPath = normalizeForwardedPath(forwardedUri);
    if (normalizedPath == null) {
      reason = 'unclassifiable-uri';
    } else if (
      isStructuralAssetPath(normalizedPath) ||
      // `dest != null` is TYPE NARROWING, not a runtime guard: inside this branch
      // a null dest is impossible (it would have made `destIsEntry` true), so no
      // test can kill it. Kept because `Set.has` needs the narrowed type; do not
      // read it as a check.
      (dest != null && NON_DOCUMENT_DESTS.has(dest) && hasNonDocumentExtension(normalizedPath))
    ) {
      // SUBRESOURCE — NEITHER arm flagged it → allow, no token. The CHIPS
      // subresource-cookie gate can't be set (Traefik doesn't forward the 2xx
      // Set-Cookie), so these are served without per-request auth; that is the
      // accepted tradeoff, with the residual stated in the header comment.
      res.status(200).json({ ok: true, via: 'subresource' });
      return;
    } else {
      reason = 'shell-path';
    }
  }

  // ENTRY (document/iframe/frame/nested-document, or ABSENT Sec-Fetch-Dest which
  // is treated as entry, fail-safe) → require a valid `mr` token bound to this host.
  const token = extractMrToken(forwardedUri);
  const result = verifyReviewAccessToken(token, forwardedHost);
  if (result.ok && result.modUserId != null) {
    res.setHeader('X-Mod-Id', String(result.modUserId));
    res.status(200).json({ ok: true, via: 'token' });
    return;
  }

  // Entry with no/invalid/expired/forged/host-mismatched token → 401. Fail-closed.
  res.setHeader('X-Mod-Gate-Reason', reason);
  res.status(401).json({ error: 'Moderator review session required' });
});

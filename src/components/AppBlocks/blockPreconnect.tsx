// App Blocks — the SSR resource hint for the block origin.
//
// WHY THIS EXISTS
// ---------------
// `/apps/run/<slug>` embeds a cross-origin iframe at `https://<slug>.civit.ai`.
// The browser cannot start the DNS + TCP + TLS handshake for that origin until
// the iframe element exists, and the iframe only mounts on the FIRST CLIENT
// RENDER AFTER HYDRATION — hundreds of milliseconds after the HTML head was
// parsed. `preconnect` moves the handshake into that gap, so by the time the
// frame's `src` is set the connection is already warm.
//
// 🔴 THE HINT MUST BE EMITTED FROM THE PAGE'S SSR `<Head>`, NOT FROM THE HOST
// COMPONENT. Emitting it from `PageBlockHost` would put it on the same client
// render that mounts the iframe, which is precisely the moment the browser
// starts the connection anyway — the hint would be a no-op that looks shipped.
// The head is the only place with a head start to give.
//
// 🔴 `crossorigin` IS REQUIRED, AND ITS ABSENCE IS SILENT. A connection is
// pooled by (origin, credentials-mode). The block frame's own subresources are
// fetched as CORS requests (`<script type="module" crossorigin>`), so they use
// the ANONYMOUS pool. A `preconnect` without `crossorigin` warms the
// credentialled pool instead: the browser opens a connection, never reuses it,
// and the page pays a connection it does not use while still paying the
// handshake it meant to avoid. Nothing errors and no devtools warning fires —
// which is why the test suite asserts this attribute specifically.
//
// 🔴 NO SPECULATIVE COST HERE, and that is what makes it safe. A viewer on this
// route has already committed to launching this one app, so the connection is
// certain to be used. That reasoning does NOT extend to the `/apps` store grid:
// hover-preconnecting 24 cards is a connection storm bought with a weak intent
// signal, and the card view model does not even carry the origin. Deliberately
// not done.

import React from 'react';

/**
 * The origin to preconnect to, derived from the iframe URL the page already
 * resolved server-side.
 *
 * 🔴 DERIVED FROM `iframeSrc`, NEVER RE-BUILT FROM THE SLUG. `https://<slug>.<domain>`
 * is assembled server-side by `stampCanonicalIframeSrc`, and `iframeSrc` is
 * already a prop on this page. Re-deriving it client-side would create a SECOND
 * source of truth for the block origin, and the failure mode of the two
 * disagreeing is a hint that warms the wrong host — again, silently: the page
 * still works, it is just slower than before, which no test and no alert sees.
 *
 * Returns `null` for anything that is not an absolute http(s) URL. A malformed
 * or relative `src` is a real possibility on a dev/preview surface, and a
 * missing hint is a non-event whereas a thrown `TypeError` from `new URL()`
 * during SSR would 500 the whole page. The hint must stay strictly subordinate
 * to the thing it accelerates.
 */
export function blockPreconnectOrigin(iframeSrc: string | null | undefined): string | null {
  if (typeof iframeSrc !== 'string' || iframeSrc.length === 0) return null;
  try {
    const url = new URL(iframeSrc);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The `<link rel="preconnect">` element for a block's origin, or `null`.
 *
 * Returns the ELEMENT rather than rendering it, so the page can place it inside
 * `next/head` (which inspects its children's `type` and only accepts real head
 * tags — a wrapper component would be dropped) while the attributes stay
 * assertable in the node unit project, which is the tier CI runs.
 */
export function blockPreconnectHint(
  iframeSrc: string | null | undefined
): React.ReactElement | null {
  const origin = blockPreconnectOrigin(iframeSrc);
  if (origin === null) return null;
  // `crossOrigin="anonymous"` renders `crossorigin="anonymous"`. The empty-string
  // form is equivalent per spec, but spelling it out is what makes a reviewer
  // see the credentials mode being chosen rather than read it as boilerplate.
  return <link key="app-block-preconnect" rel="preconnect" href={origin} crossOrigin="anonymous" />;
}

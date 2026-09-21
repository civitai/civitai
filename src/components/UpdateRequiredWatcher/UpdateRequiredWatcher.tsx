import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { GENERATION_UPDATE_HEADER } from '~/shared/constants/generation.constants';

const UpdateRequiredModal = dynamic(
  () => import('~/components/UpdateRequiredWatcher/UpdateRequiredModal')
);

let originalFetch: typeof window.fetch | undefined;

/**
 * True when a request targets our OWN origin.
 *
 * Both update headers are set exclusively by tRPC middleware, so they only ever ride
 * same-origin `/api/trpc/…` responses. Everything else on the page — ad, analytics and embed
 * requests — can skip the header inspection entirely.
 *
 * Relative URLs are first-party by definition. FAILS OPEN: anything unparseable or of an
 * unexpected shape is treated as first-party, so an exotic input can never silently disable the
 * update prompt.
 */
export function isFirstPartyRequest(input: unknown, origin: string): boolean {
  try {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.href
        : typeof (input as Request | undefined)?.url === 'string'
        ? (input as Request).url
        : '';
    if (!url) return true;

    // Fast paths, so the common cases never pay for a URL parse. This runs on EVERY fetch the
    // document makes, and `new URL` is linear in the length of its input — a multi-KB ad URL or
    // a large `data:` payload would otherwise be parsed in full just to be thrown away.
    //
    // A root-relative path (`/api/trpc/…`, the client tRPC url) is ours — but ONLY once the
    // second character cannot turn it into an authority. Three spellings can, and all three are
    // handed to the parser instead: `/` (protocol-relative), `\` (the URL parser treats it as a
    // separator for http(s)), and any C0 control or space (stripped BEFORE parsing, so it can
    // expose one of the other two). These are equivalence bugs, not theoretical — the shortcut
    // must agree with the parse it replaces, and `isFirstPartyRequest.fastPathMatchesParse` in
    // the tests fuzzes exactly that.
    const first = url.charCodeAt(0);
    const second = url.charCodeAt(1); // NaN for a 1-char url, which fails every test below
    if (first === 47 /* / */ && !(second === 47 || second === 92 || second <= 0x20)) return true;
    // `data:` always has an opaque origin, so it can never be ours. Case-insensitive: the scheme
    // is, and a `DATA:` url would otherwise pay the full linear parse to reach the same answer.
    if ((first === 100 /* d */ || first === 68) /* D */ && /^data:/i.test(url)) return false;

    return new URL(url, origin).origin === origin;
  } catch {
    return true;
  }
}

/**
 * Builds the `window.fetch` replacement that surfaces client-update prompts carried on response
 * headers. Exported for tests; the component installs it once per page load.
 *
 * 🔴 This patches fetch for the WHOLE document, so it sits on the call stack of every request
 * any script on the page makes. Two consequences:
 *   - Third-party requests are returned untouched: the header reads are skipped, along with a
 *     promise allocation and a microtask tick. That saving is real but small (~150ns), and for an
 *     ABSOLUTE url the origin check that decides it costs more than the reads it saves. Measured,
 *     so nobody re-derives it: this is a correctness change on that branch, not a CPU win. The
 *     win is on the first-party branch, which short-circuits before any parse.
 *   - This wrapper's stack frame is present on every fetch rejection regardless of who initiated
 *     it, so it is NOT evidence that our own code failed. (Measured in Chromium: a browser builds
 *     a `Failed to fetch` stack from the synchronous call stack at the moment `fetch()` runs, so
 *     NO form of a global patch — await, .then, direct passthrough, Reflect.apply — can keep
 *     itself off it.) The browser-exception classifier therefore excludes it by name — see
 *     `GLOBAL_FETCH_WRAPPER_PATH_RES` in `src/utils/faro/classifyException.ts`, and keep the two
 *     in sync if this file moves or is renamed.
 */
export function createUpdateAwareFetch(
  baseFetch: typeof window.fetch,
  origin: string
): typeof window.fetch {
  let warned = false;
  /** Tracks the version we last showed a generation update modal for */
  let generationWarnedVersion: string | undefined;

  return (...args) => {
    if (!isFirstPartyRequest(args[0], origin)) return baseFetch(...args);

    return baseFetch(...args).then((response) => {
      // Generation-panel-specific update.
      const genVersion = response.headers.get(GENERATION_UPDATE_HEADER);
      if (genVersion && genVersion !== generationWarnedVersion) {
        const notes = response.headers.get('x-generation-update-notes');
        dialogStore.trigger({
          id: 'update-required-modal',
          component: UpdateRequiredModal,
          props: {
            title: 'Generator Update Available',
            description: notes || 'Please refresh to get the latest generator updates.',
          },
        });
        generationWarnedVersion = genVersion;
      }

      // Global update required — skip if the generation-specific header already handled it.
      if (response.headers.has('x-update-required') && !warned && !generationWarnedVersion) {
        dialogStore.trigger({ id: 'update-required-modal', component: UpdateRequiredModal });
        warned = true;
      }

      return response;
    });
  };
}

/**
 * Installs the wrapper on a window. Idempotent: the module-level `originalFetch` makes every call
 * after the first a no-op, so a remount or a Fast Refresh cannot stack wrappers.
 *
 * Exported so the install itself is testable. It is a seam worth pinning: passing
 * `location.href` instead of `location.origin` here would make EVERY request look third-party and
 * silently disable both update prompts, while the factory's own tests stayed green.
 */
export function installUpdateAwareFetch(win: Pick<Window, 'fetch' | 'location'>): void {
  if (originalFetch) return;
  originalFetch = win.fetch;
  win.fetch = createUpdateAwareFetch(originalFetch, win.location.origin);
}

export function UpdateRequiredWatcher({ children }: { children: React.ReactElement }) {
  // Intercept fetch to surface client-update prompts carried on response headers. (The legacy
  // session-refresh signal was removed in the NextAuth cutover — session invalidation now propagates via
  // websocket signals, not a response header + next-auth update().)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    installUpdateAwareFetch(window);
  }, []);

  return children;
}

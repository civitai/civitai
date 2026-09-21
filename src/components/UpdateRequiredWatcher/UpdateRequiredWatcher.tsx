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
 *   - Third-party requests are passed straight through — they can never carry our headers, and
 *     inspecting them is pure work on a hot path.
 *   - This wrapper's stack frame is therefore present on every fetch rejection regardless of who
 *     initiated it, so it is NOT evidence that our own code failed. The browser-exception
 *     classifier excludes it by name for that reason — see `GLOBAL_FETCH_WRAPPER_PATH_RES` in
 *     `src/utils/faro/classifyException.ts`, and keep the two in sync if this file moves.
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

export function UpdateRequiredWatcher({ children }: { children: React.ReactElement }) {
  // Intercept fetch to surface client-update prompts carried on response headers. (The legacy
  // session-refresh signal was removed in the NextAuth cutover — session invalidation now propagates via
  // websocket signals, not a response header + next-auth update().)
  useEffect(() => {
    if (originalFetch || typeof window === 'undefined') return;
    originalFetch = window.fetch;
    window.fetch = createUpdateAwareFetch(originalFetch, window.location.origin);
  }, []);

  return children;
}

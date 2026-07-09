import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { GENERATION_UPDATE_HEADER } from '~/shared/constants/generation.constants';

const UpdateRequiredModal = dynamic(
  () => import('~/components/UpdateRequiredWatcher/UpdateRequiredModal')
);

let warned = false;
/** Tracks the version we last showed a generation update modal for */
let generationWarnedVersion: string | undefined;
let originalFetch: typeof window.fetch | undefined;

export function UpdateRequiredWatcher({ children }: { children: React.ReactElement }) {
  // Intercept fetch to surface client-update prompts carried on response headers. (The legacy
  // session-refresh signal was removed in the NextAuth cutover — session invalidation now propagates via
  // websocket signals, not a response header + next-auth update().)
  useEffect(() => {
    if (originalFetch || typeof window === 'undefined') return;
    originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch!(...args);

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
    };
  }, []);

  return children;
}

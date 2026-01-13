import { useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useSession } from 'next-auth/react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { SESSION_REFRESH_HEADER } from '~/shared/constants/auth.constants';

const UpdateRequiredModal = dynamic(
  () => import('~/components/UpdateRequiredWatcher/UpdateRequiredModal')
);

let warned = false;
let originalFetch: typeof window.fetch | undefined;
let sessionRefreshPending = false;

export function UpdateRequiredWatcher({ children }: { children: React.ReactElement }) {
  const { update } = useSession();
  const updateRef = useRef(update);
  updateRef.current = update;

  // TODO - someday, this kind of logic should probably be stored in an error boundary
  useEffect(() => {
    if (originalFetch || typeof window === 'undefined') return;
    originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch!(...args);

      // Handle update required
      if (response.headers.has('x-update-required') && !warned) {
        dialogStore.trigger({
          id: 'update-required-modal',
          component: UpdateRequiredModal,
        });
        warned = true;
      }

      // Handle session refresh signal from server
      // When the server updates session data, it signals that the client's cookie needs refreshing
      if (response.headers.has(SESSION_REFRESH_HEADER) && !sessionRefreshPending) {
        sessionRefreshPending = true;
        // Use update() to refresh session and update React state
        // This triggers the JWT callback which fetches fresh user data and updates the cookie
        updateRef.current?.().finally(() => {
          sessionRefreshPending = false;
        });
      }

      return response;
    };
  }, []);

  return children;
}

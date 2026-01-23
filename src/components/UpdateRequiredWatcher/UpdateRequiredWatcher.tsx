import { useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useSession } from 'next-auth/react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { SESSION_REFRESH_HEADER, SESSION_REFRESH_COOKIE } from '~/shared/constants/auth.constants';

const UpdateRequiredModal = dynamic(
  () => import('~/components/UpdateRequiredWatcher/UpdateRequiredModal')
);

let warned = false;
let originalFetch: typeof window.fetch | undefined;
let sessionRefreshPending = false;

/** Clear the session refresh cookie after successful refresh */
function clearSessionRefreshCookie() {
  document.cookie = `${SESSION_REFRESH_COOKIE}=; Path=/; Max-Age=0`;
}

/** Check if the session refresh cookie is present */
function hasSessionRefreshCookie() {
  return document.cookie.split(';').some((c) => c.trim().startsWith(`${SESSION_REFRESH_COOKIE}=`));
}

export function UpdateRequiredWatcher({ children }: { children: React.ReactElement }) {
  const { update } = useSession();
  const updateRef = useRef(update);
  updateRef.current = update;

  // Check for session refresh cookie on mount (handles page refresh case)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (hasSessionRefreshCookie() && !sessionRefreshPending) {
      sessionRefreshPending = true;
      updateRef.current?.().finally(() => {
        sessionRefreshPending = false;
        clearSessionRefreshCookie();
      });
    }
  }, []);

  // Intercept fetch to handle session refresh signals
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
          clearSessionRefreshCookie();
        });
      }

      return response;
    };
  }, []);

  return children;
}

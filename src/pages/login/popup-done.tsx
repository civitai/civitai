import { useEffect } from 'react';
import { LOGIN_POPUP_CHANNEL, LOGIN_POPUP_DONE } from '~/utils/auth-helpers';

// Login-completion landing, reached by EITHER the OAuth popup OR the email magic-link tab (which has no opener).
// By now the session cookie is set on this domain (the auth-code flow's /api/auth/callback minted it on this
// origin). We broadcast on a same-origin channel so the ORIGINATING tab navigates back to where login
// started (and closes the popup it owns). For the OAuth popup the opener closes us; for the email magic-link tab
// (no same-origin opener) we send ourselves to that same `cb` page so the user lands where they began.
export default function LoginPopupDonePage() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const channel = new BroadcastChannel(LOGIN_POPUP_CHANNEL);
      channel.postMessage({ type: LOGIN_POPUP_DONE });
      channel.close();
    } catch {
      /* BroadcastChannel unsupported — the email-tab redirect below still lands the user on their page */
    }

    let hasSameOriginOpener = false;
    try {
      hasSameOriginOpener =
        !!window.opener && window.opener.location.origin === window.location.origin;
    } catch {
      hasSameOriginOpener = false; // cross-origin opener (or none) → throws
    }
    if (!hasSameOriginOpener) {
      // Email magic-link tab: go to where login started.
      const cb = new URLSearchParams(window.location.search).get('cb');
      window.location.replace(cb && cb.startsWith('/') ? cb : '/');
    }
  }, []);

  return (
    <div className="flex h-screen items-center justify-center text-sm text-gray-500">
      Signing you in…
    </div>
  );
}

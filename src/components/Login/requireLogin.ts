import type React from 'react';
import type { LoginRedirectReason } from '~/utils/login-helpers';
import { openLoginPopup } from '~/utils/auth-helpers';

// Gate an action behind login. When signed out, open the hub login (auth.civitai.com) in a popup window — the
// hub owns the login UI + sets the session cookie; we just reload once it's done. (Replaces the old in-page
// LoginModal.) `message` is accepted for call-site compatibility but no longer drives an in-app modal; `reason`
// rides to the hub so it can track the LoginRedirect (the funnel analytics LoginContent used to emit).
export function requireLogin({
  uiEvent,
  returnUrl,
  reason,
  cb,
}: {
  uiEvent: React.UIEvent;
  message?: React.ReactNode;
  reason?: LoginRedirectReason;
  returnUrl?: string;
  cb: () => void;
}) {
  if (typeof window !== 'undefined' && !window.isAuthed) {
    uiEvent.preventDefault();
    uiEvent.stopPropagation();
    uiEvent.nativeEvent.stopImmediatePropagation();
    const here = window.location.pathname + window.location.search + window.location.hash;
    openLoginPopup(returnUrl ?? here, reason);
  } else {
    cb();
  }
}

import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { LoginRedirectReason } from '~/utils/login-helpers';

export function requireLogin({
  uiEvent,
  message,
  reason,
  returnUrl,
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
    dialogStore.trigger({
      component: dynamic(() => import('~/components/Login/LoginModal'), { ssr: false }),
      props: {
        message,
        reason,
        returnUrl,
      },
    });
  } else {
    cb();
  }
}

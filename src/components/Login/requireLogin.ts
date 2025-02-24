import { dialogStore } from '~/components/Dialog/dialogStore';
import LoginModal from '~/components/Login/LoginModal';
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
  console.log({ isAuthed: window.isAuthed });
  if (typeof window !== 'undefined' && !window.isAuthed) {
    uiEvent.preventDefault();
    uiEvent.stopPropagation();
    uiEvent.nativeEvent.stopImmediatePropagation();
    dialogStore.trigger({
      component: LoginModal,
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

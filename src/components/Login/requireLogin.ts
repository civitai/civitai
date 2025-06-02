import { openLoginModal } from '~/components/Dialog/dialog-registry';
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
    openLoginModal({
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

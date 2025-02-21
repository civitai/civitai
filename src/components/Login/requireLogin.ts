import { dialogStore } from '~/components/Dialog/dialogStore';
import LoginModal from '~/components/Login/LoginModal';
import type { LoginRedirectReason } from '~/utils/login-helpers';

export function requireLogin({
  message,
  reason,
  returnUrl,
  cb,
}: {
  message?: React.ReactNode;
  reason?: LoginRedirectReason;
  returnUrl?: string;
  cb: () => void;
}) {
  if (typeof window !== 'undefined' && !window.isAuthed) {
    dialogStore.trigger({
      component: LoginModal,
      props: {
        message,
        reason,
        returnUrl,
      },
    });
  } else cb();
}

import { dialogStore } from '~/components/Dialog/dialogStore';
import LoginModal from '~/components/Login/LoginModal';
import { LoginRedirectReason, loginRedirectReasons } from '~/utils/login-helpers';

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
        message:
          (reason ? loginRedirectReasons[reason] : message) ??
          'You must be logged in to perform this action',
        returnUrl,
      },
    });
  } else cb();
}

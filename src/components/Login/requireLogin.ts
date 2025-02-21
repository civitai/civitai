import { dialogStore } from '~/components/Dialog/dialogStore';
import LoginModal from '~/components/Login/LoginModal';

export function requireLogin({ message, cb }: { message?: React.ReactNode; cb: () => void }) {
  if (typeof window !== 'undefined' && !window.isAuthed) {
    dialogStore.trigger({
      component: LoginModal,
      props: {
        message,
      },
    });
  } else cb();
}

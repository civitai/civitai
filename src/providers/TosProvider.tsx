import { signIn, useSession } from 'next-auth/react';
import { useEffect } from 'react';
import { closeModal, openContextModal } from '@mantine/modals';
import { useRouter } from 'next/router';

export function TosProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    // if (!session.data?.user) return;
    if (status !== 'authenticated' || router.pathname.startsWith('/content')) return;
    if (!session?.user?.tos || !session.user.email || !session.user.username) {
      closeModal('onboarding');
      openContextModal({
        modal: 'onboarding',
        title: 'Your Account',
        withCloseButton: false,
        closeOnClickOutside: false,
        closeOnEscape: false,
        innerProps: {},
      });
    }
  }, [status, session?.user?.tos, router.pathname, session?.user?.email, session?.user?.username]);

  // https://next-auth.js.org/tutorials/refresh-token-rotation#client-side
  useEffect(() => {
    if (session?.error === 'RefreshAccessTokenError') {
      signIn();
    }
  }, [session]);

  return <>{children}</>;
}

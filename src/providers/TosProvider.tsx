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
    if (
      !session?.user?.tos ||
      !session.user.email ||
      !session.user.username ||
      !session.user.onboarded
    ) {
      closeModal('onboarding');
      openContextModal({
        modal: 'onboarding',
        withCloseButton: false,
        closeOnClickOutside: false,
        closeOnEscape: false,
        fullScreen: true,
        innerProps: {},
      });
    }
  }, [
    status,
    session?.user?.tos,
    router.pathname,
    session?.user?.email,
    session?.user?.username,
    session?.user?.onboarded,
  ]);

  // https://next-auth.js.org/tutorials/refresh-token-rotation#client-side
  useEffect(() => {
    if (session?.error === 'RefreshAccessTokenError') {
      signIn();
    }
  }, [session]);

  return <>{children}</>;
}

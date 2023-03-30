import { signIn, useSession } from 'next-auth/react';
import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Modal } from '@mantine/core';
const DynamicOnboardingModal = dynamic(
  () => import('~/components/OnboardingModal/OnboardingModal')
);

export function TosProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();

  // https://next-auth.js.org/tutorials/refresh-token-rotation#client-side
  useEffect(() => {
    if (session?.error === 'RefreshAccessTokenError') {
      signIn();
    }
  }, [session]);

  const opened =
    session?.user && (!session?.user?.tos || !session.user.username || !session.user.onboarded);

  return (
    <>
      {children}
      {opened && (
        <Modal
          opened
          onClose={() => undefined}
          closeOnEscape={false}
          withCloseButton={false}
          closeOnClickOutside={false}
          fullScreen
        >
          <DynamicOnboardingModal />
        </Modal>
      )}
    </>
  );
}

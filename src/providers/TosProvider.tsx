import { signIn, useSession } from 'next-auth/react';
import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Modal } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
const DynamicOnboardingModal = dynamic(() => import('~/components/Onboarding/OnboardingModal'));

export function TosProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const currentUser = useCurrentUser();

  // https://next-auth.js.org/tutorials/refresh-token-rotation#client-side
  useEffect(() => {
    if (session?.error === 'RefreshAccessTokenError') {
      signIn();
    }
  }, [session]);

  const opened =
    currentUser &&
    !currentUser.bannedAt &&
    (!currentUser.tos ||
      !currentUser.email ||
      !currentUser.username ||
      !!currentUser.onboardingSteps?.length);

  return (
    <>
      {opened ? (
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
      ) : (
        children
      )}
    </>
  );
}

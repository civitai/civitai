import { useSession } from 'next-auth/react';
import { useEffect } from 'react';
import { openContextModal } from '@mantine/modals';
import { useRouter } from 'next/router';

export function TosProvider({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    // if (!session.data?.user) return;
    if (session.status !== 'authenticated' || router.pathname.startsWith('/content')) return;
    if (!session.data?.user?.tos) {
      openContextModal({
        modal: 'onboarding',
        withCloseButton: false,
        closeOnClickOutside: false,
        closeOnEscape: false,
        innerProps: {},
      });
    }
  }, [session.status, session.data?.user?.tos, router.pathname]);

  return <>{children}</>;
}

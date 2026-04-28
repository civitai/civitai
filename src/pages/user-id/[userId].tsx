import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { Center, Loader, Stack, Text } from '@mantine/core';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { impersonateUser } from '~/components/Moderation/impersonate.utils';
import { Meta } from '~/components/Meta/Meta';
import { dbRead } from '~/server/db/client';
import { readOgModCookie } from '~/server/auth/og-mod-cookie';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

type PageProps = {
  targetUserId: number;
  targetUsername: string;
};

export const getServerSideProps = createServerSideProps<PageProps>({
  useSSG: false,
  useSession: true,
  resolver: async ({ session, ctx }) => {
    const { userId } = ctx.params as { userId: string };
    const loginAs = ctx.query.loginAs;
    const wantsLoginAs = loginAs === '1' || loginAs === 'true';

    // Mod authority: current session mod, or a signed og-mod cookie whose user is
    // a moderator (happens when the session is a mod that is currently impersonating
    // a non-mod user).
    let hasModAuthority = Boolean(session?.user?.isModerator);
    if (!hasModAuthority) {
      const ogUserId = readOgModCookie(ctx.req);
      if (ogUserId) {
        const ogUser = await dbRead.user.findFirst({
          where: { id: ogUserId },
          select: { isModerator: true },
        });
        if (ogUser?.isModerator) hasModAuthority = true;
      }
    }
    if (!hasModAuthority) return { redirect: { destination: '/', permanent: false } };

    const isEmail = userId.includes('@');
    const user = await dbRead.user.findFirst({
      where: isEmail ? { email: userId } : { id: Number(userId) },
      select: { id: true, username: true },
    });
    if (!user?.username) return { notFound: true };

    if (!wantsLoginAs) {
      return {
        redirect: {
          destination: `/user/${user.username}`,
          permanent: false,
        },
      };
    }

    return {
      props: { targetUserId: user.id, targetUsername: user.username },
    };
  },
});

export default function UserIdLoginAsPage({ targetUserId, targetUsername }: PageProps) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const { swapAccount, setOgAccount } = useAccountContext();

  const firedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(`Switching to ${targetUsername}...`);

  useEffect(() => {
    if (firedRef.current) return;
    if (!router.isReady || !currentUser) return;
    // Mod authority was proven in getServerSideProps (session mod or signed
    // og-mod cookie), so we skip a client-side feature flag check — the API
    // still enforces it as the final gate.
    if (targetUserId === currentUser.id) {
      firedRef.current = true;
      void router.replace(`/user/${targetUsername}`);
      return;
    }

    firedRef.current = true;
    setStatus(`Switching to ${targetUsername}...`);
    void impersonateUser({
      userId: targetUserId,
      username: targetUsername,
      currentUser,
      swapAccount,
      setOgAccount,
      callbackUrl: `/user/${targetUsername}`,
    }).then((ok) => {
      if (!ok) setError(`Unable to switch to ${targetUsername}.`);
    });
  }, [
    router.isReady,
    currentUser,
    targetUserId,
    targetUsername,
    swapAccount,
    setOgAccount,
    router,
  ]);

  const message = error ?? status;

  return (
    <>
      <Meta title="User Lookup" deIndex />
      <Center mih="60vh">
        <Stack align="center" gap="sm">
          {!error && <Loader />}
          <Text c={error ? 'red' : undefined} ta="center">
            {message}
          </Text>
        </Stack>
      </Center>
    </>
  );
}

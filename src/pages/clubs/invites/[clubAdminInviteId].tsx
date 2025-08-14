import type { InferGetServerSidePropsType } from 'next';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { useMutateClubAdmin } from '~/components/Club/club.utils';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import React, { useEffect } from 'react';
import { showSuccessNotification } from '../../../utils/notifications';
import { useRouter } from 'next/router';

const querySchema = z.object({ clubAdminInviteId: z.string() });

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features, ctx }) => {
    if (!features?.clubs) return { notFound: true };

    const result = querySchema.safeParse(ctx.params);
    if (!result.success) return { notFound: true };

    const { clubAdminInviteId } = result.data;

    if (!session)
      return {
        redirect: {
          destination: `/login?returnUrl=${encodeURIComponent(ctx.resolvedUrl)}`,
          permanent: false,
        },
      };

    // return {
    //   redirect: {
    //     destination: '/content/clubs',
    //     permanent: false,
    //   },
    // };

    return { props: { clubAdminInviteId } };
  },
});

export default function AcceptClubAdminInvite({
  clubAdminInviteId,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  // Should avoid a double call just in case effect is ran twice.
  const [stateAcceptingInvite, setStateAcceptingInvite] = React.useState(false);
  const { acceptInvite, acceptingInvite } = useMutateClubAdmin();
  const router = useRouter();

  const handleAcceptInvite = async () => {
    setStateAcceptingInvite(true);
    const clubAdmin = await acceptInvite({ id: clubAdminInviteId });

    if (clubAdmin) {
      showSuccessNotification({
        title: 'Invite accepted',
        message: 'You are now a club admin.',
      });

      router.push(`/clubs/manage/${clubAdmin.clubId}`);
    }
  };

  useEffect(() => {
    if (!stateAcceptingInvite) {
      handleAcceptInvite();
    }
  }, [stateAcceptingInvite]);

  if (acceptingInvite || !stateAcceptingInvite) return <PageLoader />;

  return <NotFound />;
}

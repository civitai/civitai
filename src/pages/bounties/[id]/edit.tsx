import { Center, Container, Loader } from '@mantine/core';
import { InferGetServerSidePropsType } from 'next';
import { z } from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { BountyEditForm } from '~/components/Bounty/BountyEditForm';
import { BountyUpsertForm } from '~/components/Bounty/BountyUpsertForm';
import { useQueryBounty } from '~/components/Bounty/bounty.utils';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { BountyGetById } from '~/types/router';

const querySchema = z.object({ id: z.coerce.number() });

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ session, features, ctx, ssg }) => {
    if (!features?.bounties) return { notFound: true };

    if (!session)
      return {
        redirect: {
          destination: `/login?returnUrl=${encodeURIComponent(ctx.resolvedUrl)}`,
          permanent: false,
        },
      };

    const result = querySchema.safeParse(ctx.params);
    if (!result.success) return { notFound: true };

    const { id } = result.data;
    const bounty = await dbRead.bounty.findUnique({
      where: { id },
      select: { expiresAt: true, userId: true },
    });
    if (!bounty) return { notFound: true };

    const isModerator = session.user?.isModerator ?? false;
    const isOwner = bounty.userId === session.user?.id || isModerator;
    const expired = bounty.expiresAt < new Date();
    if (!isOwner || expired)
      return {
        redirect: {
          destination: `/bounties/${id}`,
          permanent: false,
        },
      };

    if (ssg) await ssg.bounty.getById.prefetch({ id });

    return { props: { id } };
  },
});

export default function EditBountyPage({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { bounty, loading } = useQueryBounty({ id });

  if (!loading && !bounty) return <NotFound />;

  return (
    <Container size="md">
      {loading ? (
        <Center h="100vh">
          <Loader size="xl" />
        </Center>
      ) : (
        <BountyUpsertForm bounty={bounty as BountyGetById} />
      )}
    </Container>
  );
}

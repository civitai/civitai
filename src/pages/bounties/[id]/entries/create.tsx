import { Container } from '@mantine/core';

import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { BountyEntryUpsertForm } from '~/components/Bounty/BountyEntryUpsertForm';
import { z } from 'zod';
import { trpc } from '~/utils/trpc';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { NotFound } from '~/components/AppLayout/NotFound';
import { InferGetServerSidePropsType } from 'next';
import { removeEmpty } from '~/utils/object-helpers';

const querySchema = z.object({
  id: z.coerce.number(),
});
export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ session, ctx, ssg, features }) => {
    if (!features?.bounties) return { notFound: true };

    if (!session) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'create-bounty' }),
          permanent: false,
        },
      };
    }
    if (session.user?.muted) return { notFound: true };

    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    if (ssg) await ssg.bounty.getById.prefetch({ id: result.data.id });

    return { props: removeEmpty(result.data) };
  },
});

export default function BountyEntryCreate({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { data: bounty, isLoading } = trpc.bounty.getById.useQuery({ id });

  if (isLoading) return <PageLoader />;
  if (!bounty) {
    return <NotFound />;
  }

  return (
    <Container size="md" py="xl">
      <BountyEntryUpsertForm bounty={bounty} />
    </Container>
  );
}

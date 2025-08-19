import { Container } from '@mantine/core';

import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { BountyEntryUpsertForm } from '~/components/Bounty/BountyEntryUpsertForm';
import * as z from 'zod';
import { trpc } from '~/utils/trpc';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { NotFound } from '~/components/AppLayout/NotFound';
import type { InferGetServerSidePropsType } from 'next';
import { removeEmpty } from '~/utils/object-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';

const querySchema = z.object({
  id: z.coerce.number(),
  entryId: z.coerce.number(),
});
export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ session, ctx, ssg, features }) => {
    if (!features?.bounties) return { notFound: true };

    if (!session) {
      return {
        redirect: {
          permanent: false,
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'perform-action' }),
        },
      };
    }

    if (session.user?.muted) return { notFound: true };

    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    if (ssg) {
      await ssg.bounty.getById.prefetch({ id: result.data.id });
      await ssg.bountyEntry.getById.prefetch({ id: result.data.entryId });
    }

    return { props: removeEmpty(result.data) };
  },
});

export default function BountyEntryCreate({
  id,
  entryId,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();
  const { data: bounty, isLoading } = trpc.bounty.getById.useQuery({ id });
  const { data: bountyEntry, isLoading: isLoadingEntry } = trpc.bountyEntry.getById.useQuery({
    id: entryId,
  });

  if (isLoading || isLoadingEntry) return <PageLoader />;

  if (
    !bounty ||
    !bountyEntry ||
    !currentUser ||
    (!currentUser?.isModerator && currentUser?.id !== bountyEntry?.user?.id)
  ) {
    return <NotFound />;
  }

  return (
    <Container size="md" py="xl">
      <BountyEntryUpsertForm bounty={bounty} bountyEntry={bountyEntry} />
    </Container>
  );
}

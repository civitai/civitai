import React from 'react';
import { useRouter } from 'next/router';
import { Center, Container, Group, Loader, Stack, Title } from '@mantine/core';

import { BackButton } from '~/components/BackButton/BackButton';
import { PurchasableRewardUpsertForm } from '~/components/PurchasableRewards/PurchasableRewardUpsertForm';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { dbRead } from '~/server/db/client';
import { trpc } from '~/utils/trpc';
import { z } from 'zod';
import { Meta } from '~/components/Meta/Meta';
import { NotFound } from '~/components/AppLayout/NotFound';

const querySchema = z.object({ id: z.coerce.number() });

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ session, ctx, ssg }) => {
    const isModerator = session?.user?.isModerator ?? false;
    if (!isModerator) return { notFound: true };

    const result = querySchema.safeParse(ctx.params);
    if (!result.success) return { notFound: true };

    const { id } = result.data;

    if (ssg) await ssg.purchasableReward.getById.prefetch({ id });

    return { props: { id } };
  },
});

export default function PurchasableRewardUpdate({ id }: { id: number }) {
  const router = useRouter();
  const { data, isLoading } = trpc.purchasableReward.getById.useQuery({ id });
  const onUpdated = () => router.push(`/moderator/rewards`);

  if (isLoading && !data) {
    return (
      <Container size="md">
        <Stack>
          <Center>
            <Loader size="xl" />
          </Center>
        </Stack>
      </Container>
    );
  }

  if (!data) return <NotFound />;

  return (
    <>
      <Meta title="Update Rewards" deIndex />
      <Container size="md">
        <Stack>
          <Group spacing="md" noWrap>
            <BackButton url="/moderator/rewards" />
            <Title>Update Purchasable Reward</Title>
          </Group>
          <PurchasableRewardUpsertForm purchasableReward={data} onSave={onUpdated} />
        </Stack>
      </Container>
    </>
  );
}

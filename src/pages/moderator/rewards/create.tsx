import React from 'react';
import { useRouter } from 'next/router';
import { Container, Group, Stack, Title } from '@mantine/core';

import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { BackButton } from '~/components/BackButton/BackButton';
import { PurchasableRewardUpsertForm } from '~/components/PurchasableRewards/PurchasableRewardUpsertForm';
import { Meta } from '~/components/Meta/Meta';

export default function PurchasableRewardCreate() {
  const router = useRouter();
  const onCreated = () => router.push(`/moderator/rewards`);

  return (
    <>
      <Meta title="Create Rewards" deIndex />
      <Container size="md">
        <Stack>
          <Group spacing="md" noWrap>
            <BackButton url="/moderator/rewards" />
            <Title>Create Purchasable Reward</Title>
          </Group>
          <PurchasableRewardUpsertForm onSave={onCreated} />
        </Stack>
      </Container>
    </>
  );
}

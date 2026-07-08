import { Container, Group, Stack, Title } from '@mantine/core';

import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { ClubUpsertForm } from '~/components/Club/ClubUpsertForm';
import { BackButton } from '~/components/BackButton/BackButton';
import React from 'react';
import { useRouter } from 'next/router';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx, features }) => {
    if (!features?.createClubs) return { notFound: true };

    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'create-club' }),
          permanent: false,
        },
      };

    if (session.user?.muted) return { notFound: true };

    // return {
    //   redirect: {
    //     destination: '/content/clubs',
    //     permanent: true,
    //   },
    // };
  },
});

export default function ClubCreate() {
  const router = useRouter();
  const onCreated = (club: { id: number }) => router.push(`/clubs/manage/${club.id}`);

  return (
    <Container size="md">
      <Stack>
        <Group gap="md" wrap="nowrap">
          <BackButton url="/clubs" />
          <Title>Create new club</Title>
        </Group>
        <ClubUpsertForm onSave={onCreated} />
      </Stack>
    </Container>
  );
}

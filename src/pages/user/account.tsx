import { Container, Stack, Title, Text } from '@mantine/core';
import { getProviders } from 'next-auth/react';
import React from 'react';

import { AccountsCard } from '~/components/Account/AccountsCard';
import { ApiKeysCard } from '~/components/Account/ApiKeysCard';
import { SocialProfileCard } from '~/components/Account/SocialProfileCard';
import { DeleteCard } from '~/components/Account/DeleteCard';
import { NotificationsCard } from '~/components/Account/NotificationsCard';
import { ProfileCard } from '~/components/Account/ProfileCard';
import { SettingsCard } from '~/components/Account/SettingsCard';
import { SubscriptionCard } from '~/components/Account/SubscriptionCard';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ModerationCard } from '~/components/Account/ModerationCard';

export default function Account({ providers }: Props) {
  const { apiKeys } = useFeatureFlags();
  const currentUser = useCurrentUser();

  return (
    <>
      <Meta title="Manage your Account - Civitai" />

      <Container pb="md" size="xs">
        <Stack>
          <Stack spacing={0}>
            <Title order={1}>Manage Account</Title>
            <Text color="dimmed" size="sm">
              Take a moment to review your account information and preferences to personalize your
              experience on the site
            </Text>
          </Stack>
          <ProfileCard />
          <SocialProfileCard />
          <SettingsCard />
          <ModerationCard />
          {currentUser?.subscriptionId && <SubscriptionCard />}
          <NotificationsCard />
          <AccountsCard providers={providers} />
          {apiKeys && <ApiKeysCard />}
          <DeleteCard />
        </Stack>
      </Container>
    </>
  );
}

type Props = {
  providers: AsyncReturnType<typeof getProviders>;
};

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ssg, session }) => {
    if (!session?.user || session.user.bannedAt)
      return {
        redirect: {
          destination: '/',
          permanent: false,
        },
      };

    const providers = await getProviders();
    await ssg?.account.getAll.prefetch();
    if (session?.user?.subscriptionId) await ssg?.stripe.getUserSubscription.prefetch();

    return {
      props: {
        providers,
      },
    };
  },
});

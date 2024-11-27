import { Container, Stack, Title, Text, Button, Group, Divider } from '@mantine/core';
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
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ModerationCard } from '~/components/Account/ModerationCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { UserReferralCodesCard } from '~/components/Account/UserReferralCodesCard';
import { PaymentMethodsCard } from '~/components/Account/PaymentMethodsCard';
import { UserPaymentConfigurationCard } from '~/components/Account/UserPaymentConfigurationCard';
import { ContentControlsCard } from '~/components/Account/ContentControlsCard';
import { RefreshSessionCard } from '~/components/Account/RefreshSessionCard';

export default function Account({ providers }: Props) {
  const { apiKeys, buzz, canViewNsfw } = useFeatureFlags();
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
          <ContentControlsCard />
          {canViewNsfw && <ModerationCard />}
          <AccountsCard />
          <UserPaymentConfigurationCard />
          {currentUser?.subscriptionId && <SubscriptionCard />}
          <PaymentMethodsCard />
          {/* {buzz && <UserReferralCodesCard />} */}
          <NotificationsCard />
          {apiKeys && <ApiKeysCard />}
          <RefreshSessionCard />
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
    if (session?.user?.subscriptionId) await ssg?.subscriptions.getUserSubscription.prefetch();

    return {
      props: {
        providers,
      },
    };
  },
});

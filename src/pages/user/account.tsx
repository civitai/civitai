import { Container, Stack, Title, Text } from '@mantine/core';
import React from 'react';

import { AccountsCard } from '~/components/Account/AccountsCard';
import { ApiKeysCard } from '~/components/Account/ApiKeysCard';
import { SocialProfileCard } from '~/components/Account/SocialProfileCard';
import { DeleteCard } from '~/components/Account/DeleteCard';

import { ProfileCard } from '~/components/Account/ProfileCard';
import { SettingsCard } from '~/components/Account/SettingsCard';
import { SubscriptionCard } from '~/components/Account/SubscriptionCard';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ModerationCard } from '~/components/Account/ModerationCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { PaymentMethodsCard } from '~/components/Account/PaymentMethodsCard';
import { PurchasedCodesCard } from '~/components/Account/PurchasedCodesCard';
import { UserPaymentConfigurationCard } from '~/components/Account/UserPaymentConfigurationCard';
import { ContentControlsCard } from '~/components/Account/ContentControlsCard';
import { RefreshSessionCard } from '~/components/Account/RefreshSessionCard';
import { StrikesCard } from '~/components/Account/StrikesCard';
import { GenerationSettingsCard } from '~/components/Account/GenerationSettingsCard';
import dynamic from 'next/dynamic';

const NotificationsCard = dynamic(() => import('~/components/Account/NotificationsCard'));

export default function Account() {
  const { apiKeys, canViewNsfw, strikes } = useFeatureFlags();
  const currentUser = useCurrentUser();

  return (
    <>
      <Meta title="Manage your Account - Civitai" />

      <Container pb="md" size="xs">
        <Stack>
          <Stack gap={0}>
            <Title order={1}>Manage Account</Title>
            <Text c="dimmed" size="sm">
              Take a moment to review your account information and preferences to personalize your
              experience on the site
            </Text>
          </Stack>
          <ProfileCard />
          <SocialProfileCard />
          <SettingsCard />
          <ContentControlsCard />
          <GenerationSettingsCard />
          {canViewNsfw && <ModerationCard />}
          <AccountsCard />
          <UserPaymentConfigurationCard />
          {currentUser?.subscriptionId && <SubscriptionCard />}
          <PaymentMethodsCard />
          <PurchasedCodesCard />
          {/* {buzz && <UserReferralCodesCard />} */}
          <NotificationsCard />
          {apiKeys && <ApiKeysCard />}
          {strikes && <StrikesCard />}
          <RefreshSessionCard />
          <DeleteCard />
        </Stack>
      </Container>
    </>
  );
}

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

    await ssg?.account.getAll.prefetch();
    if (session?.user?.subscriptionId) await ssg?.subscriptions.getUserSubscription.prefetch();
  },
});

import { Container, Stack, Title, Text } from '@mantine/core';
import React from 'react';

import { AccountsCard } from '~/components/Account/AccountsCard';
import { ApiKeysCard } from '~/components/Account/ApiKeysCard';
import { OAuthAppsCard } from '~/components/Account/OAuthAppsCard';
import { ConnectedAppsCard } from '~/components/Account/ConnectedAppsCard';
import { SocialProfileCard } from '~/components/Account/SocialProfileCard';
import { DeleteCard } from '~/components/Account/DeleteCard';

import { ProfileCard } from '~/components/Account/ProfileCard';
import { SettingsCard } from '~/components/Account/SettingsCard';
import { MembershipGiftsCard } from '~/components/Account/MembershipGiftsCard';
import { SubscriptionCard } from '~/components/Account/SubscriptionCard';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ModerationCard } from '~/components/Account/ModerationCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { PaymentMethodsCard } from '~/components/Account/PaymentMethodsCard';
import { UserPaymentConfigurationCard } from '~/components/Account/UserPaymentConfigurationCard';
import { ContentControlsCard } from '~/components/Account/ContentControlsCard';
import { CreatorControlsCard } from '~/components/Account/CreatorControlsCard';
import { RefreshSessionCard } from '~/components/Account/RefreshSessionCard';
import { StrikesCard } from '~/components/Account/StrikesCard';
import { StickerInventoryCard } from '~/components/Account/StickerInventoryCard';
import { GenerationSettingsCard } from '~/components/Account/GenerationSettingsCard';
import dynamic from 'next/dynamic';

const NotificationsCard = dynamic(() => import('~/components/Account/NotificationsCard'));

export default function Account() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();

  return (
    <>
      <Meta title="Manage your Account - Civitai" deIndex />

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
          {features.canViewNsfw && <ModerationCard />}
          {/* Either flag mounts the card; each half gates itself inside. ANDing
              them here put the sticker controls behind `creator-controls`, which
              is dark by default and whose Flipt flag does not exist — so nobody
              could price their space, and the review queue nothing else links to
              became unreachable. */}
          {(features.creatorControls || features.stickerPlacement) && <CreatorControlsCard />}
          <StickerInventoryCard />
          <AccountsCard />
          <UserPaymentConfigurationCard />
          {/* No `subscriptionId` guard: a Buzz-purchased membership writes a
              CustomerSubscription row but never sets User.subscriptionId, so gating here
              kept the card unmounted no matter what the query returned. The card already
              self-hides when it resolves no subscriptions. */}
          <SubscriptionCard />
          <MembershipGiftsCard />
          <PaymentMethodsCard />
          {/* {buzz && <UserReferralCodesCard />} */}
          <NotificationsCard />
          {features.apiKeys && <ApiKeysCard />}
          {features.oauthApps && <OAuthAppsCard />}
          {features.oauthApps && <ConnectedAppsCard />}
          {features.strikes && <StrikesCard />}
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

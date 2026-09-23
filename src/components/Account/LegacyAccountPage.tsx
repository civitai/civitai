import { Container, Stack, Text, Title } from '@mantine/core';
import dynamic from 'next/dynamic';
import React from 'react';

import { AccountsCard } from '~/components/Account/AccountsCard';
import { ApiKeysCard } from '~/components/Account/ApiKeysCard';
import { ConnectedAppsCard } from '~/components/Account/ConnectedAppsCard';
import { ContentControlsCard } from '~/components/Account/ContentControlsCard';
import { CreatorControlsCard } from '~/components/Account/CreatorControlsCard';
import { DeleteCard } from '~/components/Account/DeleteCard';
import { GenerationSettingsCard } from '~/components/Account/GenerationSettingsCard';
import { MembershipGiftsCard } from '~/components/Account/MembershipGiftsCard';
import { ModerationCard } from '~/components/Account/ModerationCard';
import { OAuthAppsCard } from '~/components/Account/OAuthAppsCard';
import { PaymentMethodsCard } from '~/components/Account/PaymentMethodsCard';
import { ProfileCard } from '~/components/Account/ProfileCard';
import { RefreshSessionCard } from '~/components/Account/RefreshSessionCard';
import { SettingsCard } from '~/components/Account/SettingsCard';
import { SocialProfileCard } from '~/components/Account/SocialProfileCard';
import { StickerInventoryCard } from '~/components/Account/StickerInventoryCard';
import { StrikesCard } from '~/components/Account/StrikesCard';
import { SubscriptionCard } from '~/components/Account/SubscriptionCard';
import { UserPaymentConfigurationCard } from '~/components/Account/UserPaymentConfigurationCard';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

const NotificationsCard = dynamic(() => import('~/components/Account/NotificationsCard'));

/**
 * The single-column page, kept intact as the `accountSettingsV2` fallback. Delete it with the
 * flag; until then this and `AccountPanes` must offer the same set of cards, or turning the
 * flag off loses whatever only the new shell mounts.
 */
export function LegacyAccountPage() {
  const features = useFeatureFlags();

  return (
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
        {(features.creatorControls || features.stickerPlacement || features.remixGallery) && (
          <CreatorControlsCard />
        )}
        <StickerInventoryCard />
        <AccountsCard />
        <UserPaymentConfigurationCard />
        <SubscriptionCard />
        <MembershipGiftsCard />
        <PaymentMethodsCard />
        <NotificationsCard />
        {features.apiKeys && <ApiKeysCard />}
        {features.oauthApps && <OAuthAppsCard />}
        {features.oauthApps && <ConnectedAppsCard />}
        {features.strikes && <StrikesCard />}
        <RefreshSessionCard />
        <DeleteCard />
      </Stack>
    </Container>
  );
}

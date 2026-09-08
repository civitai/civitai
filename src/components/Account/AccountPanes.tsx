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
import { AccountOverview } from '~/components/Account/AccountOverview';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

const NotificationsCard = dynamic(() => import('~/components/Account/NotificationsCard'));

export const accountPaneCopy: Record<string, { title: string; description?: string }> = {
  overview: {
    title: 'Overview',
    description: 'Your account at a glance. Jump straight to whatever you came here to change.',
  },
  profile: {
    title: 'Profile & Account',
    description: 'Who you are on Civitai, how people reach you, and the state of your account.',
  },
  preferences: {
    title: 'Preferences',
    description: 'How media plays, which file formats you get by default, and the small comforts.',
  },
  notifications: {
    title: 'Notifications',
    description: 'Choose what reaches you, and whether it arrives on-site, by email, or both.',
  },
  content: {
    title: 'Content & Browsing',
    description: 'What you are willing to see, and whose work you would rather not.',
  },
  creator: {
    title: 'Creator',
    description: 'What the public sees about your work, and what you let others place on it.',
  },
  billing: {
    title: 'Membership & Billing',
    description: 'Your plan, how you pay for it, and how you get paid.',
  },
  security: {
    title: 'Security & Apps',
    description: 'How you sign in, and everything holding a key to your account.',
  },
};

export function AccountPane({ sectionId }: { sectionId: string }) {
  const features = useFeatureFlags();

  switch (sectionId) {
    case 'overview':
      return <AccountOverview />;

    case 'profile':
      return (
        <>
          <ProfileCard />
          <SocialProfileCard />
          {features.strikes && <StrikesCard />}
          <RefreshSessionCard />
          <DeleteCard />
        </>
      );

    case 'preferences':
      return (
        <>
          <SettingsCard />
          <GenerationSettingsCard />
        </>
      );

    case 'notifications':
      return <NotificationsCard />;

    case 'content':
      return (
        <>
          {features.canViewNsfw && <ModerationCard />}
          <ContentControlsCard />
        </>
      );

    case 'creator':
      return (
        <>
          {(features.creatorControls || features.stickerPlacement || features.remixGallery) && (
            <CreatorControlsCard />
          )}
          <StickerInventoryCard />
        </>
      );

    case 'billing':
      return (
        <>
          <SubscriptionCard />
          <MembershipGiftsCard />
          <PaymentMethodsCard />
          <UserPaymentConfigurationCard />
        </>
      );

    case 'security':
      return (
        <>
          <AccountsCard />
          {features.apiKeys && <ApiKeysCard />}
          {features.oauthApps && <OAuthAppsCard />}
          {features.oauthApps && <ConnectedAppsCard />}
        </>
      );

    default:
      return null;
  }
}

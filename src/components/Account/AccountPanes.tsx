import dynamic from 'next/dynamic';
import React from 'react';

import { AccountsCard } from '~/components/Account/AccountsCard';
import { ApiKeysCard } from '~/components/Account/ApiKeysCard';
import { ConnectedAppsCard } from '~/components/Account/ConnectedAppsCard';
import { CreatorControlsCard } from '~/components/Account/CreatorControlsCard';
import { DeleteCard } from '~/components/Account/DeleteCard';
import { MembershipGiftsCard } from '~/components/Account/MembershipGiftsCard';
import { OAuthAppsCard } from '~/components/Account/OAuthAppsCard';
import { PaymentMethodsCard } from '~/components/Account/PaymentMethodsCard';
import { ProfileCard } from '~/components/Account/ProfileCard';
import { RefreshSessionCard } from '~/components/Account/RefreshSessionCard';
import { SocialProfileCard } from '~/components/Account/SocialProfileCard';
import { StickerInventoryCard } from '~/components/Account/StickerInventoryCard';
import { StrikesCard } from '~/components/Account/StrikesCard';
import { SubscriptionCard } from '~/components/Account/SubscriptionCard';
import { UserPaymentConfigurationCard } from '~/components/Account/UserPaymentConfigurationCard';
import { AccountOverview } from '~/components/Account/AccountOverview';
import { ContentPane } from '~/components/Account/ContentPane';
import { PreferencesPane } from '~/components/Account/PreferencesPane';
import { SettingsStack } from '~/components/Account/SettingsLayout';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

const NotificationsPane = dynamic(() =>
  import('~/components/Account/NotificationsPane').then((mod) => mod.NotificationsPane)
);

export const accountPaneCopy: Record<string, { title: string }> = {
  overview: { title: 'Overview' },
  profile: { title: 'Profile & Account' },
  preferences: { title: 'Preferences' },
  notifications: { title: 'Notifications' },
  content: { title: 'Content & Browsing' },
  creator: { title: 'Creator' },
  billing: { title: 'Membership & Billing' },
  security: { title: 'Security & Apps' },
};

export function AccountPane({ sectionId }: { sectionId: string }) {
  const features = useFeatureFlags();

  switch (sectionId) {
    case 'overview':
      return <AccountOverview />;

    case 'profile':
      return (
        <SettingsStack>
          <ProfileCard flat />
          <SocialProfileCard flat />
          {features.strikes && <StrikesCard flat />}
          <div className="flex flex-col gap-3">
            <RefreshSessionCard flat />
            <DeleteCard flat />
          </div>
        </SettingsStack>
      );

    case 'preferences':
      return <PreferencesPane />;

    case 'notifications':
      return <NotificationsPane />;

    case 'content':
      return <ContentPane />;

    case 'creator':
      return (
        <SettingsStack>
          {/* Ungated on purpose: the card self-gates, and still owes the sticker pointer with
              every flag off. */}
          <CreatorControlsCard flat stickerFooter={<StickerInventoryCard flat />} />
        </SettingsStack>
      );

    case 'billing':
      return (
        <SettingsStack>
          <SubscriptionCard flat />
          <PaymentMethodsCard flat />
          <UserPaymentConfigurationCard flat />
          <MembershipGiftsCard pointer />
        </SettingsStack>
      );

    case 'security':
      return (
        <SettingsStack>
          <AccountsCard flat />
          {features.apiKeys && <ApiKeysCard flat />}
          {features.oauthApps && <OAuthAppsCard flat />}
          {features.oauthApps && <ConnectedAppsCard flat />}
        </SettingsStack>
      );

    default:
      return null;
  }
}

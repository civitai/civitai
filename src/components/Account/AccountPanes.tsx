import dynamic from 'next/dynamic';
import React from 'react';

import { AccountsCard } from '~/components/Account/AccountsCard';
import { ApiKeysCard } from '~/components/Account/ApiKeysCard';
import { AppStorageCard } from '~/components/Account/AppStorageCard';
import { CatalogItemsCard } from '~/components/Account/CatalogItemsCard';
import { ConnectedAppsCard } from '~/components/Account/ConnectedAppsCard';
import { CreatorControlsCard } from '~/components/Account/CreatorControlsCard';
import { DeleteCard } from '~/components/Account/DeleteCard';
import { MembershipGiftsCard } from '~/components/Account/MembershipGiftsCard';
import { MembershipHistoryCard } from '~/components/Account/MembershipHistoryCard';
import { OAuthAppsCard } from '~/components/Account/OAuthAppsCard';
import { PaymentMethodsCard } from '~/components/Account/PaymentMethodsCard';
import { ShowcaseHatSetting } from '~/components/Events/ScoredEvent/ShowcaseHatToggle';
import { HatTurfSetting } from '~/components/Account/HatTurfSetting';
import { HatTurfOwnerSetting } from '~/components/Account/HatTurfOwnerSetting';
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

const UsageLimitsPane = dynamic(() =>
  import('~/components/Account/usage/UsageLimitsPane').then((mod) => mod.UsageLimitsPane)
);
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
  usage: { title: 'Usage limits' },
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
          <ShowcaseHatSetting />
          <HatTurfSetting />
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
          <HatTurfOwnerSetting />
        </SettingsStack>
      );

    case 'billing':
      return (
        <SettingsStack>
          <SubscriptionCard flat />
          <MembershipHistoryCard flat />
          <PaymentMethodsCard flat />
          <UserPaymentConfigurationCard flat />
          <MembershipGiftsCard pointer />
        </SettingsStack>
      );

    case 'usage':
      return <UsageLimitsPane />;

    case 'security':
      return (
        <SettingsStack>
          <AccountsCard flat />
          {features.apiKeys && <ApiKeysCard flat />}
          {features.oauthApps && <OAuthAppsCard flat />}
          {features.oauthApps && <ConnectedAppsCard flat />}
          {features.oauthApps && <CatalogItemsCard flat />}
          {/* Self-gates on the App Blocks flag and renders nothing without app data. */}
          <AppStorageCard flat />
        </SettingsStack>
      );

    default:
      return null;
  }
}

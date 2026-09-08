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
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

const NotificationsPane = dynamic(() =>
  import('~/components/Account/NotificationsPane').then((mod) => mod.NotificationsPane)
);

/** Two columns from `md` up, for the panes still composed of prod cards rather than flat sections. */
function TwoColumn({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="grid items-start gap-4 md:grid-cols-2">
      <div className="flex flex-col gap-4">{left}</div>
      <div className="flex flex-col gap-4">{right}</div>
    </div>
  );
}

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
        <TwoColumn
          left={
            <>
              <ProfileCard />
              <SocialProfileCard />
              <RefreshSessionCard />
            </>
          }
          right={
            <>
              {features.strikes && <StrikesCard />}
              <DeleteCard />
            </>
          }
        />
      );

    case 'preferences':
      return <PreferencesPane />;

    case 'notifications':
      return <NotificationsPane />;

    case 'content':
      return <ContentPane />;

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
        <TwoColumn
          left={
            <>
              <SubscriptionCard />
              <MembershipGiftsCard />
            </>
          }
          right={
            <>
              <PaymentMethodsCard />
              <UserPaymentConfigurationCard />
            </>
          }
        />
      );

    case 'security':
      return (
        <TwoColumn
          left={
            <>
              <AccountsCard />
              {features.apiKeys && <ApiKeysCard />}
            </>
          }
          right={
            <>
              {features.oauthApps && <OAuthAppsCard />}
              {features.oauthApps && <ConnectedAppsCard />}
            </>
          }
        />
      );

    default:
      return null;
  }
}

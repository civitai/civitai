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

const NotificationsPane = dynamic(() =>
  import('~/components/Account/NotificationsPane').then((mod) => mod.NotificationsPane)
);

/**
 * Two columns from `md` up, stacked below. Only for panes whose cards are already separate — a
 * pane carrying one tall card (Preferences, Creator) gets nothing from this but a lopsided gap.
 */
function TwoColumn({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="grid items-start gap-4 md:grid-cols-2">
      <div className="flex flex-col gap-4">{left}</div>
      <div className="flex flex-col gap-4">{right}</div>
    </div>
  );
}

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
    description: 'Grouped by category. Open the one you came for; the rest stay collapsed.',
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
      return (
        <>
          <SettingsCard />
          <GenerationSettingsCard />
        </>
      );

    case 'notifications':
      return <NotificationsPane />;

    case 'content':
      return features.canViewNsfw ? (
        <TwoColumn left={<ModerationCard />} right={<ContentControlsCard />} />
      ) : (
        <ContentControlsCard />
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

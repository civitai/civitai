import React from 'react';
import {
  IconApps,
  IconAssembly,
  IconBook,
  IconBook2,
  IconBookmark,
  IconCategory,
  IconCube,
  IconId,
  IconLayoutList,
  IconPencilMinus,
  IconPhoto,
  IconSettings,
  IconShoppingBag,
  IconSticker,
  IconTrophy,
  IconVideo,
} from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useProfileAchievements } from '~/components/CreatorJourney/useProfileAchievements';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { canShowProfileAppsTab } from '~/components/Profile/profile-apps-tab';
import {
  applyHiddenProfileTabs,
  isProfileHideableTab,
} from '~/components/Profile/profile-hidden-tabs';
import type { ProfileHiddenTabsModalProps } from '~/components/Profile/ProfileHiddenTabsModal';
import { trpc } from '~/utils/trpc';
import type { DataItem } from '~/components/HomeContentToggle/HomeStyleSegmentedControl';
import { HomeStyleSegmentedControl } from '~/components/HomeContentToggle/HomeStyleSegmentedControl';
import homeStyleClasses from '~/components/HomeContentToggle/HomeStyleSegmentedControl.module.css';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { PrivacySettingsSchema } from '~/server/schema/user-profile.schema';
import { getDisplayName, postgresSlugify } from '~/utils/string-helpers';

const ProfileHiddenTabsModal = dynamic(
  () => import('~/components/Profile/ProfileHiddenTabsModal'),
  {
    ssr: false,
  }
);
const openProfileHiddenTabs = (props: ProfileHiddenTabsModalProps) =>
  dialogStore.trigger({ component: ProfileHiddenTabsModal, props });

type ProfileNavigationProps = {
  username: string;
};

const overviewPath = '[username]';

export const ProfileNavigation = ({ username }: ProfileNavigationProps) => {
  const router = useRouter();
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const settings = useCurrentUserSettings();
  const isProfileOwner =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);
  const isModerator = currentUser?.isModerator ?? false;

  const {
    data: userOverview,
    isInitialLoading,
    isRefetching,
  } = trpc.userProfile.overview.useQuery({ username });
  const { data: user, isLoading: userLoading } = trpc.userProfile.get.useQuery({ username });
  const { count: achievementCount } = useProfileAchievements(user?.id);

  const activePath = router.pathname.split('/').pop() || overviewPath;
  const baseUrl = `/user/${username}`;

  const opts: Record<string, DataItem> = {
    [overviewPath]: {
      url: `${baseUrl}/`,
      icon: (props) => <IconAssembly {...props} />,
      label: 'Overview',
    },
    about: {
      url: `${baseUrl}/about`,
      icon: (props) => <IconId {...props} />,
      label: 'About',
      disabled: !features.profileRedesign,
    },
    models: {
      url: `${baseUrl}/models`,
      icon: (props) => <IconCategory {...props} />,
      count: userOverview?.modelCount ?? 0,
      disabled: !!user?.bannedAt,
    },
    posts: {
      url: `${baseUrl}/posts`,
      icon: (props) => <IconLayoutList {...props} />,
      count: userOverview?.postCount ?? 0,
      disabled: !!user?.bannedAt,
    },
    images: {
      url: `${baseUrl}/images`,
      icon: (props) => <IconPhoto {...props} />,
      count: userOverview?.imageCount ?? 0,
      disabled: !!user?.bannedAt,
    },
    videos: {
      url: `${baseUrl}/videos`,
      icon: (props) => <IconVideo {...props} />,
      count: userOverview?.videoCount ?? 0,
      disabled: !!user?.bannedAt,
    },
    '3d-models': {
      url: `${baseUrl}/3d-models`,
      icon: (props) => <IconCube {...props} />,
      label: getDisplayName('3d-models'),
      count: userOverview?.model3dCount ?? 0,
      disabled: !features.model3dFeed || !!user?.bannedAt,
    },
    articles: {
      url: `${baseUrl}/articles`,
      icon: (props) => <IconPencilMinus {...props} />,
      count: userOverview?.articleCount ?? 0,
      disabled: !features.articles || !!user?.bannedAt,
    },
    comics: {
      url: `${baseUrl}/comics`,
      icon: (props) => <IconBook {...props} />,
      count: userOverview?.comicCount ?? 0,
      disabled: !features.comicCreator || !!user?.bannedAt,
    },
    storylines: {
      url: `${baseUrl}/storylines`,
      icon: (props) => <IconBook2 {...props} />,
      disabled: !features.storylines || !!user?.bannedAt,
    },
    apps: {
      url: `${baseUrl}/apps`,
      icon: (props) => <IconApps {...props} />,
      label: 'Apps',
      // No count: the store-visible set depends on the viewer, so there is no one number.
      disabled: !canShowProfileAppsTab(features, user),
    },
    achievements: {
      url: `${baseUrl}/achievements`,
      icon: (props) => <IconTrophy {...props} />,
      label: 'Achievements',
      count: achievementCount,
      // Zero when the flag is off for the viewer, so this also hides it then.
      disabled: achievementCount === 0 || !!user?.bannedAt,
    },
    collections: {
      url: `${baseUrl}/collections`,
      icon: (props) => <IconBookmark {...props} />,
      count: userOverview?.collectionCount ?? 0,
      disabled: !!user?.bannedAt,
    },
    'sticker-book': {
      url: `${baseUrl}/sticker-book`,
      icon: (props) => <IconSticker {...props} />,
      label: 'Sticker Book',
      // Hidden from visitors when the creator hid it, the same way a disabled
      // shop is — the owner and moderators keep the tab. The book's own payload
      // withholds the content independently; this only decides the nav item.
      disabled:
        !features.stickerBook ||
        !!user?.bannedAt ||
        (!isProfileOwner && !isModerator && !!user?.stickerBookHidden),
    },
    shop: {
      url: `${baseUrl}/shop`,
      icon: (props) => <IconShoppingBag {...props} />,
      label: 'Shop',
      className: homeStyleClasses.tabHighlight,
      // A disabled shop is hidden from everyone but its owner (and moderators,
      // who need to review/fix shops regardless of publish state).
      disabled:
        !features.creatorShop ||
        !!user?.bannedAt ||
        (!isProfileOwner && !isModerator && !user?.creatorShopEnabled),
    },
  };

  const privacySettings = user?.profile?.privacySettings as
    | PrivacySettingsSchema
    | null
    | undefined;
  const tabs = applyHiddenProfileTabs(opts, {
    hiddenTabs: privacySettings?.hiddenTabs,
    // The owner sees their tabs as visitors do, and unhides them from the gear.
    viewerSeesAll: !!isModerator,
    enabled: !!features.profileRedesign,
  });

  const segmentedControl = (
    <HomeStyleSegmentedControl
      data={tabs}
      value={activePath}
      // The user decides which tabs exist, so the row waits for it too before picking its density.
      loading={isInitialLoading || isRefetching || userLoading}
      keepLabels={settings.navigation?.keepProfileLabels}
    />
  );

  if (!features.profileRedesign || !isProfileOwner || !user) return segmentedControl;

  // Only the tabs this profile shows for other reasons; hiding one that never renders means nothing.
  const hideableTabs = Object.entries(opts).flatMap(([key, tab]) =>
    isProfileHideableTab(key) && !tab.disabled
      ? [{ key, label: tab.label ?? getDisplayName(key) }]
      : []
  );

  return (
    <div className="flex items-start gap-1 pr-2">
      <div className="min-w-0 flex-1">{segmentedControl}</div>
      <LegacyActionIcon
        size={32}
        radius="xl"
        variant="subtle"
        // The main nav gear's colour (SubNavSettingsButton), level with the pills' top padding.
        c="var(--mantine-color-bright)"
        className="mt-1 shrink-0"
        aria-label="Choose profile tabs"
        onClick={() =>
          openProfileHiddenTabs({
            userId: user.id,
            username,
            privacySettings,
            tabs: hideableTabs,
          })
        }
      >
        <IconSettings size={16} />
      </LegacyActionIcon>
    </div>
  );
};

/** The tabs in the site's sub-navigation; with the redesign they render under the banner instead. */
export const SubnavProfileNavigation = ({ username }: ProfileNavigationProps) => {
  const features = useFeatureFlags();
  return features.profileRedesign ? null : <ProfileNavigation username={username} />;
};

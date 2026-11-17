import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { MyImagesSection } from '~/components/Profile/Sections/MyImagesSection';
import { MyModelsSection } from '~/components/Profile/Sections/MyModelsSection';
import { PopularArticlesSection } from '~/components/Profile/Sections/PopularArticlesSection';
import { PopularModelsSection } from '~/components/Profile/Sections/PopularModelsSection';
import { RecentReviewsSection } from '~/components/Profile/Sections/RecentReviewsSection';
import { OnSaleSection } from '~/components/Profile/Sections/OnSaleSection';
import { ShopSection } from '~/components/Profile/Sections/ShopSection';
import { ShowcaseSection } from '~/components/Profile/Sections/ShowcaseSection';
import { CreatorJourneySection } from '~/components/Profile/Sections/CreatorJourneySection';
import type {
  CustomShowcaseKey,
  ProfileSectionSchema,
  ProfileSectionType,
  ShowcaseItemSchema,
  ShowcaseSectionSchema,
} from '~/server/schema/user-profile.schema';
import { customShowcaseKey, customShowcaseKeyPrefix } from '~/server/schema/user-profile.schema';
import type { UserOverview, UserWithProfile } from '~/types/router';

// Used to determine which sections are enabled by default when the user does not have them
// on the profile items' list. This is used such that when we add a new section, if we want to enforce
// all users to have it before they update their profile, we can.
export const defaultProfileSectionStatus: Record<ProfileSectionType, boolean> = {
  showcase: false,
  popularModels: true,
  popularArticles: false,
  modelsOverview: true,
  imagesOverview: true,
  recentReviews: true,
  shop: false,
  // Off by default: a creator running no sales should not get an empty section they never asked for.
  onSale: false,
  // Renders nothing until the creator has earned something, so it can be on for everyone.
  creatorJourney: true,
} as const;

export const ProfileSectionComponent: Record<
  ProfileSectionType,
  React.ComponentType<ProfileSectionProps>
> = {
  showcase: ShowcaseSection,
  popularModels: PopularModelsSection,
  popularArticles: PopularArticlesSection,
  modelsOverview: MyModelsSection,
  imagesOverview: MyImagesSection,
  recentReviews: RecentReviewsSection,
  shop: ShopSection,
  onSale: OnSaleSection,
  creatorJourney: CreatorJourneySection,
} as const;

export const profileSectionLabels: Record<ProfileSectionType, string> = {
  showcase: 'Showcase',
  popularModels: 'Most popular models',
  popularArticles: 'Most popular articles',
  modelsOverview: 'Models overview',
  imagesOverview: 'Images overview',
  recentReviews: 'Recent reviews',
  shop: 'Shop',
  onSale: 'On sale',
  creatorJourney: 'Creator Journey',
} as const;
export const isCustomShowcaseKey = (key: string): key is CustomShowcaseKey =>
  key.startsWith(customShowcaseKeyPrefix);

export const getShowcaseSectionByKey = (
  key: string,
  showcaseSections: ShowcaseSectionSchema[] = []
) =>
  isCustomShowcaseKey(key)
    ? showcaseSections.find((s) => customShowcaseKey(s.id) === key)
    : undefined;

/** Placed by its `custom:<id>` row; a row with no section is dropped and a section with no row goes last, enabled, so create/delete never rewrites `profileSectionsSettings`. */
export const getAllAvailableProfileSections = (
  userSections: ProfileSectionSchema[] = [],
  showcaseSections: ShowcaseSectionSchema[] = []
) => {
  const customKeys = showcaseSections.map((s) => customShowcaseKey(s.id));
  const sections: ProfileSectionSchema[] = [
    // Allows to filter items we've removed from available sections.
    ...userSections.filter(
      ({ key }) =>
        Object.keys(ProfileSectionComponent).includes(key) ||
        customKeys.includes(key as CustomShowcaseKey)
    ),
    ...Object.keys(defaultProfileSectionStatus)
      .filter((k) => !userSections.find((u) => u.key === k))
      .map((k) => ({
        key: k as ProfileSectionType,
        enabled: defaultProfileSectionStatus[k as ProfileSectionType],
      })),
    ...customKeys
      .filter((k) => !userSections.find((u) => u.key === k))
      .map((key) => ({ key, enabled: true })),
  ];

  return sections;
};

export const shouldDisplayUserNullState = ({
  overview,
  userWithProfile,
  showcaseSections = [],
}: {
  overview?: Partial<UserOverview>;
  userWithProfile: UserWithProfile;
  /** Only when the viewer has the `profileShowcases` flag: otherwise they render nothing. */
  showcaseSections?: ShowcaseSectionSchema[];
}) => {
  if (userWithProfile.bannedAt) return true;
  const userSections = (userWithProfile?.profile?.profileSectionsSettings ??
    []) as ProfileSectionSchema[];

  const sections = getAllAvailableProfileSections(userSections, showcaseSections);
  const sectionEnabled = sections.find((s) => s.enabled);

  if (!sectionEnabled) return true;

  const showcaseItems = (userWithProfile?.profile?.showcaseItems ?? []) as ShowcaseItemSchema[];

  const someSectionEnabled = (keys: ProfileSectionSchema['key'][]) => {
    return sections.find((s) => keys.includes(s.key) && s.enabled);
  };

  const hasCustomShowcase = showcaseSections.some(
    (s) => s.items.length > 0 && someSectionEnabled([customShowcaseKey(s.id)])
  );

  return (
    !hasCustomShowcase &&
    (showcaseItems.length === 0 || !someSectionEnabled(['showcase'])) &&
    (overview?.modelCount === 0 || !someSectionEnabled(['modelsOverview', 'popularModels'])) &&
    (overview?.imageCount === 0 || !someSectionEnabled(['imagesOverview'])) &&
    (overview?.articleCount === 0 || !someSectionEnabled(['popularArticles'])) &&
    (!overview?.hasReceivedReviews || !someSectionEnabled(['recentReviews']))
  );
};

/**
 * The legacy `UserProfile.message` banner is superseded by a live announcement, not replaced
 * by the feature flag: the `message` columns stay populated until the migration retires them,
 * so a creator with no announcement yet must keep the banner they have.
 */
export const shouldShowProfileMessage = ({
  message,
  userMuted,
  announcementCount,
}: {
  message?: string | null;
  userMuted?: boolean;
  announcementCount: number;
}) => !!message && !userMuted && announcementCount === 0;

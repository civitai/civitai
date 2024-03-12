import {
  ProfileSectionSchema,
  ProfileSectionType,
  ShowcaseItemSchema,
} from '~/server/schema/user-profile.schema';
import { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { PopularModelsSection } from '~/components/Profile/Sections/PopularModelsSection';
import { PopularArticlesSection } from '~/components/Profile/Sections/PopularArticlesSection';
import { MyModelsSection } from '~/components/Profile/Sections/MyModelsSection';
import { MyImagesSection } from '~/components/Profile/Sections/MyImagesSection';
import { RecentReviewsSection } from '~/components/Profile/Sections/RecentReviewsSection';
import { UserOverview, UserWithProfile } from '~/types/router';
import { ShowcaseSection } from '~/components/Profile/Sections/ShowcaseSection';

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
} as const;

export const profileSectionLabels: Record<ProfileSectionType, string> = {
  showcase: 'Showcase',
  popularModels: 'Most popular models',
  popularArticles: 'Most popular articles',
  modelsOverview: 'Models overview',
  imagesOverview: 'Images overview',
  recentReviews: 'Recent reviews',
} as const;
export const getAllAvailableProfileSections = (userSections: ProfileSectionSchema[] = []) => {
  const sections: ProfileSectionSchema[] = [
    // Allows to filter items we've removed from available sections.
    ...userSections.filter(({ key }) => Object.keys(ProfileSectionComponent).includes(key)),
    ...Object.keys(defaultProfileSectionStatus)
      .filter((k) => !userSections.find((u) => u.key === k))
      .map((k) => ({
        key: k as ProfileSectionType,
        enabled: defaultProfileSectionStatus[k as ProfileSectionType],
      })),
  ];

  return sections;
};

export const shouldDisplayUserNullState = ({
  overview,
  userWithProfile,
}: {
  overview: UserOverview;
  userWithProfile: UserWithProfile;
}) => {
  const userSections = (userWithProfile?.profile?.profileSectionsSettings ??
    []) as ProfileSectionSchema[];

  const sections = getAllAvailableProfileSections(userSections);
  const sectionEnabled = sections.find((s) => s.enabled);

  if (!sectionEnabled) return true;

  const showcaseItems = (userWithProfile?.profile?.showcaseItems ?? []) as ShowcaseItemSchema[];

  const someSectionEnabled = (keys: ProfileSectionSchema['key'][]) => {
    return sections.find((s) => keys.includes(s.key) && s.enabled);
  };

  return (
    (showcaseItems.length === 0 || !someSectionEnabled(['showcase'])) &&
    (overview.modelCount === 0 || !someSectionEnabled(['modelsOverview', 'popularModels'])) &&
    (overview.imageCount === 0 || !someSectionEnabled(['imagesOverview'])) &&
    (overview.articleCount === 0 || !someSectionEnabled(['popularArticles'])) &&
    (!overview.hasReceivedReviews || !someSectionEnabled(['recentReviews']))
  );
};

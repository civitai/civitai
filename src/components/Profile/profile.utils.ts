import { ProfileSectionSchema, ProfileSectionType } from '~/server/schema/user-profile.schema';
import { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { PopularModelsSection } from '~/components/Profile/Sections/PopularModelsSection';
import { PopularArticlesSection } from '~/components/Profile/Sections/PopularArticlesSection';
import { MyModelsSection } from '~/components/Profile/Sections/MyModelsSection';
import { MyImagesSection } from '~/components/Profile/Sections/MyImagesSection';
import { RecentReviewsSection } from '~/components/Profile/Sections/RecentReviewsSection';

// Used to determine which sections are enabled by default when the user does not have them
// on the profile items' list. This is used such that when we add a new section, if we want to enforce
// all users to have it before they update their profile, we can.
export const defaultProfileSectionStatus: Record<ProfileSectionType, boolean> = {
  showcase: true,
  popularModels: true,
  popularArticles: true,
  recent: true,
  modelsOverview: false,
  imagesOverview: false,
  recentReviews: false,
} as const;

export const ProfileSectionComponent: Record<
  ProfileSectionType,
  React.ComponentType<ProfileSectionProps>
> = {
  showcase: MyModelsSection, // TODO
  popularModels: PopularModelsSection,
  popularArticles: PopularArticlesSection,
  recent: MyModelsSection, // TODO
  modelsOverview: MyModelsSection,
  imagesOverview: MyImagesSection,
  recentReviews: RecentReviewsSection,
} as const;

export const profileSectionLabels: Record<ProfileSectionType, string> = {
  showcase: 'Showcase',
  popularModels: 'Most popular models',
  popularArticles: 'Most popular articles',
  recent: 'My recent activity',
  modelsOverview: 'Models overview',
  imagesOverview: 'Images overview',
  recentReviews: 'Recent reviews',
} as const;
export const getAllAvailableProfileSections = (userSections: ProfileSectionSchema[] = []) => {
  const sections: ProfileSectionSchema[] = [
    ...userSections,
    ...Object.keys(defaultProfileSectionStatus)
      .filter((k) => !userSections.find((u) => u.key === k))
      .map((k) => ({
        key: k as ProfileSectionSchema['key'],
        enabled: defaultProfileSectionStatus[k as ProfileSectionSchema['key']],
      })),
  ];

  return sections;
};

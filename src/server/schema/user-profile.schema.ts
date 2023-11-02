import { z } from 'zod';
import { imageSchema } from '~/server/schema/image.schema';
import { SearchIndexEntityType, SearchIndexEntityTypes } from '~/components/Search/parsers/base';

export type GetUserProfileSchema = z.infer<typeof getUserProfileSchema>;
export const getUserProfileSchema = z.object({
  username: z.string(),
});

export const ProfileSectionType = {
  Showcase: 'showcase',
  PopularModels: 'popularModels',
  PopularArticles: 'popularArticles',
  Recent: 'recent',
  ModelsOverview: 'modelsOverview',
  ImagesOverview: 'imagesOverview',
  RecentReviews: 'recentReviews',
} as const;

export type ProfileSectionType = (typeof ProfileSectionType)[keyof typeof ProfileSectionType];

// Used to determine which sections are enabled by default when the user does not have them
// on the profile items' list.
export const defaultProfileSectionStatus: Record<ProfileSectionType, boolean> = {
  showcase: true,
  popularModels: true,
  popularArticles: true,
  recent: true,
  modelsOverview: false,
  imagesOverview: false,
  recentReviews: false,
};

export type ProfileSectionSchema = z.infer<typeof profileSectionSchema>;

export const profileSectionSchema = z.object({
  key: z.nativeEnum(ProfileSectionType),
  enabled: z.boolean(),
});

export type ShowcaseItemSchema = z.infer<typeof showcaseItemSchema>;

export const showcaseItemSchema = z.object({
  entityType: z.nativeEnum(SearchIndexEntityTypes),
  entityId: z.number(),
});

export type PrivacySettingsSchema = z.infer<typeof privacySettingsSchema>;

export const privacySettingsSchema = z.object({
  showLocation: z.boolean().optional(),
  showFollowers: z.boolean().optional(),
  showFollowing: z.boolean().optional(),
  showRating: z.boolean().optional(),
});

export type UserProfileUpdateSchema = z.infer<typeof userProfileUpdateSchema>;
export const userProfileUpdateSchema = z.object({
  showcaseItems: z.array(showcaseItemSchema).optional(),
  profileSectionsSettings: z.array(profileSectionSchema).optional(),
  privacySettings: privacySettingsSchema.optional(),
  message: z.string().nullish(),
  bio: z.string().nullish(),
  location: z.string().max(100).nullish(),
  profileImage: z.string().nullish(),
  coverImage: imageSchema.nullish(),
  coverImageId: z.number().nullish(),
  links: z
    .array(
      z.object({
        id: z.number().optional(),
        type: z.string(),
        url: z.string(),
      })
    )
    .optional(),
  badgeId: z.number().nullish(),
});

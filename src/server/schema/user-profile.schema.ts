import { z } from 'zod';
import { imageSchema } from '~/server/schema/image.schema';
import { SearchIndexEntityTypes } from '~/components/Search/parsers/base';
import { LinkType } from '@prisma/client';
import { creatorCardStatsPreferences, profilePictureSchema } from './user.schema';

export type GetUserProfileSchema = z.infer<typeof getUserProfileSchema>;
export const getUserProfileSchema = z.object({
  username: z.string().optional(),
  id: z.number().optional(),
});

export const ProfileSectionTypeDef = {
  Showcase: 'showcase',
  PopularModels: 'popularModels',
  PopularArticles: 'popularArticles',
  ModelsOverview: 'modelsOverview',
  ImagesOverview: 'imagesOverview',
  RecentReviews: 'recentReviews',
} as const;

export type ProfileSectionType = (typeof ProfileSectionTypeDef)[keyof typeof ProfileSectionTypeDef];

export type ProfileSectionSchema = z.infer<typeof profileSectionSchema>;

export const profileSectionSchema = z.object({
  key: z.nativeEnum(ProfileSectionTypeDef),
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
  userId: z.number().optional(),
  showcaseItems: z.array(showcaseItemSchema).optional(),
  profileSectionsSettings: z.array(profileSectionSchema).optional(),
  privacySettings: privacySettingsSchema.optional(),
  message: z.string().nullish(),
  bio: z.string().nullish(),
  location: z.string().max(100).nullish(),
  // profileImage: z.string().nullish(),
  // profilePicture: profilePictureSchema.nullish(),
  coverImage: imageSchema.nullish(),
  socialLinks: z
    .array(
      z.object({
        id: z.number().optional(),
        url: z.string(),
        type: z.nativeEnum(LinkType),
      })
    )
    .optional(),
  sponsorshipLinks: z
    .array(
      z.object({
        id: z.number().optional(),
        url: z.string(),
        type: z.nativeEnum(LinkType),
      })
    )
    .optional(),
  creatorCardStatsPreferences: creatorCardStatsPreferences.optional(),
});

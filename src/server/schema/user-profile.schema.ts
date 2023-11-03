import { z } from 'zod';
import { imageSchema } from '~/server/schema/image.schema';
import { SearchIndexEntityType, SearchIndexEntityTypes } from '~/components/Search/parsers/base';
import {LinkType} from "@prisma/client";

export type GetUserProfileSchema = z.infer<typeof getUserProfileSchema>;
export const getUserProfileSchema = z.object({
  username: z.string().optional(),
  id: z.number().optional(),
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
  userId: z.number().optional(),
  showcaseItems: z.array(showcaseItemSchema).optional(),
  profileSectionsSettings: z.array(profileSectionSchema).optional(),
  privacySettings: privacySettingsSchema.optional(),
  message: z.string().nullish(),
  bio: z.string().nullish(),
  location: z.string().max(100).nullish(),
  profileImage: z.string().nullish(),
  coverImage: imageSchema.nullish(),
  links: z
    .array(
      z.object({
        id: z.number().optional(),
        url: z.string(),
      })
    )
    .optional(),
  badgeId: z.number().nullish(),
});

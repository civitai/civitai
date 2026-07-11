import * as z from 'zod';
import { imageSchema } from '~/server/schema/image.schema';
import { SearchIndexEntityTypes } from '~/components/Search/parsers/base';
import { LinkType } from '~/shared/utils/prisma/enums';
import { creatorCardStatsPreferences, profilePictureSchema } from './user.schema';

export type GetUserProfileSchema = z.infer<typeof getUserProfileSchema>;
export const getUserProfileSchema = z
  .object({
    // Reject an empty-string username at the input boundary. A profile page renders
    // `userProfile.get`/`userProfile.overview` before the username route param resolves,
    // sending `{ username: '' }`; that used to reach the service, fail the falsy
    // `!username && !id` guard, and surface as a raw 500. An empty/absent username is
    // invalid INPUT — reject it here so tRPC returns BAD_REQUEST (400).
    username: z.string().min(1).optional(),
    id: z.number().optional(),
  })
  .refine((d) => (d.username != null && d.username.length > 0) || d.id != null, {
    message: 'username or id required',
  });

export const ProfileSectionTypeDef = {
  Showcase: 'showcase',
  PopularModels: 'popularModels',
  PopularArticles: 'popularArticles',
  ModelsOverview: 'modelsOverview',
  ImagesOverview: 'imagesOverview',
  RecentReviews: 'recentReviews',
  Shop: 'shop',
} as const;

export type ProfileSectionType = (typeof ProfileSectionTypeDef)[keyof typeof ProfileSectionTypeDef];

export type ProfileSectionSchema = z.infer<typeof profileSectionSchema>;

export const profileSectionSchema = z.object({
  key: z.enum(ProfileSectionTypeDef),
  enabled: z.boolean(),
});

export type ShowcaseItemSchema = z.infer<typeof showcaseItemSchema>;

export const showcaseItemSchema = z.object({
  entityType: z.enum(SearchIndexEntityTypes),
  entityId: z.number(),
});

export type PrivacySettingsSchema = z.infer<typeof privacySettingsSchema>;

export const privacySettingsSchema = z.object({
  showLocation: z.boolean().optional(),
  showFollowers: z.boolean().optional(),
  showFollowing: z.boolean().optional(),
  showRating: z.boolean().optional(),
  showBadges: z.boolean().optional(),
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
        type: z.enum(LinkType),
      })
    )
    .optional(),
  sponsorshipLinks: z
    .array(
      z.object({
        id: z.number().optional(),
        url: z.string(),
        type: z.enum(LinkType),
      })
    )
    .optional(),
  creatorCardStatsPreferences: creatorCardStatsPreferences.optional(),
});

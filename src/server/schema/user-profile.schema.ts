import { z } from 'zod';
import { imageSchema } from '~/server/schema/image.schema';

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
  entityType: z.enum(['Model', 'Image']),
  entityId: z.number(),
});

export type PrivacySettingsSchema = z.infer<typeof privacySettingsSchema>;

export const privacySettingsSchema = z.object({
  showEmail: z.boolean().optional(),
  showBirthday: z.boolean().optional(),
  showGender: z.boolean().optional(),
  showLocation: z.boolean().optional(),
  showSocials: z.boolean().optional(),
  showLinks: z.boolean().optional(),
});

export type UserProfileUpdateSchema = z.infer<typeof userProfileUpdateSchema>;
export const userProfileUpdateSchema = z.object({
  showcaseItems: z.array(showcaseItemSchema),
  profileSectionsSettings: z.array(profileSectionSchema),
  privacySettings: privacySettingsSchema,
  message: z.string().optional(),
  bio: z.string().optional(),
  location: z.string().max(100).optional(),
  profileImage: z.string().optional(),
  coverImage: imageSchema.nullish(),
  coverImageId: z.number().optional(),
  links: z
    .array(
      z.object({
        id: z.number().optional(),
        type: z.string(),
        url: z.string(),
      })
    )
    .optional(),
});

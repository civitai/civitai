import {
  ArticleEngagementType,
  BountyEngagementType,
  MediaType,
  ModelEngagementType,
  TagEngagementType,
} from '@prisma/client';
import { z } from 'zod';
import { creatorCardStats, constants } from '~/server/common/constants';
import { OnboardingSteps } from '~/server/common/enums';
import { getAllQuerySchema } from '~/server/schema/base.schema';
import { userSettingsChat } from '~/server/schema/chat.schema';
import { featureFlagKeys } from '~/server/services/feature-flags.service';
import { removeEmpty } from '~/utils/object-helpers';
import { zc } from '~/utils/schema-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import {
  commaDelimitedEnumArray,
  commaDelimitedNumberArray,
  numericString,
} from '~/utils/zod-helpers';

export const userTierSchema = z.enum(['free', 'founder', 'bronze', 'silver', 'gold']);
export type UserTier = z.infer<typeof userTierSchema>;

export const userPageQuerySchema = z
  .object({
    username: z.string(),
    id: numericString().optional(),
  })
  .transform((props) => {
    // we're doing this to handle edge cases where a user hasn't finished onboarding and don't have a username
    // when a user doesn't have a username, the url becomes `/user/null?id`
    const username = !props.id ? postgresSlugify(props.username) : undefined;
    return removeEmpty({ ...props, username });
  });

export const usernameInputSchema = zc.usernameValidationSchema
  .min(3, 'Your username must be at least 3 characters long')
  .max(25, 'Your username must be at most 25 characters long')
  .transform((v) => v.trim());

export const usernameSchema = zc.usernameValidationSchema.transform((v) => v.trim());

export const getUserByUsernameSchema = z.object({
  username: usernameSchema.optional(),
  id: z.number().optional(),
  leaderboardId: z.string().optional(),
});

export type GetUserByUsernameSchema = z.infer<typeof getUserByUsernameSchema>;

export const getAllUsersInput = getAllQuerySchema
  .extend({
    email: z.string(),
    ids: commaDelimitedNumberArray(),
    include: commaDelimitedEnumArray(z.enum(['status', 'avatar'])).default([]),
  })
  .partial();
export type GetAllUsersInput = z.infer<typeof getAllUsersInput>;

export const profilePictureSchema = z.object({
  id: z.number().optional(),
  name: z.string().nullish(),
  url: z.string().url().or(z.string().uuid()),
  hash: z.string().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
  sizeKB: z.number().optional(),
  mimeType: z.string().optional(),
  metadata: z.object({}).passthrough().optional(),
  type: z.nativeEnum(MediaType).default(MediaType.image),
});

export const creatorCardStatsPreferences = z.array(z.string()).max(3);

export type UserPublicSettingsSchema = z.infer<typeof userPublicSettingsSchema>;
export const userPublicSettingsSchema = z.object({
  creatorCardStatsPreferences: creatorCardStatsPreferences.optional(),
});

export const userUpdateSchema = z.object({
  id: z.number(),
  username: usernameInputSchema.optional(),
  showNsfw: z.boolean().optional(),
  blurNsfw: z.boolean().optional(),
  browsingLevel: z.number().optional(),
  email: z.string().email().optional(),
  image: z.string().nullish(),
  profilePicture: profilePictureSchema.nullish(),
  badgeId: z.number().nullish(),
  nameplateId: z.number().nullish(),
  profileDecorationId: z.number().nullish(),
  profileBackgroundId: z.number().nullish(),
  autoplayGifs: z.boolean().optional(),
  filePreferences: z
    .object({
      format: z.enum(constants.modelFileFormats).optional(),
      size: z.enum(constants.modelFileSizes).optional(),
      fp: z.enum(constants.modelFileFp).optional(),
      imageFormat: z.enum(constants.imageFormats).optional(),
    })
    .optional(),
  leaderboardShowcase: z.string().nullish(),
  userReferralCode: z.string().optional(),
  source: z.string().optional(),
  landingPage: z.string().optional(),
});
export type UserUpdateInput = z.input<typeof userUpdateSchema>;

export const updateBrowsingModeSchema = z.object({
  showNsfw: z.boolean().optional(),
  blurNsfw: z.boolean().optional(),
  browsingLevel: z.number().optional(),
});

export const toggleFavoriteInput = z.object({
  modelId: z.number(),
  modelVersionId: z.number().optional(),
  setTo: z.boolean(),
});
export type ToggleFavoriteInput = z.infer<typeof toggleFavoriteInput>;

export const toggleModelEngagementInput = z.object({
  modelId: z.number(),
  type: z.nativeEnum(ModelEngagementType).optional(),
});
export type ToggleModelEngagementInput = z.infer<typeof toggleModelEngagementInput>;

export const toggleFollowUserSchema = z.object({
  targetUserId: z.number(),
  username: usernameSchema.nullable().optional(),
});
export type ToggleFollowUserSchema = z.infer<typeof toggleFollowUserSchema>;

export const getUserTagsSchema = z.object({ type: z.nativeEnum(TagEngagementType) });
export type GetUserTagsSchema = z.infer<typeof getUserTagsSchema>;

export const toggleBlockedTagSchema = z.object({ tagId: z.number() });
export type ToggleBlockedTagSchema = z.infer<typeof toggleBlockedTagSchema>;

export const batchBlockTagsSchema = z.object({ tagIds: z.array(z.number()) });
export type BatchBlockTagsSchema = z.infer<typeof batchBlockTagsSchema>;

export const getByUsernameSchema = z.object({ username: usernameSchema });
export type GetByUsernameSchema = z.infer<typeof getByUsernameSchema>;

export type DeleteUserInput = z.infer<typeof deleteUserSchema>;
export const deleteUserSchema = z.object({
  id: z.number(),
  username: usernameSchema.optional(),
  removeModels: z.boolean().optional(),
});

export type GetUserCosmeticsSchema = z.infer<typeof getUserCosmeticsSchema>;
export const getUserCosmeticsSchema = z.object({
  equipped: z.boolean(),
});

export type GetUserArticleEngagementsInput = z.infer<typeof getUserArticleEngagementsSchema>;
export const getUserArticleEngagementsSchema = z.object({
  type: z.nativeEnum(ArticleEngagementType),
});

export type ToggleUserArticleEngagementsInput = z.infer<typeof toggleUserArticleEngagementSchema>;
export const toggleUserArticleEngagementSchema = getUserArticleEngagementsSchema.extend({
  articleId: z.number(),
});

export type GetUserBountyEngagementsInput = z.infer<typeof getUserBountyEngagementsSchema>;
export const getUserBountyEngagementsSchema = z.object({
  type: z.nativeEnum(BountyEngagementType),
});

export type ToggleUserBountyEngagementsInput = z.infer<typeof toggleUserBountyEngagementSchema>;
export const toggleUserBountyEngagementSchema = getUserBountyEngagementsSchema.extend({
  bountyId: z.number(),
});

const prohibitedSources = z.enum(['Regex', 'External']);
export type ProhibitedSources = z.infer<typeof prohibitedSources>;
export type ReportProhibitedRequestInput = z.infer<typeof reportProhibitedRequestSchema>;
export const reportProhibitedRequestSchema = z.object({
  prompt: z.string().optional(),
  source: prohibitedSources.optional(),
});

export const userByReferralCodeSchema = z.object({ userReferralCode: z.string().min(3) });
export type UserByReferralCodeSchema = z.infer<typeof userByReferralCodeSchema>;

export type UserSettingsSchema = z.infer<typeof userSettingsSchema>;
export const userSettingsSchema = z.object({
  newsletterDialogLastSeenAt: z.date().nullish(),
  features: z.record(z.boolean()).optional(),
  newsletterSubscriber: z.boolean().optional(),
  dismissedAlerts: z.array(z.string()).optional(),
  chat: userSettingsChat.optional(),
  airEmail: z.string().email().optional(),
  creatorsProgramCodeOfConductAccepted: z.boolean().optional(),
  cosmeticStoreLastViewed: z.date().nullish(),
});

const [featureKey, ...otherKeys] = featureFlagKeys;
export type ToggleFeatureInput = z.infer<typeof toggleFeatureInputSchema>;
export const toggleFeatureInputSchema = z.object({
  // Small hack, please see: https://github.com/colinhacks/zod/discussions/839#discussioncomment-6488540
  feature: z.enum([featureKey, ...otherKeys]),
  value: z.boolean().optional(),
});

export type SetUserSettingsInput = z.infer<typeof setUserSettingsInput>;
export const setUserSettingsInput = z.object({
  creatorsProgramCodeOfConductAccepted: z.boolean().optional(),
  cosmeticStoreLastViewed: z.date().optional(),
});

export const dismissAlertSchema = z.object({ alertId: z.string() });

export type UserOnboardingSchema = z.infer<typeof userOnboardingSchema>;
export const userOnboardingSchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal(OnboardingSteps.TOS), recaptchaToken: z.string() }),
  z.object({ step: z.literal(OnboardingSteps.Profile), username: z.string(), email: z.string() }),
  z.object({ step: z.literal(OnboardingSteps.BrowsingLevels) }),
  z.object({
    step: z.literal(OnboardingSteps.Buzz),
    userReferralCode: z.string().optional(),
    source: z.string().optional(),
  }),
]);

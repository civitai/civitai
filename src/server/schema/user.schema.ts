import * as z from 'zod';
import { BanReasonCode, OnboardingSteps } from '~/server/common/enums';
import { getAllQuerySchema, paginationSchema } from '~/server/schema/base.schema';
import { userSettingsChat } from '~/server/schema/chat.schema';
import type { ModelGallerySettingsSchema } from '~/server/schema/model.schema';
// import { modelGallerySettingsSchema } from '~/server/schema/model.schema';
import { featureFlagKeys, userTiers } from '~/server/services/feature-flags.service';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import {
  ArticleEngagementType,
  BountyEngagementType,
  MediaType,
  ModelEngagementType,
  TagEngagementType,
} from '~/shared/utils/prisma/enums';
import { usernameSchema } from '~/shared/zod/username.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import {
  commaDelimitedEnumArray,
  commaDelimitedNumberArray,
  numericString,
} from '~/utils/zod-helpers';

export const userTierSchema = z.enum(userTiers);
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

export const usernameInputSchema = usernameSchema
  .min(3, 'Your username must be at least 3 characters long')
  .max(25, 'Your username must be at most 25 characters long')
  .transform((v) => v.trim());

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
    include: commaDelimitedEnumArray(['status', 'avatar']).default([]),
    excludedUserIds: z.array(z.number()).optional(),
    contestBanned: z.boolean().optional(),
  })
  .partial();
export type GetAllUsersInput = z.infer<typeof getAllUsersInput>;

export const profilePictureSchema = z.object({
  id: z.number().optional(),
  name: z.string().nullish(),
  url: z.url().or(z.string().uuid()),
  hash: z.string().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
  sizeKB: z.number().optional(),
  mimeType: z.string().optional(),
  metadata: z.object({}).passthrough().optional(),
  type: z.enum(MediaType).default(MediaType.image),
});

export const creatorCardStatsPreferences = z.array(z.string()).max(3);

export type UserPublicSettingsSchema = z.infer<typeof userPublicSettingsSchema>;
export const userPublicSettingsSchema = z.object({
  creatorCardStatsPreferences: creatorCardStatsPreferences.optional(),
});

export const userUpdateSchema = z.object({
  id: z.number(),
  username: usernameInputSchema.optional(),
  // showNsfw: z.boolean().optional(),
  // blurNsfw: z.boolean().optional(),
  // browsingLevel: z.number().min(0).max(allBrowsingLevelsFlag).optional(),
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
      format: z.string().optional(),
      size: z.string().optional(),
      fp: z.string().optional(),
      imageFormat: z.string().optional(),
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
  browsingLevel: z.number().min(0).max(allBrowsingLevelsFlag).optional(),
});

export const toggleFavoriteInput = z.object({
  modelId: z.number(),
  modelVersionId: z.number().optional(),
  setTo: z.boolean(),
});
export type ToggleFavoriteInput = z.infer<typeof toggleFavoriteInput>;

export const toggleModelEngagementInput = z.object({
  modelId: z.number(),
  type: z.enum(ModelEngagementType).optional(),
});
export type ToggleModelEngagementInput = z.infer<typeof toggleModelEngagementInput>;

export const toggleFollowUserSchema = z.object({
  targetUserId: z.number(),
  username: usernameSchema.nullable().optional(),
});
export type ToggleFollowUserSchema = z.infer<typeof toggleFollowUserSchema>;

export const getUserTagsSchema = z.object({ type: z.enum(TagEngagementType) });
export type GetUserTagsSchema = z.infer<typeof getUserTagsSchema>;

export const toggleBlockedTagSchema = z.object({ tagId: z.number() });
export type ToggleBlockedTagSchema = z.infer<typeof toggleBlockedTagSchema>;

export const batchBlockTagsSchema = z.object({ tagIds: z.array(z.number()) });
export type BatchBlockTagsSchema = z.infer<typeof batchBlockTagsSchema>;

export const getByUsernameSchema = z.object({ username: usernameSchema });
export type GetByUsernameSchema = z.infer<typeof getByUsernameSchema>;

export const getUserListSchema = paginationSchema.extend({
  username: usernameSchema,
  type: z.enum(['following', 'followers', 'hidden', 'blocked']),
});
export type GetUserListSchema = z.infer<typeof getUserListSchema>;

export type DeleteUserInput = z.infer<typeof deleteUserSchema>;
export const deleteUserSchema = z.object({
  id: z.number(),
  username: usernameSchema.optional(),
  removeModels: z.boolean().optional(),
});

export type GetUserCosmeticsSchema = z.infer<typeof getUserCosmeticsSchema>;
export const getUserCosmeticsSchema = z.object({
  equipped: z.boolean().optional(),
});

export type GetUserArticleEngagementsInput = z.infer<typeof getUserArticleEngagementsSchema>;
export const getUserArticleEngagementsSchema = z.object({
  type: z.enum(ArticleEngagementType),
});

export type ToggleUserArticleEngagementsInput = z.infer<typeof toggleUserArticleEngagementSchema>;
export const toggleUserArticleEngagementSchema = getUserArticleEngagementsSchema.extend({
  articleId: z.number(),
});

export type GetUserBountyEngagementsInput = z.infer<typeof getUserBountyEngagementsSchema>;
export const getUserBountyEngagementsSchema = z.object({
  type: z.enum(BountyEngagementType),
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
  negativePrompt: z.string().optional(),
  source: prohibitedSources.optional(),
});

export const userByReferralCodeSchema = z.object({ userReferralCode: z.string().min(3) });
export type UserByReferralCodeSchema = z.infer<typeof userByReferralCodeSchema>;

export type TourSettingsSchema = z.infer<typeof tourSettingsSchema>;
const tourSettingsSchema = z.record(
  z.string(),
  z.object({
    completed: z.boolean().optional(),
    currentStep: z.number().optional(),
  })
);

const generationSettingsSchema = z.object({
  advancedMode: z.boolean().optional(),
});

export const userAssistantPersonality = z.enum(['civbot', 'civchan']);
export type UserAssistantPersonality = z.infer<typeof userAssistantPersonality>;

export type UserSettingsInput = z.input<typeof userSettingsSchema>;
export type UserSettingsSchema = z.infer<typeof userSettingsSchema>;
export const userSettingsSchema = z.object({
  newsletterDialogLastSeenAt: z.coerce.date().nullish(),
  features: z.record(z.string(), z.boolean()).optional(),
  newsletterSubscriber: z.boolean().optional(),
  dismissedAlerts: z.array(z.string()).optional(),
  chat: userSettingsChat.optional(),
  assistantPersonality: userAssistantPersonality.optional(),
  airEmail: z.string().email().optional(),
  creatorsProgramCodeOfConductAccepted: z.union([z.boolean(), z.date()]).optional(),
  cosmeticStoreLastViewed: z.coerce.date().nullish(),
  allowAds: z.boolean().optional(),
  disableHidden: z.boolean().optional(),
  hideDownloadsSince: z.number().optional(),
  gallerySettings: (
    z.object({
      users: z.number().array().optional(),
      tags: z.number().array().optional(),
      level: z.number().optional(),
    }) satisfies z.ZodType<ModelGallerySettingsSchema>
  ).optional(),
  tourSettings: tourSettingsSchema.optional(),
  generation: generationSettingsSchema.optional(),
  redBrowsingLevel: z.number().optional(),
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
  creatorsProgramCodeOfConductAccepted: z.date().optional(),
  cosmeticStoreLastViewed: z.date().optional(),
  allowAds: z.boolean().optional(),
  tourSettings: tourSettingsSchema.optional(),
  generation: generationSettingsSchema.optional(),
  creatorProgramToSAccepted: z.date().optional(),
  assistantPersonality: userAssistantPersonality.optional(),
});

export const dismissAlertSchema = z.object({ alertId: z.string() });

export type UserOnboardingSchema = z.infer<typeof userOnboardingSchema>;
export const userOnboardingSchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal(OnboardingSteps.TOS) }),
  z.object({ step: z.literal(OnboardingSteps.RedTOS) }),
  z.object({
    step: z.literal(OnboardingSteps.Profile),
    username: usernameInputSchema,
    email: z.string(),
  }),
  z.object({ step: z.literal(OnboardingSteps.BrowsingLevels) }),
  z.object({
    step: z.literal(OnboardingSteps.Buzz),
    userReferralCode: z.string().optional(),
    source: z.string().optional(),
    recaptchaToken: z.string(),
  }),
]);

export const setLeaderboardEligbilitySchema = z.object({
  id: z.number(),
  setTo: z.boolean(),
});
export type SetLeaderboardEligibilitySchema = z.infer<typeof setLeaderboardEligbilitySchema>;

export type UserScoreMeta = z.infer<typeof userScoreMetaSchema>;
export const userScoreMetaSchema = z.object({
  total: z.number(),
  models: z.number().optional(),
  articles: z.number().optional(),
  images: z.number().optional(),
  users: z.number().optional(),
  reportsActioned: z.number().optional(),
  reportsAgainst: z.number().optional(),
});

export const userMeta = z.object({
  firstImage: z.date().optional(),
  scores: userScoreMetaSchema.optional(),
  banDetails: z
    .object({
      reasonCode: z.enum(BanReasonCode).optional(),
      detailsInternal: z.string().optional(),
      detailsExternal: z.string().optional(),
    })
    .optional(),
  contestBanDetails: z
    .object({
      bannedAt: z.date().optional(),
      detailsInternal: z.string().optional(),
    })
    .optional(),
  membershipChangedAt: z.date().optional(),
});
export type UserMeta = z.infer<typeof userMeta>;

export type ComputeDeviceFingerprintInput = z.infer<typeof computeDeviceFingerprintSchema>;
export const computeDeviceFingerprintSchema = z.object({ fingerprint: z.string() });

export type UpdateContentSettingsInput = z.infer<typeof updateContentSettingsSchema>;
export const updateContentSettingsSchema = z.object({
  showNsfw: z.boolean().optional(),
  blurNsfw: z.boolean().optional(),
  browsingLevel: z.number().optional(),
  disableHidden: z.boolean().optional(),
  allowAds: z.boolean().optional(),
  autoplayGifs: z.boolean().optional(),
  domain: z.enum(['green', 'blue', 'red']).optional(),
});

export type ToggleBanUser = z.infer<typeof toggleBanUserSchema>;
export const toggleBanUserSchema = z.object({
  id: z.number(),
  reasonCode: z.enum(BanReasonCode).optional(),
  detailsInternal: z.string().optional(),
  detailsExternal: z.string().optional(),
  type: z.enum(['universal', 'contest']).default('universal').optional(),
});

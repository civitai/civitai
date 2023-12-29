import {
  TagEngagementType,
  ArticleEngagementType,
  BountyEngagementType,
  OnboardingStep,
  NsfwLevel,
  MediaType,
} from '@prisma/client';
import { z } from 'zod';
import { constants } from '~/server/common/constants';

import { getAllQuerySchema } from '~/server/schema/base.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { zc } from '~/utils/schema-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { numericString } from '~/utils/zod-helpers';

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
  .extend({ email: z.string(), ids: z.array(z.number()) })
  .partial();
export type GetAllUsersInput = z.infer<typeof getAllUsersInput>;

export type ProfilePictureSchema = z.infer<typeof profilePictureSchema>;
export const profilePictureSchema = z.object({
  id: z.number().optional(),
  name: z.string().nullish(),
  url: z.string().url().or(z.string().uuid()),
  hash: z.string().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
  sizeKB: z.number().optional(),
  nsfw: z.nativeEnum(NsfwLevel).optional(),
  mimeType: z.string().optional(),
  metadata: z.object({}).passthrough().optional(),
  type: z.nativeEnum(MediaType).default(MediaType.image),
});

export const userUpdateSchema = z.object({
  id: z.number(),
  username: usernameInputSchema.optional(),
  showNsfw: z.boolean().optional(),
  blurNsfw: z.boolean().optional(),
  tos: z.boolean().optional(),
  onboardingStep: z.nativeEnum(OnboardingStep).array().optional(),
  email: z.string().email().optional(),
  image: z.string().nullish(),
  profilePicture: profilePictureSchema.nullish(),
  badgeId: z.number().nullish(),
  nameplateId: z.number().nullish(),
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

export const toggleModelEngagementInput = z.object({ modelId: z.number() });
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

export type CompleteOnboardingStepInput = z.infer<typeof completeOnboardStepSchema>;
export const completeOnboardStepSchema = z.object({
  step: z.nativeEnum(OnboardingStep).optional(),
});

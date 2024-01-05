import { z } from 'zod';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { comfylessImageSchema } from '~/server/schema/image.schema';
import { Currency } from '@prisma/client';
import { infiniteQuerySchema, paginationSchema, resourceInput } from '~/server/schema/base.schema';
import { ClubSort } from '~/server/common/enums';
import { constants } from '~/server/common/constants';

export type UpsertClubTierInput = z.infer<typeof upsertClubTierInput>;
export const upsertClubTierInput = z
  .object({
    id: z.number().optional(),
    name: z.string().trim().nonempty(),
    description: getSanitizedStringSchema().refine((data) => {
      return data && data.length > 0 && data !== '<p></p>';
    }, 'Cannot be empty'),
    unitAmount: z
      .number()
      .refine(
        (data) => data === 0 || data >= constants.clubs.minMonthlyBuzz,
        `Minimum price is ${constants.clubs.minMonthlyBuzz} BUZZ`
      ),
    currency: z.nativeEnum(Currency).default(Currency.BUZZ),
    coverImage: comfylessImageSchema.nullish(),
    unlisted: z.boolean().default(false),
    joinable: z.boolean().default(true),
    clubId: z.number().optional(),
    memberLimit: z.number().max(constants.clubs.tierMaxMemberLimit).nullish(),
    oneTimeFee: z.boolean().default(false),
  })
  .refine((data) => !!data.clubId || !!data.id, {
    message: 'When creating a new tier, clubId must be provided',
  });

export type UpsertClubInput = z.infer<typeof upsertClubInput>;
export const upsertClubInput = z.object({
  id: z.number().optional(),
  name: z.string().trim().nonempty(),
  description: getSanitizedStringSchema().refine((data) => {
    return data && data.length > 0 && data !== '<p></p>';
  }, 'Cannot be empty'),
  nsfw: z.boolean().optional(),
  billing: z.boolean().optional(),
  unlisted: z.boolean().optional(),
  coverImage: comfylessImageSchema.nullish(),
  headerImage: comfylessImageSchema.nullish(),
  avatar: comfylessImageSchema.nullish(),
});

export type GetClubTiersInput = z.infer<typeof getClubTiersInput>;

export const getClubTiersInput = z.object({
  clubId: z.number().optional(),
  clubIds: z.array(z.number()).optional(),
  listedOnly: z.boolean().optional(),
  joinableOnly: z.boolean().optional(),
  tierId: z.number().optional(),
});

export const supportedClubEntities = ['ModelVersion', 'Article', 'Post'] as const;
export type SupportedClubEntities = (typeof supportedClubEntities)[number];
export const supportedClubPostEntities = [...supportedClubEntities, 'Model'] as const;
export type SupportedClubPostEntities = (typeof supportedClubPostEntities)[number];

export const clubResourceSchema = z.object({
  clubId: z.number(),
  clubTierIds: z.array(z.number()).optional(),
});

export type ClubResourceSchema = z.infer<typeof clubResourceSchema>;

export const upsertClubResourceInput = z.object({
  entityType: z.enum(supportedClubEntities),
  entityId: z.number(),
  clubs: z.array(clubResourceSchema),
});

export type UpsertClubResourceInput = z.infer<typeof upsertClubResourceInput>;

export const removeClubResourceInput = z.object({
  entityType: z.enum(supportedClubEntities),
  entityId: z.number(),
  clubId: z.number(),
});

export type RemoveClubResourceInput = z.infer<typeof removeClubResourceInput>;

export const getInfiniteClubPostsSchema = infiniteQuerySchema.merge(
  z.object({
    clubId: z.number(),
    limit: z.coerce.number().min(1).max(200).default(60),
  })
);

export type GetInfiniteClubPostsSchema = z.infer<typeof getInfiniteClubPostsSchema>;

export const upsertClubPostInput = z.object({
  id: z.number().optional(),
  title: z.string().max(255).nullish(),
  description: z.string().nullish(),
  coverImage: comfylessImageSchema.nullish(),
  membersOnly: z.boolean().default(false),
  clubId: z.number(),
  entityId: z.number().nullish(),
  entityType: z.enum(supportedClubPostEntities).nullish(),
});

export type UpsertClubPostInput = z.infer<typeof upsertClubPostInput>;

export type GetInfiniteClubSchema = z.infer<typeof getInfiniteClubSchema>;
export const getInfiniteClubSchema = infiniteQuerySchema.merge(
  z.object({
    nsfw: z.boolean().optional(),
    userId: z.number().optional(),
    engagement: z.enum(['engaged']).optional(),
    sort: z.nativeEnum(ClubSort).default(ClubSort.Newest),
    limit: z.coerce.number().min(1).max(200).default(60),
    clubIds: z.array(z.number()).optional(),
    include: z.array(z.enum(['tiers'])).optional(),
  })
);

export const getPaginatedClubResourcesSchema = paginationSchema.merge(
  z.object({
    clubId: z.number(),
    limit: z.coerce.number().min(1).max(200).default(60),
    clubTierId: z.number().optional(),
  })
);

export type GetPaginatedClubResourcesSchema = z.infer<typeof getPaginatedClubResourcesSchema>;

export const updateClubResourceInput = clubResourceSchema.extend({
  entityType: z.enum(supportedClubEntities),
  entityId: z.number(),
});

export type UpdateClubResourceInput = z.infer<typeof updateClubResourceInput>;

export const clubResourceInput = resourceInput.extend({
  entityType: z.enum(supportedClubEntities),
});

export type ClubResourceInput = z.infer<typeof clubResourceInput>;

export const clubPostResourceInput = resourceInput.extend({
  entityType: z.enum(supportedClubPostEntities),
});

export type ClubPostResourceInput = z.infer<typeof clubPostResourceInput>;

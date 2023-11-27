import { z } from 'zod';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { comfylessImageSchema } from '~/server/schema/image.schema';
import { Currency } from '@prisma/client';
import { infiniteQuerySchema } from '~/server/schema/base.schema';

export type UpsertClubTierInput = z.infer<typeof upsertClubTierInput>;
export const upsertClubTierInput = z
  .object({
    id: z.number().optional(),
    name: z.string().trim().nonempty(),
    description: getSanitizedStringSchema().refine((data) => {
      return data && data.length > 0 && data !== '<p></p>';
    }, 'Cannot be empty'),
    unitAmount: z.number().min(0),
    currency: z.nativeEnum(Currency).default(Currency.BUZZ),
    coverImage: comfylessImageSchema.nullish(),
    unlisted: z.boolean().default(false),
    joinable: z.boolean().default(true),
    clubId: z.number().optional(),
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
  tiers: z.array(upsertClubTierInput).optional(),
  deleteTierIds: z.array(z.number()).optional(),
});

export type GetClubTiersInput = z.infer<typeof getClubTiersInput>;

export const getClubTiersInput = z.object({
  clubId: z.number(),
  listedOnly: z.boolean().optional(),
  joinableOnly: z.boolean().optional(),
  include: z.array(z.enum(['membershipsCount'])).optional(),
  tierId: z.number().optional(),
});

const supportedClubEntities = ['Model', 'Article'] as const;
export type SupportedClubEntities = (typeof supportedClubEntities)[number];

export const getClubEntity = z.object({
  clubId: z.number(),
  entityType: z.enum(supportedClubEntities),
  entityId: z.number(),
});

export type GetClubEntityInput = z.infer<typeof getClubEntity>;

export const upsertClubEntitySchema = z.object({
  clubId: z.number(),
  entityType: z.enum(supportedClubEntities),
  entityId: z.number(),
  title: z.string().trim().nonempty(),
  description: getSanitizedStringSchema().refine((data) => {
    return data && data.length > 0 && data !== '<p></p>';
  }, 'Cannot be empty'),
  membersOnly: z.boolean(),
  privatizeEntity: z.boolean(),
  clubTierIds: z.array(z.number()).optional(),
});

export type UpsertClubEntityInput = z.infer<typeof upsertClubEntitySchema>;

export const getAllClubEntities = infiniteQuerySchema.merge(
  z.object({
    clubId: z.number(),
    limit: z.coerce.number().min(1).max(200).default(60),
    cursor: z.string().optional(),
  })
);

export type GetAllClubEntitiesInput = z.infer<typeof getAllClubEntities>;

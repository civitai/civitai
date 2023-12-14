import { z } from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import { ClubAdminPermission } from '@prisma/client';

export const getPagedClubAdminInviteSchema = paginationSchema.merge(
  z.object({
    clubId: z.number(),
    limit: z.coerce.number().min(1).max(200).default(60),
  })
);

export type GetPagedClubAdminInviteSchema = z.infer<typeof getPagedClubAdminInviteSchema>;

export const upsertClubAdminInviteInput = z.object({
  id: z.string().optional(),
  clubId: z.number(),
  expiresAt: z.date().nullish(),
  permissions: z.array(z.nativeEnum(ClubAdminPermission)).min(1),
});

export type UpsertClubAdminInviteInput = z.infer<typeof upsertClubAdminInviteInput>;

export const getPagedClubAdminSchema = paginationSchema.merge(
  z.object({
    clubId: z.number(),
    limit: z.coerce.number().min(1).max(200).default(60),
  })
);

export type GetPagedClubAdminSchema = z.infer<typeof getPagedClubAdminSchema>;

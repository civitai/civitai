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
  permissions: z
    .array(z.nativeEnum(ClubAdminPermission))
    .min(1, { message: 'At least one permission is required' }),
});

export const deleteClubAdminInviteInput = z.object({
  id: z.string(),
  clubId: z.number(),
});

export type DeleteClubAdminInviteInput = z.infer<typeof deleteClubAdminInviteInput>;

export type UpsertClubAdminInviteInput = z.infer<typeof upsertClubAdminInviteInput>;

export const getPagedClubAdminSchema = paginationSchema.merge(
  z.object({
    clubId: z.number(),
    limit: z.coerce.number().min(1).max(200).default(60),
  })
);

export type GetPagedClubAdminSchema = z.infer<typeof getPagedClubAdminSchema>;

export const acceptClubAdminInviteInput = z.object({
  id: z.string(),
});

export type AcceptClubAdminInviteInput = z.infer<typeof acceptClubAdminInviteInput>;

export const updateClubAdminInput = z.object({
  userId: z.number(),
  clubId: z.number(),
  permissions: z.array(z.nativeEnum(ClubAdminPermission)).min(1),
});

export type UpdateClubAdminInput = z.infer<typeof updateClubAdminInput>;

export const deleteClubAdminInput = z.object({
  userId: z.number(),
  clubId: z.number(),
});

export type DeleteClubAdminInput = z.infer<typeof deleteClubAdminInput>;

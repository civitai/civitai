import { LinkType } from '@prisma/client';
import { z } from 'zod';
import { zc } from '~/utils/schema-helpers';

export type GetUserLinksQuery = z.infer<typeof getUserLinksSchema>;
export const getUserLinksSchema = z.object({ userId: z.number().optional() });

export type UpsertUserLinkParams = z.infer<typeof upsertUserLinkSchema>;
export const upsertUserLinkSchema = z.object({
  id: z.number().optional(),
  url: zc.safeUrl,
  type: z.nativeEnum(LinkType),
});
export const upsertManyUserLinkSchema = z.array(upsertUserLinkSchema);
export type UpsertManyUserLinkParams = z.infer<typeof upsertManyUserLinkSchema>;

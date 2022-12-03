import { LinkType } from '@prisma/client';
import { z } from 'zod';

export type GetUserLinksQuery = z.infer<typeof getUserLinksSchema>;
export const getUserLinksSchema = z.object({ userId: z.number().optional() });

export type UpsertUserLinkParams = z.infer<typeof upsertUserLinkSchema>;
export const upsertUserLinkSchema = z.object({
  id: z.number().optional(),
  userId: z.number(),
  url: z.string(),
  type: z.nativeEnum(LinkType),
});
export const upsertManyUserLinkSchema = z.array(upsertUserLinkSchema);
export type UpsertManyUserLinkParams = z.infer<typeof upsertManyUserLinkSchema>;

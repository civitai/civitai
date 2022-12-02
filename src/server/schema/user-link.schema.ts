import { LinkType } from '@prisma/client';
import { z } from 'zod';

export type GetUserLinksQuery = z.infer<typeof getUserLinksSchema>;
export const getUserLinksSchema = z.object({ userId: z.number() });

export type UserLinkParams = z.infer<typeof userLinkSchema>;
export const userLinkSchema = z.object({
  id: z.number().optional(),
  userId: z.number(),
  url: z.string(),
  type: z.nativeEnum(LinkType),
});
export const upsertManyUserLinkSchema = z.array(userLinkSchema);

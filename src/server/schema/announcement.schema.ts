import { z } from 'zod';

export type GetLatestAnnouncementInput = z.infer<typeof getLastestSchema>;
export const getLastestSchema = z.object({
  dismissed: z.array(z.number()).optional(),
});

export type AnnouncementMetaSchema = z.infer<typeof announcementMetaSchema>;

export const announcementMetaSchema = z
  .object({
    actions: z.array(
      z.object({
        type: z.enum(['button']),
        link: z.string(),
        linkText: z.string(),
        variant: z.string().optional(),
        icon: z.string().optional(),
        color: z.string().optional(),
      })
    ),
    targetAudience: z.enum(['all', 'unauthenticated', 'authenticated']).default('all'),
    dismissible: z.boolean().default(true),
    colSpan: z.number().default(6),
    image: z.string().optional(),
    index: z.number().optional(),
  })
  .partial();

export type GetAnnouncementsInput = z.infer<typeof getAnnouncementsSchema>;
export const getAnnouncementsSchema = z.object({
  dismissed: z.array(z.number()).optional(),
  ids: z.array(z.number()).optional(),
  limit: z.number().optional(),
});

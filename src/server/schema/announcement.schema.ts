import * as z from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';

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

export type UpsertAnnouncementSchema = z.infer<typeof upsertAnnouncementSchema>;
export const upsertAnnouncementSchema = z.object({
  id: z.number().optional(),
  title: z.string(),
  content: z.string(),
  color: z.string(),
  startsAt: z.date().nullish(),
  endsAt: z.date().nullish(),
  disabled: z.boolean().optional(),
  metadata: announcementMetaSchema,
});

export type GetAnnouncementsPagedSchema = z.infer<typeof getAnnouncementsPagedSchema>;
export const getAnnouncementsPagedSchema = paginationSchema.extend({});

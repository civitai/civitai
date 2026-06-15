import * as z from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import { DomainColor } from '~/shared/utils/prisma/enums';

export const domainColorEnum = z.enum(DomainColor);

// Where an announcement is surfaced. `site` is the default catch-all (the global
// banner area + notifications); `generator` and `training` scope an announcement
// to those pages. Untyped/legacy announcements are treated as `site` at read time.
export const announcementTypes = ['site', 'generator', 'training'] as const;
export const announcementTypeSchema = z.enum(announcementTypes);
export type AnnouncementType = z.infer<typeof announcementTypeSchema>;

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
    type: announcementTypeSchema.default('site'),
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
  domain: z.array(domainColorEnum).nonempty().default([DomainColor.all]),
  startsAt: z.date().nullish(),
  endsAt: z.date().nullish(),
  disabled: z.boolean().optional(),
  metadata: announcementMetaSchema,
});

export type GetAnnouncementsPagedSchema = z.infer<typeof getAnnouncementsPagedSchema>;
export const getAnnouncementsPagedSchema = paginationSchema.extend({
  domain: domainColorEnum.optional(),
});

export type GetCurrentAnnouncementsSchema = z.infer<typeof getCurrentAnnouncementsSchema>;
export const getCurrentAnnouncementsSchema = z.object({
  domain: domainColorEnum.optional(),
});

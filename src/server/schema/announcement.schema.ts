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
    // A bare media object key — NOT an `Image` row id and NOT a URL.
    //
    // 🔴 These keys are intentionally not registered as `Image` rows. `deleteImageFromS3`
    // is row-scoped (every call site passes an `Image` row's id + url), so a key with no
    // row cannot be deleted by any app path — which is the whole point, after a deleted
    // `Image` row took a live sitewide banner's object with it. Do not "normalise" this
    // into an `Image` FK, and any future orphan sweeper over the uploads bucket must
    // exclude the keys held here. Monitored by `~/server/jobs/announcement-media-check`.
    image: z.string().optional(),
    index: z.number().optional(),
  })
  .partial();

export const MAX_ANNOUNCEMENT_TARGET_USERS = 50_000;

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
  // Replace-set semantics: undefined leaves targeting unchanged, [] clears it
  // (announcement shows to everyone), a non-empty array restricts the
  // announcement to exactly those users.
  targetUserIds: z.array(z.number().int().positive()).max(MAX_ANNOUNCEMENT_TARGET_USERS).optional(),
  // Only acted on when targetUserIds resolves to a non-empty set: sends a
  // system-announcement notification to each targeted user on this save.
  notifyTargetedUsers: z.boolean().optional(),
});

export type GetAnnouncementsPagedSchema = z.infer<typeof getAnnouncementsPagedSchema>;
export const getAnnouncementsPagedSchema = paginationSchema.extend({
  domain: domainColorEnum.optional(),
});

export type GetCurrentAnnouncementsSchema = z.infer<typeof getCurrentAnnouncementsSchema>;
export const getCurrentAnnouncementsSchema = z.object({
  domain: domainColorEnum.optional(),
});

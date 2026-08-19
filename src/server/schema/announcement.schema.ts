import * as z from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import { DomainColor } from '~/shared/utils/prisma/enums';
import { imageSchema } from '~/server/schema/image.schema';

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

/**
 * A creator's own announcement.
 *
 * 🔴 This schema is the boundary that keeps a creator off the sitewide surfaces, and it
 * does it by omission: there is no `metadata.type` here, so `site` / `generator` /
 * `training` are not expressible on this path at all — not rejected by a check someone can
 * later loosen. `targetUserIds` and `notifyTargetedUsers` are absent for the same reason;
 * a creator's audience is their followers, resolved at send time, never a supplied list.
 *
 * `domain` IS creator-settable: DomainColor selects an audience, it does not widen reach.
 */
export const upsertCreatorAnnouncementSchema = z.object({
  id: z.number().optional(),
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(5000),
  emoji: z.string().max(8).optional(),
  color: z.string().max(32).optional(),
  domain: z.array(domainColorEnum).nonempty().default([DomainColor.all]),
  startsAt: z.date().nullish(),
  endsAt: z.date().nullish(),
  disabled: z.boolean().optional(),
  /** Shows on the author's profile only: no feed, no notification, no allowance spent. */
  profileOnly: z.boolean().default(false),
  coverImage: imageSchema.optional(),
  action: z
    .object({
      link: z.string().url(),
      linkText: z.string().trim().min(1).max(40),
    })
    .optional(),
});
export type UpsertCreatorAnnouncementSchema = z.infer<typeof upsertCreatorAnnouncementSchema>;

export const getCreatorAnnouncementsSchema = z.object({
  userId: z.number(),
  limit: z.number().min(1).max(50).default(10),
});

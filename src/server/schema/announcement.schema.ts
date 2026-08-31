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
/**
 * An announcement is a short pointer at something else, and the card that renders it has no line
 * clamp (`AnnouncementCard`) — whatever is stored is drawn in full, in a 710px drawer or a 540px
 * `Container size="sm"`. 500 is about 7-11 lines there.
 */
export const CREATOR_ANNOUNCEMENT_CONTENT_MAX = 500;

/**
 * The schema's hard bound, deliberately ABOVE the limit above.
 *
 * The pending profile-banner backfill inserts 25,655 rows from `UserProfile.message`, and 8,757 of
 * those are longer than 500 (measured on prod: p50 152, p99 1200, max 1232). Capping the schema at
 * 500 would mean a creator opening their own migrated banner to fix a typo cannot save it at all.
 * `assertContentLength` in the service enforces 500 on anything NEW or LENGTHENED instead, so an
 * over-long legacy row can still be edited and shortened, just never grown.
 */
export const CREATOR_ANNOUNCEMENT_CONTENT_CEILING = 1500;

export const upsertCreatorAnnouncementSchema = z.object({
  id: z.number().optional(),
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(CREATOR_ANNOUNCEMENT_CONTENT_CEILING),
  emoji: z.string().max(8).optional(),
  color: z.string().max(32).optional(),
  domain: z.array(domainColorEnum).nonempty().default([DomainColor.all]),
  startsAt: z.date().nullish(),
  endsAt: z.date().nullish(),
  // No `disabled`. Nothing can distinguish a row a creator hid from one a moderator took
  // down, so accepting the field lets a creator restore a moderated announcement by
  // sending `disabled: false` — for free, since that path spends no slot. Creators end an
  // announcement by deleting it or by setting an endsAt.
  /** Shows on the author's profile only: no feed, no notification, no allowance spent. */
  profileOnly: z.boolean().default(false),
  coverImage: imageSchema.optional(),
  action: z
    .object({
      // An absolute URL, or a site-relative path so one announcement resolves on whichever
      // domain the viewer is on (/models/123 works on both .com and .red).
      //
      // 🔴 The relative branch is deliberately `/` followed by something that is not `/`.
      // A scheme-relative `//evil.com` is a fully external link that merely looks relative,
      // and `javascript:` / `data:` URIs are excluded by requiring http(s) on the absolute
      // branch rather than by blacklisting schemes.
      link: z
        .string()
        .trim()
        .refine(
          (value) =>
            /^\/(?!\/)/.test(value) ||
            (() => {
              try {
                return ['http:', 'https:'].includes(new URL(value).protocol);
              } catch {
                return false;
              }
            })(),
          { message: 'Enter a full https:// link or a path beginning with /' }
        ),
      linkText: z.string().trim().min(1).max(40),
    })
    .optional(),
});
export type UpsertCreatorAnnouncementSchema = z.infer<typeof upsertCreatorAnnouncementSchema>;

export const getCreatorAnnouncementsSchema = z.object({
  userId: z.number(),
  limit: z.number().min(1).max(50).default(10),
  // Stamped from the request host by applyRequestDomainColor, never sent by the client.
  domain: domainColorEnum.optional(),
});

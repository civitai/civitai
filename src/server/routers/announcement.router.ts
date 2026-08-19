import {
  router,
  publicProcedure,
  moderatorProcedure,
  guardedProcedure,
  protectedProcedure,
  middleware,
} from '~/server/trpc';
import {
  domainColorEnum,
  getAnnouncementsPagedSchema,
  getCreatorAnnouncementsSchema,
  getCurrentAnnouncementsSchema,
  upsertAnnouncementSchema,
  upsertCreatorAnnouncementSchema,
} from '~/server/schema/announcement.schema';
import {
  deleteAnnouncement,
  getAnnouncementsPaged,
  getAnnouncementTargetUserIds,
  getCurrentAnnouncements,
  upsertAnnouncement,
} from '~/server/services/announcement.service';
import {
  deleteCreatorAnnouncement,
  getCreatorAnnouncements,
  getFollowedAnnouncements,
  getMutedAnnouncementCreators,
  isAnnouncementCreatorMuted,
  toggleAnnouncementMute,
  upsertCreatorAnnouncement,
} from '~/server/services/creator-announcement.service';
import { getAnnouncementAllowance } from '~/server/services/announcement-allowance.service';
import { getByIdSchema } from '~/server/schema/base.schema';
import { z } from 'zod';
import { applyRequestDomainColor } from '~/server/middleware.trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const announcementRouter = router({
  upsertAnnouncement: moderatorProcedure
    .input(upsertAnnouncementSchema)
    .mutation(({ input }) => upsertAnnouncement(input)),
  deleteAnnouncement: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input }) => deleteAnnouncement(input.id)),
  getAnnouncements: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getCurrentAnnouncementsSchema.default({}))
    .use(applyRequestDomainColor)
    .query(({ ctx, input }) => getCurrentAnnouncements({ ...input, userId: ctx.user?.id })),
  getAnnouncementsPaged: moderatorProcedure
    .input(getAnnouncementsPagedSchema)
    .query(({ input }) => getAnnouncementsPaged(input)),
  getAnnouncementTargets: moderatorProcedure
    .input(getByIdSchema)
    .query(({ input }) => getAnnouncementTargetUserIds(input.id)),

  // Creator-authored announcements. Separate procedures on purpose: the moderator
  // mutations above can set `domain` and `metadata.type`, and nothing on this path can
  // reach either the sitewide banner or another author's rows.
  getMyAllowance: protectedProcedure.query(({ ctx }) => getAnnouncementAllowance(ctx.user.id)),
  getCreatorAnnouncements: publicProcedure
    .input(getCreatorAnnouncementsSchema)
    .use(applyRequestDomainColor)
    .query(({ input }) => getCreatorAnnouncements(input)),
  getFollowedAnnouncements: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(50).default(20),
          cursor: z.number().optional(),
          // Stamped by applyRequestDomainColor from the request host, never by the client.
          domain: domainColorEnum.optional(),
        })
        .default({ limit: 20 })
    )
    .use(applyRequestDomainColor)
    .query(({ ctx, input }) => getFollowedAnnouncements({ ...input, userId: ctx.user.id })),
  getMutedCreators: protectedProcedure.query(({ ctx }) =>
    getMutedAnnouncementCreators(ctx.user.id)
  ),
  isCreatorMuted: protectedProcedure
    .input(z.object({ creatorId: z.number() }))
    .query(({ ctx, input }) =>
      isAnnouncementCreatorMuted({ userId: ctx.user.id, creatorId: input.creatorId })
    ),
  upsertCreatorAnnouncement: guardedProcedure
    .input(upsertCreatorAnnouncementSchema)
    .mutation(({ ctx, input }) =>
      upsertCreatorAnnouncement({
        ...input,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      })
    ),
  deleteCreatorAnnouncement: guardedProcedure.input(getByIdSchema).mutation(({ ctx, input }) =>
    deleteCreatorAnnouncement({
      id: input.id,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    })
  ),
  toggleAnnouncementMute: protectedProcedure
    .input(z.object({ creatorId: z.number(), muted: z.boolean() }))
    .mutation(({ ctx, input }) => toggleAnnouncementMute({ ...input, userId: ctx.user.id })),
});

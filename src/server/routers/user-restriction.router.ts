import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  addToAllowlistSchema,
  getGenerationRestrictionsSchema,
  resolveRestrictionSchema,
  submitRestrictionContextSchema,
} from '~/server/schema/user-restriction.schema';
import { createNotification } from '~/server/services/notification.service';
import {
  bustPromptAllowlistCache,
  resetProhibitedRequestCount,
} from '~/server/services/orchestrator/promptAuditing';
import { updateUserById } from '~/server/services/user.service';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
import { UserRestrictionStatus } from '~/shared/utils/prisma/enums';
import { refreshSession } from '~/server/auth/session-invalidation';

export const userRestrictionRouter = router({
  /**
   * Get the current user's most recent generation restriction.
   * Uses protectedProcedure (not guardedProcedure) so muted users can access it.
   */
  // getMyRestrictionStatus: protectedProcedure.query(async ({ ctx }) => {
  //   const userId = ctx.user.id;

  //   const restriction = await dbRead.userRestriction.findFirst({
  //     where: { userId, type: 'generation' },
  //     orderBy: { createdAt: 'desc' },
  //     select: {
  //       id: true,
  //       status: true,
  //       createdAt: true,
  //       resolvedAt: true,
  //       resolvedMessage: true,
  //       userMessage: true,
  //       userMessageAt: true,
  //     },
  //   });

  //   return restriction;
  // }),
  // --- Moderator endpoints ---

  /** Paginated list of generation restrictions for moderator review. */
  getAll: moderatorProcedure.input(getGenerationRestrictionsSchema).query(async ({ input }) => {
    const { limit, page, status, username, userId } = input;
    const offset = (page - 1) * limit;

    const where: NonNullable<Parameters<typeof dbRead.userRestriction.findMany>[0]>['where'] = {
      type: 'generation',
      ...(status && { status }),
      ...(userId && { userId }),
      user: {
        deletedAt: null,
        ...(username && { username: { contains: username, mode: 'insensitive' as const } }),
      },
    };

    const [items, totalCount] = await Promise.all([
      dbRead.userRestriction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          userId: true,
          status: true,
          triggers: true,
          createdAt: true,
          resolvedAt: true,
          resolvedBy: true,
          resolvedMessage: true,
          userMessage: true,
          userMessageAt: true,
          user: { select: { id: true, username: true, image: true } },
        },
      }),
      dbRead.userRestriction.count({ where }),
    ]);

    return { items, totalCount };
  }),

  /** Moderator resolves a restriction — uphold or overturn. */
  resolve: moderatorProcedure.input(resolveRestrictionSchema).mutation(async ({ ctx, input }) => {
    const { userRestrictionId, status, resolvedMessage } = input;
    const moderatorId = ctx.user.id;

    const restriction = await dbRead.userRestriction.findUnique({
      where: { id: userRestrictionId },
      select: { id: true, userId: true, status: true },
    });

    if (!restriction) throw new Error('Restriction record not found');
    if (restriction.status !== UserRestrictionStatus.Pending)
      throw new Error('Restriction has already been resolved');

    await dbWrite.userRestriction.update({
      where: { id: userRestrictionId },
      data: {
        status,
        resolvedAt: new Date(),
        resolvedBy: moderatorId,
        resolvedMessage,
      },
    });

    if (status === UserRestrictionStatus.Upheld) {
      // Set mutedAt and muteConfirmedAt to confirm the restriction
      await updateUserById({
        id: restriction.userId,
        data: { mutedAt: new Date(), muteConfirmedAt: new Date() },
        updateSource: 'moderator:generationRestrictionUpheld',
      });
      await refreshSession(restriction.userId);
    } else if (status === UserRestrictionStatus.Overturned) {
      // Unmute the user and reset their violation count
      await updateUserById({
        id: restriction.userId,
        data: { muted: false },
        updateSource: 'moderator:generationRestrictionOverturned',
      });
      await resetProhibitedRequestCount(restriction.userId);
      await refreshSession(restriction.userId);
    }

    // Send notification to the user
    const notifType =
      status === UserRestrictionStatus.Upheld
        ? 'generation-restriction-upheld'
        : 'generation-restriction-overturned';

    await createNotification({
      type: notifType,
      key: `${notifType}:${restriction.userId}:${userRestrictionId}`,
      category: NotificationCategory.System,
      userId: restriction.userId,
      details: { resolvedMessage: resolvedMessage ?? '' },
    }).catch();

    logToAxiom({
      name: 'user-restriction-resolved',
      type: 'info',
      details: { userRestrictionId, status, moderatorId, userId: restriction.userId },
    });

    return { success: true };
  }),

  /** Moderator adds a trigger to the prompt allowlist (marks as benign). */
  addToAllowlist: moderatorProcedure
    .input(addToAllowlistSchema)
    .mutation(async ({ ctx, input }) => {
      const { trigger, category, reason, userRestrictionId } = input;
      const moderatorId = ctx.user.id;

      await dbWrite.promptAllowlist.upsert({
        where: { trigger_category: { trigger, category } },
        create: {
          trigger,
          category,
          addedBy: moderatorId,
          reason,
          userRestrictionId,
        },
        update: {
          addedBy: moderatorId,
          reason,
        },
      });

      // Bust the cached allowlist so the change takes effect immediately
      await bustPromptAllowlistCache();

      logToAxiom({
        name: 'prompt-allowlist-entry-added',
        type: 'info',
        details: { trigger, category, moderatorId, userRestrictionId },
      });

      return { success: true };
    }),
});

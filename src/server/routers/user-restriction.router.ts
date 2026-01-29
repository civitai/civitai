import { NotificationCategory } from '~/server/common/enums';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import {
  addToAllowlistSchema,
  backfillRestrictionTriggersSchema,
  debugAuditPromptSchema,
  getGenerationRestrictionsSchema,
  resolveRestrictionSchema,
  saveSuspiciousMatchSchema,
  submitRestrictionContextSchema,
} from '~/server/schema/user-restriction.schema';
import type { BlockedPromptEntry } from '~/server/services/orchestrator/promptAuditing';
import { debugAuditPrompt, type DebugAuditMatch } from '~/utils/metadata/audit';
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

  /** Debug endpoint to test prompt auditing without triggering any actions. */
  debugAudit: moderatorProcedure.input(debugAuditPromptSchema).mutation(async ({ input }) => {
    const { prompt, negativePrompt } = input;
    return debugAuditPrompt(prompt, negativePrompt);
  }),

  /** Get today's prohibited prompts from ClickHouse and run them through audit. */
  getTodaysAuditResults: moderatorProcedure.query(async () => {
    if (!clickhouse) return { results: [] };

    // Fetch today's prohibited requests from ClickHouse
    const queryResult = await clickhouse.query({
      query: `
        SELECT userId, prompt, negativePrompt, source, createdDate
        FROM prohibitedRequests
        WHERE toDate(createdDate) = today()
        ORDER BY createdDate DESC
        LIMIT 500
      `,
      format: 'JSONEachRow',
    });

    const rows = (await queryResult.json()) as Array<{
      odometer: number;
      userId: number;
      prompt: string;
      negativePrompt: string;
      source: string;
      createdDate: string;
    }>;

    // Run each prompt through the audit system
    const results = rows.map((row) => {
      const auditResult = debugAuditPrompt(row.prompt, row.negativePrompt || undefined);
      return {
        userId: row.userId,
        prompt: row.prompt,
        negativePrompt: row.negativePrompt,
        source: row.source,
        createdDate: row.createdDate,
        matches: auditResult.matches,
        wouldBlock: auditResult.wouldBlock,
        blockReason: auditResult.blockReason,
      };
    });

    return { results };
  }),

  /** Save suspicious audit matches to Redis for later review. */
  saveSuspiciousMatches: moderatorProcedure
    .input(saveSuspiciousMatchSchema)
    .mutation(async ({ ctx, input }) => {
      const { matches } = input;
      const moderatorId = ctx.user.id;

      // Add each match to a Redis list with timestamp and moderator info
      const entries = matches.map((match) => ({
        ...match,
        flaggedBy: moderatorId,
        flaggedAt: new Date().toISOString(),
      }));

      for (const entry of entries) {
        await redis.lPush(REDIS_KEYS.SYSTEM.SUSPICIOUS_AUDIT_MATCHES, JSON.stringify(entry));
      }

      // Keep only the last 1000 entries
      await redis.lTrim(REDIS_KEYS.SYSTEM.SUSPICIOUS_AUDIT_MATCHES, 0, 999);

      return { success: true, savedCount: entries.length };
    }),

  /** Get suspicious audit matches from Redis. */
  getSuspiciousMatches: moderatorProcedure.query(async () => {
    const entries = await redis.lRange(REDIS_KEYS.SYSTEM.SUSPICIOUS_AUDIT_MATCHES, 0, -1);
    const matches = entries.map((entry) => JSON.parse(entry));
    return { matches };
  }),

  /** Clear all suspicious matches from Redis. */
  clearSuspiciousMatches: moderatorProcedure.mutation(async () => {
    await redis.del(REDIS_KEYS.SYSTEM.SUSPICIOUS_AUDIT_MATCHES);
    return { success: true };
  }),

  /** Backfill UserRestriction records with historical prohibited prompts from ClickHouse. */
  backfillTriggers: moderatorProcedure
    .input(backfillRestrictionTriggersSchema)
    .mutation(async ({ input }) => {
      if (!clickhouse) throw new Error('ClickHouse is not available');

      const { userRestrictionId, limit, force } = input;

      // Find restrictions that need backfilling (have 1 or fewer triggers)
      const restrictions = await dbRead.userRestriction.findMany({
        where: {
          type: 'generation',
          ...(userRestrictionId && { id: userRestrictionId }),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          userId: true,
          triggers: true,
          createdAt: true,
        },
      });

      const results: { id: number; userId: number; beforeCount: number; afterCount: number }[] = [];

      for (const restriction of restrictions) {
        // Skip if triggers is already an array (already backfilled) unless force is true
        if (!force && Array.isArray(restriction.triggers) && restriction.triggers.length > 1) {
          results.push({
            id: restriction.id,
            userId: restriction.userId,
            beforeCount: restriction.triggers.length,
            afterCount: restriction.triggers.length,
          });
          continue;
        }

        // When forcing, start fresh; otherwise preserve existing triggers
        const existingTriggers = force
          ? []
          : Array.isArray(restriction.triggers)
          ? (restriction.triggers as unknown as BlockedPromptEntry[])
          : restriction.triggers
          ? [restriction.triggers as unknown as BlockedPromptEntry]
          : [];

        // Query ClickHouse for prohibited prompts in the 24h before the restriction was created
        const restrictionDate = new Date(restriction.createdAt);
        const startDate = new Date(restrictionDate.getTime() - 24 * 60 * 60 * 1000);

        // Format dates for ClickHouse (YYYY-MM-DD HH:MM:SS)
        const formatForClickHouse = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

        const queryResult = await clickhouse.query({
          query: `
            SELECT prompt, negativePrompt, source, createdDate
            FROM prohibitedRequests
            WHERE userId = {userId:Int32}
              AND createdDate >= {startDate:DateTime}
              AND createdDate <= {endDate:DateTime}
            ORDER BY createdDate DESC
            LIMIT 8
          `,
          query_params: {
            userId: restriction.userId,
            startDate: formatForClickHouse(startDate),
            endDate: formatForClickHouse(restrictionDate),
          },
          format: 'JSONEachRow',
        });

        const rows = (await queryResult.json()) as Array<{
          prompt: string;
          negativePrompt: string;
          source: string;
          createdDate: string;
        }>;

        // Convert ClickHouse rows to BlockedPromptEntry format, running audit to get match details
        const historicalTriggers: BlockedPromptEntry[] = rows.map((row) => {
          // Run the audit to get the matched regex and word
          const auditResult = debugAuditPrompt(row.prompt, row.negativePrompt || undefined);
          const firstMatch = auditResult.matches.find((m) => m.matched);

          return {
            prompt: row.prompt,
            negativePrompt: row.negativePrompt ?? '',
            source: row.source,
            category: firstMatch?.check as BlockedPromptEntry['category'],
            matchedWord: firstMatch?.matchedText,
            matchedRegex: firstMatch?.regex,
            imageId: null,
            time: row.createdDate,
          };
        });

        // Merge with existing triggers (avoid duplicates by checking prompt + time)
        const existingKeys = new Set(existingTriggers.map((t) => `${t.prompt}:${t.time}`));
        const newTriggers = historicalTriggers.filter(
          (t) => !existingKeys.has(`${t.prompt}:${t.time}`)
        );
        const mergedTriggers = [...existingTriggers, ...newTriggers];

        // Update the restriction if we found new triggers
        if (newTriggers.length > 0) {
          await dbWrite.userRestriction.update({
            where: { id: restriction.id },
            data: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              triggers: mergedTriggers as any,
            },
          });
        }

        results.push({
          id: restriction.id,
          userId: restriction.userId,
          beforeCount: existingTriggers.length,
          afterCount: mergedTriggers.length,
        });
      }

      logToAxiom({
        name: 'user-restriction-backfill',
        type: 'info',
        details: { results },
      });

      return { success: true, results };
    }),
});

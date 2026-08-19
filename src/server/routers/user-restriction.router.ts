import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  addToAllowlistSchema,
  backfillRestrictionTriggersSchema,
  debugAuditPromptSchema,
  submitRestrictionContextSchema,
} from '~/server/schema/user-restriction.schema';
import type { BlockedPromptEntry } from '~/server/services/orchestrator/promptAuditing';
import { debugAuditPrompt, type DebugAuditMatch } from '~/utils/metadata/audit';
import { bustPromptAllowlistCache } from '~/server/services/orchestrator/promptAuditing';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

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

  /** Get suspicious audit matches from Redis. */
  getSuspiciousMatches: moderatorProcedure.query(async () => {
    const entries = await sysRedis.lRange(REDIS_SYS_KEYS.SYSTEM.SUSPICIOUS_AUDIT_MATCHES, 0, -1);
    const matches = entries.map((entry) => JSON.parse(entry));
    return { matches };
  }),

  /** Clear all suspicious matches from Redis. */
  clearSuspiciousMatches: moderatorProcedure.mutation(async () => {
    await sysRedis.del(REDIS_SYS_KEYS.SYSTEM.SUSPICIOUS_AUDIT_MATCHES);
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
            SELECT prompt, negativePrompt, source, inputImages, inputVideo, createdDate
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
          inputImages: string[];
          inputVideo: string | null;
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
            remixOfId: null,
            inputImages: row.inputImages?.length ? row.inputImages : undefined,
            inputVideo: row.inputVideo || undefined,
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

import type { NextApiRequest, NextApiResponse } from 'next';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { BlockedPromptEntry } from '~/server/services/orchestrator/promptAuditing';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { debugAuditPrompt } from '~/utils/metadata/audit';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    if (!clickhouse) throw new Error('ClickHouse is not available');

    const userRestrictionId = req.query.id ? Number(req.query.id) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 10;
    const force = req.query.force === 'true';

    // Find restrictions that need backfilling
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

    res.status(200).json({ success: true, results });
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: (e as Error).message });
  }
});

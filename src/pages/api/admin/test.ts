import type { NextApiRequest, NextApiResponse } from 'next';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { BlockedPromptEntry } from '~/server/services/orchestrator/promptAuditing';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { debugAuditPrompt } from '~/utils/metadata/audit';

const userIds = [
  11231576, 1641822, 10119527, 4406586, 7640794, 7467302, 9261165, 11160036, 11147401, 1110633,
  11171413, 11170682, 10296176, 10021203, 480152,
];

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    if (!clickhouse) throw new Error('ClickHouse is not available');

    const results: {
      userId: number;
      restrictionId?: number;
      triggerCount: number;
      error?: string;
    }[] = [];

    for (const userId of userIds) {
      try {
        // Skip if user already has a pending UserRestriction
        const existingRestriction = await dbRead.userRestriction.findFirst({
          where: { userId, type: 'generation', status: 'Pending' },
          select: { id: true },
        });

        if (existingRestriction) {
          results.push({
            userId,
            restrictionId: existingRestriction.id,
            triggerCount: 0,
            error: 'Skipped: existing Pending restriction',
          });
          continue;
        }

        // Query ClickHouse for the last 8 prohibited requests for this user
        const queryResult = await clickhouse.query({
          query: `
            SELECT prompt, negativePrompt, source, createdDate
            FROM prohibitedRequests
            WHERE userId = {userId:Int32}
            ORDER BY createdDate DESC
            LIMIT 8
          `,
          query_params: { userId },
          format: 'JSONEachRow',
        });

        const rows = (await queryResult.json()) as Array<{
          prompt: string;
          negativePrompt: string;
          source: string;
          createdDate: string;
        }>;

        // Convert rows to BlockedPromptEntry format
        const triggers: BlockedPromptEntry[] = rows.map((row) => {
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

        // Create the UserRestriction record
        const restriction = await dbWrite.userRestriction.create({
          data: {
            userId,
            type: 'generation',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            triggers: triggers as any,
          },
        });

        results.push({
          userId,
          restrictionId: restriction.id,
          triggerCount: triggers.length,
        });
      } catch (userError) {
        results.push({
          userId,
          triggerCount: 0,
          error: (userError as Error).message,
        });
      }
    }

    logToAxiom({
      name: 'backfill-user-restrictions',
      type: 'info',
      details: { results },
    });

    res.status(200).json({ success: true, results });
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: (e as Error).message });
  }
});

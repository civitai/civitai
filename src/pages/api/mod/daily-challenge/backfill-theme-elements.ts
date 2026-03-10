import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  getChallengeConfig,
  getJudgingConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { generateThemeElements } from '~/server/games/daily-challenge/generative-content';
import { logToAxiom } from '~/server/logging/client';
import { parseChallengeMetadata } from '~/server/schema/challenge.schema';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('api:backfill-theme-elements', 'cyan');

const schema = z.object({
  force: z.coerce.boolean().optional().default(false),
});

type ChallengeRow = {
  id: number;
  theme: string;
  judgeId: number | null;
  metadata: unknown;
};

export default WebhookEndpoint(async function (_req: NextApiRequest, res: NextApiResponse) {
  const parsed = schema.safeParse(_req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query params', details: parsed.error.flatten() });
  }
  const { force } = parsed.data;

  const config = await getChallengeConfig();
  const defaultJudgeId = config.defaultJudgeId;

  // Fetch active + scheduled challenges that have a theme
  const challenges = await dbRead.$queryRaw<ChallengeRow[]>`
    SELECT id, theme, "judgeId", metadata
    FROM "Challenge"
    WHERE status IN ('Active', 'Scheduled')
      AND theme IS NOT NULL
      AND theme != ''
  `;

  // Filter to those needing backfill (unless force=true, which overwrites all)
  const toBackfill = force
    ? challenges
    : challenges.filter((c) => {
        const meta = parseChallengeMetadata(c.metadata);
        return !meta.themeElements?.length;
      });

  if (toBackfill.length === 0) {
    return res.status(200).json({
      message: 'No challenges need backfilling',
      total: challenges.length,
      backfilled: 0,
    });
  }

  log(
    `Backfilling theme elements for ${toBackfill.length} challenges${
      force ? ' (force overwrite)' : ''
    }`
  );

  let successes = 0;
  let failures = 0;
  const results: Array<{ id: number; theme: string; status: string; elements?: string[] }> = [];

  const tasks = toBackfill.map((challenge) => async () => {
    try {
      const resolvedJudgeId = challenge.judgeId ?? defaultJudgeId;
      if (!resolvedJudgeId) {
        results.push({ id: challenge.id, theme: challenge.theme, status: 'skipped: no judge' });
        return;
      }

      const judgingConfig = await getJudgingConfig(resolvedJudgeId);
      const elements = await generateThemeElements({
        theme: challenge.theme,
        config: judgingConfig,
      });

      if (!elements.length) {
        results.push({
          id: challenge.id,
          theme: challenge.theme,
          status: 'skipped: generation returned empty',
        });
        return;
      }

      // Merge into existing metadata
      const existingMetadata = parseChallengeMetadata(challenge.metadata);
      const newMetadata = { ...existingMetadata, themeElements: elements };

      await dbWrite.$executeRaw`
        UPDATE "Challenge"
        SET metadata = ${JSON.stringify(newMetadata)}::jsonb
        WHERE id = ${challenge.id}
      `;

      successes++;
      results.push({
        id: challenge.id,
        theme: challenge.theme,
        status: 'ok',
        elements,
      });
      log(`Backfilled challenge ${challenge.id} (${challenge.theme}): ${elements.length} elements`);
    } catch (error) {
      failures++;
      const err = error as Error;
      results.push({ id: challenge.id, theme: challenge.theme, status: `error: ${err.message}` });
      logToAxiom({
        type: 'error',
        name: 'backfill-theme-elements',
        challengeId: challenge.id,
        message: `Failed to backfill theme elements for challenge ${challenge.id}`,
        error: err.message,
      });
      log(`Failed to backfill challenge ${challenge.id}:`, err.message);
    }
  });

  await limitConcurrency(tasks, 3);

  log(`Backfill complete: ${successes} successes, ${failures} failures`);
  return res.status(200).json({
    total: challenges.length,
    backfilled: successes,
    failures,
    force,
    results,
  });
});

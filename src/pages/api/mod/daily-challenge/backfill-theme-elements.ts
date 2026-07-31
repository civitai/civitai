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

      // Merge server-side rather than writing back the snapshot read before the (multi-second)
      // generation call above. Two separate reasons, both load-bearing:
      //
      // 1. STATUS PREDICATE. The SELECT ran on the read replica and only filtered
      //    Active/Scheduled. `claimChallengeForCompletion` can flip this challenge to Completing
      //    while `generateThemeElements` is in flight, stamping metadata.completingClaimedAt as it
      //    goes. An unpredicated write would then restore the PRE-CLAIM snapshot on top of the
      //    fresh stamp, leaving status=Completing with no completingClaimedAt — a state the
      //    NULL-propagating stuck-challenge reset never selects, so the challenge wedges
      //    permanently. `?force=true` widens the exposure to every themed Active/Scheduled
      //    challenge at once. Same guard shape (and same reasoning) as the conditional updateMany
      //    in upsertChallenge.
      // 2. JSONB MERGE. Even inside Active/Scheduled, writing the whole column clobbers any other
      //    metadata field written during the generation window. Concatenating onto the CURRENT
      //    stored value touches only themeElements. The CASE normalises a NULL/non-object metadata
      //    to {} so the result stays an object (`||` would otherwise concatenate arrays).
      const themeElementsPatch = JSON.stringify({ themeElements: elements });
      const updatedRows = await dbWrite.$executeRaw`
        UPDATE "Challenge"
        SET metadata =
          CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END
          || ${themeElementsPatch}::jsonb
        WHERE id = ${challenge.id}
          AND status IN ('Active', 'Scheduled')
      `;

      if (updatedRows === 0) {
        results.push({
          id: challenge.id,
          theme: challenge.theme,
          status: 'skipped: no longer Active/Scheduled',
        });
        return;
      }

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

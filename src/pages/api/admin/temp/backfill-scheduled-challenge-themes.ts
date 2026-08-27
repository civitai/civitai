import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  generateArticle,
  generateResourceConcept,
} from '~/server/games/daily-challenge/generative-content';
import {
  getChallengeConfig,
  getJudgingConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { getShowcaseImagesOfModel } from '~/server/jobs/daily-challenge-processing';
import { parseChallengeMetadata } from '~/server/schema/challenge.schema';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString, numericString } from '~/utils/zod-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

/**
 * Re-theme the already-queued daily challenges against their featured resource.
 *
 * Challenges are generated up to ~30 days ahead, so the theme-drift fix (#4427) would otherwise
 * not be visible until the queue drains: 27 of the 29 challenges queued at cutover carried the
 * drifted, mood-word themes the fix exists to prevent — including a repeat of the challenge in the
 * original report. This regenerates them through the fixed pipeline.
 *
 * WHY visibleAt AND NOT startsAt: a challenge publishes three days before it starts. Once it is
 * visible its theme is the contract entrants are generating against, and themeElements are what
 * they are scored on — moving that anchor underneath them is worse than leaving the drift. So
 * anything already visible is skipped, unconditionally, and that is not overridable by query param.
 *
 * WHY the whole article and not just the theme: the article body names and elaborates on the
 * theme, so writing a new theme beside the old prose leaves the page contradicting its own
 * scoring anchor. For a challenge nobody has seen, regenerating both is the coherent move.
 *
 * The challenge's Collection (name, description, cover image) is deliberately untouched: it is not
 * part of the scoring anchor and its name is referenced elsewhere.
 *
 * Dry run by default. GET with ?apply=true to write.
 *
 *   ?apply=true          actually write (default false — report only)
 *   ?limit=5             how many to process this call (default 5; each takes ~20-40s)
 *   ?ids=503,509         restrict to these challenge ids (still subject to the guards above)
 *   ?includeConcepted    also reprocess challenges that already have a resourceConcept
 */
const schema = z.object({
  // booleanString, never z.coerce.boolean: coerce runs JS Boolean() so ?apply=false would be true
  // and a dry run would silently write. Enforced by no-coerce-boolean-in-api.
  apply: booleanString().optional().default(false),
  includeConcepted: booleanString().optional().default(false),
  limit: numericString().optional().default(5),
  ids: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(',')
            .map((x) => Number(x.trim()))
            .filter((x) => Number.isInteger(x) && x > 0)
        : undefined
    ),
});

type Result = {
  challengeId: number;
  startsAt: Date;
  status: 'dry-run' | 'updated' | 'failed';
  resource?: string;
  resourceConcept?: string;
  error?: string;
  before: { theme: string | null; themeElements: string[] };
  after?: { theme: string; themeElements: string[]; title: string };
};

type Row = {
  id: number;
  title: string | null;
  theme: string | null;
  visibleAt: Date;
  startsAt: Date;
  judgeId: number | null;
  judgingPrompt: string | null;
  metadata: unknown;
};

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success)
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
  const { apply, includeConcepted, limit, ids } = parsed.data;

  const config = await getChallengeConfig();

  // The guards live in the query, not in a filter applied afterwards, so a future edit cannot
  // widen the blast radius by dropping a condition further down.
  const candidates = await dbRead.$queryRaw<Row[]>`
    SELECT id, title, theme, "visibleAt", "startsAt", "judgeId", "judgingPrompt", metadata
    FROM "Challenge"
    WHERE source = 'System'
      AND status = 'Scheduled'
      AND "visibleAt" > now()
      AND metadata ? 'resourceModelId'
    ORDER BY "startsAt"
  `;

  const eligible = candidates
    .filter((c) => (ids ? ids.includes(c.id) : true))
    .filter((c) => (includeConcepted ? true : !parseChallengeMetadata(c.metadata).resourceConcept))
    .slice(0, limit);

  // limitConcurrency resolves void, so each task records its own outcome.
  const results: Result[] = [];
  const tasks = eligible.map((challenge) => async () => {
    const meta = parseChallengeMetadata(challenge.metadata);
    const before = { theme: challenge.theme, themeElements: meta.themeElements ?? [] };
    try {
      const judgeId = challenge.judgeId ?? config.defaultJudgeId;
      if (!judgeId) throw new Error('no judge assigned and no defaultJudgeId configured');
      const judgingConfig = await getJudgingConfig(judgeId, challenge.judgingPrompt);

      const [resource] = await dbRead.$queryRaw<
        { modelId: number; title: string; creator: string; description: string | null }[]
      >`
        SELECT m.id as "modelId", m.name as title, u.username as creator, m.description
        FROM "Model" m JOIN "User" u ON u.id = m."userId"
        WHERE m.id = ${meta.resourceModelId}
        LIMIT 1
      `;
      if (!resource) throw new Error(`resource model ${meta.resourceModelId} not found`);

      const trainedWords = await dbRead.$queryRaw<{ trainedWords: string[] }[]>`
        SELECT mv."trainedWords" FROM "ModelVersion" mv
        WHERE mv."modelId" = ${meta.resourceModelId} AND mv.status = 'Published'
        ORDER BY mv.index ASC
      `;
      const fullResource = {
        ...resource,
        trainedWords: [...new Set(trainedWords.flatMap((v) => v.trainedWords ?? []))],
      };

      const images = await getShowcaseImagesOfModel(resource.modelId, 4);
      const resourceConcept = await generateResourceConcept({
        resource: fullResource,
        images,
        config: judgingConfig,
      });
      const article = await generateArticle({
        resource: fullResource,
        resourceConcept,
        image: images[0],
        challengeDate: challenge.startsAt,
        prizes: config.prizes,
        entryPrizeRequirement: config.entryPrizeRequirement,
        entryPrize: config.entryPrize,
        allowedNsfwLevel: 1,
        config: judgingConfig,
      });

      if (apply) {
        // Merge server-side rather than writing back the metadata read above: this call spends
        // tens of seconds in two LLM requests, and a concurrent writer (reviewedAt stamps, a
        // completion claim) must not lose its key to a stale snapshot.
        await dbWrite.$executeRaw`
          UPDATE "Challenge"
          SET title = ${article.title},
              description = ${article.content},
              theme = ${article.theme},
              invitation = ${article.invitation},
              metadata = (CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END)
                         || ${JSON.stringify({
                           themeElements: article.themeElements,
                           resourceConcept: resourceConcept ?? null,
                         })}::jsonb
          WHERE id = ${challenge.id}
            AND source = 'System'
            AND status = 'Scheduled'
            AND "visibleAt" > now()
        `;
      }

      results.push({
        challengeId: challenge.id,
        startsAt: challenge.startsAt,
        resource: resource.title,
        status: apply ? 'updated' : 'dry-run',
        resourceConcept,
        before,
        after: { theme: article.theme, themeElements: article.themeElements, title: article.title },
      });
    } catch (e) {
      results.push({
        challengeId: challenge.id,
        startsAt: challenge.startsAt,
        status: 'failed',
        error: (e as Error).message,
        before,
      });
    }
  });

  await limitConcurrency(tasks, 4);
  results.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return res.status(200).json({
    applied: apply,
    eligibleTotal: candidates.length,
    processed: results.length,
    remaining: Math.max(0, candidates.length - results.length),
    counts,
    results,
  });
});

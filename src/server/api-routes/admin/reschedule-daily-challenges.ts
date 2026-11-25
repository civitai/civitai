import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  eligibleRows,
  guardSql,
  hashOf,
  planIsCurrent,
  preImage,
  type RescheduleRow as Row,
} from '~/server/games/daily-challenge/daily-reschedule';
import {
  getDailyPlanFlags,
  resolveDailyPlan,
  type ResolvedDailyPlan,
} from '~/server/games/daily-challenge/daily-plan';
import { getChallengeConfig } from '~/server/games/daily-challenge/daily-challenge.utils';
import { generateArticle } from '~/server/games/daily-challenge/generative-content';
import { getShowcaseImagesOfModel } from '~/server/jobs/daily-challenge-processing';
import { parseChallengeMetadata } from '~/server/schema/challenge.schema';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { DEFAULT_CATEGORY_ROWS } from '~/shared/constants/challenge.constants';
import dayjs from '~/shared/utils/dayjs';
import { booleanString, numericString } from '~/utils/zod-helpers';

/**
 * Re-plan already-queued System dailies onto daily-schedule.ts (docs/features/challenge-platform.md §9).
 *
 * GET is the dry run: it generates each row's proposal and returns it with the row's current values
 * and a hash of them. Keep that response; it is the only copy of the old rows. POST applies exactly
 * the proposals sent back, so what was reviewed is what lands, and refuses a row whose current values
 * no longer match the hash it was proposed against.
 *
 * Only a Scheduled System daily that has not started, has no entries, and (unless rubricOnly) is not
 * yet visible is touched, checked in the SELECT and again in the UPDATE. Article text is replaced
 * only before the daily is public; after that, rubricOnly changes the rubric and judge and keeps the
 * published theme.
 *
 *   mode=schedule  (default) the date's plan: occasion-aware article, rubric set, judge
 *   mode=defaults  back to the fixed rubric and default judge; article untouched
 */

const MAX_RANGE_DAYS = 31;

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const querySchema = z
  .object({
    from: dayString,
    to: dayString,
    mode: z.enum(['schedule', 'defaults']).default('schedule'),
    // booleanString, never z.coerce.boolean: ?rubricOnly=false would be truthy.
    rubricOnly: booleanString().optional().default(false),
    limit: numericString(z.number().int().min(1).max(10)).optional().default(5),
  })
  .refine((q) => dayjs.utc(q.to).diff(dayjs.utc(q.from), 'day') <= MAX_RANGE_DAYS, {
    message: `range is at most ${MAX_RANGE_DAYS} days`,
  })
  .refine((q) => q.mode === 'schedule' || q.rubricOnly, {
    message: 'mode=defaults only changes the rubric and judge; pass rubricOnly=true',
  });

const proposalSchema = z.object({
  challengeId: z.number().int().positive(),
  preImageHash: z.string().length(64),
  mode: z.enum(['schedule', 'defaults']),
  rubricOnly: z.boolean(),
  setKey: z.string().nullable(),
  article: z
    .object({
      title: z.string().min(1).max(500),
      description: z.string().min(1).max(50_000),
      theme: z.string().min(1).max(100),
      invitation: z.string().max(1000),
      themeElements: z.array(z.string().max(100)).max(12),
    })
    .optional(),
});
const applySchema = z.object({ proposals: z.array(proposalSchema).min(1).max(10) });
type Proposal = z.infer<typeof proposalSchema>;

async function planForRow(row: Row) {
  const config = await getChallengeConfig();
  if (!config.defaultJudge) throw new Error('defaultJudge not configured');
  const plan = await resolveDailyPlan(row.startsAt, {
    defaultJudge: config.defaultJudge,
    flags: await getDailyPlanFlags(),
  });
  return { config, plan };
}

async function propose(
  row: Row,
  mode: Proposal['mode'],
  rubricOnly: boolean,
  planned?: { config: Awaited<ReturnType<typeof getChallengeConfig>>; plan: ResolvedDailyPlan }
): Promise<Proposal> {
  const base = { challengeId: row.id, preImageHash: hashOf(preImage(row)), mode, rubricOnly };
  if (mode === 'defaults') return { ...base, setKey: null };

  const { config, plan } = planned ?? (await planForRow(row));
  const setKey = plan.record?.setKey ?? null;
  if (rubricOnly) return { ...base, setKey };

  const meta = parseChallengeMetadata(row.metadata);
  if (!meta.resourceModelId) throw new Error('no resourceModelId in metadata');
  const [resource] = await dbRead.$queryRaw<{ modelId: number; title: string; creator: string }[]>`
    SELECT m.id as "modelId", m.name as title, u.username as creator
    FROM "Model" m JOIN "User" u ON u.id = m."userId"
    WHERE m.id = ${meta.resourceModelId}
  `;
  if (!resource) throw new Error(`resource model ${meta.resourceModelId} not found`);
  const [image] = await getShowcaseImagesOfModel(resource.modelId, 1);
  const article = await generateArticle({
    resource,
    resourceConcept: meta.resourceConcept,
    occasion: plan.occasion,
    image,
    challengeDate: dayjs(row.startsAt).add(1, 'day').toDate(),
    prizes: config.prizes,
    entryPrizeRequirement: config.entryPrizeRequirement,
    entryPrize: config.entryPrize,
    allowedNsfwLevel: 1,
    config: plan.judgingConfig,
  });
  return {
    ...base,
    setKey,
    article: {
      title: article.title,
      description: article.content,
      theme: article.theme,
      invitation: article.invitation,
      themeElements: article.themeElements,
    },
  };
}

async function apply(proposal: Proposal) {
  const [row] = await eligibleRows({ ids: [proposal.challengeId] }, proposal.rubricOnly);
  if (!row) return 'not eligible (started, visible, entered or not a Scheduled System daily)';
  if (hashOf(preImage(row)) !== proposal.preImageHash) return 'row changed since the dry run';
  if (!proposal.rubricOnly && !proposal.article) return 'full reschedule needs an article';

  const config = await getChallengeConfig();
  if (!config.defaultJudge) return 'defaultJudge not configured';

  let judgeId = config.defaultJudge.judgeId;
  let judgingCategories: unknown = DEFAULT_CATEGORY_ROWS;
  let dailyPlan: unknown = null;
  if (proposal.mode === 'schedule') {
    // Rubric and judge are re-derived here, never taken from the request body.
    const { plan } = await planForRow(row);
    if ((plan.record?.setKey ?? null) !== proposal.setKey)
      return 'schedule changed since the dry run';
    judgeId = plan.judgeId;
    judgingCategories = plan.judgingCategories ?? DEFAULT_CATEGORY_ROWS;
    dailyPlan = plan.record ?? null;
  }

  const article = proposal.rubricOnly ? undefined : proposal.article;
  const metadataPatch = {
    ...(article ? { themeElements: article.themeElements } : {}),
    ...(dailyPlan ? { dailyPlan } : {}),
  };
  const updated = await dbWrite.$executeRaw`
    UPDATE "Challenge" c
    SET title = COALESCE(${article?.title ?? null}, c.title),
        description = COALESCE(${article?.description ?? null}, c.description),
        theme = COALESCE(${article?.theme ?? null}, c.theme),
        invitation = COALESCE(${article?.invitation ?? null}, c.invitation),
        "judgeId" = ${judgeId},
        "judgingCategories" = ${JSON.stringify(judgingCategories)}::jsonb,
        metadata = ((CASE WHEN jsonb_typeof(c.metadata) = 'object' THEN c.metadata ELSE '{}'::jsonb END)
                    - ${dailyPlan ? '' : 'dailyPlan'}) || ${JSON.stringify(metadataPatch)}::jsonb
    WHERE c.id = ${row.id} AND ${guardSql(proposal.rubricOnly)}
  `;
  return updated === 1 ? 'updated' : 'guard refused the write';
}

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === 'POST') {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: z.treeifyError(parsed.error) });
    const results: { challengeId: number; result: string }[] = [];
    for (const proposal of parsed.data.proposals) {
      try {
        results.push({ challengeId: proposal.challengeId, result: await apply(proposal) });
      } catch (e) {
        results.push({
          challengeId: proposal.challengeId,
          result: `failed: ${(e as Error).message}`,
        });
      }
    }
    return res.status(200).json({ results });
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: z.treeifyError(parsed.error) });
  const { from, to, mode, rubricOnly, limit } = parsed.data;

  if (mode === 'schedule') {
    const flags = await getDailyPlanFlags();
    if (!flags.schedule && !flags.rotation)
      return res.status(409).json({ error: 'both daily-challenge plan flags are off' });
  }

  const eligible = await eligibleRows({ from, to }, rubricOnly);
  // A row whose stored plan already matches what the date resolves to now drops out, so the next
  // dry run is the next page; one planned while its judge was missing does not match, so it stays.
  const candidates: { row: Row; planned?: Awaited<ReturnType<typeof planForRow>> }[] = [];
  for (const row of eligible) {
    if (mode === 'defaults') {
      candidates.push({ row });
      continue;
    }
    const planned = await planForRow(row);
    if (!planIsCurrent(row, planned.plan.record)) candidates.push({ row, planned });
  }
  const page = candidates.slice(0, limit);
  const results: {
    challengeId: number;
    startsAt: Date;
    before: unknown;
    proposal?: Proposal;
    error?: string;
  }[] = [];
  await limitConcurrency(
    page.map(({ row, planned }) => async () => {
      try {
        results.push({
          challengeId: row.id,
          startsAt: row.startsAt,
          before: preImage(row),
          proposal: await propose(row, mode, rubricOnly, planned),
        });
      } catch (e) {
        results.push({
          challengeId: row.id,
          startsAt: row.startsAt,
          before: preImage(row),
          error: (e as Error).message,
        });
      }
    }),
    3
  );
  results.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return res.status(200).json({
    eligibleTotal: candidates.length,
    remaining: candidates.length - page.length,
    results,
  });
});

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import {
  eligibleRows,
  hashOf,
  planIsCurrent,
  preImage,
  writeReschedule,
  type RescheduleRow as Row,
} from '~/server/games/daily-challenge/daily-reschedule';
import {
  getDailyPlanFlags,
  resolveDailyPlan,
  type DailyPlanFlags,
  type ResolvedDailyPlan,
} from '~/server/games/daily-challenge/daily-plan';
import {
  getChallengeConfig,
  type ChallengeConfig,
  type JudgingConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { generateArticle } from '~/server/games/daily-challenge/generative-content';
import {
  getChallengeResource,
  getShowcaseImagesOfModel,
} from '~/server/jobs/daily-challenge-processing';
import { parseChallengeMetadata } from '~/server/schema/challenge.schema';
import { resolveJudgingEngineForJudge } from '~/server/services/challenge-judge.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { DEFAULT_CATEGORY_ROWS } from '~/shared/constants/challenge.constants';
import dayjs from '~/shared/utils/dayjs';
import { booleanString, numericString } from '~/utils/zod-helpers';

/**
 * Re-plan already-queued System dailies onto daily-schedule.ts (docs/features/challenge-platform.md §3, Daily plan).
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

type Ctx = { config: ChallengeConfig; defaultJudge: JudgingConfig; flags: DailyPlanFlags };

async function loadCtx(): Promise<Ctx> {
  const config = await getChallengeConfig();
  if (!config.defaultJudge) throw new Error('defaultJudge not configured');
  return { config, defaultJudge: config.defaultJudge, flags: await getDailyPlanFlags() };
}

const planForRow = (row: Row, ctx: Ctx) =>
  resolveDailyPlan(row.startsAt, { defaultJudge: ctx.defaultJudge, flags: ctx.flags });

async function propose(
  row: Row,
  mode: Proposal['mode'],
  rubricOnly: boolean,
  ctx: Ctx,
  plan?: ResolvedDailyPlan
): Promise<Proposal> {
  const base = { challengeId: row.id, preImageHash: hashOf(preImage(row)), mode, rubricOnly };
  if (mode === 'defaults') return { ...base, setKey: null };

  const resolved = plan ?? (await planForRow(row, ctx));
  const setKey = resolved.record?.setKey ?? null;
  if (rubricOnly) return { ...base, setKey };

  const meta = parseChallengeMetadata(row.metadata);
  if (!meta.resourceModelId) throw new Error('no resourceModelId in metadata');
  const resource = await getChallengeResource(meta.resourceModelId);
  if (!resource) throw new Error(`resource model ${meta.resourceModelId} not found`);
  const [image] = await getShowcaseImagesOfModel(resource.modelId, 1);
  const article = await generateArticle({
    resource,
    resourceConcept: meta.resourceConcept,
    occasion: resolved.occasion,
    image,
    challengeDate: dayjs(row.startsAt).add(1, 'day').toDate(),
    prizes: ctx.config.prizes,
    entryPrizeRequirement: ctx.config.entryPrizeRequirement,
    entryPrize: ctx.config.entryPrize,
    allowedNsfwLevel: 1,
    config: resolved.judgingConfig,
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

async function apply(proposal: Proposal, ctx: Ctx) {
  const [row] = await eligibleRows({ ids: [proposal.challengeId] }, proposal.rubricOnly);
  if (!row) return 'not eligible (started, visible, entered or not a Scheduled System daily)';

  let judgeId = ctx.defaultJudge.judgeId;
  let judgingCategories: unknown = DEFAULT_CATEGORY_ROWS;
  let dailyPlan: Record<string, unknown> | null = null;
  if (proposal.mode === 'schedule') {
    // Rubric and judge are re-derived here, never taken from the request body.
    const plan = await planForRow(row, ctx);
    if ((plan.record?.setKey ?? null) !== proposal.setKey)
      return 'schedule changed since the dry run';
    judgeId = plan.judgeId;
    judgingCategories = plan.judgingCategories ?? DEFAULT_CATEGORY_ROWS;
    dailyPlan = plan.record ?? null;
  }

  return writeReschedule({
    challengeId: row.id,
    preImageHash: proposal.preImageHash,
    rubricOnly: proposal.rubricOnly,
    article: proposal.article,
    judgeId,
    // Same rule as creation: a challenge runs on its judge's engine, copied at write time.
    judgingEngine: await resolveJudgingEngineForJudge(judgeId),
    judgingCategories,
    dailyPlan,
  });
}

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === 'POST') {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: z.treeifyError(parsed.error) });
    const ctx = await loadCtx();
    const results: { challengeId: number; result: string }[] = [];
    for (const proposal of parsed.data.proposals) {
      try {
        results.push({ challengeId: proposal.challengeId, result: await apply(proposal, ctx) });
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

  const ctx = await loadCtx();
  if (mode === 'schedule' && !ctx.flags.schedule && !ctx.flags.rotation)
    return res.status(409).json({ error: 'both daily-challenge plan flags are off' });

  const eligible = await eligibleRows({ from, to }, rubricOnly);
  // A row whose stored plan matches what its date resolves to now drops out, so the next dry run is
  // the next page. A row stored with judgeName 'default' stays once its judge exists.
  const candidates: { row: Row; plan?: ResolvedDailyPlan }[] = [];
  for (const row of eligible) {
    if (mode === 'defaults') {
      candidates.push({ row });
      continue;
    }
    const plan = await planForRow(row, ctx);
    if (!planIsCurrent(row, plan.record)) candidates.push({ row, plan });
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
    page.map(({ row, plan }) => async () => {
      try {
        results.push({
          challengeId: row.id,
          startsAt: row.startsAt,
          before: preImage(row),
          proposal: await propose(row, mode, rubricOnly, ctx, plan),
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

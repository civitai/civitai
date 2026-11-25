import { getDailyPlan, getRotationPlan } from '~/server/games/daily-challenge/daily-schedule';
import type { DailyPlan } from '~/server/games/daily-challenge/daily-schedule';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  getJudgingConfig,
  type JudgingConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import type { DailyOccasion } from '~/server/games/daily-challenge/generative-content';
import type { ChallengeJudgingCategory } from '~/server/schema/challenge.schema';
import { resolveJudgingCategories } from '~/server/services/challenge-category.service';
import { findActiveJudgeIdByName } from '~/server/services/challenge-judge.service';
import { dailyRubricSetRows } from '~/shared/constants/challenge.constants';
import { createLogger } from '~/utils/logging';

const log = createLogger('daily-challenge:plan', 'blue');

/** What one daily is generated and judged with. */
export type ResolvedDailyPlan = {
  judgeId: number;
  judgingConfig: JudgingConfig;
  /** Undefined = the fixed default rubric (createChallengeRecord's fallback). */
  judgingCategories?: ChallengeJudgingCategory[];
  occasion?: DailyOccasion;
  record?: {
    setKey: DailyPlan['setKey'];
    source: DailyPlan['source'];
    judgeName: string;
    occasion?: string;
  };
};

export type DailyPlanFlags = { schedule: boolean; rotation: boolean };

export async function getDailyPlanFlags(): Promise<DailyPlanFlags> {
  const [schedule, rotation] = await Promise.all([
    isFlipt(FLIPT_FEATURE_FLAGS.DAILY_CHALLENGE_SCHEDULE),
    isFlipt(FLIPT_FEATURE_FLAGS.DAILY_CHALLENGE_RUBRIC_ROTATION),
  ]);
  return { schedule, rotation };
}

function planFor(date: Date, flags: DailyPlanFlags): DailyPlan | null {
  const plan = getDailyPlan(date);
  if (plan.source === 'schedule' && flags.schedule) return plan;
  return flags.rotation ? getRotationPlan(date) : null;
}

// A library read failing at cron time must not fail the day: the set's preset rows carry the same
// keys, labels and criteria (challenge-helpers.ts createChallengeRecord makes the same trade).
async function categoriesFor(setKey: DailyPlan['setKey']) {
  const rows = dailyRubricSetRows(setKey);
  try {
    return await resolveJudgingCategories(rows);
  } catch (e) {
    log(`category library read failed for set ${setKey}, using preset rows:`, (e as Error).message);
    return rows;
  }
}

export async function resolveDailyPlan(
  date: Date,
  { defaultJudge, flags }: { defaultJudge: JudgingConfig; flags: DailyPlanFlags }
): Promise<ResolvedDailyPlan> {
  const plan = planFor(date, flags);
  if (!plan) return { judgeId: defaultJudge.judgeId, judgingConfig: defaultJudge };

  let judgeId = defaultJudge.judgeId;
  let judgingConfig = defaultJudge;
  let judgeName = 'default';
  if (plan.judgeName) {
    const scheduledJudgeId = await findActiveJudgeIdByName(plan.judgeName);
    if (scheduledJudgeId) {
      judgeId = scheduledJudgeId;
      judgingConfig = await getJudgingConfig(scheduledJudgeId);
      judgeName = plan.judgeName;
    } else {
      log(`judge "${plan.judgeName}" not found; using the default judge`);
    }
  }

  const judgingCategories = await categoriesFor(plan.setKey);
  return {
    judgeId,
    judgingConfig,
    judgingCategories,
    occasion: plan.occasion && {
      ...plan.occasion,
      judgedOn: judgingCategories.filter((c) => c.key !== 'theme').map((c) => c.label),
    },
    record: {
      setKey: plan.setKey,
      source: plan.source,
      judgeName,
      ...(plan.occasion ? { occasion: plan.occasion.name } : {}),
    },
  };
}

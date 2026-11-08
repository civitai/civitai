import { Prisma } from '@prisma/client';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { constants } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { getJudgingConfig } from '~/server/games/daily-challenge/daily-challenge.utils';
import { THEME_DISQUALIFY_THRESHOLD } from '~/server/games/daily-challenge/daily-challenge-scoring';
import {
  estimateBuzzCost,
  generateReview,
  REVIEW_FALLBACK_MODEL,
} from '~/server/games/daily-challenge/generative-content';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { acceptCrucibleEntry } from '~/server/services/crucible-entry-accepted';
import { visibleEntryImageSql } from '~/server/services/crucible-entry-sql';
import {
  getCrucibleThemeReviews,
  type CrucibleThemeReview,
  type ThemeReviewMode,
} from '~/server/services/crucible-theme-review-config';
import { removeCrucibleEntryForThemeReview } from '~/server/services/crucible.service';
import { createReport } from '~/server/services/report.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { CrucibleStatus, ReportReason } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { crucibleOwnerRemovalReasons } from '~/utils/crucible-helpers';

// A review takes up to ~30s, so this keeps a run inside the job's 5-minute slot.
const MAX_REVIEWS_PER_RUN = 40;
const REVIEW_CONCURRENCY = 4;
// An entry the judge could not score is tried this many times before a person decides.
export const MAX_UNSCORED_ATTEMPTS = 3;
const VERDICT_TTL_SECONDS = 60 * 24 * 60 * 60;

const OFF_THEME_REASON = crucibleOwnerRemovalReasons['off-topic'];

const verdictKey = (crucibleId: number) =>
  `${REDIS_SYS_KEYS.SYSTEM.CRUCIBLE_THEME_REVIEW}:verdicts:${crucibleId}` as const;

export type ThemeReviewEntry = {
  entryId: number;
  crucibleId: number;
  userId: number;
  crucibleName: string;
  crucibleNsfwLevel: number;
  imageId: number;
  url: string;
  username: string | null;
};

/** Image entries of the given running crucibles that judges can see now. */
export const getThemeReviewEntries = (crucibleIds: number[]) =>
  dbRead.$queryRaw<ThemeReviewEntry[]>`
    SELECT ce.id AS "entryId", c.id AS "crucibleId", ce."userId", c.name AS "crucibleName",
      c."nsfwLevel" AS "crucibleNsfwLevel", i.id AS "imageId", i.url, u.username
    FROM "Crucible" c
    JOIN "CrucibleEntry" ce ON ce."crucibleId" = c.id
    JOIN "Image" i ON i.id = ce."imageId"
    JOIN "User" u ON u.id = ce."userId"
    WHERE c.id = ANY(${crucibleIds}::int[])
      AND c.status = ${CrucibleStatus.Active}::"CrucibleStatus"
      AND c."endAt" > now()
      AND i.type = 'image'
      AND ${visibleEntryImageSql(Prisma.sql`c."nsfwLevel"`, 0)}
    ORDER BY ce.id
  `;

export type ThemeVerdict =
  | { verdict: 'pass' | 'fail'; theme: number }
  | { verdict: 'unscored'; theme?: undefined };

/**
 * The challenge judge's own disqualification rule. A review with no numeric theme score (a refusal,
 * a malformed reply) is unscored, never a fail: it must not cost anyone their entry.
 */
export function themeVerdict(score: unknown): ThemeVerdict {
  if (!score || typeof score !== 'object' || Array.isArray(score)) return { verdict: 'unscored' };
  const theme = Object.entries(score).find(([key]) => key.trim().toLowerCase() === 'theme')?.[1];
  if (typeof theme !== 'number' || !Number.isFinite(theme)) return { verdict: 'unscored' };
  return { verdict: theme < THEME_DISQUALIFY_THRESHOLD ? 'fail' : 'pass', theme };
}

export type ThemeAction = 'accepted' | 'reported' | 'removed' | 'retry';

/**
 * shadow accepts whatever the verdict. flag and enforce accept a pass; enforce removes a fail and
 * flag reports it. An unscored entry is retried, then reported and accepted, so a model outage never
 * costs an entrant.
 */
export function themeActions(
  mode: ThemeReviewMode,
  verdict: ThemeVerdict['verdict'],
  attempt: number
): ThemeAction[] {
  if (mode === 'shadow' || verdict === 'pass') return ['accepted'];
  if (verdict === 'fail') return [mode === 'enforce' ? 'removed' : 'reported'];
  return attempt < MAX_UNSCORED_ATTEMPTS ? ['retry'] : ['reported', 'accepted'];
}

type StoredVerdict = { verdict: ThemeVerdict['verdict']; attempts: number; done: boolean };

async function pendingEntries(entries: ThemeReviewEntry[]) {
  const byCrucible = new Map<number, ThemeReviewEntry[]>();
  for (const entry of entries) {
    const list = byCrucible.get(entry.crucibleId) ?? [];
    list.push(entry);
    byCrucible.set(entry.crucibleId, list);
  }
  const pending: { entry: ThemeReviewEntry; attempts: number }[] = [];
  for (const [crucibleId, list] of byCrucible) {
    const stored = await sysRedis.hGetAll(verdictKey(crucibleId));
    for (const entry of list) {
      const raw = stored[String(entry.entryId)];
      const previous = raw ? (JSON.parse(raw) as StoredVerdict) : undefined;
      if (previous?.done) continue;
      pending.push({ entry, attempts: previous?.attempts ?? 0 });
    }
  }
  return pending;
}

async function review(
  config: CrucibleThemeReview,
  judging: Awaited<ReturnType<typeof getJudgingConfig>>,
  entry: ThemeReviewEntry
) {
  const run = (model?: string) =>
    generateReview({
      theme: config.theme,
      themeElements: config.themeElements,
      creator: entry.username ?? 'unknown',
      imageUrl: getEdgeUrl(entry.url, { width: 1200, name: 'image' }),
      config: judging,
      nsfw: !getIsSafeBrowsingLevel(entry.crucibleNsfwLevel),
      model,
    });
  try {
    return await run();
  } catch (error) {
    logToAxiom({
      type: 'crucible-theme-review-fallback',
      entryId: entry.entryId,
      fallbackModel: REVIEW_FALLBACK_MODEL,
      error: (error as Error).message,
    });
    return run(REVIEW_FALLBACK_MODEL);
  }
}

async function apply(
  action: ThemeAction,
  config: CrucibleThemeReview,
  entry: ThemeReviewEntry,
  verdict: ThemeVerdict,
  summary: string
) {
  if (action === 'removed') {
    await removeCrucibleEntryForThemeReview({
      entryId: entry.entryId,
      reasonText: OFF_THEME_REASON,
    });
  } else if (action === 'reported') {
    await createReport({
      type: ReportEntity.Image,
      id: entry.imageId,
      userId: constants.system.user.id,
      isModerator: true,
      reason: ReportReason.AdminAttention,
      details: {
        reason: `Crucible theme review: ${
          verdict.verdict === 'fail' ? 'off-theme' : 'could not score'
        }`,
        comment: `Entry ${entry.entryId} in crucible ${entry.crucibleId} ("${entry.crucibleName}"), theme "${config.theme}". Remove it from /crucibles/${entry.crucibleId} if it does not belong. Review: ${summary}`,
      },
    });
  } else if (action === 'accepted') {
    await acceptCrucibleEntry({
      entryId: entry.entryId,
      crucibleId: entry.crucibleId,
      userId: entry.userId,
    });
  }
}

export type ThemeReviewRunResult = Record<ThemeVerdict['verdict'] | ThemeAction | 'errors', number>;

/**
 * Reviews each judgeable entry of the crucibles with a theme review once, and accepts, reports or
 * removes it by the crucible's mode. A failed review or action leaves the entry for the next run.
 */
export async function runCrucibleThemeReview(): Promise<ThemeReviewRunResult> {
  const result: ThemeReviewRunResult = {
    pass: 0,
    fail: 0,
    unscored: 0,
    accepted: 0,
    reported: 0,
    removed: 0,
    retry: 0,
    errors: 0,
  };
  const configs = (await getCrucibleThemeReviews()) ?? [];
  if (!configs.length) return result;

  const entries = await getThemeReviewEntries(configs.map((c) => c.crucibleId));
  const pending = (await pendingEntries(entries)).slice(0, MAX_REVIEWS_PER_RUN);
  const configFor = new Map(configs.map((c) => [c.crucibleId, c]));
  const judges = new Map<number, Awaited<ReturnType<typeof getJudgingConfig>>>();
  const judgeFor = async (config: CrucibleThemeReview) => {
    const key = config.crucibleId;
    if (!judges.has(key))
      judges.set(key, await getJudgingConfig(config.judgeId, config.reviewPrompt));
    return judges.get(key)!;
  };

  const tasks = pending.map(({ entry, attempts }) => async () => {
    const config = configFor.get(entry.crucibleId);
    if (!config) return;
    try {
      const reviewed = await review(config, await judgeFor(config), entry);
      const verdict = themeVerdict(reviewed.score);
      const attempt = attempts + 1;
      const actions = themeActions(config.mode, verdict.verdict, attempt);
      for (const action of actions) await apply(action, config, entry, verdict, reviewed.summary);

      const record = {
        mode: config.mode,
        ...verdict,
        attempts: attempt,
        done: !actions.includes('retry'),
        actions,
        model: reviewed.model,
        buzzCost: Math.ceil(estimateBuzzCost(reviewed.model, reviewed.usage)),
        at: new Date().toISOString(),
      };
      await sysRedis.hSet(
        verdictKey(entry.crucibleId),
        String(entry.entryId),
        JSON.stringify(record)
      );
      await sysRedis.expire(verdictKey(entry.crucibleId), VERDICT_TTL_SECONDS);
      logToAxiom({
        type: 'info',
        name: 'crucible-theme-review-verdict',
        crucibleId: entry.crucibleId,
        entryId: entry.entryId,
        imageId: entry.imageId,
        summary: reviewed.summary,
        ...record,
      });
      result[verdict.verdict]++;
      for (const action of actions) result[action]++;
    } catch (error) {
      result.errors++;
      logToAxiom({
        type: 'error',
        name: 'crucible-theme-review-entry-failed',
        crucibleId: entry.crucibleId,
        entryId: entry.entryId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await limitConcurrency(tasks, REVIEW_CONCURRENCY);
  return result;
}

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
 * flag reports and accepts it, so a moderator who keeps it has nothing to undo (a removal revokes).
 * An unscored entry is retried, then reported and accepted, so a model outage never costs an entrant.
 */
export function themeActions(
  mode: ThemeReviewMode,
  verdict: ThemeVerdict['verdict'],
  attempt: number
): ThemeAction[] {
  if (mode === 'shadow' || verdict === 'pass') return ['accepted'];
  if (verdict === 'fail') return mode === 'enforce' ? ['removed'] : ['reported', 'accepted'];
  return attempt < MAX_UNSCORED_ATTEMPTS ? ['retry'] : ['reported', 'accepted'];
}

type StoredVerdict = ThemeVerdict & {
  attempts: number;
  done: boolean;
  actions?: ThemeAction[];
  // Actions of `actions` already carried out, so a run that failed partway resumes without repeating them.
  applied?: ThemeAction[];
  summary?: string;
};

/** Fewest attempts first, so entries that keep failing never crowd out the rest of a run. */
async function pendingEntries(entries: ThemeReviewEntry[]) {
  const byCrucible = new Map<number, ThemeReviewEntry[]>();
  for (const entry of entries) {
    const list = byCrucible.get(entry.crucibleId) ?? [];
    list.push(entry);
    byCrucible.set(entry.crucibleId, list);
  }
  const pending: { entry: ThemeReviewEntry; previous?: StoredVerdict }[] = [];
  for (const [crucibleId, list] of byCrucible) {
    const stored = await sysRedis.hGetAll(verdictKey(crucibleId));
    for (const entry of list) {
      const raw = stored[String(entry.entryId)];
      const previous = raw ? (JSON.parse(raw) as StoredVerdict) : undefined;
      if (previous?.done) continue;
      pending.push({ entry, previous });
    }
  }
  return pending.sort(
    (a, b) =>
      (a.previous?.attempts ?? 0) - (b.previous?.attempts ?? 0) || a.entry.entryId - b.entry.entryId
  );
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
        comment: `Entry ${entry.entryId} in crucible ${entry.crucibleId} ("${entry.crucibleName}"), theme "${config.theme}". It stays in and counts; remove it from /crucibles/${entry.crucibleId} if it does not belong, which also takes back what it earned. Review: ${summary}`,
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
 * removes it by the crucible's mode. A review that throws counts as an unscored attempt. An action
 * that throws leaves the entry for the next run, which carries out the remaining actions without
 * reviewing it again.
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

  const save = async (entry: ThemeReviewEntry, record: StoredVerdict & Record<string, unknown>) => {
    await sysRedis.hSet(
      verdictKey(entry.crucibleId),
      String(entry.entryId),
      JSON.stringify(record)
    );
    await sysRedis.expire(verdictKey(entry.crucibleId), VERDICT_TTL_SECONDS);
  };

  const tasks = pending.map(({ entry, previous }) => async () => {
    const config = configFor.get(entry.crucibleId);
    if (!config) return;
    const attempt = (previous?.attempts ?? 0) + 1;
    let record: (StoredVerdict & Record<string, unknown>) | undefined;
    try {
      const resuming = !!previous?.actions?.length && !previous.actions.includes('retry');
      if (resuming) {
        record = { ...previous, attempts: attempt, applied: previous.applied ?? [] };
      } else {
        const reviewed = await review(config, await judgeFor(config), entry).catch(
          (error: unknown) => {
            logToAxiom({
              type: 'error',
              name: 'crucible-theme-review-failed',
              crucibleId: entry.crucibleId,
              entryId: entry.entryId,
              attempt,
              message: error instanceof Error ? error.message : String(error),
            });
            return undefined;
          }
        );
        const verdict: ThemeVerdict = reviewed
          ? themeVerdict(reviewed.score)
          : { verdict: 'unscored' };
        record = {
          mode: config.mode,
          ...verdict,
          attempts: attempt,
          done: false,
          actions: themeActions(config.mode, verdict.verdict, attempt),
          applied: [],
          summary: reviewed?.summary ?? 'The review failed to return a score.',
          model: reviewed?.model,
          buzzCost: reviewed
            ? Math.ceil(estimateBuzzCost(reviewed.model, reviewed.usage))
            : undefined,
          at: new Date().toISOString(),
        };
        result[verdict.verdict]++;
        await save(entry, record);
      }

      const actions = record.actions ?? [];
      for (const action of actions) {
        if (record.applied?.includes(action)) continue;
        await apply(action, config, entry, record, record.summary ?? '');
        record.applied = [...(record.applied ?? []), action];
        result[action]++;
        await save(entry, record);
      }
      record.done = !actions.includes('retry');
      await save(entry, record);
      logToAxiom({
        type: 'info',
        name: 'crucible-theme-review-verdict',
        crucibleId: entry.crucibleId,
        entryId: entry.entryId,
        imageId: entry.imageId,
        ...record,
      });
    } catch (error) {
      result.errors++;
      // Keep the attempt, so an entry whose action keeps failing sorts behind the rest.
      if (record) await save(entry, { ...record, done: false }).catch(() => undefined);
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

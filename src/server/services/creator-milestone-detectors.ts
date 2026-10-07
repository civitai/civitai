import type { MilestoneRegistryEntry } from '~/server/services/creator-milestone-registry';
import {
  creatorMilestoneRegistry,
  USER_METRICS,
} from '~/server/services/creator-milestone-registry';

type ActivityEntry = Exclude<MilestoneRegistryEntry, { detector: 'scoreSnapshot' }>;

/**
 * One set-based query per group of keys that share a detector, params, launch date and silence. It
 * selects "userId", "milestoneKey" and "achievedAt" (NULL when the moment is unknown) for every key
 * a user has reached but does not hold. `keys` and `users` are SQL placeholders; `users` narrows the
 * scan to those user ids, and NULL means everyone.
 */
export type MilestoneDetectorGroup = {
  id: string;
  /** The group's identity without its silence, so toggling silence keeps one watermark row. */
  watermarkId: string;
  keys: string[];
  launchedAt: Date;
  silent: boolean;
  /** Whether "achievedAt" is the real moment. Without it, a crossing cannot be dated. */
  timed: boolean;
  sql: (placeholders: { keys: string; users: string }) => string;
};

const notHeld = (user: string) => `NOT EXISTS (
    SELECT 1 FROM "UserCreatorMilestone" held
    WHERE held."userId" = ${user} AND held."milestoneKey" = m.key
  )`;

// Only work anyone can see counts. publishedAt is required to date the Nth item.
const publishedSources = {
  model: `SELECT x."userId", x."publishedAt", x.id FROM "Model" x
    WHERE x.status = 'Published' AND x.availability != 'Private'
      AND (x.mode IS NULL OR x.mode != 'Archived')
      AND x."deletedAt" IS NULL AND x."publishedAt" IS NOT NULL`,
  article: `SELECT x."userId", x."publishedAt", x.id FROM "Article" x
    WHERE x.status = 'Published' AND x.availability != 'Private'
      AND x."publishedAt" IS NOT NULL AND x."publishedAt" <= now()`,
} as const;

export const modelDownloadsSource = `SELECT mm."userId", mm."downloadCount" FROM "ModelMetric" mm
    WHERE mm.status = 'Published' AND mm.availability <> 'Private'`;

const userMetricSource = `SELECT um."userId", ${USER_METRICS.map((m) => `um."${m}"`).join(', ')}
    FROM "UserMetric" um WHERE um.timeframe = 'AllTime'`;

/** One user's current count per activity measure (`$1` is the user id), on the detectors' own rules. */
export const activityValuesSql = `SELECT
    (SELECT count(*) FROM (${publishedSources.model}) s WHERE s."userId" = $1)::int AS models,
    (SELECT count(*) FROM (${publishedSources.article}) s WHERE s."userId" = $1)::int AS articles,
    -- GROUP BY keeps the planner off the max() rewrite, which walks the whole downloads index for a
    -- heavy uploader with no public model (1.5s on prod).
    coalesce((SELECT max(s."downloadCount") FROM (${modelDownloadsSource}) s
      WHERE s."userId" = $1 GROUP BY s."userId"), 0)::int AS downloads,
    coalesce((SELECT s."followerCount" FROM (${userMetricSource}) s
      WHERE s."userId" = $1), 0)::int AS followers,
    coalesce((SELECT s."reactionCount" FROM (${userMetricSource}) s
      WHERE s."userId" = $1), 0)::int AS reactions`;

function detectorSql(entry: ActivityEntry): MilestoneDetectorGroup['sql'] {
  switch (entry.detector) {
    // The Nth item still published is dated by its own publishedAt.
    case 'publishedCount':
      return ({ keys, users }) => `
        SELECT r."userId", m.key AS "milestoneKey", r."publishedAt" AS "achievedAt"
        FROM (
          SELECT s."userId", s."publishedAt",
            row_number() OVER (PARTITION BY s."userId" ORDER BY s."publishedAt", s.id) AS n
          FROM (${publishedSources[entry.params.entity]}) s
          WHERE (${users}::int[] IS NULL OR s."userId" = ANY(${users}::int[]))
        ) r
        JOIN "CreatorMilestone" m ON m.key = ANY(${keys}::text[]) AND m.threshold = r.n
        WHERE ${notHeld('r."userId"')}`;
    case 'modelDownloads':
      return ({ keys, users }) => `
        SELECT d."userId", m.key AS "milestoneKey", NULL::timestamp AS "achievedAt"
        FROM (
          SELECT s."userId", max(s."downloadCount") AS top
          FROM (${modelDownloadsSource}) s
          WHERE (${users}::int[] IS NULL OR s."userId" = ANY(${users}::int[]))
          GROUP BY s."userId"
        ) d
        JOIN "CreatorMilestone" m ON m.key = ANY(${keys}::text[]) AND d.top >= m.threshold
        WHERE ${notHeld('d."userId"')}`;
    case 'userMetric':
      return ({ keys, users }) => `
        SELECT um."userId", m.key AS "milestoneKey", NULL::timestamp AS "achievedAt"
        FROM (${userMetricSource}) um
        JOIN "CreatorMilestone" m
          ON m.key = ANY(${keys}::text[]) AND um."${entry.params.metric}" >= m.threshold
        WHERE (${users}::int[] IS NULL OR um."userId" = ANY(${users}::int[]))
          AND ${notHeld('um."userId"')}`;
  }
}

/** The registry's activity keys, grouped so each group is one query. Score tiers run in their own job. */
export function activityDetectorGroups(
  registry: Record<string, MilestoneRegistryEntry> = creatorMilestoneRegistry
): MilestoneDetectorGroup[] {
  const groups = new Map<string, MilestoneDetectorGroup>();
  for (const [key, entry] of Object.entries(registry)) {
    if (entry.detector === 'scoreSnapshot') continue;
    const watermarkId = [
      entry.detector,
      ...Object.values(entry.params),
      entry.launchedAt.toISOString(),
    ].join(':');
    const id = `${watermarkId}:${entry.silent ? 'silent' : 'announced'}`;
    const group = groups.get(id);
    if (group) group.keys.push(key);
    else
      groups.set(id, {
        id,
        watermarkId,
        keys: [key],
        launchedAt: entry.launchedAt,
        silent: !!entry.silent,
        timed: entry.detector === 'publishedCount',
        sql: detectorSql(entry),
      });
  }
  return [...groups.values()];
}
